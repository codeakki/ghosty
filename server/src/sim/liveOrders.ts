import type { Config } from '../config.js';
import { createPerpVenue, HL_MIN_NOTIONAL_USD, HyperliquidVenue, type OrderResult, type PerpVenue } from '../execution/hyperliquid.js';

/**
 * Real orders from a simulation run. A confirmed sim trade always fills on the PaperVenue at the historical price;
 * with real orders on, each leg is ALSO sent to Hyperliquid mainnet at today's price, at a small fixed size.
 */
export interface SimLiveExecution {
  /** null when real orders are unavailable (see `unavailable`). */
  venue: PerpVenue | null;
  network: 'mainnet';
  /** Notional of each real leg. */
  orderUsd: number;
  /** Total real notional a run may place. */
  maxRunUsd: number;
  /** Why a run cannot place real orders, or null when it can. */
  unavailable: string | null;
}

/** One real order placed from a sim run. */
export type SimLiveOrder = OrderResult & {
  live: true;
  network: 'mainnet';
  requestId: string;
  /** Historical clock of the run when the trade was confirmed. */
  simTime: string;
  /** Wall-clock time the order went to the exchange. */
  placedAt: string;
};

export function createSimLiveExecution(
  config: Pick<
    Config,
    'SIM_LIVE_ORDERS' | 'SIM_LIVE_ORDER_USD' | 'SIM_LIVE_MAX_RUN_USD' | 'HL_AGENT_PRIVATE_KEY' | 'HL_MASTER_ADDRESS' | 'HL_DEXES' | 'HL_FALLBACK_COINS' | 'GHOSTY_MODE'
  >,
  override?: PerpVenue,
): SimLiveExecution {
  const base = {
    network: 'mainnet' as const,
    orderUsd: Math.max(HL_MIN_NOTIONAL_USD, config.SIM_LIVE_ORDER_USD),
    maxRunUsd: config.SIM_LIVE_MAX_RUN_USD,
  };
  if (!config.SIM_LIVE_ORDERS) return { ...base, venue: null, unavailable: 'Real orders are off. Set SIM_LIVE_ORDERS=true in server/.env and restart.' };
  if (override) return { ...base, venue: override, unavailable: null };
  // Mainnet regardless of HL_TESTNET: the API wallet must be approved on app.hyperliquid.xyz.
  const venue = createPerpVenue({ ...config, HL_TESTNET: false });
  if (!(venue instanceof HyperliquidVenue)) {
    return { ...base, venue: null, unavailable: 'Real orders need HL_MASTER_ADDRESS and HL_AGENT_PRIVATE_KEY (a mainnet API wallet) in server/.env.' };
  }
  return { ...base, venue, unavailable: null };
}
