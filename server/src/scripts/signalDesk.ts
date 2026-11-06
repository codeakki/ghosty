import 'dotenv/config';
import { loadConfig } from '../config.js';
import { buildSignalDeskApp } from '../payments/signalDesk.js';

/**
 * `npm run signal-desk` — start the Signal Desk merchant on SIGNAL_DESK_PORT (default 3101).
 * Needs X402_PAY_TO (the desk's own account). It never reads the agent's key.
 */
const config = loadConfig();
const app = buildSignalDeskApp({
  config,
  logger: process.stdout.isTTY ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } } : true,
});

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

try {
  await app.listen({ port: config.SIGNAL_DESK_PORT, host: config.HOST });
  app.log.info({ payTo: config.X402_PAY_TO, network: config.HEDERA_NETWORK }, 'Signal Desk selling GET /intel via x402');
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
