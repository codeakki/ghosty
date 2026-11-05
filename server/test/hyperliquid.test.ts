import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FakeHyperliquid, hip3AssetId } from '../src/execution/hyperliquid.js';

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
});
