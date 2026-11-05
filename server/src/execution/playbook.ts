import type { RiskProfile, UserMemory } from '../agent/memory.js';

export type Signal = 'geopolitical_shock' | 'regulatory_crackdown' | 'none';

export interface PlannedAction {
  venue: 'hyperliquid';
  /** Hyperliquid coin name. HIP-3 trade.xyz markets are prefixed `xyz:` (exact tickers: read from meta). */
  coin: string;
  side: 'long' | 'short';
  sizeUsd: number;
  reason: string;
}

/** Share of MAX_TRADE_USD a profile may deploy on one decision. */
export const RISK_MULTIPLIER: Record<RiskProfile, number> = {
  conservative: 0.25,
  balanced: 0.5,
  aggressive: 1,
};

interface Leg {
  coin: string;
  side: 'long' | 'short';
  /** Fraction of the decision budget; legs of one signal sum to 1. */
  weight: number;
  reason: string;
}

const PLAYBOOK: Record<Signal, Leg[]> = {
  geopolitical_shock: [
    { coin: 'xyz:GOLD', side: 'long', weight: 0.4, reason: 'safe-haven bid on geopolitical shock' },
    { coin: 'xyz:WTI', side: 'long', weight: 0.3, reason: 'oil supply risk premium' },
    { coin: 'BTC', side: 'short', weight: 0.3, reason: 'risk-off selling in crypto' },
  ],
  regulatory_crackdown: [{ coin: 'BTC', side: 'short', weight: 1, reason: 'reduce exposure on regulatory crackdown' }],
  none: [],
};

/**
 * Pure signal → actions map. Total notional = maxTradeUsd × risk multiplier, split across legs,
 * so the sum of all legs never exceeds MAX_TRADE_USD.
 * Note: Hyperliquid rejects orders under $10 notional; the executor must enforce venue minimums.
 */
export function planActions(
  signal: Signal,
  memory: Pick<UserMemory, 'riskProfile'>,
  opts: { maxTradeUsd: number },
): PlannedAction[] {
  const legs = PLAYBOOK[signal];
  const budget = Math.max(0, opts.maxTradeUsd) * RISK_MULTIPLIER[memory.riskProfile];
  if (budget === 0) return [];
  return legs.map((leg) => ({
    venue: 'hyperliquid',
    coin: leg.coin,
    side: leg.side,
    sizeUsd: Math.floor(budget * leg.weight * 100) / 100,
    reason: leg.reason,
  }));
}
