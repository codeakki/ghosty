import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Decider, DecideInput, Decision } from '../src/agent/decide.js';
import { BrainOfflineError } from '../src/agent/decide.js';
import { InMemoryMemoryStore } from '../src/agent/memory.js';
import type { BlobStore } from '../src/agent/storage.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Executor } from '../src/execution/executor.js';
import type { MarketOrderRequest, OrderResult, PerpVenue } from '../src/execution/hyperliquid.js';
import { NotConfiguredMemory } from '../src/notConfigured.js';
import { priceAt, type CandleSet, type SimCandle } from '../src/sim/candles.js';
import { realDurationMs, SimEngine, simAdvanceMs, type SimEventType } from '../src/sim/engine.js';
import { replayChain, SimEpisodeLog } from '../src/sim/episodes.js';
import { holdBaselinePnl, PaperVenue } from '../src/sim/paperVenue.js';
import { loadScenarios, type Scenario } from '../src/sim/scenarios.js';
import type { SwapRequest, SwapResult } from '../src/wallet/uniswap.js';

const H = 3_600_000;
const START = Date.parse('2025-01-01T00:00:00Z');

/** 4 hours, 2 markets. BTC 100 → 90 (falls), ETH flat 10. Two headlines: one benign, one shock at +2h. */
const SCENARIO: Scenario = {
  id: 'test-shock',
  title: 'test',
  description: 'synthetic',
  start: '2025-01-01T00:00:00Z',
  end: '2025-01-01T04:00:00Z',
  interval: '1h',
  markets: [
    { coin: 'BTC', source: 'binance', symbol: 'BTCUSDT' },
    { coin: 'ETH', source: 'binance', symbol: 'ETHUSDT' },
  ],
  headlines: [
    { ts: '2025-01-01T01:00:00Z', title: 'Ether ETF inflows steady', source: 'Test', url: 'https://example.com/a' },
    { ts: '2025-01-01T02:00:00Z', title: 'Missile strike reported near the Strait', source: 'Reuters', url: 'https://example.com/b', handle: 'Reuters' },
  ],
  sources: [],
};

const btc: SimCandle[] = [100, 100, 100, 95, 90].map((c, i) => ({ t: START + (i - 1) * H, o: i === 0 ? 100 : [100, 100, 100, 95, 90][i - 1]!, h: 101, l: 89, c }));
const CANDLES: CandleSet = {
  BTC: btc,
  ETH: [0, 1, 2, 3, 4].map((i) => ({ t: START + (i - 1) * H, o: 10, h: 10, l: 10, c: 10 })),
};
const fakeCandles = async () => structuredClone(CANDLES);

class StubDecider implements Decider {
  calls: DecideInput[] = [];
  constructor(private readonly behaviour: 'short' | 'offline' = 'short') {}
  async decide(input: DecideInput): Promise<Decision> {
    this.calls.push(input);
    if (this.behaviour === 'offline') throw new BrainOfflineError('router down', 'network_error', { requestId: 'rq-fail' });
    return {
      signal: 'geopolitical_shock',
      confidence: 0.8,
      rationale: 'Shock. Short BTC. Press to confirm.',
      requestId: `0g-mock-${this.calls.length}`,
      suggestedActions: [{ venue: 'hyperliquid', kind: 'perp', coin: 'BTC', side: 'short', sizeUsd: 12.5, reason: 'test' }],
      newsIds: input.news.map((n) => n.id),
    };
  }
}

/** Mocked 0G Storage: content-addressed in memory. */
class MemBlobStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  uploads = 0;
  async upload(data: Uint8Array): Promise<{ rootHash: string; txHash: string }> {
    this.uploads++;
    const rootHash = `0x${createHash('sha256').update(data).digest('hex')}`;
    this.blobs.set(rootHash, data);
    return { rootHash, txHash: `0xtx${this.uploads}` };
  }
  async download(rootHash: string): Promise<Uint8Array> {
    const b = this.blobs.get(rootHash);
    if (!b) throw new Error('not found');
    return b;
  }
}

/** Real-executor stand-ins that record any call: a sim must never reach them. */
class SpyVenue implements PerpVenue {
  calls: MarketOrderRequest[] = [];
  async placeMarketOrder(req: MarketOrderRequest): Promise<OrderResult> {
    this.calls.push(req);
    return { orderId: 'REAL', coin: req.coin, isBuy: req.isBuy, sizeUsd: req.sizeUsd, status: 'filled' };
  }
  async listMarkets() {
    return [];
  }
}
class SpySpot {
  calls: SwapRequest[] = [];
  async quoteAndSwap(req: SwapRequest): Promise<SwapResult> {
    this.calls.push(req);
    throw new Error('real swap attempted');
  }
}

const tmp = () => mkdtempSync(join(tmpdir(), 'ghosty-sim-'));

function engine(opts: { decider?: Decider; store?: BlobStore; memory?: InMemoryMemoryStore | NotConfiguredMemory; online?: boolean } = {}) {
  const events: Array<{ type: SimEventType; data: Record<string, unknown> }> = [];
  const episodes = new SimEpisodeLog({ dataDir: tmp(), store: opts.store });
  const decider = opts.decider ?? new StubDecider();
  const eng = new SimEngine({
    decider,
    memory: opts.memory ?? new InMemoryMemoryStore(),
    episodes,
    loadCandles: fakeCandles,
    scenarios: () => [SCENARIO],
    brainOnline: async () => opts.online ?? true,
    publish: (type, data) => events.push({ type, data: data as Record<string, unknown> }),
    maxTradeUsd: 25,
    slippageBps: 10,
    autoTick: false,
  });
  return { eng, events, episodes, decider };
}

describe('sim clock', () => {
  it('compresses market time by speed', () => {
    assert.equal(simAdvanceMs(10_000, 360), H); // 1 h per 10 s at the default speed
    assert.equal(simAdvanceMs(1_000, 1800), 30 * 60_000);
    assert.equal(realDurationMs(4 * H, 1800), 8_000);
    assert.equal(simAdvanceMs(-5, 360), 0);
  });

  it('interpolates the historical mid inside a candle', () => {
    const c = [{ t: 0, o: 100, h: 0, l: 0, c: 110 }];
    assert.equal(priceAt(c, 0, 1000), 100);
    assert.equal(priceAt(c, 500, 1000), 105);
    assert.equal(priceAt(c, 5000, 1000), 110);
    assert.equal(priceAt([], 0, 1000), null);
  });
});

describe('paper venue', () => {
  it('fills at the historical mid ± slippage and marks P&L to historical prices', async () => {
    let px = 100;
    const v = new PaperVenue({ price: () => px, now: () => START, slippageBps: 10 });
    const o = await v.placeMarketOrder({ coin: 'BTC', isBuy: false, sizeUsd: 99.9 });
    assert.equal(o.status, 'simulated');
    assert.equal(o.avgPx, 99.9); // sell at mid − 10 bps
    assert.ok(Math.abs(o.filled! - 1) < 1e-12);
    px = 90;
    assert.equal(v.snapshot().unrealizedPnlUsd, 9.9); // short 1 BTC from 99.9 → 90
    await v.placeMarketOrder({ coin: 'BTC', isBuy: true, sizeUsd: 90.09 / 2 }); // buy back half at 90.09
    const s = v.snapshot();
    assert.ok(Math.abs(s.realizedPnlUsd - 0.5 * (99.9 - 90.09)) < 1e-3);
    assert.ok(Math.abs(s.positions[0]!.size + 0.5) < 1e-9);
    assert.equal((await v.placeMarketOrder({ coin: 'GOLD', isBuy: true, sizeUsd: 10 })).status, 'simulated');
  });

  it('rejects coins without a historical price', async () => {
    const v = new PaperVenue({ price: () => null, now: () => START });
    assert.equal((await v.placeMarketOrder({ coin: 'xyz:WTI', isBuy: true, sizeUsd: 10 })).status, 'rejected');
  });

  it('computes the hold baseline', () => {
    assert.equal(holdBaselinePnl({ BTC: 100, ETH: 10 }, (c) => (c === 'BTC' ? 90 : 10), 20), -1);
  });
});

describe('sim engine', () => {
  it('schedules headlines at their sim times, decides on the shock, auto-pauses, fills on paper', async () => {
    const { eng, events, decider } = engine();
    const { runId } = await eng.start({ scenarioId: 'test-shock', speed: 360 });
    await eng.step(5_000); // +30 min
    assert.equal(eng.status().simTime, '2025-01-01T00:30:00.000Z');
    await eng.step(60_000); // would be +6 h, clamps at the first headline (01:00)
    assert.equal(eng.status().simTime, '2025-01-01T01:00:00.000Z');
    assert.equal(eng.status().decisions[0]!.skipped, 'no_shock');
    assert.equal((decider as StubDecider).calls.length, 0);
    await eng.step(60_000); // clamps at 02:00, the shock → real decider call
    let st = eng.status();
    assert.equal(st.simTime, '2025-01-01T02:00:00.000Z');
    assert.equal((decider as StubDecider).calls.length, 1);
    assert.equal(st.decisions[1]!.requestId, '0g-mock-1');
    assert.equal(st.status, 'paused');
    assert.equal(st.pauseReason, 'awaiting_press');
    assert.equal(st.pending?.requestId, '0g-mock-1');
    // Sim memory: watchlist narrowed to the scenario markets.
    assert.deepEqual((decider as StubDecider).calls[0]!.memory.preferences.watchlist, ['BTC', 'ETH']);

    await eng.step(60_000); // paused: clock does not move
    assert.equal(eng.status().simTime, '2025-01-01T02:00:00.000Z');

    const press = await eng.press('confirm');
    assert.equal(press.paper, true);
    assert.equal(press.orders[0]!.status, 'simulated');
    assert.equal(press.orders[0]!.avgPx, 99.9); // BTC mid 100 at 02:00, short − 10 bps
    st = eng.status();
    assert.equal(st.status, 'running');
    await eng.runUntilIdle();
    st = eng.status();
    assert.equal(st.status, 'done');
    assert.equal(st.progress, 1);
    // Short $12.50 from 99.9, BTC closes at 90.
    assert.ok(Math.abs(st.pnlUsd - (12.5 / 99.9) * 9.9) < 1e-3, `pnl ${st.pnlUsd}`);
    assert.equal(st.baselinePnlUsd, -1.25); // $25 hold: half BTC −10 %, half ETH flat
    assert.deepEqual(
      st.episodes.map((e) => [e.outcome, e.storage]),
      [
        ['proposed', 'local'],
        ['executed', 'local'],
      ],
    );
    // Every event the run produced is tagged.
    assert.ok(events.length > 5);
    for (const e of events) {
      assert.equal(e.data.sim, true, `${e.type} untagged`);
      if (e.data.runId !== null) assert.equal(e.data.runId, runId);
    }
    assert.ok(events.some((e) => e.type === 'market' && (e.data.mids as Record<string, number>).BTC !== undefined));
    assert.ok(events.some((e) => e.type === 'alert'));
  });

  it('safe-stop applies in sim: no fake decision when 0G is unreachable', async () => {
    const { eng } = engine({ decider: new StubDecider('offline') });
    await eng.start({ scenarioId: 'test-shock', autoPauseOnAlert: true });
    await eng.runUntilIdle();
    const st = eng.status();
    assert.equal(st.status, 'done');
    assert.equal(st.decisions[1]!.skipped, 'brain_offline');
    assert.equal(st.decisions[1]!.requestId, 'rq-fail');
    assert.equal(st.fills.length, 0);
    assert.equal(st.episodes.length, 0);

    const off = engine({ online: false });
    await off.eng.start({ scenarioId: 'test-shock' });
    await off.eng.runUntilIdle();
    assert.equal(off.eng.status().decisions[1]!.skipped, 'brain_offline');
    assert.equal((off.decider as StubDecider).calls.length, 0);
  });

  it('works without OG_PRIVATE_KEY: default memory snapshot, labelled; local episodes', async () => {
    const { eng, episodes } = engine({ memory: new NotConfiguredMemory() });
    await eng.start({ scenarioId: 'test-shock', autoPauseOnAlert: false });
    await eng.runUntilIdle();
    const st = eng.status();
    assert.match(st.memory!, /default snapshot: 0G memory not configured/);
    assert.equal(st.storage, 'local');
    assert.equal(st.decisions[1]!.requestId, '0g-mock-1');
    assert.equal(st.pending?.requestId, '0g-mock-1'); // no auto-pause: still pending, clock ran on
    const lines = readFileSync(episodes.path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].storage, 'local');
    assert.match(lines[0].rootHash, /^local:[0-9a-f]{64}$/);
    assert.equal(lines[0].body.sim, true);
  });
});

describe('episode replay', () => {
  const input = (requestId: string) => ({
    runId: 'run-1',
    scenarioId: 's',
    simTime: '2025-01-01T00:00:00Z',
    requestId,
    newsIds: [],
    decision: { signal: 'none' as const, confidence: 0, rationale: 'x' },
    actions: [],
    orders: [],
    outcome: 'proposed' as const,
    memory: 'default',
  });

  it('walks a local chain back through prevRoot, oldest → newest', async () => {
    const log = new SimEpisodeLog({ dataDir: tmp() });
    for (const id of ['a', 'b', 'c']) await log.append(input(id));
    const head = log.list().at(-1)!.rootHash;
    const r = await replayChain({ from: head, limit: 20, simLog: log, storagescan: 'https://scan' });
    assert.deepEqual(r.episodes.map((e) => e.requestId), ['a', 'b', 'c']);
    assert.equal(r.episodes[0]!.prevRoot, null);
    assert.equal(r.episodes[0]!.storagescan, null);
    assert.equal(r.stoppedAt, null);
    const limited = await replayChain({ from: head, limit: 2, simLog: log, storagescan: 'https://scan' });
    assert.deepEqual(limited.episodes.map((e) => e.requestId), ['b', 'c']);
    assert.equal(limited.stoppedAt, log.list()[0]!.rootHash);
  });

  it('walks a 0G chain by downloading each root (mocked 0G), including a live batch body', async () => {
    const store = new MemBlobStore();
    // A live batch blob at the start of the chain.
    const batch = await store.upload(
      Buffer.from(JSON.stringify({ v: 1, kind: 'ghosty.episode-batch', prevRoot: null, episodes: [{ kind: 'ghosty.episode', requestId: 'live-1', seq: 1 }, { kind: 'ghosty.episode', requestId: 'live-2', seq: 2 }] })),
    );
    const writer = new SimEpisodeLog({ dataDir: tmp(), store });
    await writer.append(input('sim-1'));
    await writer.append(input('sim-2'));
    assert.equal(writer.list()[0]!.storage, '0g');
    assert.equal(writer.list()[1]!.prevRoot, writer.list()[0]!.rootHash);
    // A reader with an empty local log must download everything from the store.
    const reader = new SimEpisodeLog({ dataDir: tmp() });
    const r = await replayChain({ from: writer.list()[1]!.rootHash, limit: 20, simLog: reader, store, storagescan: 'https://scan' });
    assert.deepEqual(r.episodes.map((e) => e.requestId), ['sim-1', 'sim-2']);
    assert.equal(r.episodes[1]!.storagescan, `https://scan/submission/${writer.list()[1]!.rootHash}`);
    assert.ok(r.episodes.every((e) => e.sim && e.storage === '0g'));
    const live = await replayChain({ from: batch.rootHash, limit: 20, simLog: reader, store, storagescan: 'https://scan' });
    assert.deepEqual(live.episodes.map((e) => e.requestId), ['live-1', 'live-2']);
    // Without a store a 0G root cannot be walked, and says so.
    const none = await replayChain({ from: batch.rootHash, limit: 20, simLog: reader, storagescan: 'https://scan' });
    assert.match(none.problems[0]!, /not configured/);
  });
});

describe('sim routes', () => {
  const liveConfig = (dir: string, extra: Record<string, string> = {}) =>
    loadConfig({ GHOSTY_MODE: 'live', OG_API_KEY: 'test-key', SAFE_STOP_ENABLED: 'false', OG_DATA_DIR: dir, NEWS_LIVE: 'false', ...extra });

  it('ships three valid scenarios with sourced headlines', async () => {
    const all = loadScenarios();
    assert.equal(all.length, 3);
    for (const s of all) {
      assert.ok(s.headlines.every((h) => h.url.startsWith('https://')));
      assert.ok(s.markets.length >= 2);
    }
    const app = buildApp({ config: loadConfig({ OG_DATA_DIR: tmp() }) });
    const res = await app.inject({ method: 'GET', url: '/sim/scenarios' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().scenarios.map((s: { id: string }) => s.id).sort(), ['bybit-hack-2025', 'israel-iran-strikes-2025', 'sec-sues-binance-2023']);
    await app.close();
  });

  it('a sim decision confirmed via POST /button never reaches the Hyperliquid or Uniswap executors (live keys, no OG_PRIVATE_KEY)', async () => {
    const venue = new SpyVenue();
    const spot = new SpySpot();
    const executor: Executor = {
      venue,
      spot,
      spotLeg: { tokenIn: 'a', tokenOut: 'b', amount: '1', chainId: 1 },
    };
    const decider = new StubDecider();
    const dir = tmp();
    const app = buildApp({
      config: liveConfig(dir, { DEVICE_TOKEN: 'tok' }),
      executor,
      deps: { decider },
      sim: { loadCandles: fakeCandles, scenarios: () => [SCENARIO], autoTick: false },
    });
    const sse: Array<{ type: string; data: Record<string, unknown> }> = [];
    app.ghosty.state.subscribe((e) => sse.push(e as never));
    const h = { 'x-device-token': 'tok' };

    assert.equal((await app.inject({ method: 'POST', url: '/sim/run', payload: { scenarioId: 'test-shock' } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/sim/run', headers: h, payload: { scenarioId: 'nope' } })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: '/sim/run', headers: h, payload: {} })).statusCode, 400);
    const run = await app.inject({ method: 'POST', url: '/sim/run', headers: h, payload: { scenarioId: 'test-shock', speed: 1800 } });
    assert.equal(run.statusCode, 200);
    const { runId } = run.json();
    await app.ghosty.sim.runUntilIdle();

    let st = (await app.inject({ method: 'GET', url: '/sim/run' })).json();
    assert.equal(st.runId, runId);
    assert.equal(st.status, 'paused');
    assert.equal(st.speed, 1800);
    assert.match(st.memory, /0G memory not configured/);

    const press = await app.inject({ method: 'POST', url: '/button', headers: h, payload: { action: 'confirm' } });
    assert.equal(press.statusCode, 200);
    assert.equal(press.json().sim, true);
    assert.equal(press.json().orders[0].orderId.startsWith('paper-'), true);
    assert.equal(venue.calls.length, 0, 'Hyperliquid executor was called');
    assert.equal(spot.calls.length, 0, 'Uniswap executor was called');

    await app.ghosty.sim.runUntilIdle();
    st = (await app.inject({ method: 'GET', url: '/sim/run' })).json();
    assert.equal(st.status, 'done');
    assert.equal(st.fills.length, 1);
    assert.ok(st.pnlUsd > 0);
    assert.equal(st.positions[0].coin, 'BTC');

    // Sim events are tagged and never land in the live pod snapshot.
    const simEvents = sse.filter((e) => e.type !== 'state');
    assert.ok(simEvents.some((e) => e.type === 'sim'));
    for (const e of simEvents) assert.equal(e.data.sim, true);
    const pod = (await app.inject({ method: 'GET', url: '/state' })).json();
    assert.equal(pod.lastDecision, null);
    assert.deepEqual(pod.orders, []);

    assert.equal(app.ghosty.sim.hasPending(), false);

    const eps = (await app.inject({ method: 'GET', url: `/episodes?runId=${runId}` })).json();
    assert.equal(eps.storage, 'local');
    assert.deepEqual(eps.episodes.map((e: { outcome: string }) => e.outcome), ['proposed', 'executed']);
    const replay = (await app.inject({ method: 'GET', url: `/episodes/replay?from=${encodeURIComponent(eps.episodes[1].rootHash)}` })).json();
    assert.deepEqual(replay.episodes.map((e: { requestId: string }) => e.requestId), ['0g-mock-1', '0g-mock-1']);
    await app.close();
  });

  it('POST /sim/control pauses, resumes and stops; 409 before any run', async () => {
    const app = buildApp({
      config: loadConfig({ OG_DATA_DIR: tmp() }),
      deps: { decider: new StubDecider() },
      sim: { loadCandles: fakeCandles, scenarios: () => [SCENARIO], autoTick: false, store: new MemBlobStore() },
    });
    assert.equal((await app.inject({ method: 'GET', url: '/sim/run' })).json().status, 'idle');
    assert.equal((await app.inject({ method: 'POST', url: '/sim/control', payload: { action: 'pause' } })).statusCode, 409);
    await app.inject({ method: 'POST', url: '/sim/run', payload: { scenarioId: 'test-shock', autoPauseOnAlert: false } });
    assert.equal((await app.inject({ method: 'POST', url: '/sim/control', payload: { action: 'pause' } })).json().status, 'paused');
    await app.ghosty.sim.step(60_000);
    assert.equal(app.ghosty.sim.status().simTime, '2025-01-01T00:00:00.000Z');
    assert.equal((await app.inject({ method: 'POST', url: '/sim/control', payload: { action: 'resume' } })).json().status, 'running');
    await app.ghosty.sim.runUntilIdle();
    assert.equal(app.ghosty.sim.status().storage, '0g');
    assert.equal(app.ghosty.sim.status().episodes[0]!.storage, '0g');
    assert.equal((await app.inject({ method: 'POST', url: '/sim/control', payload: { action: 'stop' } })).json().status, 'done');
    assert.equal((await app.inject({ method: 'POST', url: '/sim/control', payload: { action: 'bogus' } })).statusCode, 400);
    await app.close();
  });
});
