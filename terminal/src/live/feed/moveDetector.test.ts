import { describe, expect, it } from 'vitest';
import { DEFAULT_MOVE_OPTIONS, detectMoves, seedRange, thresholdFromSearch, type DetectorState } from './moveDetector';

const T0 = Date.UTC(2026, 10, 6, 9, 30, 0);
const s = (n: number) => T0 + n * 1000;

/** A fast profile (0.25% / 60 s / 2 min throttle) so the window and throttle mechanics are quick to exercise. */
const FAST = { ...DEFAULT_MOVE_OPTIONS, thresholdPct: 0.25, windowMs: 60_000, throttleMs: 120_000 };

/** Feed a list of [secondsFromT0, price] ticks for one coin; collect all moves. */
function run(ticks: Array<[number, number]>, coin = 'BTC', init: DetectorState = {}, opts = FAST) {
  let state = init;
  const moves = [];
  for (const [sec, px] of ticks) {
    const r = detectMoves(state, { [coin]: px }, s(sec), opts);
    state = r.state;
    moves.push(...r.moves);
  }
  return { state, moves };
}

describe('market-move detector', () => {
  it('ignores moves under the threshold', () => {
    const { moves } = run([
      [0, 100],
      [10, 100.1],
      [20, 100.2],
    ]);
    expect(moves).toEqual([]);
  });

  it('emits a move at the threshold within the window, with sign and window length', () => {
    const { moves } = run([
      [0, 100],
      [30, 100.1],
      [45, 100.25],
    ]);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ coin: 'BTC', reason: 'move', price: 100.25, from: 100, windowSec: 45 });
    expect(moves[0]!.pct).toBeCloseTo(0.25, 5);
  });

  it('reports drops as negative moves', () => {
    const { moves } = run([
      [0, 200],
      [20, 199],
    ]);
    expect(moves).toHaveLength(1);
    expect(moves[0]!.pct).toBeCloseTo(-0.5, 5);
  });

  it('only compares against prices inside the window', () => {
    // 100 → 100.3 over 90 s is outside a 60 s window: each 60 s slice is only +0.1..0.2%.
    const { moves } = run([
      [0, 100],
      [30, 100.1],
      [61, 100.15],
      [90, 100.3],
    ]);
    expect(moves).toEqual([]);
  });

  it('throttles to one card per asset per 2 minutes', () => {
    const { moves } = run([
      [0, 100],
      [10, 101], // +1% → card
      [20, 102], // +1% again, throttled
      [100, 104], // still within 120 s of the first card
      [131, 106], // 121 s later: allowed again
    ]);
    expect(moves.map((m) => m.price)).toEqual([101, 106]);
  });

  it('throttles per asset, not globally', () => {
    let state: DetectorState = {};
    const out = [];
    for (const [sec, mids] of [
      [0, { BTC: 100, ETH: 10 }],
      [10, { BTC: 101, ETH: 10 }],
      [20, { BTC: 102, ETH: 10.1 }],
    ] as const) {
      const r = detectMoves(state, mids, s(sec), FAST);
      state = r.state;
      out.push(...r.moves.map((m) => m.coin));
    }
    expect(out).toEqual(['BTC', 'ETH']);
  });

  it('respects a custom threshold (URL override for local testing)', () => {
    const opts = { ...FAST, thresholdPct: 0.05 };
    const { moves } = run(
      [
        [0, 100],
        [5, 100.06],
      ],
      'BTC',
      {},
      opts,
    );
    expect(moves).toHaveLength(1);
  });

  it('only watches the coins it is told to', () => {
    const r1 = detectMoves({}, { BTC: 100, DOGE: 1 }, s(0), DEFAULT_MOVE_OPTIONS, new Set(['BTC']));
    const r2 = detectMoves(r1.state, { BTC: 100, DOGE: 2 }, s(5), DEFAULT_MOVE_OPTIONS, new Set(['BTC']));
    expect(r2.moves).toEqual([]);
    expect(Object.keys(r2.state)).toEqual(['BTC']);
  });

  it('flags a break of the seeded 1h high', () => {
    const seeded = seedRange({}, 'GOLD', [{ t: T0 - 20 * 60_000, h: 4100, l: 4050 }], T0);
    const { moves } = run(
      [
        [0, 4099],
        [30, 4103], // +0.1% in 30 s: no % move, but 0.07% above the 1h high
      ],
      'GOLD',
      seeded,
    );
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ reason: 'high', from: 4100 });
  });

  it('flags a break of the 1h low', () => {
    const seeded = seedRange({}, 'GOLD', [{ t: T0 - 20 * 60_000, h: 4100, l: 4050 }], T0);
    const { moves } = run(
      [
        [0, 4051],
        [30, 4047.5],
      ],
      'GOLD',
      seeded,
    );
    expect(moves[0]).toMatchObject({ reason: 'low', from: 4050 });
  });

  it('ignores a break that only grazes the level (needs threshold/5 = 0.05%)', () => {
    const seeded = seedRange({}, 'GOLD', [{ t: T0 - 20 * 60_000, h: 4100, l: 4050 }], T0);
    const { moves } = run(
      [
        [0, 4099],
        [30, 4101], // 0.024% above the high
      ],
      'GOLD',
      seeded,
    );
    expect(moves).toEqual([]);
  });

  it('does not call a fresh session high a 1h high without history', () => {
    const { moves } = run([
      [0, 100],
      [10, 100.05],
      [20, 100.1],
    ]);
    expect(moves).toEqual([]);
  });

  it('ignores a stale hourly candle', () => {
    const seeded = seedRange({}, 'GOLD', [{ t: T0 - 3 * 3600_000, h: 4100, l: 4050 }], T0);
    expect(seeded).toEqual({});
  });

  it('parses ?moveThreshold safely', () => {
    expect(thresholdFromSearch('?moveThreshold=0.05')).toBe(0.05);
    expect(thresholdFromSearch('')).toBe(0.5);
    expect(thresholdFromSearch('?moveThreshold=abc')).toBe(0.5);
    expect(thresholdFromSearch('?moveThreshold=-1')).toBe(0.5);
  });
});

describe('market-move detector: default rules (calm)', () => {
  it('needs ≥ 0.5% within 5 minutes', () => {
    const quiet = run([[0, 100], [120, 100.2], [290, 100.4]], 'BTC', {}, DEFAULT_MOVE_OPTIONS);
    expect(quiet.moves).toEqual([]);
    const loud = run([[0, 100], [120, 100.2], [290, 100.5]], 'BTC', {}, DEFAULT_MOVE_OPTIONS);
    expect(loud.moves).toHaveLength(1);
    expect(loud.moves[0]!.windowSec).toBe(290);
  });

  it('throttles to one card per asset per 10 minutes', () => {
    const { moves } = run(
      [
        [0, 100],
        [60, 101], // +1% → card
        [400, 103], // throttled (< 10 min)
        [661, 106], // 601 s after the first card → allowed
      ],
      'BTC',
      {},
      DEFAULT_MOVE_OPTIONS,
    );
    expect(moves.map((m) => m.price)).toEqual([101, 106]);
  });

  it('the default rule is only "0.5% in 5 min" or a 1h high/low: no day crossing, no demo threshold', () => {
    expect(DEFAULT_MOVE_OPTIONS).toMatchObject({ thresholdPct: 0.5, windowMs: 300_000, throttleMs: 600_000, dayPct: null });
    // A slow drift through −2% on the day, inside the 1h range, is not news under the default rule.
    let state: DetectorState = seedRange({}, 'BTC', [{ t: s(-1800), h: 99, l: 97 }], s(0));
    const out = [];
    for (const [sec, px] of [
      [0, 98.1],
      [400, 98.05],
      [800, 97.9],
    ] as const) {
      const r = detectMoves(state, { BTC: px }, s(sec), DEFAULT_MOVE_OPTIONS, undefined, { BTC: 100 });
      state = r.state;
      out.push(...r.moves);
    }
    expect(out).toEqual([]);
  });

  it('flags a new 1h high under the default rule, then stays quiet for 10 minutes', () => {
    const seeded = seedRange({}, 'BTC', [{ t: s(-1800), h: 100, l: 99 }], s(0));
    const { moves } = run(
      [
        [0, 99.9],
        [30, 100.2], // only +0.3%, but clears the 1h high by > 0.1% → row
        [90, 100.6], // higher still, but throttled
      ],
      'BTC',
      seeded,
      DEFAULT_MOVE_OPTIONS,
    );
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ reason: 'high', from: 100, price: 100.2 });
  });

  it('can flag a ±2% crossing on the day when enabled, once per crossing', () => {
    const DAY = { ...DEFAULT_MOVE_OPTIONS, dayPct: 2 };
    const prevDay = { BTC: 100 };
    let state: DetectorState = {};
    const out = [];
    // Slow drift (never 0.5% in 5 min) from −1.9% to −2.15%: only the crossing is news.
    for (const [sec, px] of [
      [0, 98.1],
      [400, 98.05],
      [800, 97.9],
      [1200, 97.85],
    ] as const) {
      const r = detectMoves(state, { BTC: px }, s(sec), DAY, undefined, prevDay);
      state = r.state;
      out.push(...r.moves);
    }
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ reason: 'day', from: 100, price: 97.9 });
    expect(out[0]!.pct).toBeCloseTo(-2.1, 5);
  });

  it('does not call the first sighting of a big day a "crossing"', () => {
    const r = detectMoves({}, { BTC: 95 }, s(0), { ...DEFAULT_MOVE_OPTIONS, dayPct: 2 }, undefined, { BTC: 100 });
    expect(r.moves).toEqual([]);
    expect(r.state.BTC!.dayBand).toBe(-1);
  });
});
