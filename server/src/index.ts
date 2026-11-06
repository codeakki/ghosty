import 'dotenv/config';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { NewsPoller } from './news/aggregator.js';

const config = loadConfig();
const app = buildApp({
  config,
  logger: process.stdout.isTTY ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } } : true,
});

// Live news only (NEWS_LIVE=true, the default in live mode). Started here, never in buildApp, so tests stay timer-free.
const { aggregator, onFreshNews, providers, market, state } = app.ghosty;
const poller = aggregator
  ? new NewsPoller(aggregator, {
      intervalMs: config.NEWS_POLL_SECONDS * 1000,
      onError: (err) => app.log.warn({ err }, 'news poll failed'),
      onProviderErrors: (errors) => app.log.warn({ errors }, 'news providers failed'),
    }).onNew(async (items) => {
      const out = await onFreshNews(items);
      app.log.info(
        { n: items.length, shock: out.shock.candidate, requestId: out.decision?.requestId, alert: out.alert?.id, skipped: out.skipped },
        'news',
      );
    })
  : undefined;

// Provider health: poll every 30 s, SSE `providers` whenever a state changes. Details never carry secrets.
providers.onChange((status, changed) => {
  state.publish('providers', status);
  app.log.info({ changed: changed.map((p) => `${p.id}=${p.state}`) }, 'provider state changed');
});

// Live market data (keyless Hyperliquid info API): SSE `market` {ts, mids}, throttled to 1/s by the service.
market.onMids((event) => state.publish('market', event));

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  poller?.stop();
  providers.stopPolling();
  market.stop();
  await app.close();
  // Wait for queued 0G Storage uploads (memory and episodes) before exiting.
  await app.ghosty.agent.flush().catch((err: unknown) => app.log.error({ err }, '0G flush failed'));
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ port: config.PORT, host: config.HOST });
  app.log.info(
    { mode: config.GHOSTY_MODE, marketNetwork: config.MARKET_DATA_NETWORK, executionNetwork: config.HL_TESTNET ? 'testnet' : 'mainnet' },
    config.GHOSTY_MODE === 'live' ? 'live mode: real providers only, missing keys answer 503 not_configured' : 'TEST mode: fake providers',
  );
  poller?.start();
  market.start();
  providers.startPolling();
  providers
    .refresh()
    .then((status) => {
      const summary = status.providers.map((p) => `${p.id}=${p.state}`).join(' ');
      app.log.info({ providers: summary }, 'provider status (GET /providers/status, npm run doctor)');
    })
    .catch((err: unknown) => app.log.warn({ err }, 'provider probe failed'));
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
