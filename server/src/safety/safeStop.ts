import type { Config } from '../config.js';
import { isTestMode } from '../mode.js';

/**
 * Runtime override for SIMULATE_BRAIN_OFFLINE, one per app instance.
 * The virtual pod (`POST /sim/safe-stop`) flips it to demo safe-stop without a restart.
 */
export class BrainSwitch {
  constructor(public simulateOffline: boolean) {}
}

/**
 * Safe-stop (0G Physical AI requirement): if the brain (0G Compute) is unreachable,
 * the device says "brain offline" and no trade is placed.
 *
 * - SAFE_STOP_ENABLED=false bypasses the check entirely.
 * - SIMULATE_BRAIN_OFFLINE=true always reports offline (demo switch). The sim's BrainSwitch
 *   (`POST /sim/safe-stop`) overrides it at runtime when passed as `opts.sim`.
 * - OG_API_KEY unset: in test mode the brain is the local FakeDecider, so it counts as online. In live mode there
 *   is no brain at all, so safe-stop is engaged (no fake decisions).
 * - OG_API_KEY set: GET <OG_ROUTER_URL>/models with a 6 s timeout (status line only; the ~130 KB model list is not
 *   downloaded), cached for 10 s. The mainnet router often needs 2-4 s from a cold TLS handshake, so 3 s flapped.
 *   A failed 0G decide() call also marks the brain offline for one cache window (reportBrainFailure).
 */
export type SafeStopConfig = Pick<Config, 'SAFE_STOP_ENABLED' | 'SIMULATE_BRAIN_OFFLINE' | 'OG_ROUTER_URL'> &
  Partial<Pick<Config, 'OG_API_KEY' | 'GHOSTY_MODE'>>;

export interface BrainProbeOptions {
  fetch?: typeof fetch;
  now?: () => number;
  /** Per-app runtime override of SIMULATE_BRAIN_OFFLINE (virtual pod). */
  sim?: BrainSwitch;
}

export const PING_TIMEOUT_MS = 6_000;
export const CACHE_TTL_MS = 10_000;

interface CacheEntry {
  online: boolean;
  at: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<boolean>>();

function routerKey(url: string): string {
  return url.replace(/\/+$/, '');
}

export async function isBrainOnline(config: SafeStopConfig, opts: BrainProbeOptions = {}): Promise<boolean> {
  if (!config.SAFE_STOP_ENABLED) return true;
  if (opts.sim?.simulateOffline ?? config.SIMULATE_BRAIN_OFFLINE) return false;
  if (!config.OG_API_KEY) return isTestMode(config);

  const now = opts.now ?? Date.now;
  const key = routerKey(config.OG_ROUTER_URL);
  const hit = cache.get(key);
  if (hit && now() - hit.at < CACHE_TTL_MS) return hit.online;

  // Coalesce concurrent probes (e.g. /health and /voice landing together).
  const pending = inFlight.get(key);
  if (pending) return pending;

  const probe = pingRouter(key, opts.fetch ?? fetch).then((online) => {
    cache.set(key, { online, at: now() });
    inFlight.delete(key);
    return online;
  });
  inFlight.set(key, probe);
  return probe;
}

/** Cheap reachability probe. `GET /models` needs no auth on the 0G Router. */
async function pingRouter(baseUrl: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`${baseUrl}/models`, { method: 'GET', signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
    // Only the status matters: cancel the (large) model list instead of downloading it under the timeout.
    await res.body?.cancel().catch(() => undefined);
    return res.ok;
  } catch {
    return false;
  }
}

/** A real 0G call just failed: report offline until the cache window expires. */
export function reportBrainFailure(routerUrl: string, now: () => number = Date.now): void {
  cache.set(routerKey(routerUrl), { online: false, at: now() });
}

/** Last known router state without probing (null = never probed). */
export function lastKnownBrainState(routerUrl: string): boolean | null {
  return cache.get(routerKey(routerUrl))?.online ?? null;
}

/** Tests only. */
export function resetBrainHealthCache(): void {
  cache.clear();
  inFlight.clear();
}
