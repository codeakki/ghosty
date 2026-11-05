import { type NewsItem, type NewsProvider } from './types.js';

/** Polymarket Gamma API, no auth. */
export const POLYMARKET_GAMMA = 'https://gamma-api.polymarket.com';

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
      },
      {
        id: 'polymarket:fake-2',
        source: 'polymarket',
        title: 'Fed cuts rates in December: 63%',
        url: 'https://polymarket.com/event/fake-fed-december',
        publishedAt: '2026-11-07T05:00:00.000Z',
      },
    ];
    return items.slice(0, limit);
  }
}

// TODO(news): real Polymarket provider. Treat a large move in a geopolitical market's odds as a signal.
// Endpoints: GET `${POLYMARKET_GAMMA}/events?limit=50&active=true&closed=false`
//            GET `${POLYMARKET_GAMMA}/markets?limit=50&active=true`
// Keep the last snapshot of outcomePrices per market and emit a NewsItem when the delta exceeds a threshold.
//
// export class PolymarketProvider implements NewsProvider {
//   readonly name = 'polymarket';
//   async fetchLatest(limit = 10): Promise<NewsItem[]> {
//     const res = await fetch(`${POLYMARKET_GAMMA}/events?limit=${limit}&active=true&closed=false`);
//     const events = (await res.json()) as Array<{ id: string; title: string; slug: string; updatedAt: string }>;
//     return events.map((e) => ({
//       id: `polymarket:${e.id}`, source: 'polymarket', title: e.title,
//       url: `https://polymarket.com/event/${e.slug}`, publishedAt: e.updatedAt,
//     }));
//   }
// }
