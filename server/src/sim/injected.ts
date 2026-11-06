import type { NewsItem, NewsProvider } from '../news/types.js';

export interface InjectInput {
  title: string;
  /** Outlet or X handle (e.g. "Reuters"); used for credibility scoring. */
  source?: string;
  url?: string;
}

/**
 * News provider fed by hand through `POST /news/inject` (a user action from the terminal or the virtual pod).
 * Items are labelled source "manual" so they are never mistaken for a feed headline. They stay for the life
 * of the process, like a real feed's recent headlines.
 */
export class InjectedNewsProvider implements NewsProvider {
  readonly name = 'manual';
  private readonly items: NewsItem[] = [];
  private seq = 0;

  add(input: InjectInput): NewsItem {
    const item: NewsItem = {
      id: `manual:${++this.seq}`,
      source: 'manual',
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
