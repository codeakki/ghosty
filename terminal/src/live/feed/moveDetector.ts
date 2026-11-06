/**
 * Market-move detector: turns the real SSE `market` mids into a few "this just moved" events.
 * Pure (time comes in as an argument), so it is unit-tested without a browser.
 *
 * A move is emitted when a watched asset
 *  - moves at least `thresholdPct` within the last `windowMs` (default 0.5% in 5 min), or
 *  - breaks its rolling 1 h high or low, or
 *  - crosses ±`dayPct` (default 2%) on the day (versus the previous day's close from /market/snapshot).
 * At most one move per asset per `throttleMs` (default 10 min): market moves are context, not the story.
 * A high/low break must clear the old level by a fifth of the threshold (0.1% by default), so a
 * one-tick wobble across the level is not news.
 *
 * The 1 h range is built from one-minute buckets of observed ticks, seeded with the in-progress hourly
 * candle from GET /market/history. A break only counts once the range covers at least `minRangeMs`
 * (seeded, or observed for 10 min), so a fresh page load does not call every first tick a "new high".
 */

export interface MoveOptions {
  thresholdPct: number;
  windowMs: number;
  throttleMs: number;
  rangeMs: number;
  minRangeMs: number;
  dayPct: number;
}

export const DEFAULT_MOVE_OPTIONS: MoveOptions = {
  thresholdPct: 0.5,
  windowMs: 5 * 60_000,
  throttleMs: 10 * 60_000,
  rangeMs: 60 * 60_000,
  minRangeMs: 10 * 60_000,
  dayPct: 2,
};

interface Sample {
  t: number;
  px: number;
}

interface Bucket {
  /** Minute index (floor(t / 60 s)). */
  m: number;
  h: number;
  l: number;
}

export interface CoinTrack {
  samples: Sample[];
  buckets: Bucket[];
  /** High/low of the in-progress hourly candle (from /market/history), if seeded. */
  seed: { h: number; l: number; at: number } | null;
  firstAt: number;
  lastEmitAt: number | null;
  /** Which side of ±dayPct the day change was on at the last tick (null until first seen with a reference). */
  dayBand: -1 | 0 | 1 | null;
}

export type DetectorState = Record<string, CoinTrack>;

export type MoveReason = 'move' | 'high' | 'low' | 'day';

export interface MarketMove {
  coin: string;
  price: number;
  /** Signed % change versus the reference (window start, or the broken level). */
  pct: number;
  reason: MoveReason;
  /** Reference price: oldest price in the window, the 1 h high/low that broke, or the previous day's close. */
  from: number;
  /** Seconds covered by a `move` (oldest sample in window → now). */
  windowSec: number;
  at: number;
}

const MINUTE = 60_000;

function emptyTrack(at: number): CoinTrack {
  return { samples: [], buckets: [], seed: null, firstAt: at, lastEmitAt: null, dayBand: null };
}

/** Seed the 1 h range from hourly candles (newest last). Only the in-progress hour is used. */
export function seedRange(
  state: DetectorState,
  coin: string,
  candles: ReadonlyArray<{ t: number; h: number; l: number }>,
  at: number,
): DetectorState {
  const last = candles[candles.length - 1];
  if (!last || !(last.h > 0) || !(last.l > 0)) return state;
  // A candle more than 1 h old says nothing about the last hour.
  if (at - last.t > 60 * MINUTE) return state;
  const track = state[coin] ?? emptyTrack(at);
  return { ...state, [coin]: { ...track, seed: { h: last.h, l: last.l, at: last.t } } };
}

function rangeOf(track: CoinTrack, at: number, opts: MoveOptions): { h: number; l: number; covered: number } | null {
  const minM = Math.floor((at - opts.rangeMs) / MINUTE);
  let h = -Infinity;
  let l = Infinity;
  for (const b of track.buckets) {
    if (b.m < minM) continue;
    if (b.h > h) h = b.h;
    if (b.l < l) l = b.l;
  }
  let covered = at - track.firstAt;
  if (track.seed && at - track.seed.at <= opts.rangeMs) {
    if (track.seed.h > h) h = track.seed.h;
    if (track.seed.l < l) l = track.seed.l;
    covered = Math.max(covered, at - track.seed.at, opts.minRangeMs);
  }
  if (!Number.isFinite(h) || !Number.isFinite(l)) return null;
  return { h, l, covered };
}

/**
 * Feed one tick of mids. Returns the next state and the moves to show (at most one per coin).
 * `watch` limits detection to the watched coins; unknown coins are ignored.
 */
export function detectMoves(
  state: DetectorState,
  mids: Readonly<Record<string, number>>,
  at: number,
  opts: MoveOptions = DEFAULT_MOVE_OPTIONS,
  watch?: ReadonlySet<string>,
  /** Previous day's close per coin (from /market/snapshot), for the ±dayPct crossing. */
  prevDay?: Readonly<Record<string, number>>,
): { state: DetectorState; moves: MarketMove[] } {
  const next: DetectorState = { ...state };
  const moves: MarketMove[] = [];

  for (const [coin, px] of Object.entries(mids)) {
    if (!(px > 0)) continue;
    if (watch && !watch.has(coin)) continue;
    const prev = state[coin] ?? emptyTrack(at);

    // Range before this tick, so a tick can break it.
    const range = rangeOf(prev, at, opts);

    // Window samples (keep a little history past the window for the reference price).
    const cutoff = at - opts.windowMs;
    const samples = prev.samples.filter((s) => s.t >= cutoff);
    const oldest = samples[0];

    // One-minute buckets for the rolling 1 h range.
    const m = Math.floor(at / MINUTE);
    const minM = Math.floor((at - opts.rangeMs) / MINUTE);
    const buckets = prev.buckets.filter((b) => b.m >= minM);
    const lastBucket = buckets[buckets.length - 1];
    if (lastBucket && lastBucket.m === m) {
      buckets[buckets.length - 1] = { m, h: Math.max(lastBucket.h, px), l: Math.min(lastBucket.l, px) };
    } else {
      buckets.push({ m, h: px, l: px });
    }

    // Day band: which side of ±dayPct the change on the day is on. The first sighting only records it.
    const ref = prevDay?.[coin];
    const dayPctNow = ref && ref > 0 ? ((px - ref) / ref) * 100 : null;
    const band: -1 | 0 | 1 | null = dayPctNow === null ? null : dayPctNow >= opts.dayPct ? 1 : dayPctNow <= -opts.dayPct ? -1 : 0;
    const crossedDay = band !== null && band !== 0 && prev.dayBand !== null && band !== prev.dayBand;

    let track: CoinTrack = { ...prev, samples: [...samples, { t: at, px }], buckets, dayBand: band ?? prev.dayBand };

    const throttled = prev.lastEmitAt !== null && at - prev.lastEmitAt < opts.throttleMs;
    if (!throttled) {
      let move: MarketMove | null = null;
      if (oldest && oldest.t < at) {
        const pct = ((px - oldest.px) / oldest.px) * 100;
        if (Math.abs(pct) >= opts.thresholdPct) {
          move = { coin, price: px, pct, reason: 'move', from: oldest.px, windowSec: Math.round((at - oldest.t) / 1000), at };
        }
      }
      if (!move && crossedDay && ref && dayPctNow !== null) {
        move = { coin, price: px, pct: dayPctNow, reason: 'day', from: ref, windowSec: 86_400, at };
      }
      if (!move && range && range.covered >= opts.minRangeMs) {
        const margin = opts.thresholdPct / 5 / 100;
        if (px > range.h * (1 + margin)) {
          move = { coin, price: px, pct: ((px - range.h) / range.h) * 100, reason: 'high', from: range.h, windowSec: 3600, at };
        } else if (px < range.l * (1 - margin)) {
          move = { coin, price: px, pct: ((px - range.l) / range.l) * 100, reason: 'low', from: range.l, windowSec: 3600, at };
        }
      }
      if (move) {
        moves.push(move);
        // Reset the window so the same move is not reported again from the same base.
        track = { ...track, samples: [{ t: at, px }], lastEmitAt: at };
      }
    }
    next[coin] = track;
  }
  return { state: next, moves };
}

/** Parse `?moveThreshold=0.05` (percent). Out-of-range or missing values fall back to the default. */
export function thresholdFromSearch(search: string): number {
  const raw = new URLSearchParams(search).get('moveThreshold');
  if (raw === null) return DEFAULT_MOVE_OPTIONS.thresholdPct;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 50 ? n : DEFAULT_MOVE_OPTIONS.thresholdPct;
}
