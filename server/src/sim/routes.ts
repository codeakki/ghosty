import type { ServerResponse } from 'node:http';
import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import { OUTPUT_SAMPLE_RATE } from '../audio/tts.js';
import type { Pipeline } from '../pipeline.js';
import type { BrainSwitch } from '../safety/safeStop.js';
import type { InjectedNewsProvider } from './injected.js';
import type { PodEvent, PodState } from './state.js';

/**
 * Virtual pod routes: read the pod state, stream its changes, inject headlines, drain the alert queue.
 * None of these are called by the firmware today (`/alerts/next` is meant for a later firmware poll).
 */
export interface SimRouteContext {
  state: PodState;
  pipeline: Pipeline;
  injected: InjectedNewsProvider;
  /** Runtime override for SIMULATE_BRAIN_OFFLINE, flipped by POST /sim/safe-stop. */
  brain: BrainSwitch;
  /** Current safe-stop state (true = trading blocked), same source as /health. */
  safeStopEngaged: () => Promise<boolean>;
  /** X-Device-Token check, same as /voice and /button. */
  requireDevice: preHandlerAsyncHookHandler;
  /** 503 brain_offline when safe-stop is engaged. */
  requireBrain: preHandlerAsyncHookHandler;
  /** Claude answers questions: /voice/text then checks safe-stop on the 0G trade path only (in the pipeline). */
  voiceRouting?: boolean;
}

const InjectBody = z.object({
  title: z.string().trim().min(1).max(500),
  source: z.string().trim().min(1).max(100).optional(),
  url: z.string().trim().max(2000).optional(),
});

const AlertParams = z.object({ id: z.string().min(1).max(100) });

const TextBody = z.object({ text: z.string().trim().min(1).max(2000) });

const SafeStopBody = z.object({ enabled: z.boolean() });

/** Keep idle proxies and browsers from dropping the stream. */
const SSE_PING_MS = 15_000;

function writeEvent(res: ServerResponse, event: PodEvent): void {
  res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
}

export function registerSimRoutes(app: FastifyInstance, ctx: SimRouteContext): void {
  const { state, pipeline, injected } = ctx;
  const guarded = { preHandler: [ctx.requireDevice, ctx.requireBrain] };

  app.get('/state', async () => {
    state.setSafeStop(await ctx.safeStopEngaged());
    return state.snapshot();
  });

  // Server-sent events: a `state` snapshot on connect, then `news`, `decision`, `alert`, `order`,
  // `episode` and coalesced `state` events as the pipeline runs. index.ts adds `providers` (on a provider
  // state change) and `market` (watchlist mids, at most 1/s).
  const streams = new Set<ServerResponse>();
  app.get('/events', async (req, reply) => {
    state.setSafeStop(await ctx.safeStopEngaged());
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      // Keep headers set by hooks (CORS) that reply.hijack() would otherwise drop.
      ...(reply.getHeaders() as Record<string, string>),
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    writeEvent(res, { id: 0, type: 'state', data: state.snapshot() });

    const unsubscribe = state.subscribe((event) => writeEvent(res, event));
    const ping = setInterval(() => res.write(': ping\n\n'), SSE_PING_MS);
    streams.add(res);
    req.raw.on('close', () => {
      clearInterval(ping);
      unsubscribe();
      streams.delete(res);
    });
  });

  // A headline arrives: run the decision loop on it; an actionable decision becomes a pending alert
  // and the pending trade for the next button press.
  app.post('/news/inject', guarded, async (req, reply) => {
    const parsed = InjectBody.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'bad_request', message: 'body must be {"title": string, "source"?: string, "url"?: string}' });
    }
    const item = injected.add(parsed.data);
    const decision = await pipeline.decideOnHeadline(item);
    const alert = state.enqueueAlert(decision, item);
    req.log.info({ requestId: decision.requestId, signal: decision.signal, alert: alert?.id }, 'headline injected');
    return {
      item,
      decision: {
        requestId: decision.requestId,
        signal: decision.signal,
        confidence: decision.confidence,
        rationale: decision.rationale,
        actions: decision.suggestedActions,
      },
      alert,
    };
  });

  // Pop the oldest pending alert (204 when there is none). Shape kept small for a future firmware poll.
  app.get('/alerts/next', { preHandler: ctx.requireDevice }, async (_req, reply) => {
    const alert = state.nextAlert();
    if (!alert) return reply.code(204).send();
    return {
      id: alert.id,
      text: alert.text,
      signal: alert.signal,
      actions: alert.actions,
      requestId: alert.requestId,
      confidence: alert.confidence,
      headline: alert.headline ?? null,
      createdAt: alert.createdAt,
    };
  });

  app.post('/alerts/:id/ack', { preHandler: ctx.requireDevice }, async (req, reply) => {
    const parsed = AlertParams.safeParse(req.params);
    const alert = parsed.success ? state.ackAlert(parsed.data.id) : undefined;
    if (!alert) return reply.code(404).send({ error: 'not_found' });
    return { ok: true, alert };
  });

  // Text turn: the voice loop without STT. JSON out, with the TTS reply as base64 PCM s16le.
  // Questions are answered by Claude (answeredBy "claude", signal "none", no actions); trade requests by 0G.
  const textGuard = ctx.voiceRouting ? { preHandler: [ctx.requireDevice] } : guarded;
  app.post('/voice/text', textGuard, async (req, reply) => {
    const parsed = TextBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', message: 'body must be {"text": string}' });
    const result = await pipeline.handleText(parsed.data.text);
    const decision = result.decision;
    req.log.info(
      { answeredBy: result.answeredBy, intent: result.intent, requestId: result.requestId, signal: decision?.signal, assistantError: result.assistantError },
      'text turn',
    );
    reply.header('x-answered-by', result.answeredBy);
    return {
      transcript: result.transcript,
      answeredBy: result.answeredBy,
      intent: result.intent,
      reply: result.reply,
      requestId: result.requestId,
      signal: decision?.signal ?? 'none',
      confidence: decision?.confidence ?? 0,
      rationale: result.reply,
      actions: decision?.suggestedActions ?? [],
      assistantError: result.assistantError ?? null,
      sampleRate: OUTPUT_SAMPLE_RATE,
      audioBytes: result.audio.length,
      audioBase64: result.audio.toString('base64'),
      // Live mode without TTS keys: the decision stands, the audio is empty.
      tts: result.ttsNotConfigured
        ? { error: 'not_configured', ...result.ttsNotConfigured }
        : result.ttsFailed
          ? { error: 'tts_failed', message: result.ttsFailed }
          : null,
    };
  });

  // Flip the simulated "0G unreachable" flag at runtime. enabled=true engages safe-stop:
  // /voice, /button, /voice/text and /news/inject answer 503 brain_offline until it is turned off.
  // With SAFE_STOP_ENABLED=false the check is bypassed and safe-stop stays off.
  app.post('/sim/safe-stop', { preHandler: ctx.requireDevice }, async (req, reply) => {
    const parsed = SafeStopBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', message: 'body must be {"enabled": boolean}' });
    ctx.brain.simulateOffline = parsed.data.enabled;
    const safeStop = await ctx.safeStopEngaged();
    state.setSafeStop(safeStop);
    req.log.warn({ simulateOffline: parsed.data.enabled, safeStop }, 'sim safe-stop toggled');
    return { safeStop, simulateOffline: parsed.data.enabled };
  });

  // Open streams would keep server.close() waiting forever; end them first.
  app.addHook('preClose', async () => {
    for (const res of streams) res.end();
    streams.clear();
  });
}
