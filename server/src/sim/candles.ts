import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDataDir } from '../agent/storage.js';
import type { Scenario, ScenarioMarket } from './scenarios.js';

/** One historical candle. t = open time (ms). */
export interface SimCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

/** coin → candles (oldest first) covering the scenario window. */
export type CandleSet = Record<string, SimCandle[]>;

export type CandleLoader = (scenario: Scenario) => Promise<CandleSet>;

const INTERVAL_MS: Record<Scenario['interval'], number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000 };
const BINANCE_URL = 'https://data-api.binance.vision/api/v3/klines';
const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
const FETCH_TIMEOUT_MS = 15_000;

export function intervalMs(interval: Scenario['interval']): number {
  return INTERVAL_MS[interval];
}

/**
 * Historical mid at `t`: linear between the candle's open and close (candles are too coarse for a real mid,
 * this keeps the playback smooth). Before the first candle → its open; after the last → its close.
 */
export function priceAt(candles: SimCandle[], t: number, stepMs: number): number | null {
  if (candles.length === 0) return null;
  const first = candles[0]!;
  if (t <= first.t) return first.o;
  let lo = 0;
  let hi = candles.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (candles[mid]!.t <= t) lo = mid;
    else hi = mid - 1;
  }
  const k = candles[lo]!;
  const frac = Math.min(1, Math.max(0, (t - k.t) / stepMs));
  return k.o + (k.c - k.o) * frac;
}

async function getJson(fetchImpl: typeof fetch, url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

async function fetchBinance(fetchImpl: typeof fetch, m: ScenarioMarket, interval: string, start: number, end: number): Promise<SimCandle[]> {
  const out: SimCandle[] = [];
  let from = start;
  while (from < end) {
    const url = `${BINANCE_URL}?symbol=${encodeURIComponent(m.symbol)}&interval=${interval}&startTime=${from}&endTime=${end}&limit=1000`;
    const rows = (await getJson(fetchImpl, url)) as Array<[number, string, string, string, string]>;
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) out.push({ t: r[0], o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]) });
    from = rows.at(-1)![0] + 1;
    if (rows.length < 1000) break;
  }
  return out;
}

async function fetchHyperliquid(fetchImpl: typeof fetch, m: ScenarioMarket, interval: string, start: number, end: number): Promise<SimCandle[]> {
  const rows = (await getJson(fetchImpl, HL_INFO_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'candleSnapshot', req: { coin: m.symbol, interval, startTime: start, endTime: end } }),
  })) as Array<{ t: number; o: string; h: string; l: string; c: string }>;
  return (Array.isArray(rows) ? rows : []).map((r) => ({ t: r.t, o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c) }));
}

/**
 * Real historical candles from keyless public APIs (Binance public klines, Hyperliquid candleSnapshot), cached
 * as JSON under <dataDir>/candles/ so a scenario is fetched once.
 */
export function createCandleLoader(opts: { dataDir: string; fetch?: typeof fetch }): CandleLoader {
  const fetchImpl = opts.fetch ?? fetch;
  return async (scenario) => {
    const dir = ensureDataDir(join(opts.dataDir, 'candles'));
    const start = Date.parse(scenario.start) - intervalMs(scenario.interval);
    const end = Date.parse(scenario.end);
    const set: CandleSet = {};
    for (const m of scenario.markets) {
      const file = join(dir, `${m.source}-${m.symbol.replace(/[^a-z0-9]/gi, '_')}-${scenario.interval}-${start}-${end}.json`);
      let candles: SimCandle[] | undefined;
      if (existsSync(file)) candles = JSON.parse(readFileSync(file, 'utf8')) as SimCandle[];
      if (!candles || candles.length === 0) {
        candles =
          m.source === 'binance'
            ? await fetchBinance(fetchImpl, m, scenario.interval, start, end)
            : await fetchHyperliquid(fetchImpl, m, scenario.interval, start, end);
        if (candles.length === 0) throw new Error(`no ${m.source} candles for ${m.symbol} in ${scenario.start}..${scenario.end}`);
        writeFileSync(file, JSON.stringify(candles));
      }
      set[m.coin] = candles.sort((a, b) => a.t - b.t);
    }
    return set;
  };
}
