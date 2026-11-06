import 'dotenv/config';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { createPayments } from '../payments/index.js';

/**
 * `npm run x402:demo [headline]` — the agent buys one intel bundle from the Signal Desk on hedera:testnet with
 * no human approval, waits for the mirror-node verification and the HCS audit message, and appends a row to
 * docs/evidence.md. Starts nothing: run the desk first (`npm run signal-desk`).
 *
 * Env: the agent (HEDERA_ACCOUNT_ID + HEDERA_PRIVATE_KEY), SIGNAL_DESK_URL (default http://127.0.0.1:3101).
 */

const EVIDENCE = fileURLToPath(new URL('../../../docs/evidence.md', import.meta.url));
const HEADER = `# Evidence

## Hedera x402 settled transactions

| Time (UTC) | Transaction (HashScan) | Amount | Payer → payTo | Mirror verified | HCS audit |
|---|---|---|---|---|---|
`;

const config = loadConfig();
const headline = process.argv.slice(2).join(' ').trim() || 'TEST: missile strikes reported near Strait of Hormuz';

if (!config.HEDERA_ACCOUNT_ID || !config.HEDERA_PRIVATE_KEY) {
  console.error('x402:demo needs the agent account (HEDERA_ACCOUNT_ID, HEDERA_PRIVATE_KEY). Run npm run hedera:setup first.');
  process.exit(1);
}

const payments = createPayments(config, { log: (msg, data) => console.log(msg, data ?? '') });
console.log(`buying intel for "${headline}" from ${config.SIGNAL_DESK_URL} as ${config.HEDERA_ACCOUNT_ID} (prefers ${config.X402_PREFERRED_ASSET})`);

try {
  const intel = await payments.buyer.buy({ title: headline }, 'sim');
  const check = await intel.verification;
  // The HCS message is written right after verification; give it a moment to land.
  for (let i = 0; i < 20 && payments.audit.enabled && !payments.buyer.lastPayment?.audit; i++) await new Promise((r) => setTimeout(r, 500));
  const last = payments.buyer.lastPayment;

  console.log('');
  console.log(`bundle:    ${JSON.stringify(intel.bundle)}`);
  console.log(`tx id:     ${intel.txId}`);
  console.log(`hashscan:  ${intel.hashscanUrl}`);
  console.log(`amount:    ${last?.amountLabel}`);
  console.log(`verified:  ${check.verified ? `yes (consensus ${check.consensusTimestamp})` : `NO (${check.reason})`}`);
  if (last?.audit) console.log(`hcs audit: ${payments.audit.topicUrl()} (sequence ${last.audit.sequenceNumber})`);

  if (!existsSync(EVIDENCE)) writeFileSync(EVIDENCE, HEADER);
  const hcs = last?.audit ? `[${last.audit.topicId} #${last.audit.sequenceNumber}](${payments.audit.topicUrl()})` : '—';
  const row = `| ${new Date().toISOString()} | [\`${intel.txId}\`](${intel.hashscanUrl}) | ${last?.amountLabel ?? '?'} | ${config.HEDERA_ACCOUNT_ID} → ${last?.payTo ?? '?'} | ${check.verified ? 'yes' : `no: ${check.reason}`} | ${hcs} |\n`;
  appendFileSync(EVIDENCE, row);
  console.log(`appended to ${EVIDENCE}`);
} catch (err) {
  console.error(`payment failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  payments.audit.close();
}
