import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Decider, DecideInput, Decision } from '../src/agent/decide.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Executor } from '../src/execution/executor.js';
import type { MarketOrderRequest, OrderResult, PerpVenue } from '../src/execution/hyperliquid.js';
import type { CandleSet } from '../src/sim/candles.js';
import { createSimLiveExecution } from '../src/sim/liveOrders.js';
import type { Scenario } from '../src/sim/scenarios.js';

const H = 3_600_000;
const START = Date.parse('2025-01-01T00:00:00Z');
const SCENARIO: Scenario = {
  id: 'live-orders-test',
  title: 'test',
  description: 'synthetic',
  start: '2025-01-01T00:00:00Z',
  end: '2025-01-01T03:00:00Z',
  interval: '1h',
  markets: [
    { coin: 'BTC', source: 'binance', symbol: 'BTCUSDT' },
    { coin: 'ETH', source: 'binance', symbol: 'ETHUSDT' },
  ],
  headlines: [{ ts: '2025-01-01T01:00:00Z', title: 'Missile strike reported near the Strait', source: 'Reuters', url: 'https://example.com/b' }],
  sources: [],
};
const CANDLES: CandleSet = {
  BTC: [0, 1, 2, 3, 4].map((i) => ({ t: START + (i - 1) * H, o: 100, h: 100, l: 100, c: 100 })),
  ETH: [0, 1, 2, 3, 4].map((i) => ({ t: START + (i - 1) * H, o: 10, h: 10, l: 10, c: 10 })),
};
const loadCandles = async () => structuredClone(CANDLES);

/** Two legs: short BTC, long ETH. */
class TwoLegDecider implements Decider {
  async decide(input: DecideInput): Promise<Decision> {
    return {
      signal: 'geopolitical_shock',
      confidence: 0.8,
      rationale: 'Shock. Press to confirm.',
      requestId: '0g-mock-live',
      suggestedActions: [
        { venue: 'hyperliquid', kind: 'perp', coin: 'BTC', side: 'short', sizeUsd: 12.5, reason: 'test' },
        { venue: 'hyperliquid', kind: 'perp', coin: 'ETH', side: 'long', sizeUsd: 12.5, reason: 'test' },
      ],
      newsIds: input.news.map((n) => n.id),
    };
  }
}

class SpyVenue implements PerpVenue {
  calls: MarketOrderRequest[] = [];
  constructor(private readonly tag: string) {}
  async placeMarketOrder(req: MarketOrderRequest): Promise<OrderResult> {
    this.calls.push(req);
    return { orderId: `${this.tag}-${this.calls.length}`, coin: req.coin, isBuy: req.isBuy, sizeUsd: req.sizeUsd, status: 'filled', avgPx: 1, url: 'https://app.hyperliquid.xyz/explorer' };
  }
  async listMarkets() {
    return [];
  }
}

const tmp = () => mkdtempSync(join(tmpdir(), 'ghosty-sim-live-'));
const H_TOK = { 'x-device-token': 'tok' };

function app(env: Record<string, string>, liveVenue?: PerpVenue) {
  const executorVenue = new SpyVenue('EXECUTOR');
  const executor: Executor = { venue: executorVenue, spot: { quoteAndSwap: async () => { throw new Error('no swaps'); } } as never };
  const a = buildApp({
    config: loadConfig({ GHOSTY_MODE: 'live', OG_API_KEY: 'k', SAFE_STOP_ENABLED: 'false', NEWS_LIVE: 'false', OG_DATA_DIR: tmp(), DEVICE_TOKEN: 'tok', ...env }),
    executor,
    deps: { decider: new TwoLegDecider() },
    sim: { loadCandles, scenarios: () => [SCENARIO], autoTick: false, store: null, liveVenue },
  });
  return { a, executorVenue };
}

describe('sim real orders (Hyperliquid mainnet)', () => {
  it('are off by default: liveOrders:true answers 409 and GET /sim/run says why', async () => {
    const live = new SpyVenue('LIVE');
    const { a } = app({}, live);
    const st = (await a.inject({ method: 'GET', url: '/sim/run' })).json();
    assert.equal(st.execution.available, false);
    assert.match(st.execution.unavailable, /SIM_LIVE_ORDERS/);
    const res = await a.inject({ method: 'POST', url: '/sim/run', headers: H_TOK, payload: { scenarioId: SCENARIO.id, liveOrders: true } });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, 'live_unavailable');
    assert.equal(live.calls.length, 0);
    await a.close();
  });

  it('a paper-only run never calls the mainnet venue, even with SIM_LIVE_ORDERS on', async () => {
    const live = new SpyVenue('LIVE');
    const { a, executorVenue } = app({ SIM_LIVE_ORDERS: 'true' }, live);
    await a.inject({ method: 'POST', url: '/sim/run', headers: H_TOK, payload: { scenarioId: SCENARIO.id } });
    await a.ghosty.sim.runUntilIdle();
    const press = (await a.inject({ method: 'POST', url: '/button', headers: H_TOK, payload: { action: 'confirm' } })).json();
    assert.equal(press.orders.length, 2);
    assert.deepEqual(press.liveOrders, []);
    assert.equal(live.calls.length, 0);
    assert.equal(executorVenue.calls.length, 0);
    await a.close();
  });

  it('an opted-in run fills on paper AND sends each leg to mainnet at SIM_LIVE_ORDER_USD, capped per run', async () => {
    const live = new SpyVenue('LIVE');
    const { a, executorVenue } = app({ SIM_LIVE_ORDERS: 'true', SIM_LIVE_ORDER_USD: '12', SIM_LIVE_MAX_RUN_USD: '20' }, live);
    const sse: Array<{ type: string; data: Record<string, unknown> }> = [];
    a.ghosty.state.subscribe((e) => sse.push(e as never));
    const start = await a.inject({ method: 'POST', url: '/sim/run', headers: H_TOK, payload: { scenarioId: SCENARIO.id, liveOrders: true } });
    assert.equal(start.statusCode, 200);
    assert.equal(start.json().liveOrders, true);
    await a.ghosty.sim.runUntilIdle();
    const press = (await a.inject({ method: 'POST', url: '/button', headers: H_TOK, payload: { action: 'confirm' } })).json();

    // Paper fills at the historical price, as before.
    assert.ok(press.orders.every((o: OrderResult) => o.orderId.startsWith('paper-')));
    // Real legs: fixed size, short BTC then long ETH; the second would pass the $20 run cap and is refused.
    assert.deepEqual(live.calls, [{ coin: 'BTC', isBuy: false, sizeUsd: 12 }]);
    assert.equal(press.liveOrders.length, 2);
    assert.equal(press.liveOrders[0].status, 'filled');
    assert.equal(press.liveOrders[0].network, 'mainnet');
    assert.equal(press.liveOrders[1].status, 'rejected');
    assert.match(press.liveOrders[1].error, /run cap/);
    assert.equal(executorVenue.calls.length, 0, 'the live executor is never used by a sim');

    const st = (await a.inject({ method: 'GET', url: '/sim/run' })).json();
    assert.equal(st.execution.liveOrders, true);
    assert.equal(st.execution.spentUsd, 12);
    assert.equal(st.execution.orders.length, 2);
    const liveEvents = sse.filter((e) => e.type === 'order' && e.data.live === true);
    assert.equal(liveEvents.length, 2);
    assert.equal(liveEvents[0]!.data.sim, true);
    assert.equal(liveEvents[0]!.data.paper, false);
    await a.close();
  });

  it('cancel places nothing real', async () => {
    const live = new SpyVenue('LIVE');
    const { a } = app({ SIM_LIVE_ORDERS: 'true' }, live);
    await a.inject({ method: 'POST', url: '/sim/run', headers: H_TOK, payload: { scenarioId: SCENARIO.id, liveOrders: true } });
    await a.ghosty.sim.runUntilIdle();
    const press = (await a.inject({ method: 'POST', url: '/button', headers: H_TOK, payload: { action: 'cancel' } })).json();
    assert.deepEqual(press.liveOrders, []);
    assert.equal(live.calls.length, 0);
    await a.close();
  });

  it('createSimLiveExecution: off by default, needs mainnet keys, raises size to the $10 minimum', () => {
    const cfg = (env: Record<string, string>) => loadConfig({ GHOSTY_MODE: 'live', ...env });
    assert.match(createSimLiveExecution(cfg({})).unavailable!, /SIM_LIVE_ORDERS/);
    const noKeys = createSimLiveExecution(cfg({ SIM_LIVE_ORDERS: 'true' }));
    assert.equal(noKeys.venue, null);
    assert.match(noKeys.unavailable!, /HL_MASTER_ADDRESS/);
    const keyed = createSimLiveExecution(
      cfg({
        SIM_LIVE_ORDERS: 'true',
        SIM_LIVE_ORDER_USD: '5',
        HL_TESTNET: 'true',
        HL_MASTER_ADDRESS: '0x' + '1'.repeat(40),
        HL_AGENT_PRIVATE_KEY: '0x' + '2'.repeat(64),
      }),
    );
    assert.equal(keyed.unavailable, null);
    assert.equal(keyed.network, 'mainnet');
    assert.equal(keyed.orderUsd, 10);
  });
});
