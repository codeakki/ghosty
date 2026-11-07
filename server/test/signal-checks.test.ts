import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { decodeFrame, encodeSignRequest, orderAction, RSP_SIGNATURE, type HlOrderFields } from '../src/execution/dabao.js';
import { binanceSymbol, hyperliquidCoin, priceMove, runSignalChecks, searchTerms, type MarketPicker } from '../src/signals/checks.js';

/** Routes the public APIs the checks call to canned answers. */
function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const key = Object.keys(routes).find((k) => url.includes(k) || (body?.req?.coin && k === `candles:${body.req.coin}`));
    if (!key) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const t0 = 1_794_010_000;
const routes = {
  'public-search': {
    events: [
      { markets: [{ question: 'Will Iran strike Israel by November 30?', active: true, closed: false, clobTokenIds: '["111","112"]', volume24hr: 50000 }] },
      { markets: [{ question: 'Gold above $4,200 on Nov 30?', active: true, closed: false, clobTokenIds: '["221","222"]', volume24hr: 9000 }] },
    ],
  },
  'prices-history?market=111': { history: [{ t: t0, p: 0.31 }, { t: t0 + 60, p: 0.34 }, { t: t0 + 120, p: 0.38 }] },
  'prices-history?market=221': { history: [{ t: t0, p: 0.4 }, { t: t0 + 60, p: 0.405 }] },
  // Gold up 0.3 % in five minutes on Hyperliquid, flat on Binance.
  'candles:xyz:GOLD': [4060, 4062, 4064, 4066, 4070, 4072.2].map((c) => ({ c: String(c) })),
  'symbol=PAXGUSDT': [4061, 4061, 4061, 4061, 4061, 4061.5].map((c) => [0, '0', '0', '0', String(c)]),
};

const picker: MarketPicker = {
  async pick(_headline, strategy, candidates) {
    assert.equal(strategy, 'long gold');
    assert.equal(candidates.length, 2);
    return [
      { index: 0, yesRisingAgrees: true },   // more strike risk -> safe haven gold
      { index: 1, yesRisingAgrees: true },
    ];
  },
};

describe('signal checks', () => {
  it('reads the odds move and the price move, and speaks only what agrees or is significant', async () => {
    const checks = await runSignalChecks(
      { headline: 'Iran launches missile strike on Israel', actions: [{ venue: 'hyperliquid', kind: 'perp', coin: 'xyz:GOLD', side: 'long', sizeUsd: 10, reason: 'safe haven' }] },
      { picker, fetch: fakeFetch(routes) },
    );
    assert.deepEqual(checks.errors, []);
    const [strike, goldMarket] = checks.predictionMarkets;
    assert.equal(strike!.oddsNow, 0.38);
    assert.equal(strike!.odds1mAgo, 0.34);
    assert.equal(strike!.agrees, true);
    assert.equal(goldMarket!.agrees, null, 'half a point is below the 1 point threshold');
    const hl = checks.prices.find((p) => p.venue === 'hyperliquid')!;
    assert.ok(hl.significant && hl.agrees && Math.abs(hl.change5mPct - 0.3005) < 0.001);
    assert.equal(checks.prices.find((p) => p.venue === 'binance')!.significant, false);
    assert.deepEqual(checks.spoken, [
      'Polymarket agrees: Will Iran strike Israel by November 30 moved from 34 to 38 percent in the last minute.',
      'Gold is up 0.3 percent in five minutes on Hyperliquid.',
    ]);
  });

  it('reports a failed source instead of guessing', async () => {
    const checks = await runSignalChecks(
      { headline: 'Exchange hacked', actions: [{ venue: 'hyperliquid', kind: 'perp', coin: 'BTC', side: 'short', sizeUsd: 10, reason: 'x' }] },
      { picker, fetch: fakeFetch({}) },
    );
    assert.deepEqual(checks.spoken, []);
    assert.ok(checks.errors.some((e) => e.startsWith('polymarket')));
    assert.ok(checks.errors.some((e) => e.startsWith('hyperliquid BTC')));
  });

  it('helpers', () => {
    assert.equal(searchTerms('Iran launches a missile strike on Israel'), 'iran launches missile strike');
    assert.equal(binanceSymbol('xyz:GOLD'), 'PAXGUSDT');
    assert.equal(binanceSymbol('xyz:CL'), undefined);
    assert.equal(hyperliquidCoin('xyz:WTI'), 'xyz:CL');
    assert.equal(hyperliquidCoin('xyz:GOLD'), 'xyz:GOLD');
    assert.equal(priceMove('binance', 'BTCUSDT', [100, 100, 100, 100, 100, 99.4], 'short')!.agrees, true);
    assert.equal(priceMove('binance', 'BTCUSDT', [100, 99.8], 'long')!.significant, false);
  });
});

describe('GET /announce', () => {
  it('is 204 when nothing is queued', async () => {
    const app = buildApp({ config: loadConfig({}), assistant: null });
    assert.equal((await app.inject({ method: 'GET', url: '/announce' })).statusCode, 204);
    await app.close();
  });
});

const HOST = fileURLToPath(new URL('../../firmware/dabao/ghosty_signer/host/host_signer', import.meta.url));
const KEY = '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';

describe('Dabao reduce-only', { skip: !existsSync(HOST) && 'run firmware/dabao/build.sh host first' }, () => {
  const close: HlOrderFields = { asset: 110003, isBuy: false, px: '4039.5', sz: '0.005', nonce: 1794011000000, testnet: false, reduceOnly: true };

  it('signs a close above the 15 USD order limit, and marks it reduce-only', () => {
    const out = execFileSync(HOST, [KEY, encodeSignRequest(close).toString('hex')], { encoding: 'utf8' });
    assert.equal(decodeFrame(Buffer.from(/^reply (\w+)$/m.exec(out)![1]!, 'hex')).type, RSP_SIGNATURE);
    // msgpack "r": true (0xa1 'r' 0xc3)
    assert.match(/^msgpack (\w+)$/m.exec(out)![1]!, /a172c3/);
    assert.equal(orderAction(close).orders[0]!.r, true);
  });

  it('still refuses the same size as an opening order', () => {
    const out = execFileSync(HOST, [KEY, encodeSignRequest({ ...close, reduceOnly: false }).toString('hex')], { encoding: 'utf8' });
    assert.equal(decodeFrame(Buffer.from(/^reply (\w+)$/m.exec(out)![1]!, 'hex')).payload[0], 5);
  });
});
