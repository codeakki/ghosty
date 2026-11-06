import { DEFAULT_TIMEOUT_MS, fetchJson, HttpError, type FetchLike } from './http.js';
import { type NewsItem, type NewsProvider } from './types.js';

/** Polymarket Gamma API, no auth. */
export const POLYMARKET_GAMMA = 'https://gamma-api.polymarket.com';

export const DEFAULT_POLYMARKET_KEYWORDS = ['war', 'strike', 'ceasefire', 'invasion', 'sanction', 'missile', 'nuclear'];

export class FakePolymarketProvider implements NewsProvider {
  readonly name = 'polymarket';

  async fetchLatest(limit = 10): Promise<NewsItem[]> {
    const items: NewsItem[] = [
      {
        id: 'polymarket:fake-1',
        source: 'polymarket',
        title: 'Odds of a direct military strike on oil infrastructure this month jump to 41%',
        url: 'https://polymarket.com/event/fake-oil-infrastructure-strike',
        publishedAt: '2026-11-07T08:55:00.000Z',
        probability: 0.41,
      },
      {
        id: 'polymarket:fake-2',
        source: 'polymarket',
        title: 'Fed cuts rates in December: 63%',
        url: 'https://polymarket.com/event/fake-fed-december',
        publishedAt: '2026-11-07T05:00:00.000Z',
        probability: 0.63,
      },
    ];
    return items.slice(0, limit);
  }
}

/** Subset of the Gamma market object we read. outcomes/outcomePrices are JSON-encoded strings. */
export interface GammaMarket {
  id: string | number;
  question?: string;
  slug?: string;
  outcomes?: string | string[];
  outcomePrices?: string | Array<string | number>;
  lastTradePrice?: number;
  oneDayPriceChange?: number;
  volume24hr?: number;
  active?: boolean;
  closed?: boolean;
  updatedAt?: string;
}

export interface GammaEvent {
  id: string | number;
  title?: string;
  slug?: string;
  updatedAt?: string;
  volume24hr?: number;
  closed?: boolean;
  markets?: GammaMarket[];
}

function parseList(value: string | Array<string | number> | undefined): Array<string | number> {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as Array<string | number>) : [];
  } catch {
    return [];
  }
}

/** Implied probability of "Yes" (or of the first outcome when there is no Yes/No pair). */
export function yesProbability(market: GammaMarket): number | undefined {
  const outcomes = parseList(market.outcomes).map((o) => String(o).toLowerCase());
  const prices = parseList(market.outcomePrices).map(Number);
  const idx = Math.max(0, outcomes.indexOf('yes'));
  const p = prices[idx] ?? market.lastTradePrice;
  return typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1 ? p : undefined;
}

/** Word-prefix match: "sanction" hits "sanctions", "strike" hits "strikes", not "airstrike-free" substrings mid-word. */
export function keywordMatcher(keywords: string[]): (text: string) => boolean {
  const escaped = keywords.map((k) => k.trim().toLowerCase()).filter(Boolean).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (escaped.length === 0) return () => true;
  const re = new RegExp(`\\b(${escaped.join('|')})`, 'i');
  return (text) => re.test(text);
}

const pct = (p: number) => `${Math.round(p * 100)}%`;

/** Turn Gamma events into one NewsItem per open, keyword-matching market (best volume first). */
export function eventsToItems(events: GammaEvent[], keywords: string[], fetchedAt = new Date().toISOString()): NewsItem[] {
  const matches = keywordMatcher(keywords);
  const items: Array<NewsItem & { volume: number }> = [];
  for (const event of events) {
    if (event.closed) continue;
    const eventHit = matches(event.title ?? '');
    for (const market of event.markets ?? []) {
      if (market.closed || market.active === false) continue;
      const question = market.question ?? event.title;
      if (!question || !(eventHit || matches(question))) continue;
      const probability = yesProbability(market);
      if (probability === undefined) continue;
      const change = typeof market.oneDayPriceChange === 'number' ? market.oneDayPriceChange : undefined;
      const delta = change === undefined ? '' : `, ${change >= 0 ? '+' : ''}${Math.round(change * 100)} pts 24h`;
      items.push({
        id: `polymarket:${market.id}`,
        source: 'polymarket',
        title: `${question} (Polymarket ${pct(probability)} yes${delta})`,
        url: `https://polymarket.com/event/${event.slug ?? market.slug ?? market.id}`,
        publishedAt: market.updatedAt ?? event.updatedAt ?? fetchedAt,
        domain: 'polymarket.com',
        probability,
        ...(change !== undefined ? { probabilityChange24h: change } : {}),
        volume: market.volume24hr ?? event.volume24hr ?? 0,
      });
    }
  }
  return items.sort((a, b) => b.volume - a.volume).map(({ volume: _volume, ...item }) => item);
}

export interface PolymarketProviderOptions {
  keywords?: string[];
  /** Gamma tag_slug filter, e.g. "geopolitics". */
  tagSlug?: string;
  /** How many events to scan per poll. */
  scan?: number;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: FetchLike;
}

/**
 * Open geopolitical prediction markets as "how likely" signals. Scans the highest 24 h volume open
 * events and keeps markets whose event title or question matches a keyword.
 */
export class PolymarketProvider implements NewsProvider {
  readonly name = 'polymarket';
  private readonly keywords: string[];

  constructor(private readonly opts: PolymarketProviderOptions = {}) {
    this.keywords = opts.keywords ?? DEFAULT_POLYMARKET_KEYWORDS;
  }

  eventsUrl(ordered = true): string {
    const params = new URLSearchParams({ active: 'true', closed: 'false', limit: String(this.opts.scan ?? 200) });
    if (ordered) {
      params.set('order', 'volume24hr');
      params.set('ascending', 'false');
    }
    if (this.opts.tagSlug) params.set('tag_slug', this.opts.tagSlug);
    return `${this.opts.baseUrl ?? POLYMARKET_GAMMA}/events?${params.toString()}`;
  }

  async fetchLatest(limit = 20): Promise<NewsItem[]> {
    const req = { fetch: this.opts.fetch, timeoutMs: this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS };
    let events: GammaEvent[];
    try {
      events = await fetchJson<GammaEvent[]>(this.eventsUrl(true), req);
    } catch (err) {
      // `order` field names are not in the public docs we could reach; retry unordered on a 4xx.
      if (!(err instanceof HttpError) || err.status < 400 || err.status >= 500) throw err;
      events = await fetchJson<GammaEvent[]>(this.eventsUrl(false), req);
    }
    return eventsToItems(Array.isArray(events) ? events : [], this.keywords).slice(0, limit);
  }
}
