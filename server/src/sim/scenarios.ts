import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Simulation scenarios: real past events, real headlines (with a source URL each) and the markets we can price
 * from keyless historical candles. Files live in src/sim/scenarios/*.json.
 */

const Iso = z.string().refine((s) => Number.isFinite(Date.parse(s)), 'must be an ISO 8601 timestamp');

export const ScenarioMarketSchema = z.object({
  /** Coin name the decider sees and trades (same spelling as the live watchlist, e.g. "BTC", "xyz:GOLD"). */
  coin: z.string().min(1),
  /** Keyless historical price source. */
  source: z.enum(['binance', 'hyperliquid']),
  /** Binance symbol ("BTCUSDT") or Hyperliquid coin ("BTC"). */
  symbol: z.string().min(1),
  /** Set when the price series stands in for the coin (e.g. PAXG for gold). */
  proxy: z.string().optional(),
});

export const ScenarioHeadlineSchema = z.object({
  ts: Iso,
  title: z.string().min(1),
  source: z.string().min(1),
  url: z.string().url(),
  handle: z.string().optional(),
  /** How exact `ts` is (most outlets do not publish the minute). */
  tsNote: z.string().optional(),
});

export const ScenarioSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    title: z.string().min(1),
    description: z.string().min(1),
    category: z.string().optional(),
    start: Iso,
    end: Iso,
    interval: z.enum(['1m', '5m', '15m', '1h']).default('15m'),
    markets: z.array(ScenarioMarketSchema).min(1),
    headlines: z.array(ScenarioHeadlineSchema).min(1),
    sources: z.array(z.string()).default([]),
  })
  .refine((s) => Date.parse(s.end) > Date.parse(s.start), 'end must be after start')
  .refine(
    (s) => s.headlines.every((h) => Date.parse(h.ts) >= Date.parse(s.start) && Date.parse(h.ts) <= Date.parse(s.end)),
    'every headline must fall inside [start, end]',
  );

export type Scenario = z.infer<typeof ScenarioSchema>;
export type ScenarioMarket = z.infer<typeof ScenarioMarketSchema>;
export type ScenarioHeadline = z.infer<typeof ScenarioHeadlineSchema>;

/** src/sim/scenarios from tsx; from dist/sim the JSON is not copied by tsc, so fall back to the source tree. */
const CANDIDATE_DIRS = [
  fileURLToPath(new URL('./scenarios/', import.meta.url)),
  fileURLToPath(new URL('../../src/sim/scenarios/', import.meta.url)),
];

export function scenarioDir(): string {
  return CANDIDATE_DIRS.find((d) => existsSync(d)) ?? CANDIDATE_DIRS[0]!;
}

/** Every scenario file, headlines sorted by time. Throws on an invalid file (a broken scenario is a bug). */
export function loadScenarios(dir = scenarioDir()): Scenario[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const parsed = ScenarioSchema.safeParse(JSON.parse(readFileSync(join(dir, f), 'utf8')));
      if (!parsed.success) throw new Error(`invalid scenario ${f}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
      return { ...parsed.data, headlines: [...parsed.data.headlines].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)) };
    });
}
