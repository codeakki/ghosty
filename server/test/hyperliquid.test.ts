import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildMarketMap,
  createPerpVenue,
  FakeHyperliquid,
  hip3AssetId,
  HyperliquidVenue,
  MARKET_CACHE_MS,
  parseFallbackCoins,
  sizeForNotional,
  type HlExchangeApi,
  type HlInfoApi,
  type HlOrderParams,
} from '../src/execution/hyperliquid.js';
import { loadConfig } from '../src/config.js';

describe('hip3AssetId', () => {
  it('applies 100000 + dexIndex * 10000 + metaIndex', () => {
    assert.equal(hip3AssetId(1, 0), 110000);
    assert.equal(hip3AssetId(1, 5), 110005);
    assert.equal(hip3AssetId(2, 37), 120037);
    assert.equal(hip3AssetId(7, 9999), 179999);
  });

  it('rejects the main dex and invalid indexes', () => {
    assert.throws(() => hip3AssetId(0, 1), RangeError);
    assert.throws(() => hip3AssetId(-1, 1), RangeError);
    assert.throws(() => hip3AssetId(1.5, 1), RangeError);
    assert.throws(() => hip3AssetId(1, -1), RangeError);
    assert.throws(() => hip3AssetId(1, 10000), RangeError);
  });
});

describe('FakeHyperliquid', () => {
  it('returns deterministic incrementing order ids', async () => {
    const venue = new FakeHyperliquid();
    const a = await venue.placeMarketOrder({ coin: 'xyz:GOLD', isBuy: true, sizeUsd: 10 });
    const b = await venue.placeMarketOrder({ coin: 'BTC', isBuy: false, sizeUsd: 10 });
    assert.equal(a.orderId, 'fake-hl-000001');
    assert.equal(b.orderId, 'fake-hl-000002');
    assert.equal(a.status, 'simulated');
  });

  it('lists markets for the sim', async () => {
    const xyz = await new FakeHyperliquid().listMarkets({ dex: 'xyz', query: 'gold' });
    assert.deepEqual(
      xyz.map((m) => m.coin),
      ['xyz:GOLD'],
    );
  });
});

// Shapes mirror testnet on 2026-11-06: "xyz" is a builder dex, gold is xyz:GOLD, WTI crude is xyz:CL,
// and xyz:CRCL (Circle) sits before xyz:CL, which an unanchored /CL/ would match first.
function fakeInfo(opts: { withGold?: boolean; mids?: Record<string, string> } = {}) {
  const calls = { perpDexs: 0, meta: [] as string[], allMids: [] as string[] };
  const universes: Record<string, Array<{ name: string; szDecimals: number; isDelisted?: boolean }>> = {
    '': [
      { name: 'SOL', szDecimals: 2 },
      { name: 'BTC', szDecimals: 5 },
      { name: 'ETH', szDecimals: 4 },
    ],
    xyz: [
      { name: 'xyz:TSLA', szDecimals: 3 },
      { name: 'xyz:CRCL', szDecimals: 3 },
      ...(opts.withGold === false ? [] : [{ name: 'xyz:GOLD', szDecimals: 4 }]),
      { name: 'xyz:BRENTOIL', szDecimals: 2, isDelisted: true },
      { name: 'xyz:CL', szDecimals: 3 },
    ],
    other: [{ name: 'NOPREFIX', szDecimals: 1 }],
  };
  const mids = opts.mids ?? { BTC: '76520', ETH: '2272.5', 'xyz:GOLD': '4044.3', 'xyz:CL': '88.671' };
  const info: HlInfoApi = {
    async perpDexs() {
      calls.perpDexs++;
      return [null, { name: 'test' }, { name: 'xyz' }, { name: 'other' }];
    },
    async meta({ dex }) {
      calls.meta.push(dex ?? '');
      return { universe: universes[dex ?? ''] ?? [] };
    },
    async allMids({ dex }) {
      calls.allMids.push(dex ?? '');
      return Object.fromEntries(Object.entries(mids).filter(([k]) => (dex ? k.startsWith(`${dex}:`) : !k.includes(':'))));
    },
  };
  return { info, calls };
}

type Status = Awaited<ReturnType<HlExchangeApi['order']>>['response']['data']['statuses'][number];

function fakeExchange(status: Status | Error = { filled: { totalSz: '0.0062', avgPx: '4045.1', oid: 4242 } }) {
  const orders: HlOrderParams[] = [];
  const exchange: HlExchangeApi = {
    async order(params) {
      orders.push(params);
      if (status instanceof Error) throw status;
      return { response: { data: { statuses: [status] } } };
    },
  };
  return { exchange, orders };
}

describe('buildMarketMap', () => {
  it('maps main-dex coins to metaIndex and HIP-3 coins to 100000 + dexIdx*10000 + metaIdx', async () => {
    const { info, calls } = fakeInfo();
    const map = await buildMarketMap(info, ['xyz']);
    assert.equal(map.get('BTC')?.assetId, 1);
    assert.equal(map.get('BTC')?.szDecimals, 5);
    assert.equal(map.get('xyz:TSLA')?.assetId, 120000);
    assert.equal(map.get('xyz:GOLD')?.assetId, 120002);
    assert.equal(map.get('xyz:CL')?.assetId, 120004);
    assert.equal(map.get('xyz:GOLD')?.dex, 'xyz');
    assert.equal(map.get('xyz:BRENTOIL')?.delisted, true);
    // Only the main dex and the configured dexes are fetched.
    assert.deepEqual(calls.meta, ['', 'xyz']);
  });

  it('prefixes names that lack the dex prefix and skips dexes that are not listed', async () => {
    const { info } = fakeInfo();
    const map = await buildMarketMap(info, ['other', 'missing']);
    assert.equal(map.get('other:NOPREFIX')?.assetId, 130000);
    assert.equal([...map.values()].some((m) => m.dex === 'missing'), false);
  });

  it('caches the map for 5 minutes', async () => {
    const { info, calls } = fakeInfo();
    let now = 1_000_000;
    const venue = new HyperliquidVenue({ info, testnet: true, now: () => now });
    await venue.listMarkets();
    now += MARKET_CACHE_MS - 1;
    await venue.listMarkets();
    assert.equal(calls.perpDexs, 1);
    now += 2;
    await venue.listMarkets();
    assert.equal(calls.perpDexs, 2);
  });
});

describe('resolveCoin', () => {
  it('maps playbook aliases to live markets (xyz:WTI → xyz:CL, not xyz:CRCL)', async () => {
    const venue = new HyperliquidVenue({ info: fakeInfo().info, testnet: true });
    assert.equal((await venue.resolveCoin('xyz:GOLD')).market.coin, 'xyz:GOLD');
    assert.equal((await venue.resolveCoin('GOLD')).market.coin, 'xyz:GOLD');
    assert.equal((await venue.resolveCoin('xyz:WTI')).market.coin, 'xyz:CL');
    assert.equal((await venue.resolveCoin('WTI')).market.coin, 'xyz:CL');
    const btc = await venue.resolveCoin('BTC');
    assert.equal(btc.market.coin, 'BTC');
    assert.equal(btc.fallback, false);
  });

  it('falls back per HL_FALLBACK_COINS and tags the result', async () => {
    const venue = new HyperliquidVenue({
      info: fakeInfo({ withGold: false }).info,
      testnet: true,
      fallbackCoins: parseFallbackCoins('GOLD=BTC, WTI=ETH'),
    });
    const gold = await venue.resolveCoin('xyz:GOLD');
    assert.equal(gold.market.coin, 'BTC');
    assert.equal(gold.fallback, true);
  });

  it('throws for unknown markets without a fallback', async () => {
    const venue = new HyperliquidVenue({ info: fakeInfo({ withGold: false }).info, testnet: true });
    await assert.rejects(venue.resolveCoin('xyz:GOLD'), /no Hyperliquid market for "xyz:GOLD"/);
    await assert.rejects(venue.resolveCoin('xyz:BRENTOIL'), /no Hyperliquid market/);
  });

  it('parses HL_FALLBACK_COINS', () => {
    assert.deepEqual(parseFallbackCoins('gold=BTC,WTI=ETH,,bad'), { GOLD: 'BTC', WTI: 'ETH' });
    assert.deepEqual(parseFallbackCoins(undefined), {});
  });
});

describe('sizeForNotional', () => {
  it('rounds to szDecimals', () => {
    assert.equal(sizeForNotional(25, 4044.3, 4), 0.0062);
    assert.equal(sizeForNotional(15, 88.671, 3), 0.169);
    assert.equal(sizeForNotional(100, 3, 0), 33);
  });

  it('bumps a size that rounds under the $10 minimum', () => {
    // $10 / 76520 = 0.0001307 → 0.00013 BTC = $9.95 < $10 → 0.00014
    assert.equal(sizeForNotional(10, 76520, 5), 0.00014);
    // Checked at a lower (sell limit) price
    assert.ok(sizeForNotional(10, 100, 2, 10, 99) * 99 >= 10);
  });

  it('returns 0 for nonsense inputs', () => {
    assert.equal(sizeForNotional(10, 0, 2), 0);
    assert.equal(sizeForNotional(0, 100, 2), 0);
  });
});

describe('HyperliquidVenue.placeMarketOrder', () => {
  it('rejects orders under $10 without calling the exchange', async () => {
    const { exchange, orders } = fakeExchange();
    const venue = new HyperliquidVenue({ info: fakeInfo().info, exchange, testnet: true });
    const res = await venue.placeMarketOrder({ coin: 'BTC', isBuy: false, sizeUsd: 9.99 });
    assert.equal(res.status, 'rejected');
    assert.match(res.error ?? '', /below the Hyperliquid minimum of \$10/);
    assert.equal(orders.length, 0);
  });

  it('sends an IOC limit at mid + slippage for buys and returns the fill', async () => {
    const { exchange, orders } = fakeExchange();
    const { info, calls } = fakeInfo();
    const venue = new HyperliquidVenue({ info, exchange, testnet: true, masterAddress: '0x' + '1'.repeat(40) });
    const res = await venue.placeMarketOrder({ coin: 'xyz:GOLD', isBuy: true, sizeUsd: 25 });
    assert.deepEqual(orders[0], {
      orders: [{ a: 120002, b: true, p: '4084.7', s: '0.0062', r: false, t: { limit: { tif: 'Ioc' } } }],
      grouping: 'na',
    });
    assert.deepEqual(calls.allMids, ['xyz']);
    assert.equal(res.status, 'filled');
    assert.equal(res.orderId, '4242');
    assert.equal(res.filled, 0.0062);
    assert.equal(res.avgPx, 4045.1);
    assert.equal(res.assetId, 120002);
    assert.equal(res.fallback, undefined);
    assert.match(res.url ?? '', /^https:\/\/app\.hyperliquid-testnet\.xyz\/explorer\/address\/0x1{40}$/);
  });

  it('prices sells below mid and keeps notional ≥ $10 at the limit price', async () => {
    const { exchange, orders } = fakeExchange();
    const venue = new HyperliquidVenue({ info: fakeInfo().info, exchange, testnet: false });
    await venue.placeMarketOrder({ coin: 'BTC', isBuy: false, sizeUsd: 10, slippageBps: 50 });
    const o = orders[0]?.orders[0];
    assert.equal(o?.a, 1);
    assert.equal(o?.b, false);
    assert.equal(o?.p, '76137');
    assert.ok(Number(o?.s) * Number(o?.p) >= 10);
  });

  it('tags fallback orders', async () => {
    const { exchange, orders } = fakeExchange();
    const venue = new HyperliquidVenue({
      info: fakeInfo({ withGold: false }).info,
      exchange,
      testnet: true,
      fallbackCoins: { GOLD: 'BTC' },
    });
    const res = await venue.placeMarketOrder({ coin: 'xyz:GOLD', isBuy: true, sizeUsd: 12.5 });
    assert.equal(orders[0]?.orders[0]?.a, 1);
    assert.equal(res.coin, 'BTC');
    assert.equal(res.requestedCoin, 'xyz:GOLD');
    assert.equal(res.fallback, true);
  });

  it('returns rejected (never throws) on unknown markets, missing mids and exchange errors', async () => {
    const noGold = new HyperliquidVenue({ info: fakeInfo({ withGold: false }).info, exchange: fakeExchange().exchange, testnet: true });
    assert.equal((await noGold.placeMarketOrder({ coin: 'xyz:GOLD', isBuy: true, sizeUsd: 20 })).status, 'rejected');

    const noMid = new HyperliquidVenue({ info: fakeInfo({ mids: {} }).info, exchange: fakeExchange().exchange, testnet: true });
    assert.match((await noMid.placeMarketOrder({ coin: 'BTC', isBuy: true, sizeUsd: 20 })).error ?? '', /no mid price/);

    const ioc = fakeExchange(new Error('Order could not immediately match against any resting orders.'));
    const throwing = new HyperliquidVenue({ info: fakeInfo().info, exchange: ioc.exchange, testnet: true });
    const res = await throwing.placeMarketOrder({ coin: 'BTC', isBuy: true, sizeUsd: 20 });
    assert.equal(res.status, 'rejected');
    assert.match(res.error ?? '', /could not immediately match/);
    assert.equal(res.assetId, 1);

    const readOnly = new HyperliquidVenue({ info: fakeInfo().info, testnet: true });
    assert.match((await readOnly.placeMarketOrder({ coin: 'BTC', isBuy: true, sizeUsd: 20 })).error ?? '', /read-only/);
  });
});

describe('createPerpVenue', () => {
  it('uses the fake without keys and the real venue with them', () => {
    assert.ok(createPerpVenue(loadConfig({})) instanceof FakeHyperliquid);
    const real = createPerpVenue(
      loadConfig({ HL_AGENT_PRIVATE_KEY: '0x' + 'ab'.repeat(32), HL_MASTER_ADDRESS: '0x' + '2'.repeat(40) }),
    );
    assert.ok(real instanceof HyperliquidVenue);
  });
});
