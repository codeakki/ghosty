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
 * - OG_API_KEY set: GET <OG_ROUTER_URL>/models with an OG_HEALTH_TIMEOUT_MS timeout (default 15 s; status line only,
 *   the ~130 KB model list is not downloaded), cached for 10 s. Slow networks need far more than a cold TLS handshake.
 * - Hysteresis: once the router has answered, it flips offline only after 2 consecutive failures (probe or failed
 *   decide()), and back online after 1 success. With no successful probe yet, a failure is offline straight away.
 *   This only gates requests: a decide() that fails still throws BrainOfflineError, never a fake decision.
 */
export type SafeStopConfig = Pick<Config, 'SAFE_STOP_ENABLED' | 'SIMULATE_BRAIN_OFFLINE' | 'OG_ROUTER_URL'> &
  Partial<Pick<Config, 'OG_API_KEY' | 'GHOSTY_MODE' | 'OG_HEALTH_TIMEOUT_MS'>>;

export interface BrainProbeOptions {
  fetch?: typeof fetch;
  now?: () => number;
  /** Per-app runtime override of SIMULATE_BRAIN_OFFLINE (virtual pod). */
  sim?: BrainSwitch;
}

export const PING_TIMEOUT_MS = 15_000;
export const CACHE_TTL_MS = 10_000;
/** Consecutive failures before a known-good brain is reported offline. */
export const OFFLINE_AFTER_FAILURES = 2;

interface CacheEntry {
  online: boolean;
  at: number;
  /** Consecutive failures since the last success. */
  failures: number;
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

  const timeoutMs = config.OG_HEALTH_TIMEOUT_MS ?? PING_TIMEOUT_MS;
  const probe = pingRouter(key, opts.fetch ?? fetch, timeoutMs).then((ok) => {
    const entry = record(key, ok, now());
    inFlight.delete(key);
    return entry.online;
  });
  inFlight.set(key, probe);
  return probe;
}

/** Cheap reachability probe. `GET /models` needs no auth on the 0G Router. */
async function pingRouter(baseUrl: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetchImpl(`${baseUrl}/models`, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    // Only the status matters: cancel the (large) model list instead of downloading it under the timeout.
    await res.body?.cancel().catch(() => undefined);
    return res.ok;
  } catch {
    return false;
  }
}

/** Apply one probe outcome with hysteresis: success → online; failure → offline after 2 in a row (1 if never online). */
function record(key: string, ok: boolean, at: number): CacheEntry {
  const prev = cache.get(key);
  const entry: CacheEntry = ok
    ? { online: true, at, failures: 0 }
    : (() => {
        const failures = (prev?.failures ?? 0) + 1;
        return { online: prev?.online === true && failures < OFFLINE_AFTER_FAILURES, at, failures };
      })();
  cache.set(key, entry);
  return entry;
}

/** A real 0G call just failed: counts as one failure (offline after 2 in a row, or at once if never online). */
export function reportBrainFailure(routerUrl: string, now: () => number = Date.now): void {
  record(routerKey(routerUrl), false, now());
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
