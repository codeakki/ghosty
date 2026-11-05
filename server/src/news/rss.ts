import { FAKE_NOW, type NewsItem, type NewsProvider } from './types.js';

/** Crypto outlets we plan to poll. URLs from prior knowledge; verify each still serves RSS. */
export const RSS_FEEDS = {
  coindesk: 'https://www.coindesk.com/arc/outboundfeeds/rss/',
  cointelegraph: 'https://cointelegraph.com/rss',
  theblock: 'https://www.theblock.co/rss.xml',
  decrypt: 'https://decrypt.co/feed',
} as const;

export class FakeRssProvider implements NewsProvider {
  readonly name = 'rss';

  async fetchLatest(limit = 10): Promise<NewsItem[]> {
    const items: NewsItem[] = [
      {
        id: 'rss:coindesk:fake-1',
        source: 'rss',
        title: 'Missile strike near Strait of Hormuz sends oil and gold higher, bitcoin slips',
        url: 'https://www.coindesk.com/markets/fake-hormuz-strike',
        publishedAt: FAKE_NOW,
        handle: 'CoinDesk',
      },
      {
        id: 'rss:cointelegraph:fake-2',
        source: 'rss',
        title: 'Ether ETF inflows steady for a third day',
        url: 'https://cointelegraph.com/news/fake-eth-etf-inflows',
        publishedAt: '2026-11-07T08:30:00.000Z',
        handle: 'Cointelegraph',
      },
    ];
    return items.slice(0, limit);
  }
}

// TODO(news): real RSS provider. Poll RSS_FEEDS every 60 s, parse <item><title|link|pubDate|guid>.
// Option A: a tiny regex/XML parser (feeds are simple). Option B: add `fast-xml-parser` (tracked as an issue).
//
// export class RssProvider implements NewsProvider {
//   readonly name = 'rss';
//   constructor(private readonly feeds: Record<string, string> = RSS_FEEDS) {}
//   async fetchLatest(limit = 10): Promise<NewsItem[]> {
//     const results = await Promise.allSettled(
//       Object.entries(this.feeds).map(async ([outlet, url]) => parseRss(outlet, await (await fetch(url)).text())),
//     );
//     return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])).slice(0, limit);
//   }
// }
