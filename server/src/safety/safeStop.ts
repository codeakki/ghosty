import type { Config } from '../config.js';

/**
 * Safe-stop (0G Physical AI requirement): if the brain (0G Compute) is unreachable,
 * the device says "brain offline" and no trade is placed.
 *
 * Stub: online unless SIMULATE_BRAIN_OFFLINE=true. SAFE_STOP_ENABLED=false bypasses the check entirely.
 */
export async function isBrainOnline(config: Pick<Config, 'SAFE_STOP_ENABLED' | 'SIMULATE_BRAIN_OFFLINE' | 'OG_ROUTER_URL'>): Promise<boolean> {
  if (!config.SAFE_STOP_ENABLED) return true;
  return !config.SIMULATE_BRAIN_OFFLINE;
}

// TODO(0g): real check. Ping the router with a short timeout and cache the result for ~10 s:
// const res = await fetch(`${config.OG_ROUTER_URL}/models`, {
//   headers: { authorization: `Bearer ${config.OG_API_KEY}` },
//   signal: AbortSignal.timeout(1500),
// });
// return res.ok;
// Also treat a failed decide() call as offline for that request (never fall back to a non-0G model for trades).
