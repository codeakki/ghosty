import { useSyncExternalStore } from 'react';

/**
 * One shared 1 s clock for every relative timestamp. Components that read it re-render on the tick; nothing else
 * does (the feed list and cards stay memoised).
 */
const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (timer === null) {
    timer = setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, 1000);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function useClock(): number {
  return useSyncExternalStore(subscribe, () => now, () => now);
}

const unit = (u: 'second' | 'minute' | 'hour' | 'day') => new Intl.NumberFormat(undefined, { style: 'unit', unit: u, unitDisplay: 'narrow' });
const SEC = unit('second');
const MIN = unit('minute');
const HOUR = unit('hour');
const DAY = unit('day');

/** "just now" → "12s ago" → "3m ago" → "2h ago" → "1d ago". Future times (clock skew) read as "just now". */
export function formatSince(ms: number, at: number): string {
  const s = Math.floor((at - ms) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${SEC.format(s)} ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${MIN.format(m)} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${HOUR.format(h)} ago`;
  return `${DAY.format(Math.floor(h / 24))} ago`;
}
