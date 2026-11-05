import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyText, FakeDecider } from '../src/agent/decide.js';
import { defaultMemory } from '../src/agent/memory.js';
import { planActions } from '../src/execution/playbook.js';

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
    assert.equal(decision.suggestedActions.length, 3);
    assert.match(decision.requestId, /^fake-/);
    assert.ok(decision.confidence > 0 && decision.confidence < 1);
  });
});
