export interface NewsItem {
  /** Stable id, prefixed by source (e.g. "rss:coindesk:123"). */
  id: string;
  /** Provider name: rss, cryptopanic, polymarket, grok, claude-scout. */
  source: string;
  title: string;
  url: string;
  /** ISO 8601 timestamp. */
  publishedAt: string;
  /** X handle of the author or outlet, used for Ethos credibility scoring. */
  handle?: string;
  /** Publisher domain without www (coindesk.com), used for the static source-credibility table. */
  domain?: string;
  /** Short description or post text when the provider has one. */
  summary?: string;
  /** claude-scout only: the scout's one-line note on why it may move markets. Not read by the shock detector. */
  why?: string;
  /** CryptoPanic community votes collapsed to 0 (bearish) .. 1 (bullish); 0.5 = neutral/no votes. */
  sentiment?: number;
  /** Polymarket: implied probability (0..1) of the market's "Yes" outcome. */
  probability?: number;
  /** Polymarket: 24 h change of that probability, in probability units (-1..1). */
  probabilityChange24h?: number;
  /** 0.2..1.0 weight attached by credibility/weightItems (Ethos score and/or source table). */
  credibility?: number;
}

export interface NewsProvider {
  readonly name: string;
  /** Most recent items first. */
  fetchLatest(limit?: number): Promise<NewsItem[]>;
}

/** Fixed timestamp so fake providers stay deterministic across runs and tests. */
export const FAKE_NOW = '2026-11-07T09:00:00.000Z';

/** Fetch from every provider, tolerate individual failures, newest first, deduped by id. */
export async function fetchAll(providers: NewsProvider[], limitPerProvider = 10): Promise<NewsItem[]> {
  const settled = await Promise.allSettled(providers.map((p) => p.fetchLatest(limitPerProvider)));
  const seen = new Set<string>();
  const items: NewsItem[] = [];
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;
    for (const item of result.value) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }
  return items.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}
