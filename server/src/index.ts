import 'dotenv/config';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { NewsPoller } from './news/aggregator.js';

const config = loadConfig();
const app = buildApp({
  config,
  logger: process.stdout.isTTY ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } } : true,
});

// Live news only (NEWS_LIVE=true). Started here, never in buildApp, so tests stay timer-free.
const { aggregator, onFreshNews } = app.ghosty;
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

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  poller?.stop();
  await app.close();
  // Wait for queued 0G Storage uploads (memory and episodes) before exiting.
  await app.ghosty.agent.flush().catch((err: unknown) => app.log.error({ err }, '0G flush failed'));
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ port: config.PORT, host: config.HOST });
  poller?.start();
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
