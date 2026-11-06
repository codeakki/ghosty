import type { FastifyInstance, FastifyReply, preHandlerAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import { ZeroGEpisodeLog, type EpisodeLog } from '../agent/episode.js';
import type { BlobStore } from '../agent/storage.js';
import { SimRunError, type SimEngine } from './engine.js';
import { replayChain, type SimEpisodeLog } from './episodes.js';

/** Simulation run routes (scenario replay) and the episode list / replay walk. */
export interface SimRunRouteContext {
  engine: SimEngine;
  simLog: SimEpisodeLog;
  liveEpisodes: EpisodeLog;
  store?: BlobStore;
  storagescan: string;
  requireDevice: preHandlerAsyncHookHandler;
}

const RunBody = z.object({
  scenarioId: z.string().min(1).max(100),
  speed: z.number().positive().max(1_000_000).optional(),
  autoPauseOnAlert: z.boolean().optional(),
});
const ControlBody = z.object({ action: z.enum(['pause', 'resume', 'stop']) });
const EpisodesQuery = z.object({ runId: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(500).default(50) });
const ReplayQuery = z.object({ from: z.string().min(1).max(200), limit: z.coerce.number().int().min(1).max(200).default(20) });

const STATUS_FOR: Record<SimRunError['code'], number> = { unknown_scenario: 404, no_run: 409, no_pending: 409, candles_failed: 502 };

export function registerSimRunRoutes(app: FastifyInstance, ctx: SimRunRouteContext): void {
  const { engine } = ctx;
  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof SimRunError) return reply.code(STATUS_FOR[err.code]).send({ error: err.code, message: err.message });
    throw err;
  };

  app.get('/sim/scenarios', async () => ({
    scenarios: engine.scenarios().map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      category: s.category ?? null,
      start: s.start,
      end: s.end,
      interval: s.interval,
      markets: s.markets,
      headlines: s.headlines,
      sources: s.sources,
    })),
  }));

  app.post('/sim/run', { preHandler: ctx.requireDevice }, async (req, reply) => {
    const parsed = RunBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', message: 'body must be {"scenarioId": string, "speed"?: number, "autoPauseOnAlert"?: boolean}' });
    }
    try {
      return await engine.start(parsed.data);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get('/sim/run', async () => engine.status());

  app.post('/sim/control', { preHandler: ctx.requireDevice }, async (req, reply) => {
    const parsed = ControlBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', message: 'body must be {"action": "pause"|"resume"|"stop"}' });
    try {
      return engine.control(parsed.data.action);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Sim episodes from server/.ghosty/sim-episodes.jsonl; without runId the live 0G index is merged in.
  app.get('/episodes', async (req, reply) => {
    const parsed = EpisodesQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', message: 'query: runId?, limit? (1-500)' });
    const { runId, limit } = parsed.data;
    const sim = ctx.simLog.list({ runId, limit }).map(({ body, ...e }) => ({
      ...e,
      sim: true,
      simTime: body.simTime,
      headline: body.headline ?? null,
      signal: body.decision.signal,
      storagescan: e.storage === '0g' ? `${ctx.storagescan}/submission/${e.rootHash}` : null,
    }));
    const live =
      !runId && ctx.liveEpisodes instanceof ZeroGEpisodeLog
        ? ctx.liveEpisodes.listIndex(limit).map((e) => ({ ...e, sim: false, storage: '0g' as const, storagescan: `${ctx.storagescan}/submission/${e.rootHash}` }))
        : [];
    const episodes = [...live, ...sim].sort((a, b) => a.ts.localeCompare(b.ts)).slice(-limit);
    return { runId: runId ?? null, storage: ctx.simLog.storageMode, episodes };
  });

  app.get('/episodes/replay', async (req, reply) => {
    const parsed = ReplayQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', message: 'query: from=<rootHash>, limit? (1-200)' });
    return replayChain({ ...parsed.data, simLog: ctx.simLog, store: ctx.store, storagescan: ctx.storagescan });
  });
}
