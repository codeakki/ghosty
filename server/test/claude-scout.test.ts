import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { ClaudeScoutProvider, extractHeadlines, SCOUT_SOURCE, toScoutItems } from '../src/claude/scout.js';
import { loadConfig } from '../src/config.js';
import { NewsAggregator } from '../src/news/aggregator.js';
import { createNewsProviders } from '../src/news/factory.js';
import { shockDetector } from '../src/news/shock.js';
import type { NewsItem, NewsProvider } from '../src/news/types.js';
import { PROBES } from '../src/providers/probes.js';
import { ProviderRegistry } from '../src/providers/registry.js';

const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

const HEADLINES = [
  { title: 'Missile strikes hit Gulf oil terminal', url: 'https://www.reuters.com/world/strike-1/', source: 'Reuters', publishedAt: ago(20), why: 'Oil supply risk.' },
  { title: 'Exchange hacked for 200 million dollars', url: 'https://www.coindesk.com/hack', source: 'CoinDesk', publishedAt: ago(50), why: 'Crypto risk-off.' },
  { title: 'No URL story', source: 'Blog', publishedAt: ago(5), why: '' },
  { title: 'Old story', url: 'https://example.com/old', source: 'AP', publishedAt: ago(200), why: '' },
  { title: 'Missile strikes hit Gulf oil terminal (update)', url: 'https://reuters.com/world/strike-1', source: 'Reuters', publishedAt: ago(10), why: 'dup url' },
  { title: 'Bad time', url: 'https://example.com/t', source: 'AP', publishedAt: 'an hour ago', why: '' },
];

const textReply = (text: string, extra: Partial<Anthropic.Message> = {}): Anthropic.Message =>
  ({
    id: 'msg_scout_1',
    stop_reason: 'end_turn',
    content: [
      { type: 'text', text: 'Let me search.', citations: null },
      { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'news' } },
      { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [] },
      { type: 'text', text, citations: null },
    ],
    ...extra,
  }) as unknown as Anthropic.Message;

function scoutClient(replies: Array<Anthropic.Message | Error | (() => Promise<Anthropic.Message>)>) {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client = {
    messages: {
      create: async (body: Anthropic.MessageCreateParamsNonStreaming) => {
        calls.push(structuredClone(body));
        const next = replies.shift();
        if (!next) throw new Error('unexpected call');
        if (next instanceof Error) throw next;
        return typeof next === 'function' ? next() : next;
      },
    },
  } as unknown as Pick<Anthropic, 'messages'>;
  return { client, calls };
}

const scout = (client: Pick<Anthropic, 'messages'>, maxPerDay = 200, now = () => NOW) =>
  new ClaudeScoutProvider({ client, model: 'claude-sonnet-5-5', query: 'market news', maxPerDay, now });

describe('scout JSON parsing and validation', () => {
  it('extracts the headlines object from prose or fences', () => {
    assert.equal(extractHeadlines('Here you go:\n```json\n{"headlines":[{"title":"a"}]}\n```').length, 1);
    assert.equal(extractHeadlines('[{"title":"a"},{"title":"b"}]').length, 2);
    assert.throws(() => extractHeadlines('nothing found'), /no headlines JSON/);
  });

  it('drops items without a URL, too old, unparseable times and duplicates; tags source claude-scout', () => {
    const { items, dropped } = toScoutItems(HEADLINES, NOW);
    assert.deepEqual(
      items.map((i) => i.title),
      ['Missile strikes hit Gulf oil terminal', 'Exchange hacked for 200 million dollars'],
    );
    assert.equal(dropped, 4);
    for (const i of items) {
      assert.equal(i.source, SCOUT_SOURCE);
      assert.match(i.id, /^claude-scout:[0-9a-f]{16}$/);
    }
    assert.equal(items[0]!.domain, 'reuters.com');
    assert.equal(items[0]!.summary, 'Reuters');
    assert.equal(items[0]!.why, 'Oil supply risk.');
  });

  it("keeps the scout's own note out of the shock detector", () => {
    const [item] = toScoutItems([{ title: 'Fed holds rates', url: 'https://ft.com/a', source: 'FT', publishedAt: ago(1), why: 'Could matter if war breaks out' }], NOW).items;
    assert.equal(shockDetector([item!]).candidate, 'none');
  });
});

describe('ClaudeScoutProvider', () => {
  it('one cycle: web_search tool with max_uses 3, validated items, fetchLatest never calls the API', async () => {
    const { client, calls } = scoutClient([textReply(JSON.stringify({ headlines: HEADLINES }))]);
    const s = scout(client);
    assert.deepEqual(await s.fetchLatest(), [], 'nothing before the first cycle');
    const r = await s.runCycle();
    assert.equal(r.error, undefined);
    assert.equal(r.items.length, 2);
    assert.equal(r.searches, 1);
    assert.equal(r.messageId, 'msg_scout_1');
    assert.deepEqual(calls[0]!.tools, [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }]);
    assert.equal(calls[0]!.model, 'claude-sonnet-5-5');
    assert.match(String(calls[0]!.messages[0]!.content), /market news/);
    assert.equal((await s.fetchLatest()).length, 2);
    assert.equal(calls.length, 1, 'fetchLatest served the cache');
  });

  it('resumes a pause_turn by resending the assistant turn', async () => {
    const paused = { ...textReply(''), stop_reason: 'pause_turn' } as Anthropic.Message;
    const { client, calls } = scoutClient([paused, textReply(JSON.stringify({ headlines: HEADLINES.slice(0, 1) }))]);
    const r = await scout(client).runCycle();
    assert.equal(r.items.length, 1);
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.messages.at(-1)!.role, 'assistant');
  });

  it('skips a cycle while the previous one is still running (no second API call)', async () => {
    let release!: (m: Anthropic.Message) => void;
    const slow = () => new Promise<Anthropic.Message>((resolve) => (release = resolve));
    const { client, calls } = scoutClient([slow]);
    const s = scout(client);
    const first = s.runCycle();
    assert.deepEqual(await s.runCycle(), { skipped: 'overlap', items: [], dropped: 0, searches: 0 });
    release(textReply('{"headlines":[]}'));
    assert.equal((await first).items.length, 0);
    assert.equal(calls.length, 1);
  });

  it('stops at the daily cap and resets the next UTC day', async () => {
    let now = NOW;
    const { client, calls } = scoutClient([textReply('{"headlines":[]}'), textReply('{"headlines":[]}'), textReply('{"headlines":[]}')]);
    const s = scout(client, 2, () => now);
    await s.runCycle();
    await s.runCycle();
    assert.equal((await s.runCycle()).skipped, 'daily_cap');
    assert.equal(calls.length, 2);
    now += 24 * 3600_000;
    assert.equal((await s.runCycle()).skipped, undefined);
    assert.equal(calls.length, 3);
  });

  it('a failed cycle reports the error and keeps the previous headlines', async () => {
    const { client } = scoutClient([textReply(JSON.stringify({ headlines: HEADLINES })), textReply('sorry, no JSON')]);
    const s = scout(client);
    await s.runCycle();
    const r = await s.runCycle();
    assert.match(r.error ?? '', /no headlines JSON/);
    assert.equal((await s.fetchLatest()).length, 2);
  });

  it('feeds the aggregator: deduped against other providers by URL, then the shock detector sees it', async () => {
    const { client } = scoutClient([textReply(JSON.stringify({ headlines: HEADLINES }))]);
    const s = scout(client);
    await s.runCycle();
    const rss: NewsProvider = {
      name: 'rss',
      fetchLatest: async (): Promise<NewsItem[]> => [
        { id: 'rss:reuters:1', source: 'rss', title: 'Strike on Gulf terminal', url: 'https://reuters.com/world/strike-1', publishedAt: ago(25) },
      ],
    };
    const agg = new NewsAggregator({ providers: [rss, s], now: () => NOW });
    const { fresh } = await agg.poll();
    assert.deepEqual(fresh.map((i) => i.source).sort(), ['claude-scout', 'rss'], 'same Reuters URL kept once');
    assert.equal(shockDetector(fresh).candidate, 'geopolitical_shock');
  });

  it('is only created with NEWS_LIVE, ANTHROPIC_API_KEY and CLAUDE_SCOUT_ENABLED', () => {
    const has = (env: Record<string, string>) => createNewsProviders(loadConfig({ GHOSTY_MODE: 'live', ...env })).some((p) => p.name === SCOUT_SOURCE);
    assert.equal(has({}), false);
    assert.equal(has({ ANTHROPIC_API_KEY: 'sk-ant-test' }), true);
    assert.equal(has({ ANTHROPIC_API_KEY: 'sk-ant-test', CLAUDE_SCOUT_ENABLED: 'false' }), false);
    assert.equal(has({ ANTHROPIC_API_KEY: 'sk-ant-test', NEWS_LIVE: 'false' }), false);
  });

  it('config defaults', () => {
    const c = loadConfig({ ANTHROPIC_API_KEY: 'k' });
    assert.equal(c.ANTHROPIC_MODEL, 'claude-sonnet-5-5');
    assert.equal(c.CLAUDE_VOICE_ENABLED, true);
    assert.equal(c.CLAUDE_SCOUT_ENABLED, true);
    assert.equal(c.CLAUDE_SCOUT_MINUTES, 5);
    assert.equal(c.CLAUDE_SCOUT_MAX_PER_DAY, 200);
    assert.match(c.CLAUDE_SCOUT_QUERY, /exchange-hack and macro news/);
    const off = loadConfig({});
    assert.equal(off.CLAUDE_VOICE_ENABLED, false);
    assert.equal(off.CLAUDE_SCOUT_ENABLED, false);
    assert.equal(off.OG_HEALTH_TIMEOUT_MS, 15_000);
    assert.equal(off.OG_DECIDE_TIMEOUT_MS, 45_000);
  });
});

describe('claude provider probe', () => {
  const probe = PROBES.find((p) => p.id === 'claude')!;
  const run = async (env: Record<string, string>, fetchImpl: typeof fetch) => {
    const registry = new ProviderRegistry({ config: loadConfig(env), fetch: fetchImpl, probes: [probe] });
    return (await registry.refresh()).providers[0]!;
  };
  const respond = (status: number, body: unknown) => {
    const urls: string[] = [];
    const headers: Array<Record<string, string>> = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      headers.push(Object.fromEntries(new Headers(init?.headers).entries()));
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    return { impl, urls, headers };
  };

  it('not_configured without a key, no request', async () => {
    const r = respond(200, {});
    const s = await run({}, r.impl);
    assert.equal(s.state, 'not_configured');
    assert.deepEqual(s.missingEnv, ['ANTHROPIC_API_KEY']);
    assert.equal(r.urls.length, 0);
  });

  it('live: GET /v1/models/{model} with the key in a header, never in the detail', async () => {
    const r = respond(200, { id: 'claude-sonnet-5-5', type: 'model', display_name: 'Claude Sonnet 5.5', created_at: '2026-01-01T00:00:00Z' });
    const s = await run({ ANTHROPIC_API_KEY: 'sk-ant-secret' }, r.impl);
    assert.equal(s.state, 'live');
    assert.equal(s.track, 'data');
    assert.match(r.urls[0]!, /\/v1\/models\/claude-sonnet-5-5$/);
    const h = r.headers[0]!;
    assert.ok(h['x-api-key'] === 'sk-ant-secret' || h.authorization === 'Bearer sk-ant-secret', 'key sent as a header');
    assert.doesNotMatch(r.urls[0]!, /sk-ant-secret/);
    assert.doesNotMatch(JSON.stringify(s), /sk-ant-secret/);
  });

  it('offline on a rejected key or an unknown model', async () => {
    const bad = await run({ ANTHROPIC_API_KEY: 'sk-ant-bad' }, respond(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }).impl);
    assert.equal(bad.state, 'offline');
    assert.match(bad.detail, /rejected the key \(401\)/);
    const missing = await run({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_MODEL: 'nope' }, respond(404, { type: 'error', error: { type: 'not_found_error', message: 'model' } }).impl);
    assert.equal(missing.state, 'offline');
    assert.match(missing.detail, /model nope was not found/);
  });

  it('offline when Anthropic is unreachable', async () => {
    const down = (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    }) as typeof fetch;
    const s = await run({ ANTHROPIC_API_KEY: 'k' }, down);
    assert.equal(s.state, 'offline');
  });
});
