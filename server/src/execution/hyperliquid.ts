/**
 * Hyperliquid perps, including HIP-3 builder-deployed markets on trade.xyz (dex `xyz`):
 * gold, oil, stocks, indices, 24/7, same API as crypto perps.
 * Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids
 */

/**
 * Asset id for a market on a builder-deployed (HIP-3) perp dex:
 *   100000 + perpDexIndex * 10000 + indexInMeta
 * perpDexIndex comes from the `perpDexs` info call (0 is the main dex, whose assets use indexInMeta directly);
 * indexInMeta is the market's position in `meta({ dex })`'s universe.
 */
export function hip3AssetId(dexIndex: number, metaIndex: number): number {
  if (!Number.isInteger(dexIndex) || dexIndex < 1) {
    throw new RangeError(`dexIndex must be an integer >= 1 for builder-deployed dexes, got ${dexIndex}`);
  }
  if (!Number.isInteger(metaIndex) || metaIndex < 0 || metaIndex >= 10000) {
    throw new RangeError(`metaIndex must be an integer in [0, 10000), got ${metaIndex}`);
  }
  return 100000 + dexIndex * 10000 + metaIndex;
}

export interface MarketOrderRequest {
  /** e.g. "BTC" or "xyz:GOLD" */
  coin: string;
  isBuy: boolean;
  sizeUsd: number;
}

export interface OrderResult {
  orderId: string;
  coin: string;
  isBuy: boolean;
  sizeUsd: number;
  status: 'simulated' | 'filled' | 'resting' | 'rejected';
}

export interface PerpVenue {
  placeMarketOrder(req: MarketOrderRequest): Promise<OrderResult>;
}

/** Fake venue: deterministic incrementing order ids, never touches the network. */
export class FakeHyperliquid implements PerpVenue {
  private nextId = 1;

  async placeMarketOrder(req: MarketOrderRequest): Promise<OrderResult> {
    const orderId = `fake-hl-${String(this.nextId++).padStart(6, '0')}`;
    return { orderId, coin: req.coin, isBuy: req.isBuy, sizeUsd: req.sizeUsd, status: 'simulated' };
  }
}

// TODO(hyperliquid): real venue via @nktkas/hyperliquid (not installed yet; best-maintained TS SDK).
// Setup (pre-event): master deposits on mainnet → claim 1,000 mock USDC at app.hyperliquid-testnet.xyz/drip,
// master approves an API (agent) wallet with ApproveAgent; HL_AGENT_PRIVATE_KEY signs, HL_MASTER_ADDRESS is queried.
// Steps per order:
//   1. info.perpDexs() → find index of dex "xyz"; info.meta({ dex: 'xyz' }) → index of e.g. "xyz:GOLD", szDecimals.
//   2. asset = hip3AssetId(dexIndex, metaIndex) for xyz:*, or the main-dex index for BTC.
//   3. mid from allMids / metaAndAssetCtxs; size = sizeUsd / mid rounded to szDecimals.
//   4. exchange.order({ orders: [{ a: asset, b: isBuy, p: slippagePrice, s: size, r: false, t: { limit: { tif: 'Ioc' } } }], grouping: 'na' })
//      (Hyperliquid "market" orders are aggressive IOC limits.)
// Testnet: HL_TESTNET=true. Whether xyz stock/gold markets exist on testnet is UNVERIFIED → mainnet tiny size fallback.
