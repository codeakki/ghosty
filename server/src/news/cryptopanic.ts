import { type NewsItem, type NewsProvider } from './types.js';

/** Docs: https://cryptopanic.com/developers/api/ (free token, ~5 req/s, includes votes/sentiment). */
export const CRYPTOPANIC_DOCS = 'https://cryptopanic.com/developers/api/';

export class FakeCryptoPanicProvider implements NewsProvider {
  readonly name = 'cryptopanic';

  async fetchLatest(limit = 10): Promise<NewsItem[]> {
    const items: NewsItem[] = [
      {
        id: 'cryptopanic:fake-1',
        source: 'cryptopanic',
        title: 'Reports of a military invasion across the border; risk assets sell off',
        url: 'https://cryptopanic.com/news/fake-invasion',
        publishedAt: '2026-11-07T08:58:00.000Z',
        handle: 'DeItaone',
      },
      {
        id: 'cryptopanic:fake-2',
        source: 'cryptopanic',
        title: 'Solana validator client ships performance update',
        url: 'https://cryptopanic.com/news/fake-solana-client',
        publishedAt: '2026-11-07T07:45:00.000Z',
      },
      {
        id: 'cryptopanic:fake-3',
        source: 'cryptopanic',
        title: 'Analysts expect range-bound BTC into the weekend',
        url: 'https://cryptopanic.com/news/fake-btc-range',
        publishedAt: '2026-11-07T06:00:00.000Z',
      },
    ];
    return items.slice(0, limit);
  }
}

// TODO(news): real CryptoPanic provider. Token in CRYPTOPANIC_TOKEN.
// Endpoint: GET https://cryptopanic.com/api/v1/posts/?auth_token=<token>&public=true&kind=news
// (newer accounts may get the /api/developer/v2/posts/ path; confirm against CRYPTOPANIC_DOCS).
// Map: results[].{id,title,url,published_at,source.domain} → NewsItem; keep votes for sentiment later.
//
// export class CryptoPanicProvider implements NewsProvider {
//   readonly name = 'cryptopanic';
//   constructor(private readonly token: string) {}
//   async fetchLatest(limit = 10): Promise<NewsItem[]> {
//     const url = `https://cryptopanic.com/api/v1/posts/?auth_token=${this.token}&public=true&kind=news`;
//     const json = (await (await fetch(url)).json()) as { results: Array<{ id: number; title: string; url: string; published_at: string }> };
//     return json.results.slice(0, limit).map((r) => ({
//       id: `cryptopanic:${r.id}`, source: 'cryptopanic', title: r.title, url: r.url, publishedAt: r.published_at,
//     }));
//   }
// }
