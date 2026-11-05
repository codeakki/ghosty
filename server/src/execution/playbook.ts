import type { RiskProfile, UserMemory } from '../agent/memory.js';

export type Signal = 'geopolitical_shock' | 'regulatory_crackdown' | 'none';

/** Perp leg on Hyperliquid. */
export interface PlannedAction {
  venue: 'hyperliquid';
  kind: 'perp';
  /** Hyperliquid coin or playbook alias. The venue resolves it (xyz:WTI → xyz:CL, fallbacks via HL_FALLBACK_COINS). */
  coin: string;
  side: 'long' | 'short';
  sizeUsd: number;
  reason: string;
}

/** Spot leg through the Uniswap Trading API. Runs before the perp legs. */
export interface SpotAction {
  venue: 'uniswap';
  kind: 'spot';
  tokenIn: string;
  tokenOut: string;
  /** tokenIn amount in base units. */
  amount: string;
  chainId: number;
  reason: string;
}

export type PlanStep = SpotAction | PlannedAction;

/** Hyperliquid rejects orders under $10 notional. */
export const DEFAULT_MIN_NOTIONAL_USD = 10;

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

export interface PlanOptions {
  /** Hard cap on total notional across legs (MAX_TRADE_USD). */
  maxTradeUsd: number;
  /** Per-leg venue minimum. Default $10 (Hyperliquid). 0 disables the check. */
  minNotionalUsd?: number;
  /**
   * true (default): drop the smallest-weight legs and re-split the budget until every leg clears the minimum;
   * if one leg is left and still short, raise it to the minimum when that stays within maxTradeUsd.
   * false: drop legs under the minimum without re-splitting.
   */
  scaleToMin?: boolean;
}

const cents = (x: number) => Math.floor(x * 100) / 100;

function toAction(leg: Leg, sizeUsd: number): PlannedAction {
  return { venue: 'hyperliquid', kind: 'perp', coin: leg.coin, side: leg.side, sizeUsd, reason: leg.reason };
}

function split(legs: Leg[], budget: number): number[] {
  const total = legs.reduce((s, l) => s + l.weight, 0);
  return legs.map((l) => cents((budget * l.weight) / total));
}

/**
 * Pure signal → perp actions map. Total notional = maxTradeUsd × risk multiplier, split across legs,
 * so the sum of all legs never exceeds MAX_TRADE_USD. Every returned leg is ≥ minNotionalUsd, so the venue
 * never sees an order it will reject (e.g. $25 cap, balanced → one $12.50 gold leg instead of three sub-$10 legs).
 */
export function planActions(signal: Signal, memory: Pick<UserMemory, 'riskProfile'>, opts: PlanOptions): PlannedAction[] {
  const maxTradeUsd = Math.max(0, opts.maxTradeUsd);
  const budget = maxTradeUsd * RISK_MULTIPLIER[memory.riskProfile];
  const min = Math.max(0, opts.minNotionalUsd ?? DEFAULT_MIN_NOTIONAL_USD);
  const legs = PLAYBOOK[signal];
  if (budget === 0 || legs.length === 0) return [];

  if (opts.scaleToMin === false) {
    const sizes = split(legs, budget);
    return legs.map((leg, i) => toAction(leg, sizes[i] ?? 0)).filter((a) => a.sizeUsd >= min && a.sizeUsd > 0);
  }

  let active = [...legs];
  while (active.length > 0) {
    const sizes = split(active, budget);
    if (sizes.every((s) => s >= min)) return active.map((leg, i) => toAction(leg, sizes[i] ?? 0));
    if (active.length === 1) {
      const only = active[0] as Leg;
      return min <= maxTradeUsd ? [toAction(only, min)] : [];
    }
    // Drop the smallest-weight leg; on ties drop the later one (playbook order = priority).
    let drop = 0;
    active.forEach((l, i) => {
      if (l.weight <= (active[drop] as Leg).weight) drop = i;
    });
    active = active.filter((_, i) => i !== drop);
  }
  return [];
}

export interface SpotLegSpec {
  tokenIn: string;
  tokenOut: string;
  amount: string;
  chainId: number;
}

/**
 * Full plan: the optional Uniswap spot leg first (UNISWAP_SPOT_LEG=true), then the perp legs.
 * The spot leg is a fixed demo amount in tokenIn base units, outside the USD perp budget.
 */
export function planSteps(
  signal: Signal,
  memory: Pick<UserMemory, 'riskProfile'>,
  opts: PlanOptions & { spotLeg?: SpotLegSpec },
): PlanStep[] {
  const perps = planActions(signal, memory, opts);
  if (!opts.spotLeg || signal === 'none') return perps;
  const spot: SpotAction = {
    venue: 'uniswap',
    kind: 'spot',
    ...opts.spotLeg,
    reason: 'spot leg via Uniswap Trading API before the perp orders',
  };
  return [spot, ...perps];
}
