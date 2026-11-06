import type { MarketInfo, MarketOrderRequest, OrderResult, PerpVenue } from '../execution/hyperliquid.js';

/**
 * Paper perp venue for simulation runs: fills at the historical mid at sim time (± slippage), keeps positions and
 * marks them to historical prices. Never talks to an exchange.
 */

export type PriceFn = (coin: string) => number | null;

export interface PaperFill {
  orderId: string;
  coin: string;
  isBuy: boolean;
  sizeUsd: number;
  /** Coin units. */
  size: number;
  px: number;
  mid: number;
  simTime: string;
}

export interface PaperPosition {
  coin: string;
  /** Signed coin units: > 0 long, < 0 short. */
  size: number;
  entryPx: number;
  markPx: number | null;
  unrealizedPnlUsd: number;
  realizedPnlUsd: number;
}

export interface PaperVenueOptions {
  price: PriceFn;
  /** Sim clock (ms). */
  now: () => number;
  slippageBps?: number;
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

export class PaperVenue implements PerpVenue {
  readonly paper = true;
  private readonly positions = new Map<string, { size: number; entryPx: number; realized: number }>();
  readonly fills: PaperFill[] = [];
  private seq = 0;
  private readonly slippageBps: number;

  constructor(private readonly opts: PaperVenueOptions) {
    this.slippageBps = Math.max(0, opts.slippageBps ?? 5);
  }

  async placeMarketOrder(req: MarketOrderRequest): Promise<OrderResult> {
    const mid = this.opts.price(req.coin);
    const orderId = `paper-${++this.seq}`;
    if (mid === null || !(mid > 0) || !(req.sizeUsd > 0)) {
      return { orderId: '', coin: req.coin, isBuy: req.isBuy, sizeUsd: req.sizeUsd, status: 'rejected', error: `no historical price for ${req.coin}` };
    }
    const slip = this.slippageBps / 10_000;
    const px = req.isBuy ? mid * (1 + slip) : mid * (1 - slip);
    const size = req.sizeUsd / px;
    this.apply(req.coin, req.isBuy ? size : -size, px);
    this.fills.push({ orderId, coin: req.coin, isBuy: req.isBuy, sizeUsd: req.sizeUsd, size, px, mid, simTime: new Date(this.opts.now()).toISOString() });
    return { orderId, coin: req.coin, isBuy: req.isBuy, sizeUsd: req.sizeUsd, status: 'simulated', filled: size, avgPx: px };
  }

  async listMarkets(): Promise<MarketInfo[]> {
    return [];
  }

  private apply(coin: string, delta: number, px: number): void {
    const p = this.positions.get(coin) ?? { size: 0, entryPx: 0, realized: 0 };
    if (p.size === 0 || Math.sign(p.size) === Math.sign(delta)) {
      const size = p.size + delta;
      p.entryPx = (p.entryPx * Math.abs(p.size) + px * Math.abs(delta)) / Math.abs(size);
      p.size = size;
    } else {
      const closing = Math.min(Math.abs(delta), Math.abs(p.size));
      p.realized += closing * (px - p.entryPx) * Math.sign(p.size);
      const size = p.size + delta;
      // Flipped through zero: the remainder opens at this fill's price.
      if (Math.abs(delta) > Math.abs(p.size)) p.entryPx = px;
      p.size = Math.abs(size) < 1e-12 ? 0 : size;
    }
    this.positions.set(coin, p);
  }

  snapshot(): { positions: PaperPosition[]; realizedPnlUsd: number; unrealizedPnlUsd: number; pnlUsd: number } {
    const positions: PaperPosition[] = [];
    let realized = 0;
    let unrealized = 0;
    for (const [coin, p] of this.positions) {
      const mark = this.opts.price(coin);
      const u = mark === null || p.size === 0 ? 0 : p.size * (mark - p.entryPx);
      realized += p.realized;
      unrealized += u;
      positions.push({
        coin,
        size: round(p.size, 8),
        entryPx: round(p.entryPx, 4),
        markPx: mark === null ? null : round(mark, 4),
        unrealizedPnlUsd: round(u, 4),
        realizedPnlUsd: round(p.realized, 4),
      });
    }
    return { positions, realizedPnlUsd: round(realized, 4), unrealizedPnlUsd: round(unrealized, 4), pnlUsd: round(realized + unrealized, 4) };
  }
}

/**
 * "Hold" baseline: `notionalUsd` split equally long across the scenario markets at the run's first prices,
 * marked to the same historical prices. What simply holding the basket would have made.
 */
export function holdBaselinePnl(startPx: Record<string, number>, price: PriceFn, notionalUsd: number): number {
  const coins = Object.keys(startPx).filter((c) => startPx[c]! > 0);
  if (coins.length === 0) return 0;
  const each = notionalUsd / coins.length;
  let pnl = 0;
  for (const c of coins) {
    const now = price(c);
    if (now !== null) pnl += each * (now / startPx[c]! - 1);
  }
  return round(pnl, 4);
}
