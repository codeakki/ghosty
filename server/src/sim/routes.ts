import type { ServerResponse } from 'node:http';
import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import type { Pipeline } from '../pipeline.js';
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
  /** Current safe-stop state (true = trading blocked), same source as /health. */
  safeStopEngaged: () => Promise<boolean>;
  /** X-Device-Token check, same as /voice and /button. */
  requireDevice: preHandlerAsyncHookHandler;
  /** 503 brain_offline when safe-stop is engaged. */
  requireBrain: preHandlerAsyncHookHandler;
}

const InjectBody = z.object({
  title: z.string().trim().min(1).max(500),
  source: z.string().trim().min(1).max(100).optional(),
  url: z.string().trim().max(2000).optional(),
});

const AlertParams = z.object({ id: z.string().min(1).max(100) });

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
  // `episode` and coalesced `state` events as the pipeline runs.
  const streams = new Set<ServerResponse>();
  app.get('/events', async (req, reply) => {
    state.setSafeStop(await ctx.safeStopEngaged());
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
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

  // Open streams would keep server.close() waiting forever; end them first.
  app.addHook('preClose', async () => {
    for (const res of streams) res.end();
    streams.clear();
  });
}
