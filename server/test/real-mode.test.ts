import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { toPlannedActions, type LlmDecision } from '../src/agent/decide.js';
import { defaultMemory, InMemoryMemoryStore } from '../src/agent/memory.js';
import { buildApp, createProviders } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { notConfiguredInfo, ProviderNotConfiguredError } from '../src/mode.js';
import { createPayments } from '../src/payments/index.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { MarketService, type WsLike } from '../src/market/service.js';

/**
 * Live mode (GHOSTY_MODE=live) with an empty env: no fakes, 503 not_configured, provider probes and market data
 * against mocked fetch. Nothing here touches the network.
 */

const LIVE_EMPTY = { GHOSTY_MODE: 'live' } as const;

/** Live config whose news/market/registry never reach the network in these tests. */
const liveApp = (env: Record<string, string> = {}) =>
  buildApp({
    config: loadConfig({ ...LIVE_EMPTY, ...env }),
    deps: { news: [] },
    providerRegistry: new ProviderRegistry({ config: loadConfig(LIVE_EMPTY), probes: [] }),
  });

// ---------------------------------------------------------------------------

describe('config modes', () => {
  it('live by default outside node --test overrides; live turns on keyless news and Ethos', () => {
    const live = loadConfig(LIVE_EMPTY);
    assert.equal(live.GHOSTY_MODE, 'live');
    assert.equal(live.NEWS_LIVE, true);
    assert.equal(live.ETHOS_ENABLED, true);
    assert.equal(live.MARKET_DATA_NETWORK, 'mainnet');
    assert.deepEqual(live.MARKET_WATCHLIST, ['BTC', 'ETH', 'SOL', 'xyz:GOLD', 'xyz:CL', 'xyz:TSLA', 'xyz:NVDA', 'xyz:SP500']);
    const test = loadConfig({});
    assert.equal(test.GHOSTY_MODE, 'test', 'npm test sets GHOSTY_MODE=test');
    assert.equal(test.NEWS_LIVE, false);
    assert.equal(test.ETHOS_ENABLED, false);
    assert.equal(loadConfig({ ...LIVE_EMPTY, NEWS_LIVE: 'false' }).NEWS_LIVE, false);
  });
});

describe('live-mode factory', () => {
  it('never returns a fake with an empty env', () => {
    const config = loadConfig(LIVE_EMPTY);
    const p = createProviders(config);
    const payments = createPayments(config);
    const slots: Record<string, unknown> = {
      stt: p.deps.stt,
      tts: p.deps.tts,
      decider: p.deps.decider,
      memory: p.deps.memory,
      episodes: p.deps.episodes,
      venue: p.deps.venue,
      spot: p.deps.spot,
      scorer: p.scorer,
      payer: payments.payer,
      ...Object.fromEntries(p.deps.news.map((n, i) => [`news${i}`, n])),
    };
    const fakeNames = /^(Fake|Tone|InMemory)/;
    for (const [slot, impl] of Object.entries(slots)) {
      const name = (impl as object).constructor.name;
      assert.doesNotMatch(name, fakeNames, `${slot} is ${name}`);
    }
    for (const slot of ['stt', 'tts', 'decider', 'memory', 'episodes', 'venue', 'spot', 'payer']) {
      assert.ok(notConfiguredInfo(slots[slot]), `${slot} should be NotConfigured`);
    }
    assert.deepEqual(notConfiguredInfo(p.deps.stt), { provider: 'groq', missingEnv: ['GROQ_API_KEY'] });
    assert.deepEqual(notConfiguredInfo(p.deps.venue)?.missingEnv, ['HL_MASTER_ADDRESS', 'HL_AGENT_PRIVATE_KEY']);
    assert.equal(payments.mode, 'not_configured');
    // Keyless sources are real: Ethos scorer and the RSS + Polymarket aggregator.
    assert.equal((p.scorer as object).constructor.name, 'EthosScorer');
    assert.ok(p.aggregator, 'NEWS_LIVE defaults to true in live mode');
  });

  it('with NEWS_LIVE and ETHOS off, live mode has no news providers and a NotConfigured scorer', () => {
    const p = createProviders(loadConfig({ ...LIVE_EMPTY, NEWS_LIVE: 'false', ETHOS_ENABLED: 'false' }));
    assert.deepEqual(p.deps.news, []);
    assert.equal(notConfiguredInfo(p.scorer)?.provider, 'ethos');
  });
});

describe('NotConfigured → 503 not_configured', () => {
  it('maps ProviderNotConfiguredError to 503 with provider and missingEnv', async () => {
    const app = buildApp({
      config: loadConfig({}),
      deps: {
        stt: {
          transcribe: async () => {
            throw new ProviderNotConfiguredError({ provider: 'groq', missingEnv: ['GROQ_API_KEY'] });
          },
        },
        decider: {
          decide: async () => {
            throw new ProviderNotConfiguredError({ provider: 'x', missingEnv: ['X_KEY'] });
          },
        },
      },
    });
    const res = await app.inject({ method: 'POST', url: '/voice/text', payload: { text: 'hi' } });
    assert.equal(res.statusCode, 503);
    const body = res.json() as Record<string, unknown>;
    assert.deepEqual([body.error, body.provider, body.missingEnv], ['not_configured', 'x', ['X_KEY']]);
    assert.match(String(body.message), /x is not configured: set X_KEY/);
    await app.close();
  });

  it('live /voice without STT/TTS keys answers 503 not_configured before anything else', async () => {
    const app = liveApp();
    const res = await app.inject({ method: 'POST', url: '/voice', headers: { 'content-type': 'audio/wav' }, payload: Buffer.alloc(64) });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error, 'not_configured');
    assert.equal(res.json().provider, 'groq');
    assert.deepEqual(res.json().missingEnv, ['GROQ_API_KEY']);
    await app.close();
  });

  it('live decisions without OG_API_KEY are a safe-stop, never a fake decision', async () => {
    const app = liveApp();
    assert.equal((await app.inject({ method: 'GET', url: '/health' })).json().safeStop, true);
    const res = await app.inject({ method: 'POST', url: '/voice/text', payload: { text: 'war?' } });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error, 'brain_offline');
    // With safe-stop bypassed the decider itself refuses and names the missing key (memory swapped for an
    // in-process store so the decider is what answers; without it the 0G Storage slot answers not_configured).
    const bypass = buildApp({
      config: loadConfig({ ...LIVE_EMPTY, SAFE_STOP_ENABLED: 'false' }),
      deps: { news: [], memory: new InMemoryMemoryStore() },
      providerRegistry: new ProviderRegistry({ config: loadConfig(LIVE_EMPTY), probes: [] }),
    });
    const refused = await bypass.inject({ method: 'POST', url: '/news/inject', payload: { title: 'Missile strike near Hormuz' } });
    assert.equal(refused.statusCode, 503);
    assert.deepEqual(
      { error: refused.json().error, reason: refused.json().reason, missingEnv: refused.json().missingEnv },
      { error: 'brain_offline', reason: 'not_configured', missingEnv: ['OG_API_KEY'] },
    );
    const state = (await bypass.inject({ method: 'GET', url: '/state' })).json();
    assert.equal(state.lastDecision, null);
    assert.equal(state.news[0].source, 'manual', 'injected headlines are labelled manual');
    await app.close();
    await bypass.close();
  });

  it('live /sim/pay-signal and /button confirm without keys answer 503 not_configured', async () => {
    const app = liveApp({ SAFE_STOP_ENABLED: 'false' });
    const pay = await app.inject({ method: 'POST', url: '/sim/pay-signal' });
    assert.equal(pay.statusCode, 503);
    assert.equal(pay.json().provider, 'hedera-payer');
    assert.deepEqual(pay.json().missingEnv, ['HEDERA_ACCOUNT_ID', 'HEDERA_PRIVATE_KEY']);
    const press = await app.inject({ method: 'POST', url: '/button', payload: { action: 'confirm' } });
    assert.equal(press.statusCode, 503);
    assert.equal(press.json().provider, 'hyperliquid');
    const status = (await app.inject({ method: 'GET', url: '/x402/status' })).json();
    assert.equal(status.mode, 'not_configured');
    await app.close();
  });
});

// ---------------------------------------------------------------------------

type Route = (url: string, init: RequestInit) => { status: number; body: unknown } | Error | undefined;

function mockFetch(route: Route): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push(url);
    const hit = route(url, init);
    if (hit instanceof Error) throw hit;
    const { status, body } = hit ?? { status: 404, body: { error: 'not mocked' } };
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

const AGENT_KEY = `0x${'11'.repeat(32)}`;
const AGENT_ADDR = privateKeyToAccount(AGENT_KEY as `0x${string}`).address;
const MASTER = `0x${'ab'.repeat(20)}`;

describe('provider registry', () => {
  const env = {
    GHOSTY_MODE: 'live',
    NEWS_LIVE: 'false',
    ETHOS_ENABLED: 'false',
    GROQ_API_KEY: 'gsk_secret_groq',
    ELEVENLABS_API_KEY: 'sk_secret_eleven',
    HL_MASTER_ADDRESS: MASTER,
    HL_AGENT_PRIVATE_KEY: AGENT_KEY,
  };

  const route: Route = (url, init) => {
    if (url === 'https://api.groq.com/openai/v1/models') return { status: 200, body: { data: [{ id: 'whisper-large-v3-turbo' }] } };
    if (url.startsWith('https://api.elevenlabs.io/')) return { status: 401, body: { detail: 'invalid_api_key' } };
    if (url.endsWith('/v1/models') && url.includes('router')) return new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    if (url === 'https://api.testnet.blocky402.com/supported') return { status: 200, body: { kinds: [{ network: 'hedera:testnet' }] } };
    if (url === 'https://api.hyperliquid-testnet.xyz/info') {
      const body = JSON.parse(String(init.body)) as { type: string; dex?: string };
      if (body.type === 'clearinghouseState') return { status: 200, body: { marginSummary: { accountValue: body.dex === 'xyz' ? '0.0' : '25.5' } } };
      if (body.type === 'extraAgents') return { status: 200, body: [{ address: AGENT_ADDR, name: 'ghosty' }] };
    }
    return undefined;
  };

  it('reports live, degraded, offline and not_configured from real-shaped responses, without secrets', async () => {
    const { fetch, calls } = mockFetch(route);
    const registry = new ProviderRegistry({ config: loadConfig(env), fetch });
    const status = await registry.status();
    const by = Object.fromEntries(status.providers.map((p) => [p.id, p]));
    assert.equal(status.mode, 'live');

    assert.equal(by.groq?.state, 'live');
    assert.equal(by.groq?.track, 'audio');
    assert.ok(by.groq?.lastOkAt);
    assert.equal(by.elevenlabs?.state, 'offline');
    assert.match(by.elevenlabs?.detail ?? '', /rejected the key \(401\)/);
    assert.equal(by['0g-router']?.state, 'not_configured');
    assert.deepEqual(by['0g-router']?.missingEnv, ['OG_API_KEY']);
    assert.match(by['0g-router']?.detail ?? '', /ECONNRESET/);
    assert.equal(by['x402-facilitator']?.state, 'live');
    assert.equal(by.hyperliquid?.state, 'degraded', 'xyz margin 0');
    assert.match(by.hyperliquid?.detail ?? '', /main \$25\.50, xyz \$0\.00; xyz dex margin is 0/);
    assert.equal(by['hedera-payer']?.state, 'not_configured');
    assert.deepEqual(by['hedera-payer']?.missingEnv, ['HEDERA_ACCOUNT_ID', 'HEDERA_PRIVATE_KEY']);
    assert.equal(by.rss?.state, 'not_configured');
    assert.equal(by.ethos?.state, 'not_configured');
    for (const p of status.providers) assert.ok(typeof p.latencyMs === 'number', p.id);

    const text = JSON.stringify(status);
    for (const secret of ['gsk_secret_groq', 'sk_secret_eleven', AGENT_KEY.slice(2)]) assert.ok(!text.includes(secret), secret);

    // Cached for 30 s: a second call does not probe again.
    const n = calls.length;
    await registry.status();
    assert.equal(calls.length, n);
  });

  it('points mainnet setups at mainnet funding, not testnet faucets', async () => {
    const { fetch } = mockFetch(() => undefined);
    const mainnet = { ...env, HEDERA_NETWORK: 'mainnet', OG_RPC_URL: 'https://evmrpc.0g.ai', HL_TESTNET: 'false' };
    const status = await new ProviderRegistry({ config: loadConfig(mainnet), fetch }).status();
    const by = Object.fromEntries(status.providers.map((p) => [p.id, p]));
    for (const id of ['hedera-payer', 'hedera-merchant', '0g-storage']) {
      const hint = by[id]?.nextAction ?? '';
      assert.match(hint, /mainnet/, id);
      assert.doesNotMatch(hint, /testnet|faucet/i, id);
    }
    const testnet = await new ProviderRegistry({ config: loadConfig(env), fetch }).status();
    const tby = Object.fromEntries(testnet.providers.map((p) => [p.id, p]));
    assert.match(tby['hedera-payer']?.nextAction ?? '', /testnet account at https:\/\/portal\.hedera\.com/);
    assert.match(tby['0g-storage']?.nextAction ?? '', /faucet\.0g\.ai/);
  });

  it('times out a hanging probe at the deadline and emits changes only', async () => {
    const hanging = mockFetch(() => undefined);
    const probes = [
      {
        id: 'slow',
        label: 'Slow',
        track: 'data' as const,
        run: (ctx: { signal: AbortSignal }) =>
          new Promise<never>((_, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('aborted')))),
      },
    ];
    const registry = new ProviderRegistry({ config: loadConfig(env), fetch: hanging.fetch, probes, timeoutMs: 20 });
    const seen: string[][] = [];
    registry.onChange((_, changed) => seen.push(changed.map((p) => `${p.id}=${p.state}`)));
    const first = await registry.refresh();
    assert.equal(first.providers[0]?.state, 'offline');
    assert.equal(first.providers[0]?.detail, 'timed out');
    await registry.refresh();
    assert.deepEqual(seen, [['slow=offline']], 'second run had no state change');
  });

  it('GET /providers/status serves the registry', async () => {
    const { fetch } = mockFetch(route);
    const app = buildApp({ config: loadConfig({}), providerRegistry: new ProviderRegistry({ config: loadConfig(env), fetch }) });
    const res = await app.inject({ method: 'GET', url: '/providers/status' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().providers.find((p: { id: string }) => p.id === 'groq').state, 'live');
    await app.close();
  });
});

// ---------------------------------------------------------------------------

const MAIN_META = [
  { universe: [{ name: 'BTC' }, { name: 'ETH' }, { name: 'SOL' }, { name: 'OLD', isDelisted: true }] },
  [
    { prevDayPx: '80000.0', funding: '0.0000125', openInterest: '100.0', dayNtlVlm: '5000000.5', midPx: '79000.0' },
    { prevDayPx: '4000.0', funding: '0.00001', openInterest: '2000.0', dayNtlVlm: '1000000.0', midPx: '4100.0' },
    { prevDayPx: '200.0', funding: '-0.00002', openInterest: '50000.0', dayNtlVlm: '300000.0', midPx: '190.0' },
    { prevDayPx: '1.0', funding: '0', openInterest: '0', dayNtlVlm: '0', midPx: null },
  ],
];
const XYZ_META = [
  { universe: [{ name: 'xyz:GOLD' }, { name: 'xyz:CL' }] },
  [
    { prevDayPx: '4000.0', funding: '0.000005', openInterest: '10.0', dayNtlVlm: '2000000.0', midPx: '4040.0' },
    { prevDayPx: '90.0', funding: '0.00001', openInterest: '500.0', dayNtlVlm: '100000.0', midPx: '91.0' },
  ],
];

function hlRoute(mids: { main: Record<string, string>; xyz: Record<string, string> }): Route {
  return (url, init) => {
    if (url !== 'https://api.hyperliquid.xyz/info') return undefined;
    const body = JSON.parse(String(init.body)) as { type: string; dex?: string; req?: { coin: string } };
    if (body.type === 'metaAndAssetCtxs') return { status: 200, body: body.dex === 'xyz' ? XYZ_META : MAIN_META };
    if (body.type === 'allMids') return { status: 200, body: body.dex === 'xyz' ? mids.xyz : mids.main };
    if (body.type === 'candleSnapshot') {
      return {
        status: 200,
        body: [
          { t: 1000, T: 1999, s: body.req?.coin, i: '1h', o: '1.0', c: '2.0', h: '2.5', l: '0.5', v: '10.0', n: 3 },
          { t: 2000, T: 2999, s: body.req?.coin, i: '1h', o: '2.0', c: '1.5', h: '2.1', l: '1.4', v: '4.0', n: 1 },
        ],
      };
    }
    return undefined;
  };
}

const marketService = (fetchImpl: typeof fetch) =>
  new MarketService({
    network: 'mainnet',
    executionNetwork: 'testnet',
    watchlist: ['BTC', 'ETH', 'SOL', 'xyz:GOLD', 'xyz:CL', 'xyz:SPX', 'OLD'],
    fetch: fetchImpl,
    webSocket: null,
  });

describe('market service', () => {
  it('resolves the watchlist over main + xyz, computes change24h, reports missing coins', async () => {
    const { fetch, calls } = mockFetch(hlRoute({ main: { BTC: '84000.0', ETH: '3900.0', SOL: '190.0' }, xyz: { 'xyz:GOLD': '4100.0', 'xyz:CL': '91.0' } }));
    const market = marketService(fetch);
    assert.deepEqual(market.dexes, ['', 'xyz']);
    const snap = await market.snapshot();
    assert.equal(snap.network, 'mainnet');
    assert.equal(snap.executionNetwork, 'testnet');
    assert.deepEqual(snap.missing, ['xyz:SPX', 'OLD'], 'missing and delisted coins are reported, not faked');
    assert.deepEqual(
      snap.assets.map((a) => a.coin),
      ['BTC', 'ETH', 'SOL', 'xyz:GOLD', 'xyz:CL'],
    );
    const btc = snap.assets[0];
    assert.equal(btc?.mid, 84000);
    assert.equal(btc?.prevDayPx, 80000);
    assert.equal(btc?.change24hPct, 5);
    assert.equal(btc?.funding, 0.0000125);
    assert.equal(btc?.openInterest, 100);
    assert.equal(btc?.openInterestUsd, 8_400_000);
    assert.equal(btc?.volume24h, 5_000_001);
    assert.equal(btc?.label, 'Bitcoin');
    const eth = snap.assets[1];
    assert.equal(eth?.change24hPct, -2.5);
    const gold = snap.assets.find((a) => a.coin === 'xyz:GOLD');
    assert.equal(gold?.dex, 'xyz');
    assert.equal(gold?.label, 'Gold');
    assert.equal(gold?.change24hPct, 2.5);
    // metaAndAssetCtxs and allMids once per dex.
    assert.equal(calls.length, 4);
  });

  it('falls back to the context midPx when allMids fails', async () => {
    const base = hlRoute({ main: {}, xyz: {} });
    const { fetch } = mockFetch((url, init) =>
      JSON.parse(String(init.body)).type === 'allMids' ? { status: 500, body: 'down' } : base(url, init),
    );
    const snap = await marketService(fetch).snapshot();
    assert.equal(snap.assets[0]?.mid, 79000);
    assert.equal(snap.assets[0]?.change24hPct, -1.25);
  });

  it('streams websocket allMids per dex and throttles mids events', async () => {
    const { fetch } = mockFetch(hlRoute({ main: {}, xyz: {} }));
    const sockets: Array<WsLike & { sent: string[] }> = [];
    const factory = () => {
      const ws = { onopen: null, onmessage: null, onclose: null, onerror: null, sent: [] as string[], send(d: string) { this.sent.push(d); }, close() {} };
      sockets.push(ws);
      return ws;
    };
    const market = new MarketService({ network: 'mainnet', executionNetwork: 'testnet', watchlist: ['BTC', 'xyz:GOLD'], fetch, webSocket: factory });
    const events: Array<Record<string, number>> = [];
    market.onMids((e) => events.push(e.mids));
    market.start();
    try {
      const ws = sockets[0];
      assert.ok(ws);
      ws.onopen?.({});
      assert.deepEqual(
        ws.sent.map((s) => JSON.parse(s).subscription),
        [{ type: 'allMids' }, { type: 'allMids', dex: 'xyz' }],
      );
      ws.onmessage?.({ data: JSON.stringify({ channel: 'allMids', data: { mids: { BTC: '81000', ETH: '1' } } }) });
      ws.onmessage?.({ data: JSON.stringify({ channel: 'allMids', data: { dex: 'xyz', mids: { 'xyz:GOLD': '4050' } } }) });
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(events.length, 1, 'two messages in one tick → one throttled event');
      assert.deepEqual(events[0], { BTC: 81000, 'xyz:GOLD': 4050 });
      const snap = await market.snapshot();
      assert.equal(snap.source, 'ws');
      assert.equal(snap.assets.find((a) => a.coin === 'BTC')?.mid, 81000);
    } finally {
      market.stop();
    }
  });

  it('GET /market/snapshot and /market/history', async () => {
    const { fetch, calls } = mockFetch(hlRoute({ main: { BTC: '84000.0' }, xyz: { 'xyz:GOLD': '4100.0' } }));
    const app = buildApp({ config: loadConfig({}), market: marketService(fetch) });
    const snap = await app.inject({ method: 'GET', url: '/market/snapshot' });
    assert.equal(snap.statusCode, 200);
    assert.equal(snap.json().assets[0].coin, 'BTC');

    const hist = await app.inject({ method: 'GET', url: '/market/history?coin=xyz:GOLD&interval=1h&hours=24' });
    assert.equal(hist.statusCode, 200);
    assert.deepEqual(hist.json().candles[0], { t: 1000, o: 1, h: 2.5, l: 0.5, c: 2, v: 10, n: 3 });
    const candleCall = calls.at(-1);
    assert.equal(candleCall, 'https://api.hyperliquid.xyz/info');

    assert.equal((await app.inject({ method: 'GET', url: '/market/history?coin=xyz:SPX' })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/market/history?coin=BTC&interval=7m' })).statusCode, 400);
    await app.close();
  });
});

// ---------------------------------------------------------------------------

const llm = (legs: Array<[string, 'long' | 'short', number]>): LlmDecision => ({
  signal: 'geopolitical_shock',
  confidence: 0.8,
  rationale: 'test',
  suggestedActions: legs.map(([market, side, sizePct]) => ({ venue: 'hyperliquid', market, side, sizePct })),
});

describe('0G decider leg clamping', () => {
  const memory = (riskProfile: 'conservative' | 'balanced' | 'aggressive') => ({
    ...defaultMemory(),
    riskProfile,
    preferences: { watchlist: ['BTC', 'ETH', 'xyz:GOLD', 'xyz:CL'] },
  });
  const sizes = (r: ReturnType<typeof toPlannedActions>) => r.actions.map((a) => [a.coin, a.sizeUsd]);

  it('keeps legs that clear $10 as proposed', () => {
    const r = toPlannedActions(llm([['xyz:GOLD', 'long', 40], ['xyz:CL', 'long', 30], ['BTC', 'short', 30]]), memory('aggressive'), 100);
    assert.deepEqual(sizes(r), [['xyz:GOLD', 40], ['xyz:CL', 30], ['BTC', 30]]);
  });

  it('drops the smallest legs and re-splits like the playbook ($25 cap, balanced → one $12.50 leg)', () => {
    const r = toPlannedActions(llm([['xyz:GOLD', 'long', 40], ['xyz:CL', 'long', 30], ['BTC', 'short', 30]]), memory('balanced'), 25);
    assert.deepEqual(sizes(r), [['xyz:GOLD', 12.5]]);
    assert.deepEqual(r.dropped.map((d) => d.market), ['xyz:CL', 'BTC']);
  });

  it('raises a lone short leg to $10 only within MAX_TRADE_USD', () => {
    assert.deepEqual(sizes(toPlannedActions(llm([['BTC', 'short', 20]]), memory('aggressive'), 25)), [['BTC', 10]]);
    assert.deepEqual(sizes(toPlannedActions(llm([['BTC', 'short', 100]]), memory('aggressive'), 8)), []);
  });

  it('never exceeds MAX_TRADE_USD, even when the model over-allocates', () => {
    for (const cap of [10, 12, 25, 40, 100]) {
      for (const risk of ['conservative', 'balanced', 'aggressive'] as const) {
        const r = toPlannedActions(llm([['xyz:GOLD', 'long', 90], ['BTC', 'short', 80], ['ETH', 'short', 5]]), memory(risk), cap);
        const total = r.actions.reduce((s, a) => s + a.sizeUsd, 0);
        assert.ok(total <= cap, `${risk} cap ${cap}: total ${total}`);
        assert.ok(r.actions.every((a) => a.sizeUsd >= 10), `${risk} cap ${cap}: every leg ≥ $10`);
      }
    }
  });
});

// ---------------------------------------------------------------------------

describe('terminal static serving', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghosty-terminal-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Ghosty terminal</title><div id="root"></div>');
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("terminal")');
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('serves dist at / with an SPA fallback and keeps API routes and /sim', async () => {
    const app = buildApp({ config: loadConfig({ TERMINAL_DIST: dir }) });
    const root = await app.inject({ method: 'GET', url: '/' });
    assert.equal(root.statusCode, 200);
    assert.match(root.body, /Ghosty terminal/);
    const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });
    assert.equal(asset.statusCode, 200);
    assert.match(String(asset.headers['content-type']), /javascript/);
    const deep = await app.inject({ method: 'GET', url: '/markets/xyz:GOLD', headers: { accept: 'text/html,application/xhtml+xml' } });
    assert.equal(deep.statusCode, 200);
    assert.match(deep.body, /Ghosty terminal/);
    const missingJson = await app.inject({ method: 'GET', url: '/nope', headers: { accept: 'application/json' } });
    assert.equal(missingJson.statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/health' })).json().ok, true);
    const sim = await app.inject({ method: 'GET', url: '/sim' });
    assert.equal(sim.statusCode, 200);
    assert.match(sim.body, /<html/i);
    await app.close();
  });

  it('does not serve / when the dist has no index.html', async () => {
    const app = buildApp({ config: loadConfig({ TERMINAL_DIST: join(dir, 'assets') }) });
    assert.equal((await app.inject({ method: 'GET', url: '/' })).statusCode, 404);
    await app.close();
  });

  it('answers CORS for the Vite dev server in live mode only', async () => {
    const live = liveApp();
    const pre = await live.inject({
      method: 'OPTIONS',
      url: '/market/snapshot',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'GET' },
    });
    assert.equal(pre.statusCode, 204);
    assert.equal(pre.headers['access-control-allow-origin'], 'http://localhost:5173');
    const health = await live.inject({ method: 'GET', url: '/health', headers: { origin: 'http://localhost:5173' } });
    assert.equal(health.headers['access-control-allow-origin'], 'http://localhost:5173');
    const other = await live.inject({ method: 'GET', url: '/health', headers: { origin: 'https://evil.example' } });
    assert.equal(other.headers['access-control-allow-origin'], undefined);
    await live.close();

    const test = buildApp({ config: loadConfig({}) });
    const res = await test.inject({ method: 'GET', url: '/health', headers: { origin: 'http://localhost:5173' } });
    assert.equal(res.headers['access-control-allow-origin'], undefined);
    await test.close();
  });
});
