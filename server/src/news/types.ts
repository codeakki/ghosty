export interface NewsItem {
  /** Stable id, prefixed by source (e.g. "rss:coindesk:123"). */
  id: string;
  /** Provider name: rss, cryptopanic, polymarket, grok. */
  source: string;
  title: string;
  url: string;
  /** ISO 8601 timestamp. */
  publishedAt: string;
  /** X handle of the author or outlet, used for Ethos credibility scoring. */
  handle?: string;
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
