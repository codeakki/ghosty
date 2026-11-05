import 'dotenv/config';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { HcsAuditLog } from '../payments/hcsAudit.js';
import { TINYBAR_PER_HBAR } from '../payments/hedera.js';
import { X402Payer } from '../payments/x402Client.js';

/**
 * `npm run x402:demo` — the agent pays for one `/signal` on hedera:testnet with no human approval.
 * Starts nothing: run the server first (`npm run dev`). Prints the settled tx id + HashScan link
 * and appends a row to docs/evidence.md (the Hedera track's "tx ID in the README" evidence).
 *
 * Env: HEDERA_ACCOUNT_ID + HEDERA_PRIVATE_KEY (payer), SERVER_URL (default http://localhost:$PORT).
 * The server's X402_PAY_TO must be a different account than HEDERA_ACCOUNT_ID.
 */

const EVIDENCE = fileURLToPath(new URL('../../../docs/evidence.md', import.meta.url));
const HEADER = `# Evidence

## Hedera x402 settled transactions

Each row is one autonomous \`GET /signal\` payment by the agent wallet, settled on \`hedera:testnet\` through an x402 facilitator. Appended by \`npm run x402:demo\` (server/src/scripts/x402Demo.ts).

| Time (UTC) | Transaction (HashScan) | Amount | Payer → payTo | Signal requestId | HCS audit |
|---|---|---|---|---|---|
`;

const config = loadConfig();
const serverUrl = (process.env.SERVER_URL ?? `http://localhost:${config.PORT}`).replace(/\/+$/, '');
const url = `${serverUrl}/signal`;

if (!config.HEDERA_ACCOUNT_ID || !config.HEDERA_PRIVATE_KEY) {
  console.error('x402:demo needs HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY in server/.env (testnet account from portal.hedera.com).');
  process.exit(1);
}

const audit = HcsAuditLog.fromConfig(config);
const payer = new X402Payer({ config, audit, log: (msg, data) => console.log(msg, data ?? '') });

console.log(`paying for ${url} as ${config.HEDERA_ACCOUNT_ID} (daily cap ${config.X402_MAX_SPEND_TINYBAR} tinybar, spent today ${payer.spendCap.spentToday()})`);

try {
  const paid = await payer.payForSignal(url);
  const body = paid.body as { signal?: string; confidence?: number; requestId?: string } | undefined;
  const hbar = paid.amountTinybar !== undefined ? `${paid.amountTinybar / TINYBAR_PER_HBAR} HBAR` : '?';

  console.log('');
  console.log(`signal:    ${body?.signal ?? '?'} (confidence ${body?.confidence ?? '?'}, requestId ${body?.requestId ?? '?'})`);
  console.log(`tx id:     ${paid.txId}`);
  console.log(`hashscan:  ${paid.hashscanUrl}`);
  if (paid.audit) console.log(`hcs audit: ${audit.topicUrl()} (sequence ${paid.audit.sequenceNumber})`);

  if (!existsSync(EVIDENCE)) writeFileSync(EVIDENCE, HEADER);
  const hcs = paid.audit && audit.topicUrl() ? `[${paid.audit.topicId} #${paid.audit.sequenceNumber}](${audit.topicUrl()})` : '—';
  const row = `| ${new Date().toISOString()} | [\`${paid.txId}\`](${paid.hashscanUrl}) | ${hbar} | ${config.HEDERA_ACCOUNT_ID} → ${paid.payTo ?? '?'} | \`${body?.requestId ?? '?'}\` | ${hcs} |\n`;
  appendFileSync(EVIDENCE, row);
  console.log(`appended to ${EVIDENCE}`);
} catch (err) {
  console.error(`payment failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  if (audit instanceof HcsAuditLog) audit.close();
}
