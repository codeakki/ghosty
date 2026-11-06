/**
 * Coalesce bursts: actions that arrive within `windowMs` of the first queued one are applied together, in order,
 * in one render. A burst of SSE events (a decision, its alert, the state snapshot, a few ticks) then lands as one
 * layout change instead of a cascade of small jumps.
 */
export interface Batcher<A> {
  push(action: A): void;
  /** Apply whatever is queued now (used on unmount and in tests). */
  flush(): void;
  /** Drop the queue and any pending timer. */
  cancel(): void;
}

export interface TimerApi {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const realTimers: TimerApi = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export const BATCH_WINDOW_MS = 150;

export function createBatcher<A>(apply: (actions: A[]) => void, windowMs = BATCH_WINDOW_MS, timers: TimerApi = realTimers): Batcher<A> {
  let queue: A[] = [];
  let handle: unknown = null;

  const flush = () => {
    if (handle !== null) timers.clear(handle);
    handle = null;
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    apply(batch);
  };

  return {
    push(action) {
      queue.push(action);
      // The window opens with the first action; later ones ride along (no sliding window, so latency is bounded).
      if (handle === null) handle = timers.set(flush, windowMs);
    },
    flush,
    cancel() {
      if (handle !== null) timers.clear(handle);
      handle = null;
      queue = [];
    },
  };
}
