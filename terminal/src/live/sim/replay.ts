import type { ReplayEpisode } from '../../api/types';

/** One replayed episode every this many ms: steady enough to read each card as it lands. */
export const REPLAY_INTERVAL_MS = 1_200;

/** Oldest → newest, one card per request id (the server should already send them in order; never trust it). */
export function replayOrder(episodes: readonly ReplayEpisode[]): ReplayEpisode[] {
  const seen = new Set<string>();
  const unique = episodes.filter((e) => (seen.has(e.requestId) ? false : (seen.add(e.requestId), true)));
  return unique
    .map((e, i) => ({ e, i, t: Date.parse(e.ts) }))
    .sort((a, b) => (Number.isFinite(a.t) && Number.isFinite(b.t) && a.t !== b.t ? a.t - b.t : a.i - b.i))
    .map((x) => x.e);
}

export interface ReplayTimers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const realTimers: ReplayTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Play episodes back at a steady pace: the first one right away, then one every `intervalMs`.
 * `onStep(episode, index (1-based), total)`; `onDone()` after the last. Returns a cancel function.
 */
export function playReplay(
  episodes: readonly ReplayEpisode[],
  onStep: (episode: ReplayEpisode, index: number, total: number) => void,
  onDone: () => void,
  intervalMs = REPLAY_INTERVAL_MS,
  timers: ReplayTimers = realTimers,
): () => void {
  const order = replayOrder(episodes);
  let i = 0;
  let handle: unknown = null;
  let cancelled = false;
  const tick = () => {
    if (cancelled) return;
    const ep = order[i];
    if (!ep) {
      onDone();
      return;
    }
    i += 1;
    onStep(ep, i, order.length);
    if (i >= order.length) onDone();
    else handle = timers.set(tick, intervalMs);
  };
  tick();
  return () => {
    cancelled = true;
    if (handle !== null) timers.clear(handle);
  };
}
