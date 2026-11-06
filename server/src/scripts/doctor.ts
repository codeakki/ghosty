/**
 * `npm run doctor`: loads server/.env, runs the same probes as GET /providers/status, and prints one table per
 * track with the state, detail, missing env keys and the next action (with the exact URL to get each key).
 * Never prints secrets and always exits 0, so it is safe to paste into a PR or docs/evidence.md.
 */
import 'dotenv/config';
import { loadConfig } from '../config.js';
import { ProviderRegistry, type ProviderStatus, type ProviderTrack } from '../providers/registry.js';

const TRACKS: Array<{ track: ProviderTrack; title: string }> = [
  { track: '0g', title: '0G (Compute + Storage)' },
  { track: 'hedera', title: 'Hedera x402' },
  { track: 'hyperliquid', title: 'Hyperliquid (execution venue)' },
  { track: 'uniswap', title: 'Uniswap (spot leg)' },
  { track: 'data', title: 'News + credibility data' },
  { track: 'audio', title: 'Audio (STT / TTS)' },
];

const MARK: Record<ProviderStatus['state'], string> = {
  live: 'LIVE',
  degraded: 'DEGRADED',
  offline: 'OFFLINE',
  not_configured: 'NOT CONFIGURED',
};

function table(rows: string[][]): string {
  const widths = rows[0]?.map((_, c) => Math.max(...rows.map((r) => (r[c] ?? '').length))) ?? [];
  return rows.map((r) => r.map((cell, c) => cell.padEnd(widths[c] ?? 0)).join('  ').trimEnd()).join('\n');
}

const config = loadConfig();
const registry = new ProviderRegistry({ config });
const status = await registry.refresh().catch((err: unknown) => {
  console.error(`doctor: probes failed: ${(err as Error).message}`);
  return undefined;
});

console.log(`Ghosty doctor  ${status?.checkedAt ?? new Date().toISOString()}`);
console.log(
  `mode=${config.GHOSTY_MODE}  execution=${config.HL_TESTNET ? 'Hyperliquid testnet' : 'Hyperliquid MAINNET'}  ` +
    `market data=${config.MARKET_DATA_NETWORK} (read-only)  hedera=${config.HEDERA_NETWORK}`,
);

const counts: Record<string, number> = { live: 0, degraded: 0, offline: 0, not_configured: 0 };
for (const { track, title } of TRACKS) {
  const rows = (status?.providers ?? []).filter((p) => p.track === track);
  if (rows.length === 0) continue;
  console.log(`\n== ${title} ==`);
  console.log(
    table([
      ['provider', 'state', 'ms', 'detail', 'missing env'],
      ...rows.map((p) => [p.id, MARK[p.state], String(p.latencyMs ?? ''), p.detail, p.missingEnv.join(', ') || '-']),
    ]),
  );
  for (const p of rows) {
    counts[p.state] = (counts[p.state] ?? 0) + 1;
    if (p.state !== 'live' && p.nextAction) console.log(`  -> ${p.id}: ${p.nextAction}`);
  }
}

console.log(
  `\nsummary: ${counts.live} live, ${counts.degraded} degraded, ${counts.offline} offline, ${counts.not_configured} not configured`,
);
console.log('Same data: GET /providers/status on the running server. Keys go in server/.env (template: .env.example).');
process.exit(0);
