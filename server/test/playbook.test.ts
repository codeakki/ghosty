import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyText, FakeDecider } from '../src/agent/decide.js';
import { defaultMemory } from '../src/agent/memory.js';
import { executePlan } from '../src/execution/executor.js';
import { FakeHyperliquid, type MarketOrderRequest } from '../src/execution/hyperliquid.js';
import { planActions, planSteps, type PlanStep } from '../src/execution/playbook.js';
import { FakeSpotLeg, type SwapRequest } from '../src/wallet/uniswap.js';

const total = (xs: Array<{ sizeUsd: number }>) => xs.reduce((s, x) => s + x.sizeUsd, 0);

describe('planActions', () => {
  it('geopolitical_shock → long xyz:GOLD, long xyz:WTI, short BTC', () => {
    const actions = planActions('geopolitical_shock', { riskProfile: 'balanced' }, { maxTradeUsd: 100 });
    assert.deepEqual(
      actions.map((a) => [a.coin, a.side, a.sizeUsd]),
      [
        ['xyz:GOLD', 'long', 20],
        ['xyz:WTI', 'long', 15],
        ['BTC', 'short', 15],
      ],
    );
    assert.ok(actions.every((a) => a.venue === 'hyperliquid'));
  });

  it('sizes by risk profile and never exceeds MAX_TRADE_USD', () => {
    const conservative = total(planActions('geopolitical_shock', { riskProfile: 'conservative' }, { maxTradeUsd: 100 }));
    const balanced = total(planActions('geopolitical_shock', { riskProfile: 'balanced' }, { maxTradeUsd: 100 }));
    const aggressive = total(planActions('geopolitical_shock', { riskProfile: 'aggressive' }, { maxTradeUsd: 100 }));
    assert.ok(conservative < balanced && balanced < aggressive);
    assert.ok(aggressive <= 100);
    assert.ok(total(planActions('geopolitical_shock', { riskProfile: 'aggressive' }, { maxTradeUsd: 33.33 })) <= 33.33);
  });

  it('regulatory_crackdown → reduce exposure with a single BTC short', () => {
    const actions = planActions('regulatory_crackdown', { riskProfile: 'aggressive' }, { maxTradeUsd: 40 });
    assert.equal(actions.length, 1);
    assert.equal(actions[0]?.coin, 'BTC');
    assert.equal(actions[0]?.side, 'short');
    assert.equal(actions[0]?.sizeUsd, 40);
  });

  it('none or zero budget → no actions', () => {
    assert.deepEqual(planActions('none', { riskProfile: 'aggressive' }, { maxTradeUsd: 100 }), []);
    assert.deepEqual(planActions('geopolitical_shock', { riskProfile: 'balanced' }, { maxTradeUsd: 0 }), []);
  });
});

describe('planActions: venue minimum ($10)', () => {
  const legs = (xs: Array<{ coin: string; sizeUsd: number }>) => xs.map((a) => [a.coin, a.sizeUsd]);

  it('$25 cap, balanced: drops the smallest legs instead of sending three sub-$10 orders', () => {
    // 12.50 budget → 5 / 3.75 / 3.75 → drop BTC (tie, later) → 7.14 / 5.35 → drop WTI → GOLD 12.50
    const actions = planActions('geopolitical_shock', { riskProfile: 'balanced' }, { maxTradeUsd: 25 });
    assert.deepEqual(legs(actions), [['xyz:GOLD', 12.5]]);
  });

  it('$25 cap, aggressive: two legs, each ≥ $10, total ≤ cap', () => {
    const actions = planActions('geopolitical_shock', { riskProfile: 'aggressive' }, { maxTradeUsd: 25 });
    assert.deepEqual(legs(actions), [
      ['xyz:GOLD', 14.28],
      ['xyz:WTI', 10.71],
    ]);
    assert.ok(total(actions) <= 25);
  });

  it('$25 cap, conservative: single leg raised to the $10 minimum (still within MAX_TRADE_USD)', () => {
    const actions = planActions('geopolitical_shock', { riskProfile: 'conservative' }, { maxTradeUsd: 25 });
    assert.deepEqual(legs(actions), [['xyz:GOLD', 10]]);
  });

  it('cap below the minimum → no actions', () => {
    assert.deepEqual(planActions('regulatory_crackdown', { riskProfile: 'aggressive' }, { maxTradeUsd: 8 }), []);
  });

  it('every leg ≥ minimum and total ≤ cap across caps and profiles', () => {
    for (const maxTradeUsd of [10, 12, 20, 25, 33.33, 40, 60, 100, 1000]) {
      for (const riskProfile of ['conservative', 'balanced', 'aggressive'] as const) {
        const actions = planActions('geopolitical_shock', { riskProfile }, { maxTradeUsd });
        assert.ok(actions.every((a) => a.sizeUsd >= 10), `${maxTradeUsd} ${riskProfile}`);
        assert.ok(total(actions) <= maxTradeUsd + 1e-9, `${maxTradeUsd} ${riskProfile}`);
      }
    }
  });

  it('scaleToMin=false drops sub-minimum legs without re-splitting', () => {
    const actions = planActions('geopolitical_shock', { riskProfile: 'aggressive' }, { maxTradeUsd: 25, scaleToMin: false });
    assert.deepEqual(legs(actions), [['xyz:GOLD', 10]]);
  });

  it('minNotionalUsd=0 keeps the plain split', () => {
    const actions = planActions('geopolitical_shock', { riskProfile: 'balanced' }, { maxTradeUsd: 25, minNotionalUsd: 0 });
    assert.deepEqual(legs(actions), [
      ['xyz:GOLD', 5],
      ['xyz:WTI', 3.75],
      ['BTC', 3.75],
    ]);
  });
});

const spotLeg = { tokenIn: '0xin', tokenOut: '0xout', amount: '1000', chainId: 84532 };

describe('planSteps', () => {
  it('puts the Uniswap spot leg first when configured', () => {
    const steps = planSteps('geopolitical_shock', { riskProfile: 'aggressive' }, { maxTradeUsd: 100, spotLeg });
    assert.deepEqual(
      steps.map((s) => s.venue),
      ['uniswap', 'hyperliquid', 'hyperliquid', 'hyperliquid'],
    );
    assert.equal(steps[0]?.kind, 'spot');
  });

  it('no spot leg without config or on signal none', () => {
    assert.ok(planSteps('geopolitical_shock', { riskProfile: 'balanced' }, { maxTradeUsd: 100 }).every((s) => s.kind === 'perp'));
    assert.deepEqual(planSteps('none', { riskProfile: 'balanced' }, { maxTradeUsd: 100, spotLeg }), []);
  });
});

describe('executePlan', () => {
  it('runs spot steps before perp legs and keeps going when the spot leg fails', async () => {
    const log: string[] = [];
    const venue = new FakeHyperliquid();
    const realPlace = venue.placeMarketOrder.bind(venue);
    venue.placeMarketOrder = async (req: MarketOrderRequest) => {
      log.push(`perp:${req.coin}`);
      return realPlace(req);
    };
    const spot = {
      quoteAndSwap: async (req: SwapRequest) => {
        log.push(`spot:${req.tokenIn}`);
        throw new Error('NoRouteFoundError');
      },
    };
    const steps: PlanStep[] = [
      ...planActions('regulatory_crackdown', { riskProfile: 'aggressive' }, { maxTradeUsd: 20 }),
      { venue: 'uniswap', kind: 'spot', ...spotLeg, reason: 'test' },
    ];
    const report = await executePlan(steps, { venue, spot });
    assert.deepEqual(log, ['spot:0xin', 'perp:BTC']);
    assert.equal(report.spot[0]?.error, 'NoRouteFoundError');
    assert.equal(report.orders.length, 1);
    assert.equal(report.orders[0]?.isBuy, false);
  });

  it('records spot results with the fake leg', async () => {
    const steps = planSteps('geopolitical_shock', { riskProfile: 'aggressive' }, { maxTradeUsd: 100, spotLeg });
    const report = await executePlan(steps, { venue: new FakeHyperliquid(), spot: new FakeSpotLeg() });
    assert.equal(report.spot[0]?.result?.status, 'simulated');
    assert.equal(report.orders.length, 3);
  });
});

describe('FakeDecider', () => {
  it('maps war keywords to geopolitical_shock', () => {
    assert.equal(classifyText('Missile strike reported'), 'geopolitical_shock');
    assert.equal(classifyText('SEC lawsuit against exchange'), 'regulatory_crackdown');
    assert.equal(classifyText('ETH ETF inflows steady'), 'none');
    assert.equal(classifyText('Strikeout record in baseball'), 'none');
  });

  it('produces a decision with actions and a request id', async () => {
    const decision = await new FakeDecider().decide({
      transcript: 'is there an invasion?',
      news: [],
      memory: defaultMemory(),
      maxTradeUsd: 25,
    });
    assert.equal(decision.signal, 'geopolitical_shock');
    // $25 cap × balanced = $12.50: one leg that clears Hyperliquid's $10 minimum.
    assert.equal(decision.suggestedActions.length, 1);
    assert.equal(decision.suggestedActions[0]?.coin, 'xyz:GOLD');
    assert.match(decision.requestId, /^fake-/);
    assert.ok(decision.confidence > 0 && decision.confidence < 1);
  });
});
