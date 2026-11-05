import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { PodEvent, PodState } from './state.js';

/**
 * Virtual pod routes: read the pod state and stream its changes.
 * None of these are called by the firmware today.
 */
export interface SimRouteContext {
  state: PodState;
  /** Current safe-stop state (true = trading blocked), same source as /health. */
  safeStopEngaged: () => Promise<boolean>;
}

/** Keep idle proxies and browsers from dropping the stream. */
const SSE_PING_MS = 15_000;

function writeEvent(res: ServerResponse, event: PodEvent): void {
  res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
}

export function registerSimRoutes(app: FastifyInstance, ctx: SimRouteContext): void {
  const { state } = ctx;

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

  // Open streams would keep server.close() waiting forever; end them first.
  app.addHook('preClose', async () => {
    for (const res of streams) res.end();
    streams.clear();
  });
}
