import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { spokenRationale, type Decider, type DecideInput, type Decision } from '../src/agent/decide.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Executor } from '../src/execution/executor.js';
import type { MarketOrderRequest, OrderResult, PerpVenue } from '../src/execution/hyperliquid.js';
import { PROBES } from '../src/providers/probes.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import type { CandleSet } from '../src/sim/candles.js';
import type { Scenario } from '../src/sim/scenarios.js';
import { FakeSpotLeg, type SwapRequest, type SwapResult } from '../src/wallet/uniswap.js';

/**
 * Real-money safety: POST /button only ever trades a decision the wearer has heard (still pending, not expired).
 * A press with nothing pending answers 409 and never asks 0G for a new decision or touches a venue.
 */

const WAR = 'War breaks out: missile strikes hit Gulf oil terminals';
const NOTHING = { error: 'nothing_pending', message: "Nothing to confirm. Ghosty only trades on an alert you've heard." };

type Shape = 'short' | 'none' | 'no_legs';

class StubDecider implements Decider {
  calls = 0;
  constructor(public shape: Shape = 'short') {}
  async decide(_input: DecideInput): Promise<Decision> {
    this.calls++;
    const requestId = `0g-stub-${this.calls}`;
    if (this.shape === 'none') {
      return { signal: 'none', confidence: 0.1, rationale: 'Nothing market-moving. Press to confirm.', requestId, suggestedActions: [] };
    }
    if (this.shape === 'no_legs') {
      // A real signal whose legs were all dropped (watchlist / $10 minimum): the model still wrote the prompt.
      return { signal: 'regulatory_crackdown', confidence: 0.6, rationale: 'SEC pressure on exchanges. Press to confirm.', requestId, suggestedActions: [] };
    }
    return {
      signal: 'geopolitical_shock',
      confidence: 0.8,
      rationale: 'Shock. Short BTC. Press to confirm.',
      requestId,
      suggestedActions: [{ venue: 'hyperliquid', kind: 'perp', coin: 'BTC', side: 'short', sizeUsd: 12.5, reason: 'test' }],
    };
  }
}

class SpyVenue implements PerpVenue {
  calls: MarketOrderRequest[] = [];
  async placeMarketOrder(req: MarketOrderRequest): Promise<OrderResult> {
    this.calls.push(req);
    return { orderId: `hl-${this.calls.length}`, coin: req.coin, isBuy: req.isBuy, sizeUsd: req.sizeUsd, status: 'simulated' };
  }
  async listMarkets() {
    return [];
  }
}

class SpySpot {
  calls: SwapRequest[] = [];
  private readonly inner = new FakeSpotLeg();
  async quoteAndSwap(req: SwapRequest): Promise<SwapResult> {
    this.calls.push(req);
    return this.inner.quoteAndSwap(req);
  }
}

function setup(opts: { shape?: Shape; env?: Record<string, string>; now?: () => number } = {}) {
  const decider = new StubDecider(opts.shape);
  const venue = new SpyVenue();
  const spot = new SpySpot();
  const executor: Executor = { venue, spot, spotLeg: { tokenIn: '0xin', tokenOut: '0xout', amount: '1', chainId: 84532 } };
  const app = buildApp({
    config: loadConfig({ ...opts.env }),
    executor,
    deps: { decider, ...(opts.now ? { now: opts.now } : {}) },
  });
  const press = (action: 'confirm' | 'cancel') => app.inject({ method: 'POST', url: '/button', payload: { action } });
  return { app, decider, venue, spot, press };
}

describe('POST /button: only an alert you heard can trade', () => {
  it('confirm with nothing pending → 409 nothing_pending, no 0G decision, no order, no swap', async () => {
    const { app, decider, venue, spot, press } = setup();
    const res = await press('confirm');
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.json(), NOTHING);
    assert.equal(decider.calls, 0, 'a press must never ask 0G for a fresh decision');
    assert.equal(venue.calls.length, 0);
    assert.equal(spot.calls.length, 0);
    const state = (await app.inject({ method: 'GET', url: '/state' })).json();
    assert.equal(state.lastDecision, null);
    assert.equal(state.orders.length, 0);
    assert.equal(state.episodes.length, 0);
    await app.close();
  });

  it('cancel with nothing pending → 409 nothing_pending, no 0G decision', async () => {
    const { app, decider, press } = setup();
    const res = await press('cancel');
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.json(), NOTHING);
    assert.equal(decider.calls, 0);
    await app.close();
  });

  it('an alert executes exactly once; a second confirm → 409', async () => {
    const { app, decider, venue, spot, press } = setup();
    const inject = await app.inject({ method: 'POST', url: '/news/inject', payload: { title: WAR } });
    assert.equal(inject.statusCode, 200);
    assert.ok(inject.json().alert, 'alert queued');
    assert.equal(decider.calls, 1);

    const first = await press('confirm');
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().executed, true);
    assert.equal(first.json().requestId, '0g-stub-1');
    assert.deepEqual(venue.calls.map((c) => c.coin), ['BTC']);
    assert.equal(spot.calls.length, 1);

    const second = await press('confirm');
    assert.equal(second.statusCode, 409);
    assert.deepEqual(second.json(), NOTHING);
    assert.equal(venue.calls.length, 1, 'executed once');
    assert.equal(spot.calls.length, 1);
    assert.equal(decider.calls, 1, 'no new decision');
    await app.close();
  });

  it('two simultaneous confirms on one alert execute it once', async () => {
    const { app, venue, press } = setup();
    await app.inject({ method: 'POST', url: '/news/inject', payload: { title: WAR } });
    const [a, b] = await Promise.all([press('confirm'), press('confirm')]);
    assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
    assert.equal(venue.calls.length, 1);
    await app.close();
  });

  it('cancel drops the pending alert; a later confirm → 409', async () => {
    const { app, venue, press } = setup();
    await app.inject({ method: 'POST', url: '/news/inject', payload: { title: WAR } });
    const cancel = await press('cancel');
    assert.equal(cancel.statusCode, 200);
    assert.equal(cancel.json().executed, false);
    assert.equal((await press('confirm')).statusCode, 409);
    assert.equal(venue.calls.length, 0);
    await app.close();
  });

  it('an alert older than PENDING_DECISION_TTL_SEC → 409 alert_expired, nothing executed', async () => {
    let clock = 1_000_000;
    const { app, decider, venue, spot, press } = setup({ env: { PENDING_DECISION_TTL_SEC: '120' }, now: () => clock });
    await app.inject({ method: 'POST', url: '/news/inject', payload: { title: WAR } });
    clock += 120_001;
    const res = await press('confirm');
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, 'alert_expired');
    assert.match(res.json().message, /expired/i);
    assert.equal(res.json().requestId, '0g-stub-1');
    assert.equal(venue.calls.length, 0);
    assert.equal(spot.calls.length, 0);
    assert.equal(decider.calls, 1);
    // The expired alert is gone: the next press has nothing at all to act on.
    assert.deepEqual((await press('confirm')).json(), NOTHING);
    await app.close();
  });

  it('within the TTL the alert still confirms', async () => {
    let clock = 1_000_000;
    const { app, venue, press } = setup({ env: { PENDING_DECISION_TTL_SEC: '30' }, now: () => clock });
    await app.inject({ method: 'POST', url: '/news/inject', payload: { title: WAR } });
    clock += 29_000;
    assert.equal((await press('confirm')).statusCode, 200);
    assert.equal(venue.calls.length, 1);
    await app.close();
  });

  it('cancel on an expired alert → 409 alert_expired', async () => {
    let clock = 0;
    const { app, press } = setup({ now: () => clock });
    await app.inject({ method: 'POST', url: '/news/inject', payload: { title: WAR } });
    clock += 121_000;
    const res = await press('cancel');
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, 'alert_expired');
    await app.close();
  });

  it('PENDING_DECISION_TTL_SEC defaults to 120', () => {
    assert.equal(loadConfig({}).PENDING_DECISION_TTL_SEC, 120);
    assert.equal(loadConfig({ PENDING_DECISION_TTL_SEC: 'junk' }).PENDING_DECISION_TTL_SEC, 120);
  });
});

describe('non-actionable decisions never ask for a press', () => {
  for (const shape of ['none', 'no_legs'] as const) {
    it(`${shape}: no pending decision, no alert, no "Press to confirm" in the reply`, async () => {
      const { app, venue, press } = setup({ shape });
      const text = await app.inject({ method: 'POST', url: '/voice/text', payload: { text: 'anything happening?' } });
      assert.equal(text.statusCode, 200);
      assert.doesNotMatch(text.json().reply, /press .*to confirm/i);
      assert.doesNotMatch(text.json().rationale, /press .*to confirm/i);

      const inject = await app.inject({ method: 'POST', url: '/news/inject', payload: { title: WAR } });
      assert.equal(inject.json().alert, null, 'no alert for a decision with nothing to confirm');
      assert.doesNotMatch(inject.json().decision.rationale, /press .*to confirm/i);

      const state = (await app.inject({ method: 'GET', url: '/state' })).json();
      assert.doesNotMatch(state.lastDecision.rationale, /press .*to confirm/i);

      assert.deepEqual((await press('confirm')).json(), NOTHING);
      assert.equal(venue.calls.length, 0);
      await app.close();
    });
  }

  it('a non-actionable decision replaces an earlier pending one (the last thing heard was not a trade)', async () => {
    const { app, decider, venue, press } = setup();
    await app.inject({ method: 'POST', url: '/news/inject', payload: { title: WAR } });
    decider.shape = 'none';
    await app.inject({ method: 'POST', url: '/voice/text', payload: { text: 'anything else?' } });
    assert.equal((await press('confirm')).statusCode, 409);
    assert.equal(venue.calls.length, 0);
    await app.close();
  });

  it('spokenRationale keeps the prompt only for actionable decisions', () => {
    const leg = { venue: 'hyperliquid' as const, kind: 'perp' as const, coin: 'BTC', side: 'short' as const, sizeUsd: 12, reason: '' };
    assert.equal(spokenRationale({ signal: 'geopolitical_shock', suggestedActions: [leg], rationale: 'Short BTC. Press to confirm.' }), 'Short BTC. Press to confirm.');
    assert.equal(spokenRationale({ signal: 'none', suggestedActions: [], rationale: 'Quiet. Press to confirm.' }), 'Quiet.');
    assert.equal(spokenRationale({ signal: 'geopolitical_shock', suggestedActions: [], rationale: 'Press the button to confirm.' }), 'Nothing to act on right now. I will keep watching.');
  });
});

// ---------------------------------------------------------------------------

const H = 3_600_000;
const START = Date.parse('2025-01-01T00:00:00Z');
const SCENARIO: Scenario = {
  id: 'button-safety-sim',
  title: 'test',
  description: 'synthetic',
  start: '2025-01-01T00:00:00Z',
  end: '2025-01-01T04:00:00Z',
  interval: '1h',
  markets: [{ coin: 'BTC', source: 'binance', symbol: 'BTCUSDT' }],
  headlines: [{ ts: '2025-01-01T02:00:00Z', title: 'Missile strike reported near the Strait', source: 'Reuters', url: 'https://example.com/b', handle: 'Reuters' }],
  sources: [],
};
const CANDLES: CandleSet = {
  BTC: [100, 100, 100, 95, 90].map((c, i) => ({ t: START + (i - 1) * H, o: 100, h: 101, l: 89, c })),
};

describe('sim button path', () => {
  it('a pending sim decision confirms on the PaperVenue; the next press has nothing pending → 409', async () => {
    const decider = new StubDecider();
    const venue = new SpyVenue();
    const app = buildApp({
      config: loadConfig({ OG_DATA_DIR: mkdtempSync(join(tmpdir(), 'ghosty-button-')) }),
      executor: { venue, spot: new SpySpot() },
      deps: { decider },
      sim: { loadCandles: async () => structuredClone(CANDLES), scenarios: () => [SCENARIO], autoTick: false, store: null },
    });
    assert.equal((await app.inject({ method: 'POST', url: '/sim/run', payload: { scenarioId: 'button-safety-sim', speed: 1800 } })).statusCode, 200);
    await app.ghosty.sim.runUntilIdle();
    const calls = decider.calls;
    const press = await app.inject({ method: 'POST', url: '/button', payload: { action: 'confirm' } });
    assert.equal(press.statusCode, 200);
    assert.equal(press.json().sim, true);
    assert.equal(press.json().paper, true);
    assert.ok(press.json().orders[0].orderId.startsWith('paper-'));
    assert.equal(venue.calls.length, 0, 'never the real venue');

    const again = await app.inject({ method: 'POST', url: '/button', payload: { action: 'confirm' } });
    assert.equal(again.statusCode, 409);
    assert.deepEqual(again.json(), NOTHING);
    assert.equal(decider.calls, calls, 'no new decision from a stray press');
    assert.equal(venue.calls.length, 0);
    await app.ghosty.sim.runUntilIdle();
    await app.close();
  });
});

// ---------------------------------------------------------------------------

const AGENT_KEY = `0x${'11'.repeat(32)}`;
const AGENT_ADDR = privateKeyToAccount(AGENT_KEY as `0x${string}`).address;
const MASTER = `0x${'ab'.repeat(20)}`;

function hlRegistry(opts: { abstraction: unknown; spotUsdc?: string; perDex?: Record<string, string> }) {
  const types: string[] = [];
  const fetchImpl = (async (_input: string | URL | Request, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body)) as { type: string; dex?: string };
    types.push(body.type);
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
    if (body.type === 'userAbstraction') return json(200, opts.abstraction);
    if (body.type === 'spotClearinghouseState') {
      return json(200, { balances: opts.spotUsdc === undefined ? [] : [{ coin: 'USDC', token: 0, total: opts.spotUsdc, hold: '0.0', entryNtl: '0.0' }] });
    }
    if (body.type === 'clearinghouseState') return json(200, { marginSummary: { accountValue: opts.perDex?.[body.dex ?? 'main'] ?? '0.0' } });
    if (body.type === 'extraAgents') return json(200, [{ address: AGENT_ADDR, name: 'ghosty' }]);
    return json(404, { error: 'not mocked' });
  }) as typeof fetch;
  const config = loadConfig({ GHOSTY_MODE: 'live', HL_MASTER_ADDRESS: MASTER, HL_AGENT_PRIVATE_KEY: AGENT_KEY });
  const registry = new ProviderRegistry({ config, fetch: fetchImpl, probes: PROBES.filter((p) => p.id === 'hyperliquid') });
  return {
    types,
    status: async () => (await registry.status()).providers[0]!,
  };
}

describe('Hyperliquid probe: unified account', () => {
  it('unified account with 9.70 USDC → live, shared collateral across main + xyz', async () => {
    const { status, types } = hlRegistry({ abstraction: 'unifiedAccount', spotUsdc: '9.70' });
    const p = await status();
    assert.equal(p.state, 'live');
    assert.match(p.detail, /unified account: 9\.70 USDC shared across main \+ xyz/);
    assert.ok(!types.includes('clearinghouseState'), 'per-dex margin is not read in unified mode');
  });

  it('unified account below $2 → degraded with a deposit hint', async () => {
    const { status } = hlRegistry({ abstraction: 'unifiedAccount', spotUsdc: '1.5' });
    const p = await status();
    assert.equal(p.state, 'degraded');
    assert.match(p.detail, /1\.50 USDC shared/);
    assert.match(p.detail, /below \$2 collateral/);
    assert.match(p.nextAction ?? '', /Deposit USDC/);
  });

  it('unified account with no USDC balance → degraded', async () => {
    const { status } = hlRegistry({ abstraction: 'unifiedAccount' });
    assert.equal((await status()).state, 'degraded');
  });

  it('non-unified accounts keep the per-dex margin check', async () => {
    const degraded = await hlRegistry({ abstraction: 'disabled', perDex: { main: '25.5', xyz: '0.0' } }).status();
    assert.equal(degraded.state, 'degraded');
    assert.match(degraded.detail, /margin: main \$25\.50, xyz \$0\.00; xyz dex margin is 0/);
    const live = await hlRegistry({ abstraction: 'default', perDex: { main: '25.5', xyz: '12' } }).status();
    assert.equal(live.state, 'live');
  });
});
