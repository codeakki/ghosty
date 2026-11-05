import { DEFAULT_TIMEOUT_MS, domainOf, fetchJson, type FetchLike } from './http.js';
import { type NewsItem, type NewsProvider } from './types.js';

/** Docs: https://cryptopanic.com/developers/api/ (JS-rendered; the path below was confirmed by probing). */
export const CRYPTOPANIC_DOCS = 'https://cryptopanic.com/developers/api/';
/**
 * v1 (/api/v1/posts/) is gone. Probing /api/developer/v2/posts/ on 2026-11-06 returned:
 * "Valid paths are /api/{growth|growth_weekly|enterprise}/v2/{posts|portfolio|status}/".
 */
export const CRYPTOPANIC_API_URL = 'https://cryptopanic.com/api/growth/v2';

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

export interface CryptoPanicVotes {
  positive?: number;
  negative?: number;
  important?: number;
  liked?: number;
  disliked?: number;
  lol?: number;
  toxic?: number;
  saved?: number;
  comments?: number;
}

export interface CryptoPanicPost {
  id: number | string;
  title: string;
  url?: string;
  original_url?: string;
  published_at?: string;
  created_at?: string;
  description?: string;
  kind?: string;
  source?: { title?: string; domain?: string; region?: string };
  votes?: CryptoPanicVotes;
  author?: { twitter?: string | null } | null;
}

/**
 * Collapse community votes to 0..1 (0 = bearish, 1 = bullish). Laplace-smoothed so no votes = 0.5
 * and one vote cannot swing a post to an extreme. positive/liked count up; negative/disliked/toxic down.
 */
export function votesToSentiment(votes: CryptoPanicVotes | undefined): number {
  if (!votes) return 0.5;
  const up = (votes.positive ?? 0) + (votes.liked ?? 0);
  const down = (votes.negative ?? 0) + (votes.disliked ?? 0) + (votes.toxic ?? 0);
  return Math.round(((up + 1) / (up + down + 2)) * 1000) / 1000;
}

function twitterHandle(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const m = /(?:x\.com|twitter\.com)\/@?([A-Za-z0-9_]{1,15})/i.exec(value) ?? /^@?([A-Za-z0-9_]{1,15})$/.exec(value.trim());
  return m?.[1];
}

export function mapCryptoPanicPost(post: CryptoPanicPost, fetchedAt = new Date().toISOString()): NewsItem {
  const url = post.original_url ?? post.url ?? `https://cryptopanic.com/news/${post.id}/`;
  const handle = twitterHandle(post.author?.twitter);
  return {
    id: `cryptopanic:${post.id}`,
    source: 'cryptopanic',
    title: post.title,
    url,
    publishedAt: post.published_at ?? post.created_at ?? fetchedAt,
    domain: post.source?.domain?.replace(/^www\./, '') ?? domainOf(url),
    sentiment: votesToSentiment(post.votes),
    ...(handle ? { handle } : {}),
    ...(post.description ? { summary: post.description.slice(0, 280) } : {}),
  };
}

export interface CryptoPanicProviderOptions {
  token: string;
  baseUrl?: string;
  /** currencies filter, e.g. ['BTC','ETH']; empty = all. */
  currencies?: string[];
  timeoutMs?: number;
  fetch?: FetchLike;
}

/** CryptoPanic posts (news kind, public mode). auth_token goes in the query string per the API. */
export class CryptoPanicProvider implements NewsProvider {
  readonly name = 'cryptopanic';

  constructor(private readonly opts: CryptoPanicProviderOptions) {}

  url(): string {
    const params = new URLSearchParams({ auth_token: this.opts.token, public: 'true', kind: 'news' });
    if (this.opts.currencies?.length) params.set('currencies', this.opts.currencies.join(','));
    return `${(this.opts.baseUrl ?? CRYPTOPANIC_API_URL).replace(/\/$/, '')}/posts/?${params.toString()}`;
  }

  async fetchLatest(limit = 20): Promise<NewsItem[]> {
    const json = await fetchJson<{ results?: CryptoPanicPost[] }>(this.url(), {
      fetch: this.opts.fetch,
      timeoutMs: this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    const fetchedAt = new Date().toISOString();
    return (json.results ?? [])
      .filter((p) => typeof p.title === 'string' && p.title.length > 0)
      .slice(0, limit)
      .map((p) => mapCryptoPanicPost(p, fetchedAt));
  }
}
