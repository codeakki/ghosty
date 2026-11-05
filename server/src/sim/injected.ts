import type { NewsItem, NewsProvider } from '../news/types.js';

export interface InjectInput {
  title: string;
  /** Outlet or X handle (e.g. "Reuters"); used for credibility scoring. */
  source?: string;
  url?: string;
}

/**
 * News provider fed by hand through `POST /news/inject` (virtual pod only).
 * Items stay for the life of the process, like a real feed's recent headlines.
 */
export class InjectedNewsProvider implements NewsProvider {
  readonly name = 'inject';
  private readonly items: NewsItem[] = [];
  private seq = 0;

  add(input: InjectInput): NewsItem {
    const item: NewsItem = {
      id: `inject:${++this.seq}`,
      source: 'inject',
      title: input.title,
      url: input.url ?? '',
      publishedAt: new Date().toISOString(),
      ...(input.source ? { handle: input.source } : {}),
    };
    this.items.unshift(item);
    return item;
  }

  async fetchLatest(limit = 10): Promise<NewsItem[]> {
    return this.items.slice(0, limit);
  }
}
