import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { executeSpotBuy, SPOT_ASSETS, SpotDailyBudget, USDC_BASE } from '../src/execution/spotOrder.js';
import type { SwapRequest } from '../src/wallet/uniswap.js';

function fakeLeg(amountOut: string) {
  const calls: SwapRequest[] = [];
  return {
    calls,
    async quoteAndSwap(req: SwapRequest) {
      calls.push(req);
      return { quoteId: 'q', txHash: '0xabc' as const, status: 'confirmed' as const, amountOut, explorerUrl: 'https://basescan.org/tx/0xabc' };
    },
  };
}

describe('Uniswap buys paid in USDC', () => {
  it('swaps exactly the spoken dollars of USDC into the stock and reports the shares', async () => {
    const leg = fakeLeg('1458100'); // 0.014581 AAPLc (8 decimals)
    const { reply, result } = await executeSpotBuy('AAPL', 5, { spot: leg, chainId: 8453, budget: new SpotDailyBudget() });
    assert.deepEqual(leg.calls, [{ tokenIn: USDC_BASE, tokenOut: SPOT_ASSETS.AAPL.address, amount: '5000000', chainId: 8453 }]);
    assert.equal(reply, 'Done. I bought 0.0146 Apple shares for 5 dollars of USDC on Uniswap.');
    assert.equal(result?.txHash, '0xabc');
    assert.equal(result?.status, 'filled');
  });

  it('buys native ETH and cbBTC too', async () => {
    const eth = await executeSpotBuy('ETH', 5, { spot: fakeLeg('2226113655428440'), chainId: 8453, budget: new SpotDailyBudget() });
    assert.match(eth.reply, /0\.00223 ETH for 5 dollars/);
    const btc = await executeSpotBuy('BTC', 5, { spot: fakeLeg('6581'), chainId: 8453, budget: new SpotDailyBudget() });
    assert.match(btc.reply, /0\.0000658 bitcoin \(cbBTC\)/);
  });

  it('stops at 100 dollars a day and starts again the next day', async () => {
    let now = new Date('2026-11-07T10:00:00Z');
    const budget = new SpotDailyBudget(100, () => now);
    const leg = fakeLeg('100000000');
    assert.equal((await executeSpotBuy('NVDA', 80, { spot: leg, chainId: 8453, budget })).result?.status, 'filled');
    const over = await executeSpotBuy('NVDA', 30, { spot: leg, chainId: 8453, budget });
    assert.equal(over.result, undefined);
    assert.match(over.reply, /above today's Uniswap limit\. 20 dollars are left of 100/);
    now = new Date('2026-11-08T00:01:00Z');
    assert.equal((await executeSpotBuy('NVDA', 30, { spot: leg, chainId: 8453, budget })).result?.status, 'filled');
    assert.equal(leg.calls.length, 2);
  });
});
