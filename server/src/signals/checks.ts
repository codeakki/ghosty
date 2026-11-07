import Anthropic from '@anthropic-ai/sdk';
import { POLYMARKET_GAMMA } from '../news/polymarket.js';
import type { PlannedAction } from '../execution/playbook.js';

/**
 * The two checks every signal gets before Ghosty speaks it:
 *  1. Prediction markets: related Polymarket markets, YES odds now vs one minute ago, and whether the move
 *     agrees with the strategy (Claude picks the markets and says which way agrees; the numbers are measured).
 *  2. Price: the asset on Hyperliquid and Binance over the last 1 and 5 minutes; a significant move is spoken.
 * Both are read-only public APIs. A failed check is reported as missing, never guessed.
 */

export const POLYMARKET_CLOB = 'https://clob.polymarket.com';
export const BINANCE_API = 'https://data-api.binance.vision';

export interface OddsMove {
  question: string;
  /** YES probability, 0..1. */
  oddsNow: number;
  odds1mAgo: number;
  /** oddsNow - odds1mAgo. */
  move: number;
  /** True when this move agrees with the strategy; null when the move is too small to count. */
  agrees: boolean | null;
}

export interface PriceMove {
  venue: 'hyperliquid' | 'binance';
  symbol: string;
  price: number;
  change1mPct: number;
  change5mPct: number;
  significant: boolean;
  /** Direction of the 5-minute move matches the strategy side. */
  agrees: boolean;
}

export interface SignalChecks {
  predictionMarkets: OddsMove[];
  prices: PriceMove[];
  /** Short sentences for the speaker, already filtered: agreeing odds moves and significant price moves. */
  spoken: string[];
  /** Checks that could not run, e.g. "polymarket: timeout". */
  errors: string[];
}

/** Odds must move at least this much (absolute, 0..1) in a minute to count. */
export const MIN_ODDS_MOVE = 0.01;

/** 5-minute move that counts as significant, in percent. Gold and oil move less than crypto. */
export function significantPct(coin: string): number {
  return /GOLD|CL|WTI|OIL|XAU|PAXG/i.test(coin) ? 0.2 : 0.5;
}

/** Binance spot symbol for a Hyperliquid coin, when one exists (PAXG tracks one ounce of gold). */
export function binanceSymbol(coin: string): string | undefined {
  const t = coin.replace(/^.*:/, '').toUpperCase();
  return ({ BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', GOLD: 'PAXGUSDT' } as Record<string, string>)[t];
}

const label = (coin: string) => ({ GOLD: 'gold', CL: 'oil', WTI: 'oil', BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana' } as Record<string, string>)[coin.replace(/^.*:/, '').toUpperCase()] ?? coin;
const pct = (n: number) => Math.abs(n).toFixed(n >= 1 || n <= -1 ? 1 : 2).replace(/\.?0+$/, '');

// ---------------------------------------------------------------------------
// Price check

/** Hyperliquid market for a playbook coin: the playbook says xyz:WTI, trade.xyz lists WTI crude as xyz:CL. */
export function hyperliquidCoin(coin: string): string {
  return coin.replace(/^xyz:WTI$/i, 'xyz:CL');
}

/** Closes of the last six 1-minute candles, oldest first: [t-5m … now]. */
async function hyperliquidCloses(coin: string, fetchImpl: typeof fetch, testnet: boolean): Promise<number[]> {
  const now = Date.now();
  const url = testnet ? 'https://api.hyperliquid-testnet.xyz/info' : 'https://api.hyperliquid.xyz/info';
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval: '1m', startTime: now - 7 * 60_000, endTime: now } }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`hyperliquid candles ${res.status}`);
  const candles = (await res.json()) as Array<{ c: string }>;
  return candles.slice(-6).map((k) => Number(k.c));
}

async function binanceCloses(symbol: string, fetchImpl: typeof fetch): Promise<number[]> {
  const res = await fetchImpl(`${BINANCE_API}/api/v3/klines?symbol=${symbol}&interval=1m&limit=6`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`binance klines ${res.status}`);
  return ((await res.json()) as Array<[number, string, string, string, string]>).map((k) => Number(k[4]));
}

export function priceMove(venue: PriceMove['venue'], symbol: string, closes: number[], side: 'long' | 'short'): PriceMove | undefined {
  if (closes.length < 2) return undefined;
  const now = closes[closes.length - 1]!;
  const change = (from: number) => ((now - from) / from) * 100;
  const change5mPct = change(closes[0]!);
  return {
    venue,
    symbol,
    price: now,
    change1mPct: change(closes[closes.length - 2]!),
    change5mPct,
    significant: Math.abs(change5mPct) >= significantPct(symbol),
    agrees: side === 'long' ? change5mPct > 0 : change5mPct < 0,
  };
}

// ---------------------------------------------------------------------------
// Prediction market check

interface Candidate {
  question: string;
  tokenId: string;
  volume24h: number;
}

const STOP = new Set(
  'the a an of to in on for and or with at by from as is are was were be been after over into amid says said new report reports'.split(' '),
);

/** A few distinctive words from the headline for the Polymarket search. */
export function searchTerms(headline: string): string {
  return headline
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .slice(0, 4)
    .join(' ');
}

async function candidateMarkets(headline: string, fetchImpl: typeof fetch): Promise<Candidate[]> {
  const q = encodeURIComponent(searchTerms(headline));
  const res = await fetchImpl(`${POLYMARKET_GAMMA}/public-search?q=${q}&limit_per_type=10`, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`polymarket search ${res.status}`);
  const body = (await res.json()) as {
    events?: Array<{ markets?: Array<{ question?: string; active?: boolean; closed?: boolean; clobTokenIds?: string; volume24hr?: number }> }>;
  };
  const out: Candidate[] = [];
  for (const e of body.events ?? []) {
    for (const m of e.markets ?? []) {
      if (!m.active || m.closed || !m.clobTokenIds || !m.question) continue;
      try {
        const [yes] = JSON.parse(m.clobTokenIds) as string[];
        if (yes) out.push({ question: m.question, tokenId: yes, volume24h: m.volume24hr ?? 0 });
      } catch {
        // malformed token list: skip the market
      }
    }
  }
  return out.sort((a, b) => b.volume24h - a.volume24h).slice(0, 8);
}

/** YES odds now and one minute earlier, from the CLOB's 1-minute history. */
export async function oddsNowAndMinuteAgo(tokenId: string, fetchImpl: typeof fetch): Promise<{ now: number; minuteAgo: number } | undefined> {
  const res = await fetchImpl(`${POLYMARKET_CLOB}/prices-history?market=${tokenId}&interval=1h&fidelity=1`, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`polymarket history ${res.status}`);
  const history = ((await res.json()) as { history?: Array<{ t: number; p: number }> }).history ?? [];
  if (history.length === 0) return undefined;
  const last = history[history.length - 1]!;
  const before = [...history].reverse().find((h) => h.t <= last.t - 60) ?? history[0]!;
  return { now: last.p, minuteAgo: before.p };
}

/** Which candidate markets relate to the signal, and does a rising YES agree with the strategy? */
export interface MarketPicker {
  pick(headline: string, strategy: string, candidates: string[]): Promise<Array<{ index: number; yesRisingAgrees: boolean }>>;
}

export class ClaudeMarketPicker implements MarketPicker {
  private readonly client: Pick<Anthropic, 'messages'>;

  constructor(private readonly opts: { apiKey?: string; model: string; client?: Pick<Anthropic, 'messages'> }) {
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, maxRetries: 0, timeout: 15_000 });
  }

  async pick(headline: string, strategy: string, candidates: string[]) {
    const response = await this.client.messages.create({
      model: this.opts.model,
      max_tokens: 2048,
      output_config: {
        effort: 'medium',
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              markets: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { index: { type: 'integer' }, yesRisingAgrees: { type: 'boolean' } },
                  required: ['index', 'yesRisingAgrees'],
                  additionalProperties: false,
                },
              },
            },
            required: ['markets'],
            additionalProperties: false,
          },
        },
      },
      system:
        'You match prediction markets to a trading signal. Pick at most two markets that are clearly about the same event or its direct consequences. ' +
        'For each, say whether the YES odds going UP would support the strategy. Pick none if nothing is clearly related.',
      messages: [
        {
          role: 'user',
          content: `Headline: ${headline}\nStrategy: ${strategy}\nMarkets:\n${candidates.map((q, i) => `${i}. ${q}`).join('\n')}`,
        },
      ],
    });
    const text = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
    const parsed = JSON.parse(text) as { markets: Array<{ index: number; yesRisingAgrees: boolean }> };
    return parsed.markets.filter((m) => m.index >= 0 && m.index < candidates.length).slice(0, 2);
  }
}

// ---------------------------------------------------------------------------

export interface SignalCheckDeps {
  picker?: MarketPicker;
  fetch?: typeof fetch;
  testnet?: boolean;
}

/** Runs both checks for a signal. Never throws: failures land in `errors`. */
export async function runSignalChecks(
  signal: { headline: string; actions: PlannedAction[] },
  deps: SignalCheckDeps,
): Promise<SignalChecks> {
  const fetchImpl = deps.fetch ?? fetch;
  const errors: string[] = [];
  const strategy = signal.actions.map((a) => `${a.side} ${label(a.coin)}`).join(', ') || 'no trade';

  const odds = (async (): Promise<OddsMove[]> => {
    if (!deps.picker) return [];
    try {
      const candidates = await candidateMarkets(signal.headline, fetchImpl);
      if (candidates.length === 0) return [];
      const picks = await deps.picker.pick(signal.headline, strategy, candidates.map((c) => c.question));
      const moves = await Promise.all(
        picks.map(async ({ index, yesRisingAgrees }) => {
          const c = candidates[index]!;
          const o = await oddsNowAndMinuteAgo(c.tokenId, fetchImpl);
          if (!o) return undefined;
          const move = o.now - o.minuteAgo;
          const agrees = Math.abs(move) < MIN_ODDS_MOVE ? null : (move > 0) === yesRisingAgrees;
          return { question: c.question, oddsNow: o.now, odds1mAgo: o.minuteAgo, move, agrees };
        }),
      );
      return moves.filter((m): m is OddsMove => m !== undefined);
    } catch (err) {
      errors.push(`polymarket: ${(err as Error).message}`);
      return [];
    }
  })();

  const prices = Promise.all(
    signal.actions.map(async (a) => {
      const out: PriceMove[] = [];
      try {
        const coin = hyperliquidCoin(a.coin);
        const m = priceMove('hyperliquid', coin, await hyperliquidCloses(coin, fetchImpl, deps.testnet ?? false), a.side);
        if (m) out.push(m);
      } catch (err) {
        errors.push(`hyperliquid ${a.coin}: ${(err as Error).message}`);
      }
      const sym = binanceSymbol(a.coin);
      if (sym) {
        try {
          const m = priceMove('binance', sym, await binanceCloses(sym, fetchImpl), a.side);
          if (m) out.push(m);
        } catch (err) {
          errors.push(`binance ${sym}: ${(err as Error).message}`);
        }
      }
      return out;
    }),
  ).then((all) => all.flat());

  const [predictionMarkets, priceMoves] = await Promise.all([odds, prices]);
  const spoken: string[] = [];
  for (const m of predictionMarkets) {
    if (m.agrees) {
      spoken.push(
        `Polymarket agrees: ${m.question.replace(/\?$/, '')} moved from ${Math.round(m.odds1mAgo * 100)} to ${Math.round(m.oddsNow * 100)} percent in the last minute.`,
      );
    }
  }
  // One sentence per asset: prefer Hyperliquid, where the trade would happen.
  const seen = new Set<string>();
  for (const p of priceMoves) {
    const asset = label(p.symbol === 'PAXGUSDT' ? 'GOLD' : p.symbol.replace(/USDT$/, ''));
    if (!p.significant || seen.has(asset)) continue;
    seen.add(asset);
    spoken.push(`${asset[0]!.toUpperCase()}${asset.slice(1)} is ${p.change5mPct > 0 ? 'up' : 'down'} ${pct(p.change5mPct)} percent in five minutes on ${p.venue === 'hyperliquid' ? 'Hyperliquid' : 'Binance'}.`);
  }
  return { predictionMarkets, prices: priceMoves, spoken, errors };
}
