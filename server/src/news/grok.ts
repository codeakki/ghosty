import { FAKE_NOW, type NewsItem, type NewsProvider } from './types.js';

/** xAI Responses API with the x_search tool (live X posts). Optional, paid per post fetched. */
export const XAI_RESPONSES_URL = 'https://api.x.ai/v1/responses';

/** Handles we would pass as allowed_x_handles (max 20). */
export const DEFAULT_X_HANDLES = ['DeItaone', 'Reuters', 'WatcherGuru', 'tier10k', 'zerohedge'];

export class FakeGrokProvider implements NewsProvider {
  readonly name = 'grok';

  async fetchLatest(limit = 10): Promise<NewsItem[]> {
    const items: NewsItem[] = [
      {
        id: 'grok:fake-1',
        source: 'grok',
        title: 'BREAKING: Air raid sirens reported after missile launch, war fears grow',
        url: 'https://x.com/DeItaone/status/0000000000000000001',
        publishedAt: FAKE_NOW,
        handle: 'DeItaone',
      },
      {
        id: 'grok:fake-2',
        source: 'grok',
        title: 'Rumour: exchange listing announcement coming today',
        url: 'https://x.com/randomtrader123/status/0000000000000000002',
        publishedAt: '2026-11-07T08:40:00.000Z',
        handle: 'randomtrader123',
      },
    ];
    return items.slice(0, limit);
  }
}

// TODO(news): real Grok x_search provider. Key in XAI_API_KEY.
// POST https://api.x.ai/v1/responses
// body: { model: 'grok-4.7', input: 'Latest market-moving posts about war, sanctions, crypto regulation',
//         tools: [{ type: 'x_search', allowed_x_handles: DEFAULT_X_HANDLES, from_date: '<yyyy-mm-dd>' }] }
// Pricing: $5 / 1k posts fetched + tokens. Keep polling slow (every few minutes) and cache results.
// Parse cited post URLs + text from the response output into NewsItem with handle = post author.
//
// export class GrokProvider implements NewsProvider {
//   readonly name = 'grok';
//   constructor(private readonly apiKey: string, private readonly handles = DEFAULT_X_HANDLES) {}
//   async fetchLatest(limit = 10): Promise<NewsItem[]> {
//     const res = await fetch(XAI_RESPONSES_URL, {
//       method: 'POST',
//       headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
//       body: JSON.stringify({ model: 'grok-4.7', input: '...', tools: [{ type: 'x_search', allowed_x_handles: this.handles }] }),
//     });
//     ...
//   }
// }
