import type { PlannedAction } from '../api/types';
import { splitCoin } from '../lib/format';

/** Plain-words helpers shared by the Device and Feed pages. Numbers go through Intl. */

const usd = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 0 });
const signedPct = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: 'always' });

/** Short display names for the watch list ("xyz:GOLD" → "Gold"). Falls back to the server label, then the ticker. */
const SHORT: Record<string, string> = {
  BTC: 'BTC',
  ETH: 'ETH',
  SOL: 'SOL',
  GOLD: 'Gold',
  CL: 'Oil',
  SP500: 'S&P 500',
  TSLA: 'Tesla',
  NVDA: 'Nvidia',
};

export function coinName(coin: string, labels?: Record<string, string>): string {
  const { ticker } = splitCoin(coin);
  return SHORT[ticker] ?? labels?.[coin] ?? ticker;
}

export function formatUsdAmount(v: number): string {
  return usd.format(v);
}

export function formatConfidencePct(v: number | undefined): string {
  return v === undefined ? '—' : pct.format(Math.max(0, Math.min(1, v)));
}

/** "+0.42%" / "−0.31%" with a real minus sign. */
export function formatSignedPct(v: number): string {
  return `${signedPct.format(v).replace('-', '−')}%`;
}

/** Display precision per watched asset, so a price never changes width as it ticks. Anything else: 2 dp. */
export const ASSET_DP: Readonly<Record<string, number>> = { BTC: 0, ETH: 2, SOL: 2, GOLD: 1, CL: 2, SP500: 1, TSLA: 2, NVDA: 2 };
const DEFAULT_DP = 2;

/** Decimal places for a coin ("xyz:GOLD" → 1). */
export function assetDecimals(coin: string): number {
  return ASSET_DP[splitCoin(coin).ticker] ?? DEFAULT_DP;
}

/** A watched asset's price at its fixed precision (BTC 76,148 · ETH 2,238.95 · Gold 4,067.5 · S&P 500 7,373.7). */
export function formatAssetPx(coin: string, v: number): string {
  const dp = assetDecimals(coin);
  return new Intl.NumberFormat(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp }).format(v);
}

/** Price with sensible precision: 75,884 · 2,233.25 · 89.84 · 0.4123. */
export function formatPx(v: number): string {
  const digits = v >= 10_000 ? 0 : v >= 100 ? 2 : v >= 1 ? 3 : 5;
  return new Intl.NumberFormat(undefined, { minimumFractionDigits: Math.min(2, digits), maximumFractionDigits: digits }).format(v);
}

/** "Long Gold · $12.50 on Hyperliquid". */
export function legText(a: PlannedAction, labels?: Record<string, string>): string {
  return `${a.side === 'long' ? 'Long' : 'Short'} ${coinName(a.coin, labels)} · ${formatUsdAmount(a.sizeUsd)} on Hyperliquid`;
}

export function shortHash(id: string, head = 6, tail = 4): string {
  return id.length <= head + tail + 1 ? id : `${id.slice(0, head)}…${id.slice(-tail)}`;
}
