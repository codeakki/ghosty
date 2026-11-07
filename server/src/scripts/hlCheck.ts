/**
 * Pre-event Hyperliquid checklist: `npm run hl:check`.
 * Read-only: perpDexs, which GOLD / WTI / TSLA markets exist, master account state, and how playbook coins resolve.
 * Needs no keys; HL_MASTER_ADDRESS adds account state, HL_AGENT_PRIVATE_KEY is only reported (never used to sign).
 */
import 'dotenv/config';
import { loadConfig } from '../config.js';
import {
  appUrl,
  createHyperliquidClients,
  HyperliquidVenue,
  parseFallbackCoins,
  tickerOf,
  UnknownMarketError,
} from '../execution/hyperliquid.js';
import { HL_UNIFIED_MIN_COLLATERAL_USD, spotUsdc } from '../providers/probes.js';
import { isAddress, normalizePrivateKey } from '../wallet/account.js';

const config = loadConfig();
const { info } = createHyperliquidClients({ ...config, HL_AGENT_PRIVATE_KEY: undefined });
const dexes = config.HL_DEXES.split(',').map((d) => d.trim()).filter(Boolean);
const venue = new HyperliquidVenue({
  info,
  testnet: config.HL_TESTNET,
  dexes,
  fallbackCoins: parseFallbackCoins(config.HL_FALLBACK_COINS),
});

const ok = (b: boolean) => (b ? '[ok]  ' : '[MISS]');
let problems = 0;

console.log(`Hyperliquid ${config.HL_TESTNET ? 'TESTNET' : 'MAINNET'}  ${appUrl(config.HL_TESTNET)}`);
console.log(`agent key: ${normalizePrivateKey(config.HL_AGENT_PRIVATE_KEY) ? 'set' : 'not set (fake venue will be used)'}`);

// 1. perpDexs
const all = await info.perpDexs();
console.log(`\nperpDexs: ${all.length} (index 0 = main dex)`);
for (const dex of dexes) {
  const idx = all.findIndex((d, i) => i > 0 && d?.name === dex);
  console.log(`  ${ok(idx > 0)} dex "${dex}" ${idx > 0 ? `index ${idx} → asset ids ${100000 + idx * 10000}+` : 'not listed'}`);
  if (idx <= 0) problems++;
}
const preview = all
  .slice(1, 16)
  .map((d) => d?.name)
  .join(', ');
console.log(`  first dexes: ${preview}${all.length > 16 ? ', …' : ''}`);

// 2. Markets of interest
console.log('\nmarkets:');
for (const [label, re] of [
  ['GOLD', /^(GOLD|XAU)/],
  ['WTI', /^(WTI|CL|USOIL|BRENTOIL|OIL)$/],
  ['TSLA', /^TSLA$/],
] as const) {
  const found = (await venue.listMarkets({ includeDelisted: true })).filter((m) => m.dex !== '' && re.test(tickerOf(m.coin)));
  if (found.length === 0) console.log(`  ${ok(false)} ${label}: none on ${dexes.join(', ')}`);
  for (const m of found) {
    const mid = m.delisted ? undefined : await venue.mid(m);
    console.log(
      `  ${m.delisted ? '[--]  ' : ok(true)} ${label}: ${m.coin} asset=${m.assetId} szDecimals=${m.szDecimals}${m.delisted ? ' DELISTED' : ''}` +
        `${mid ? ` mid=${mid}` : m.delisted ? '' : ' (no mid: empty book?)'}`,
    );
  }
}

// 3. Playbook resolution
console.log('\nplaybook coins:');
for (const coin of ['xyz:GOLD', 'xyz:WTI', 'BTC', 'GOLD', 'WTI']) {
  try {
    const { market, fallback } = await venue.resolveCoin(coin);
    console.log(`  ${ok(true)} ${coin} → ${market.coin} (asset ${market.assetId})${fallback ? '  FALLBACK' : ''}`);
  } catch (err) {
    problems++;
    console.log(`  ${ok(false)} ${coin}: ${err instanceof UnknownMarketError ? err.message : String(err)}`);
  }
}

// 4. Account state (always the master address; the agent address has no state)
console.log('\naccount:');
if (!isAddress(config.HL_MASTER_ADDRESS)) {
  problems++;
  console.log(`  ${ok(false)} HL_MASTER_ADDRESS not set`);
} else {
  // HIP-3 dexes keep separate margin. Orders there need USDC moved into the dex, or an abstraction mode
  // (unifiedAccount / portfolioMargin) that pulls collateral automatically. Under those modes clearinghouseState
  // under-reports; check spot balances in the app instead.
  const abstraction = await info.userAbstraction({ user: config.HL_MASTER_ADDRESS });
  const autoCollateral = abstraction === 'unifiedAccount' || abstraction === 'portfolioMargin';
  console.log(`  abstraction: ${abstraction}${autoCollateral ? ' (HIP-3 collateral pulled automatically)' : ''}`);
  if (abstraction === 'unifiedAccount') {
    // Unified mode: one spot USDC balance backs the main dex and every HIP-3 dex. Per-dex accountValue reads ~0.
    const usdc = spotUsdc(await info.spotClearinghouseState({ user: config.HL_MASTER_ADDRESS }));
    const enough = usdc >= HL_UNIFIED_MIN_COLLATERAL_USD;
    if (!enough) problems++;
    console.log(
      `  ${ok(enough)} unified account: ${usdc.toFixed(2)} USDC shared across ${['main', ...dexes].join(' + ')}` +
        (enough ? '' : `  → deposit USDC (need at least $${HL_UNIFIED_MIN_COLLATERAL_USD} for a $10 leg at 5x)`),
    );
  }
  for (const dex of ['', ...dexes]) {
    const state = await info.clearinghouseState({ user: config.HL_MASTER_ADDRESS, ...(dex ? { dex } : {}) });
    const positions = state.assetPositions.map((p) => `${p.position.coin} ${p.position.szi}`).join(', ') || 'none';
    const funded = Number(state.withdrawable) >= 10 || autoCollateral;
    if (!funded) problems++;
    console.log(
      `  ${ok(funded)} ${dex || 'main'}: accountValue=${state.marginSummary.accountValue} withdrawable=${state.withdrawable} positions=${positions}` +
        (funded ? '' : dex ? '  → move USDC to this dex or enable unified account in the app' : '  → claim testnet USDC at /drip'),
    );
  }
  console.log(`  explorer: ${appUrl(config.HL_TESTNET)}/explorer/address/${config.HL_MASTER_ADDRESS}`);
}

console.log(`\n${problems === 0 ? 'all checks passed' : `${problems} item(s) need attention`}`);
process.exitCode = problems === 0 ? 0 : 1;
