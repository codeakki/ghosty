import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CryptoPanicProvider, mapCryptoPanicPost, votesToSentiment } from '../src/news/cryptopanic.js';
import { createNewsProviders } from '../src/news/factory.js';
import { GrokProvider, parseGrokResponse } from '../src/news/grok.js';
import { eventsToItems, PolymarketProvider, yesProbability, type GammaEvent } from '../src/news/polymarket.js';
import { decodeEntities, parseFeedList, parseRss, RSS_FEEDS, RssProvider } from '../src/news/rss.js';
import { shockDetector } from '../src/news/shock.js';
import type { NewsItem } from '../src/news/types.js';
import { loadConfig } from '../src/config.js';

interface Call {
  url: string;
  init: RequestInit;
}

function mockFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(input), init };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fn, calls };
}

/** Trimmed from the live CoinDesk / Cointelegraph feeds (2026-11-05): CDATA, entities, utm params, guid. */
const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>CoinDesk</title>
    <link>https://www.coindesk.com</link>
    <item>
      <title><![CDATA[U.S. Justice Department assembles force to shield against foreign AI threats]]></title>
      <link>https://www.coindesk.com/policy/2026/11/05/u-s-justice-department-assembles-force</link>
      <guid isPermaLink="false">752de2cb-a3d8-4514-a3be-3e113d85ad62</guid>
      <pubDate>Thu, 05 Nov 2026 18:59:45 +0000</pubDate>
      <dc:creator>Jesse Hamilton</dc:creator>
      <description><![CDATA[<p>The DOJ unit will <b>focus</b> on AI.</p>]]></description>
    </item>
    <item>
      <title>Binance &amp; Deribit revoke SignalPlus API keys after &#8216;fake Teams&#8217; attack</title>
      <pubDate>Thu, 05 Nov 2026 19:02:19 +0000</pubDate>
      <guid isPermaLink="true">https://cointelegraph.com/news/binance-deribit-revoke</guid>
      <link><![CDATA[https://cointelegraph.com/news/binance-deribit-revoke?utm_source=rss_feed&utm_medium=rss]]></link>
    </item>
    <item>
      <title>No link here, skipped</title>
    </item>
  </channel>
</rss>`;

describe('RSS', () => {
  it('parses title/link/pubDate/guid with CDATA, entities and utm stripping', () => {
    const items = parseRss('coindesk', RSS_FIXTURE, '2026-11-06T00:00:00.000Z');
    assert.equal(items.length, 2);
    assert.deepEqual(items[0], {
      id: 'rss:coindesk:752de2cb-a3d8-4514-a3be-3e113d85ad62',
      source: 'rss',
      title: 'U.S. Justice Department assembles force to shield against foreign AI threats',
      url: 'https://www.coindesk.com/policy/2026/11/05/u-s-justice-department-assembles-force',
      publishedAt: '2026-11-05T18:59:45.000Z',
      handle: 'CoinDesk',
      domain: 'coindesk.com',
      summary: 'The DOJ unit will focus on AI.',
    });
    assert.equal(items[1]!.title, 'Binance & Deribit revoke SignalPlus API keys after ‘fake Teams’ attack');
    assert.equal(items[1]!.url, 'https://cointelegraph.com/news/binance-deribit-revoke');
  });

  it('parses Atom entries', () => {
    const atom = `<feed><entry><title>Atom headline</title><link rel="alternate" href="https://ex.com/a?x=1&amp;y=2"/>
      <id>tag:ex.com,1</id><updated>2026-11-05T10:00:00Z</updated></entry></feed>`;
    const [item] = parseRss('ex', atom);
    assert.equal(item?.url, 'https://ex.com/a?x=1&y=2');
    assert.equal(item?.id, 'rss:ex:tag:ex.com,1');
    assert.equal(item?.publishedAt, '2026-11-05T10:00:00.000Z');
  });

  it('decodes numeric and named entities', () => {
    assert.equal(decodeEntities('a &lt;b&gt; &#x27;c&#39; &quot;d&quot; &unknown;'), `a <b> 'c' "d" &unknown;`);
  });

  it('parseFeedList: name=url pairs, bare urls, default four', () => {
    assert.deepEqual(parseFeedList(undefined), { ...RSS_FEEDS });
    assert.deepEqual(parseFeedList('cd=https://www.coindesk.com/rss, https://decrypt.co/feed'), {
      cd: 'https://www.coindesk.com/rss',
      decrypt: 'https://decrypt.co/feed',
    });
  });

  it('RssProvider tolerates one dead feed, sorts newest first, and fails only if all feeds fail', async () => {
    const { fn, calls } = mockFetch((c) =>
      c.url.includes('good') ? new Response(RSS_FIXTURE) : new Response('nope', { status: 503 }),
    );
    const items = await new RssProvider({ feeds: { coindesk: 'https://good.example/rss', bad: 'https://bad.example/rss' }, fetch: fn }).fetchLatest();
    assert.equal(calls.length, 2);
    assert.equal(items.length, 2);
    assert.equal(items[0]!.publishedAt, '2026-11-05T19:02:19.000Z');
    assert.match((calls[0]!.init.headers as Record<string, string>)['user-agent']!, /ghosty/);

    await assert.rejects(new RssProvider({ feeds: { bad: 'https://bad.example/rss' }, fetch: fn }).fetchLatest(), /all RSS feeds failed/);
  });
});

describe('CryptoPanic', () => {
  it('maps votes to a 0..1 sentiment (0.5 neutral, smoothed)', () => {
    assert.equal(votesToSentiment(undefined), 0.5);
    assert.equal(votesToSentiment({}), 0.5);
    assert.equal(votesToSentiment({ positive: 8, liked: 0, negative: 0 }), 0.9);
    assert.equal(votesToSentiment({ negative: 5, toxic: 2, disliked: 1 }), 0.1);
    assert.equal(votesToSentiment({ positive: 3, negative: 3, important: 10, lol: 4 }), 0.5);
  });

  it('maps a v2 post to a NewsItem', () => {
    const item = mapCryptoPanicPost({
      id: 123,
      title: 'Exchange hacked for $40M',
      url: 'https://cryptopanic.com/news/123/exchange-hacked',
      original_url: 'https://www.theblock.co/post/1',
      published_at: '2026-11-05T12:00:00Z',
      source: { title: 'The Block', domain: 'www.theblock.co' },
      votes: { positive: 1, negative: 7, important: 3 },
      author: { twitter: 'https://twitter.com/TheBlock__' },
    });
    assert.deepEqual(item, {
      id: 'cryptopanic:123',
      source: 'cryptopanic',
      title: 'Exchange hacked for $40M',
      url: 'https://www.theblock.co/post/1',
      publishedAt: '2026-11-05T12:00:00Z',
      domain: 'theblock.co',
      sentiment: 0.2,
      handle: 'TheBlock__',
    });
  });

  it('calls /growth/v2/posts/ with auth_token, public, kind=news', async () => {
    const { fn, calls } = mockFetch(() =>
      Response.json({ results: [{ id: 1, title: 'A', url: 'https://cryptopanic.com/news/1/' }, { id: 2, title: '' }] }),
    );
    const items = await new CryptoPanicProvider({ token: 'tok', fetch: fn, currencies: ['BTC', 'ETH'] }).fetchLatest();
    const url = new URL(calls[0]!.url);
    assert.equal(url.origin + url.pathname, 'https://cryptopanic.com/api/growth/v2/posts/');
    assert.equal(url.searchParams.get('auth_token'), 'tok');
    assert.equal(url.searchParams.get('public'), 'true');
    assert.equal(url.searchParams.get('kind'), 'news');
    assert.equal(url.searchParams.get('currencies'), 'BTC,ETH');
    assert.equal(items.length, 1, 'posts without a title are dropped');
  });

  it('redacts the token from HTTP errors', async () => {
    const { fn } = mockFetch(() => new Response('bad', { status: 403 }));
    await assert.rejects(new CryptoPanicProvider({ token: 'secret-token', fetch: fn }).fetchLatest(), (e: Error) => {
      assert.doesNotMatch(e.message, /secret-token/);
      return true;
    });
  });
});

describe('Polymarket', () => {
  const events: GammaEvent[] = [
    {
      id: 1,
      title: 'Russia x Ukraine ceasefire in 2026?',
      slug: 'russia-ukraine-ceasefire-2026',
      updatedAt: '2026-11-05T10:00:00Z',
      markets: [
        {
          id: 11,
          question: 'Russia x Ukraine ceasefire in 2026?',
          outcomes: '["Yes", "No"]',
          outcomePrices: '["0.235", "0.765"]',
          oneDayPriceChange: 0.04,
          volume24hr: 5000,
          updatedAt: '2026-11-05T11:00:00Z',
        },
        { id: 12, question: 'Closed one', outcomes: '["Yes","No"]', outcomePrices: '["1","0"]', closed: true },
      ],
    },
    {
      id: 2,
      title: 'Geopolitics',
      slug: 'geo',
      markets: [{ id: 21, question: 'US strikes Iran by Nov 30?', outcomes: ['No', 'Yes'], outcomePrices: ['0.6', '0.4'], volume24hr: 90000 }],
    },
    { id: 3, title: 'Fed decision in December?', slug: 'fed', markets: [{ id: 31, question: 'Fed cuts?', outcomePrices: '["0.6","0.4"]' }] },
    { id: 4, title: 'Starwars box office', slug: 'sw', markets: [{ id: 41, question: 'Starwars > $1B?', outcomePrices: '["0.5","0.5"]' }] },
  ];

  it('keeps open keyword markets with the Yes probability, best volume first', () => {
    const items = eventsToItems(events, ['war', 'strike', 'ceasefire'], '2026-11-06T00:00:00.000Z');
    assert.deepEqual(
      items.map((i) => [i.id, i.probability]),
      [
        ['polymarket:21', 0.4],
        ['polymarket:11', 0.235],
      ],
    );
    assert.equal(items[1]!.title, 'Russia x Ukraine ceasefire in 2026? (Polymarket 24% yes, +4 pts 24h)');
    assert.equal(items[1]!.url, 'https://polymarket.com/event/russia-ukraine-ceasefire-2026');
    assert.equal(items[1]!.probabilityChange24h, 0.04);
    assert.equal(items[0]!.publishedAt, '2026-11-06T00:00:00.000Z');
  });

  it('word-prefix matching: "war" does not match "Starwars"', () => {
    assert.equal(eventsToItems([events[3]!], ['war']).length, 0);
  });

  it('yesProbability falls back to lastTradePrice and rejects junk', () => {
    assert.equal(yesProbability({ id: 1, lastTradePrice: 0.3 }), 0.3);
    assert.equal(yesProbability({ id: 1, outcomePrices: 'not json' }), undefined);
  });

  it('queries Gamma /events (active, open, by 24h volume) and retries unordered on 422', async () => {
    let first = true;
    const { fn, calls } = mockFetch(() => {
      if (first) {
        first = false;
        return new Response('{"error":"invalid order"}', { status: 422 });
      }
      return Response.json(events);
    });
    const items = await new PolymarketProvider({ keywords: ['strike'], tagSlug: 'geopolitics', fetch: fn }).fetchLatest();
    assert.equal(calls.length, 2);
    const u1 = new URL(calls[0]!.url);
    assert.equal(u1.origin + u1.pathname, 'https://gamma-api.polymarket.com/events');
    assert.equal(u1.searchParams.get('active'), 'true');
    assert.equal(u1.searchParams.get('closed'), 'false');
    assert.equal(u1.searchParams.get('order'), 'volume24hr');
    assert.equal(u1.searchParams.get('tag_slug'), 'geopolitics');
    assert.equal(new URL(calls[1]!.url).searchParams.get('order'), null);
    assert.deepEqual(
      items.map((i) => i.id),
      ['polymarket:21'],
    );
  });
});

describe('Grok x_search', () => {
  const json = {
    output: [
      { type: 'custom_tool_call', name: 'x_keyword_search' },
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text:
              '```json\n[{"handle":"DeItaone","text":"*US STRIKES TARGETS IN IRAN: OFFICIAL","url":"https://x.com/DeItaone/status/1854000000000000001","posted_at":"2026-11-05T21:00:00Z"},' +
              '{"handle":"Reuters","text":"dup","url":"https://twitter.com/Reuters/status/1854000000000000001"}]\n```',
            annotations: [],
          },
        ],
      },
    ],
  };

  it('parses the JSON array the prompt asks for, dedupes by status id', () => {
    const items = parseGrokResponse(json);
    assert.deepEqual(items, [
      {
        id: 'grok:1854000000000000001',
        source: 'grok',
        title: '*US STRIKES TARGETS IN IRAN: OFFICIAL',
        url: 'https://x.com/DeItaone/status/1854000000000000001',
        publishedAt: '2026-11-05T21:00:00.000Z',
        handle: 'DeItaone',
        domain: 'x.com',
      },
    ]);
  });

  it('falls back to url_citation annotations when the model answers in prose', () => {
    const url = 'https://x.com/WatcherGuru/status/1854000000000000002';
    const items = parseGrokResponse(
      {
        output: [
          {
            type: 'message',
            content: [
              { type: 'output_text', text: `- Exchange halts withdrawals after exploit [[1]](${url})`, annotations: [{ type: 'url_citation', url, start_index: 0 }] },
            ],
          },
        ],
      },
      '2026-11-06T00:00:00.000Z',
    );
    assert.equal(items.length, 1);
    assert.equal(items[0]!.title, 'Exchange halts withdrawals after exploit');
    assert.equal(items[0]!.handle, 'WatcherGuru');
  });

  it('sends x_search with allowed handles + from_date, and caches between paid calls', async () => {
    let now = Date.parse('2026-11-06T12:00:00Z');
    const { fn, calls } = mockFetch(() => Response.json(json));
    const grok = new GrokProvider({ apiKey: 'xai', handles: ['@DeItaone', 'Reuters'], fetch: fn, now: () => now, minIntervalMs: 300_000 });
    await grok.fetchLatest();
    const body = JSON.parse(calls[0]!.init.body as string);
    assert.equal(calls[0]!.url, 'https://api.x.ai/v1/responses');
    assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, 'Bearer xai');
    assert.equal(body.model, 'grok-4.7');
    assert.deepEqual(body.tools, [{ type: 'x_search', allowed_x_handles: ['DeItaone', 'Reuters'], from_date: '2026-11-05' }]);

    now += 60_000;
    await grok.fetchLatest();
    assert.equal(calls.length, 1, 'served from cache inside minIntervalMs');
    now += 300_000;
    await grok.fetchLatest();
    assert.equal(calls.length, 2);
  });
});

describe('news config', () => {
  it('has defaults and falls back on malformed numbers', () => {
    const cfg = loadConfig({ NEWS_POLL_SECONDS: 'abc', NEWS_WINDOW_MINUTES: '-5' });
    assert.equal(cfg.NEWS_POLL_SECONDS, 60);
    assert.equal(cfg.NEWS_WINDOW_MINUTES, 120);
    assert.equal(cfg.NEWS_PROVIDER_TIMEOUT_MS, 8000);
    assert.equal(cfg.NEWS_LIVE, false);
    assert.equal(cfg.ETHOS_ENABLED, false);
    assert.equal(cfg.GROQ_STT_MODEL, 'whisper-large-v3-turbo');
    assert.equal(cfg.ELEVENLABS_MODEL_ID, 'eleven_flash_v2_5');
  });
});

describe('createNewsProviders', () => {
  it('fakes by default; NEWS_LIVE switches keyless sources to real and drops unkeyed fakes', () => {
    const names = (env: Record<string, string>) => createNewsProviders(loadConfig(env)).map((p) => p.constructor.name);
    assert.deepEqual(names({}), ['FakeRssProvider', 'FakeCryptoPanicProvider', 'FakePolymarketProvider', 'FakeGrokProvider']);
    assert.deepEqual(names({ NEWS_LIVE: 'true' }), ['RssProvider', 'PolymarketProvider']);
    assert.deepEqual(names({ NEWS_LIVE: 'true', CRYPTOPANIC_TOKEN: 't', XAI_API_KEY: 'x' }), [
      'RssProvider',
      'CryptoPanicProvider',
      'PolymarketProvider',
      'GrokProvider',
    ]);
  });
});

describe('shockDetector', () => {
  const item = (id: string, title: string, extra: Partial<NewsItem> = {}): NewsItem => ({
    id,
    source: 'rss',
    title,
    url: `https://ex.com/${id}`,
    publishedAt: '2026-11-05T10:00:00.000Z',
    ...extra,
  });

  it('returns none when nothing matches', () => {
    const r = shockDetector([item('a', 'ETF inflows steady'), item('b', 'Starwars sequel announced')]);
    assert.equal(r.candidate, 'none');
    assert.equal(r.signal, 'none');
    assert.equal(r.matched.length, 0);
  });

  it('geopolitical beats regulatory beats crypto incident; matched sorted by credibility', () => {
    const r = shockDetector([
      item('hack', 'DeFi protocol exploited for $20M'),
      item('ban', 'Country bans crypto trading'),
      item('m1', 'Missile strikes reported near port', { credibility: 0.5 }),
      item('m2', 'Nuclear talks collapse as war fears grow', { credibility: 0.9 }),
    ]);
    assert.equal(r.candidate, 'geopolitical_shock');
    assert.equal(r.signal, 'geopolitical_shock');
    assert.deepEqual(
      r.matched.map((m) => m.item.id),
      ['m2', 'm1'],
    );
    assert.deepEqual(r.matched[1]!.keywords, ['missile', 'strikes']);
    assert.equal(r.all.length, 4);
  });

  it('crypto incidents are a candidate without a playbook signal', () => {
    const r = shockDetector([item('d', 'Stablecoin depegs to $0.91'), item('h', 'Bridge hacked')]);
    assert.equal(r.candidate, 'crypto_incident');
    assert.equal(r.signal, 'none');
    assert.equal(r.matched.length, 2);
  });

  it('sanctions map to regulatory_crackdown', () => {
    assert.equal(shockDetector([item('s', 'Treasury sanctions mixer')]).signal, 'regulatory_crackdown');
  });
});
