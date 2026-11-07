import { HL_MIN_NOTIONAL_USD, type OrderResult, type PerpVenue } from './hyperliquid.js';

/**
 * Direct spoken orders (VOICE_ORDERS_ENABLED). Claude reads the wearer's words and calls `place_order`
 * (claude/orderAgent.ts); this module checks the limits, places the order and says what happened.
 * Claude never sizes past MAX_TRADE_USD or speaks a fill: both come from here.
 */

/** Assets a spoken order may name, with the venue alias each one trades. */
export const VOICE_ASSETS = {
  GOLD: { coin: 'GOLD', label: 'gold' },
  OIL: { coin: 'WTI', label: 'oil' },
  BTC: { coin: 'BTC', label: 'bitcoin' },
  ETH: { coin: 'ETH', label: 'ethereum' },
  SOL: { coin: 'SOL', label: 'solana' },
} as const;

export type VoiceAsset = keyof typeof VOICE_ASSETS;

export interface VoiceOrder {
  isBuy: boolean;
  sizeUsd: number;
  /** Venue alias: "GOLD", "WTI" (HIP-3 on trade.xyz) or a main-dex coin ("BTC"). */
  coin: string;
  /** Spoken name: "gold". */
  label: string;
}

export function voiceOrder(side: 'buy' | 'sell', asset: VoiceAsset, usd: number): VoiceOrder {
  const { coin, label } = VOICE_ASSETS[asset];
  return { isBuy: side === 'buy', sizeUsd: usd, coin, label };
}

const dollars = (n: number) => (n >= 100 ? Math.round(n).toString() : n.toFixed(2).replace(/\.00$/, ''));

/** Speakable confirmation for a finished order. Never claims a fill the venue did not report. */
export function describeVoiceOrder(order: VoiceOrder, result: OrderResult): string {
  const verb = order.isBuy ? 'bought' : 'sold';
  if (result.status === 'filled' && result.filled !== undefined && result.avgPx !== undefined) {
    return `Done. I ${verb} ${dollars(result.filled * result.avgPx)} dollars of ${order.label} on Hyperliquid, at ${dollars(result.avgPx)} dollars.`;
  }
  if (result.status === 'resting') return `The ${order.label} order is placed but not filled yet.`;
  if (result.status === 'simulated') return `Simulated only. I would have ${verb} ${dollars(order.sizeUsd)} dollars of ${order.label}.`;
  return `The ${order.label} order failed. ${result.error ?? 'Hyperliquid gave no reason.'} Nothing was ${verb}.`;
}

/** Check the limits, place the order, and say what happened. Never throws. */
export async function executeVoiceOrder(
  order: VoiceOrder,
  deps: { venue: PerpVenue; maxTradeUsd: number },
): Promise<{ reply: string; result?: OrderResult }> {
  const verb = order.isBuy ? 'bought' : 'sold';
  if (!(order.sizeUsd >= HL_MIN_NOTIONAL_USD)) {
    return { reply: `Hyperliquid needs at least ${HL_MIN_NOTIONAL_USD} dollars per order. Nothing was ${verb}.` };
  }
  if (order.sizeUsd > deps.maxTradeUsd) {
    return { reply: `My limit is ${dollars(deps.maxTradeUsd)} dollars per trade. Nothing was ${verb}.` };
  }
  let result: OrderResult;
  try {
    result = await deps.venue.placeMarketOrder({ coin: order.coin, isBuy: order.isBuy, sizeUsd: order.sizeUsd });
  } catch (err) {
    result = { coin: order.coin, isBuy: order.isBuy, sizeUsd: order.sizeUsd, orderId: '', status: 'rejected', error: (err as Error).message };
  }
  return { reply: describeVoiceOrder(order, result), result };
}
