import type { Config } from '../config.js';
import { createSpotLeg, type SpotLeg, type SwapResult } from '../wallet/uniswap.js';
import { createPerpVenue, type OrderResult, type PerpVenue } from './hyperliquid.js';
import type { PlanStep, SpotAction, SpotLegSpec } from './playbook.js';

export interface SpotOutcome {
  action: SpotAction;
  result?: SwapResult;
  error?: string;
}

export interface ExecutionReport {
  spot: SpotOutcome[];
  orders: OrderResult[];
}

export interface Executor {
  venue: PerpVenue;
  spot: SpotLeg;
  /** Spot leg config to pass to planSteps, or undefined when UNISWAP_SPOT_LEG is off. */
  spotLeg?: SpotLegSpec;
}

/**
 * Run a plan: Uniswap spot steps first, then Hyperliquid perp legs in order.
 * Never throws: a failed spot leg is recorded and the perp legs still run; venue rejections come back as
 * `status: 'rejected'` orders.
 */
export async function executePlan(steps: PlanStep[], deps: Pick<Executor, 'venue' | 'spot'>): Promise<ExecutionReport> {
  const report: ExecutionReport = { spot: [], orders: [] };
  for (const step of steps) {
    if (step.kind !== 'spot') continue;
    try {
      const result = await deps.spot.quoteAndSwap({
        tokenIn: step.tokenIn,
        tokenOut: step.tokenOut,
        amount: step.amount,
        chainId: step.chainId,
      });
      report.spot.push({ action: step, result });
    } catch (err) {
      report.spot.push({ action: step, error: (err as Error).message });
    }
  }
  for (const step of steps) {
    if (step.kind === 'spot') continue;
    report.orders.push(await deps.venue.placeMarketOrder({ coin: step.coin, isBuy: step.side === 'long', sizeUsd: step.sizeUsd }));
  }
  return report;
}

/** Real Hyperliquid / Uniswap when their keys are set, else the fakes. */
export function createExecutor(config: Config): Executor {
  return {
    venue: createPerpVenue(config),
    spot: createSpotLeg(config),
    spotLeg: config.UNISWAP_SPOT_LEG
      ? {
          tokenIn: config.UNISWAP_DEMO_TOKEN_IN,
          tokenOut: config.UNISWAP_DEMO_TOKEN_OUT,
          amount: config.UNISWAP_DEMO_AMOUNT,
          chainId: config.EVM_CHAIN_ID,
        }
      : undefined,
  };
}
