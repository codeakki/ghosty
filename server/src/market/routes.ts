import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CANDLE_INTERVALS, MarketDataError, UnknownCoinError, type MarketService } from './service.js';

const HistoryQuery = z.object({
  coin: z.string().trim().min(1).max(40),
  interval: z.enum(CANDLE_INTERVALS).default('1h'),
  hours: z.coerce.number().positive().max(24 * 90).default(24),
});

/** Read-only market data for the terminal: GET /market/snapshot, GET /market/history. No auth, no keys. */
export function registerMarketRoutes(app: FastifyInstance, market: MarketService): void {
  app.get('/market/snapshot', async (req, reply) => {
    try {
      return await market.snapshot();
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, 'market snapshot failed');
      return reply.code(502).send({ error: 'market_unavailable', message: (err as Error).message });
    }
  });

  app.get('/market/history', async (req, reply) => {
    const parsed = HistoryQuery.safeParse(req.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'bad_request',
        message: `query must be coin=<coin>&interval=<${CANDLE_INTERVALS.join('|')}>&hours=<1..2160>`,
      });
    }
    const { coin, interval, hours } = parsed.data;
    try {
      return await market.history(coin, interval, hours);
    } catch (err) {
      if (err instanceof UnknownCoinError) return reply.code(404).send({ error: 'unknown_coin', coin });
      if (err instanceof MarketDataError) {
        req.log.warn({ err: err.message }, 'market history failed');
        return reply.code(502).send({ error: 'market_unavailable', message: err.message });
      }
      throw err;
    }
  });
}
