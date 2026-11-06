import { csv, DEFAULT_TIMEOUT_MS, domainOf, fetchText, type FetchLike } from './http.js';
import { FAKE_NOW, type NewsItem, type NewsProvider } from './types.js';

/** Default crypto outlets. Each URL fetched on 2026-11-06 and returned RSS 2.0 XML (20–37 items). */
export const RSS_FEEDS = {
  coindesk: 'https://www.coindesk.com/arc/outboundfeeds/rss/',
  cointelegraph: 'https://cointelegraph.com/rss',
  theblock: 'https://www.theblock.co/rss.xml',
  decrypt: 'https://decrypt.co/feed',
} as const;

/** Outlet X handles, so RSS items can be scored by Ethos like any other source. */
export const OUTLET_HANDLES: Record<string, string> = {
  coindesk: 'CoinDesk',
  cointelegraph: 'Cointelegraph',
  theblock: 'TheBlock__',
  decrypt: 'decryptmedia',
};

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

/**
 * Parse NEWS_RSS_FEEDS: comma-separated `name=url` pairs or bare urls (name = host's first label).
 * Empty → RSS_FEEDS.
 */
export function parseFeedList(value: string | undefined): Record<string, string> {
  const entries = csv(value);
  if (entries.length === 0) return { ...RSS_FEEDS };
  const feeds: Record<string, string> = {};
  for (const entry of entries) {
    const eq = entry.indexOf('=');
    const hasName = eq > 0 && !entry.slice(0, eq).includes('/');
    const url = hasName ? entry.slice(eq + 1).trim() : entry;
    const name = hasName ? entry.slice(0, eq).trim() : (domainOf(url)?.split('.')[0] ?? url);
    feeds[name] = url;
  }
  return feeds;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Decode the XML/HTML entities that show up in feed titles. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref.startsWith('#')) {
      const hex = ref[1] === 'x' || ref[1] === 'X';
      const code = hex ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

/** Text of the first <tag>…</tag> in `xml`, with CDATA unwrapped, markup stripped, entities decoded. */
function tagText(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  if (!m || m[1] === undefined) return undefined;
  const raw = m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  const text = decodeEntities(raw.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  return text.length > 0 ? text : undefined;
}

/** Atom <link href="…"/>; prefers rel="alternate" or no rel. */
function atomLink(xml: string): string | undefined {
  for (const m of xml.matchAll(/<link\b([^>]*)\/?>/gi)) {
    const attrs = m[1] ?? '';
    const href = /href=["']([^"']+)["']/i.exec(attrs)?.[1];
    const rel = /rel=["']([^"']+)["']/i.exec(attrs)?.[1];
    if (href && (!rel || rel === 'alternate')) return decodeEntities(href);
  }
  return undefined;
}

/** Remove tracking params (utm_*) so the same story dedupes across feeds. */
export function cleanUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) if (key.toLowerCase().startsWith('utm_')) u.searchParams.delete(key);
    return u.toString();
  } catch {
    return url;
  }
}

function toIso(date: string | undefined, fallback: string): string {
  if (!date) return fallback;
  const t = Date.parse(date);
  return Number.isNaN(t) ? fallback : new Date(t).toISOString();
}

/**
 * Parse an RSS 2.0 (or Atom) document into NewsItems. Regex-based on purpose: the outlets we
 * poll publish flat <item> lists, and this keeps the server dependency-free.
 */
export function parseRss(outlet: string, xml: string, fetchedAt = new Date().toISOString()): NewsItem[] {
  const blocks = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi), ...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)];
  const items: NewsItem[] = [];
  for (const [block] of blocks) {
    const title = tagText(block, 'title');
    const rawLink = tagText(block, 'link') ?? atomLink(block);
    if (!title || !rawLink) continue;
    const url = cleanUrl(rawLink);
    const guid = tagText(block, 'guid') ?? tagText(block, 'id') ?? url;
    const summary = tagText(block, 'description') ?? tagText(block, 'summary');
    const handle = OUTLET_HANDLES[outlet];
    items.push({
      id: `rss:${outlet}:${guid}`,
      source: 'rss',
      title,
      url,
      publishedAt: toIso(tagText(block, 'pubDate') ?? tagText(block, 'published') ?? tagText(block, 'updated'), fetchedAt),
      ...(handle ? { handle } : {}),
      domain: domainOf(url),
      ...(summary ? { summary: summary.slice(0, 280) } : {}),
    });
  }
  return items;
}

export interface RssProviderOptions {
  feeds?: Record<string, string>;
  timeoutMs?: number;
  fetch?: FetchLike;
}

/** Polls every feed in parallel; one dead feed never sinks the others. */
export class RssProvider implements NewsProvider {
  readonly name = 'rss';
  readonly feeds: Record<string, string>;

  constructor(private readonly opts: RssProviderOptions = {}) {
    this.feeds = opts.feeds ?? { ...RSS_FEEDS };
  }

  async fetchLatest(limit = 40): Promise<NewsItem[]> {
    const fetchedAt = new Date().toISOString();
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const settled = await Promise.allSettled(
      Object.entries(this.feeds).map(async ([outlet, url]) =>
        parseRss(outlet, await fetchText(url, { fetch: this.opts.fetch, timeoutMs }), fetchedAt),
      ),
    );
    const failures = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (settled.length > 0 && failures.length === settled.length) {
      throw new AggregateError(
        failures.map((f) => f.reason),
        'all RSS feeds failed',
      );
    }
    const items = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    return items.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, limit);
  }
}
