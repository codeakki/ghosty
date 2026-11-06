import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createCredibilityScorer,
  EthosScorer,
  FakeEthosScorer,
  UNKNOWN_WEIGHT,
  weightFromScore,
  weightItems,
  xUserkey,
} from '../src/credibility/ethos.js';
import { sourceWeight, UNKNOWN_SOURCE_WEIGHT } from '../src/credibility/sources.js';
import type { NewsItem } from '../src/news/types.js';

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

/** Real response bodies captured from api.ethos.network on 2026-11-06. */
const SCORES: Record<string, { score: number; level: string }> = {
  'service:x.com:username:VitalikButerin': { score: 2626, level: 'renowned' },
  'service:x.com:username:Reuters': { score: 1427, level: 'known' },
  'service:x.com:username:DeItaone': { score: 1900, level: 'reputable' },
  'service:x.com:username:CoinDesk': { score: 1850, level: 'reputable' },
  '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045': { score: 1312, level: 'neutral' },
};
const NOT_FOUND = {
  message: 'Twitter username not found',
  code: 'NOT_FOUND',
  data: { code: 'TWITTER_USER_NOT_FOUND', httpStatus: 404 },
};

function ethosApi() {
  return mockFetch((c) => {
    const url = new URL(c.url);
    if (c.init.method === 'POST') {
      const body = JSON.parse(c.init.body as string) as { userkeys?: string[]; addresses?: string[] };
      const keys = body.userkeys ?? body.addresses ?? [];
      return Response.json(Object.fromEntries(keys.filter((k) => SCORES[k]).map((k) => [k, SCORES[k]])));
    }
    const key = url.searchParams.get('userkey') ?? url.searchParams.get('address') ?? '';
    const hit = SCORES[key];
    return hit ? Response.json(hit) : Response.json(NOT_FOUND, { status: 404 });
  });
}

describe('weightFromScore', () => {
  it('maps 0–2800 linearly onto 0.2–1.0 and clamps', () => {
    assert.equal(weightFromScore(0), 0.2);
    assert.equal(weightFromScore(1400), 0.6);
    assert.equal(weightFromScore(2800), 1.0);
    assert.equal(weightFromScore(5000), 1.0);
    assert.equal(weightFromScore(-10), 0.2);
    assert.equal(weightFromScore(null), UNKNOWN_WEIGHT);
  });
});

describe('sourceWeight', () => {
  it('knows the big outlets, matches subdomains, and defaults unknowns to medium', () => {
    assert.deepEqual(sourceWeight('reuters.com'), { weight: 1.0, known: true });
    assert.deepEqual(sourceWeight('markets.reuters.com'), { weight: 1.0, known: true });
    assert.equal(sourceWeight('www.coindesk.com').weight, 0.9);
    assert.equal(sourceWeight('theblock.co').weight, 0.9);
    assert.deepEqual(sourceWeight('randomblog.xyz'), { weight: UNKNOWN_SOURCE_WEIGHT, known: false });
    assert.equal(sourceWeight(undefined).known, false);
  });
});

describe('EthosScorer', () => {
  it('GETs /score/userkey with the X-Ethos-Client header and maps the score', async () => {
    const { fn, calls } = ethosApi();
    const s = await new EthosScorer({ client: 'ghosty@0.1.0', fetch: fn }).scoreHandle('@VitalikButerin');
    assert.deepEqual(s, { handle: '@VitalikButerin', score: 2626, level: 'exemplary', weight: 0.95, ethosLevel: 'renowned' });
    const url = new URL(calls[0]!.url);
    assert.equal(url.origin + url.pathname, 'https://api.ethos.network/api/v2/score/userkey');
    assert.equal(url.searchParams.get('userkey'), 'service:x.com:username:VitalikButerin');
    assert.equal((calls[0]!.init.headers as Record<string, string>)['X-Ethos-Client'], 'ghosty@0.1.0');
  });

  it('404 → unknown, and the 404 is cached like a hit', async () => {
    const { fn, calls } = ethosApi();
    const scorer = new EthosScorer({ fetch: fn });
    const s = await scorer.scoreHandle('nobody_here_123');
    assert.deepEqual(s, { handle: 'nobody_here_123', score: null, level: 'questionable', weight: UNKNOWN_WEIGHT });
    await scorer.scoreHandle('nobody_here_123');
    assert.equal(calls.length, 1);
  });

  it('caches for 1 h, then refetches', async () => {
    let now = 0;
    const { fn, calls } = ethosApi();
    const scorer = new EthosScorer({ fetch: fn, now: () => now });
    await scorer.scoreHandle('Reuters');
    now += 59 * 60_000;
    await scorer.scoreHandle('Reuters');
    assert.equal(calls.length, 1);
    now += 2 * 60_000;
    await scorer.scoreHandle('Reuters');
    assert.equal(calls.length, 2);
  });

  it('5xx and network errors → unknown, not cached', async () => {
    let fail = true;
    const { fn, calls } = mockFetch(() => (fail ? new Response('oops', { status: 502 }) : Response.json({ score: 1427, level: 'known' })));
    const scorer = new EthosScorer({ fetch: fn });
    assert.equal((await scorer.scoreHandle('Reuters')).score, null);
    fail = false;
    assert.equal((await scorer.scoreHandle('Reuters')).score, 1427);
    assert.equal(calls.length, 2);

    const boom = (async () => {
      throw new Error('ENOTFOUND');
    }) as typeof fetch;
    assert.equal((await new EthosScorer({ fetch: boom }).scoreHandle('x')).weight, UNKNOWN_WEIGHT);
  });

  it('uses one bulk POST /score/userkeys for more than 3 uncached handles; missing keys are unknown', async () => {
    const { fn, calls } = ethosApi();
    const scorer = new EthosScorer({ fetch: fn });
    const handles = ['VitalikButerin', 'Reuters', 'DeItaone', 'CoinDesk', 'ghost_account_x'];
    const scores = await scorer.scoreHandles(handles);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.init.method, 'POST');
    assert.equal(calls[0]!.url, 'https://api.ethos.network/api/v2/score/userkeys');
    assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { userkeys: handles.map(xUserkey) });
    assert.equal(scores.get('Reuters')?.score, 1427);
    assert.equal(scores.get('ghost_account_x')?.score, null);

    // All cached now (including the unknown one): no further calls.
    await scorer.scoreHandles(handles);
    assert.equal(calls.length, 1);
  });

  it('uses individual GETs for 3 or fewer', async () => {
    const { fn, calls } = ethosApi();
    await new EthosScorer({ fetch: fn }).scoreHandles(['Reuters', 'DeItaone', 'CoinDesk']);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((c) => c.init.method === undefined));
  });

  it('scores addresses via GET /score/address and bulk POST /score/addresses', async () => {
    const { fn, calls } = ethosApi();
    const scorer = new EthosScorer({ fetch: fn });
    const addr = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
    assert.equal((await scorer.scoreAddress(addr)).score, 1312);
    assert.match(calls[0]!.url, /\/score\/address\?address=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045$/);

    const many = ['0x1', '0x2', '0x3', '0x4'];
    const scores = await scorer.scoreAddresses(many);
    assert.equal(calls[1]!.url, 'https://api.ethos.network/api/v2/score/addresses');
    assert.deepEqual(JSON.parse(calls[1]!.init.body as string), { addresses: many });
    assert.equal(scores.get('0x1')?.score, null);
  });
});

describe('weightItems', () => {
  const item = (id: string, extra: Partial<NewsItem>): NewsItem => ({
    id,
    source: 'test',
    title: id,
    url: `https://ex.com/${id}`,
    publishedAt: '2026-11-06T00:00:00.000Z',
    ...extra,
  });

  it('combines the source table with Ethos: known domain → max, unknown domain → Ethos, else medium', async () => {
    const { fn } = ethosApi();
    const items = await new EthosScorer({ fetch: fn }).weightItems([
      item('wire', { domain: 'reuters.com', handle: 'Reuters' }), // max(1.0, 0.608)
      item('desk', { domain: 'coindesk.com', handle: 'VitalikButerin' }), // max(0.9, 0.95)
      item('post', { domain: 'unknown.blog', handle: 'DeItaone' }), // Ethos 1900 → 0.743
      item('anon', { domain: 'unknown.blog', handle: 'ghost_account_x' }), // medium
      item('bare', {}), // medium
    ]);
    assert.deepEqual(
      items.map((i) => [i.id, i.credibility]),
      [
        ['wire', 1.0],
        ['desk', 0.95],
        ['post', 0.743],
        ['anon', UNKNOWN_SOURCE_WEIGHT],
        ['bare', UNKNOWN_SOURCE_WEIGHT],
      ],
    );
  });

  it('works with any scorer, and a throwing scorer only loses the Ethos part', async () => {
    const fake = await weightItems([item('a', { handle: 'reuters', domain: 'x.com' })], new FakeEthosScorer());
    assert.equal(fake[0]!.credibility, weightFromScore(2300));
    const broken = { scoreHandle: async () => Promise.reject(new Error('down')) };
    const out = await weightItems([item('b', { handle: 'h', domain: 'coindesk.com' })], broken);
    assert.equal(out[0]!.credibility, 0.9);
  });
});

describe('createCredibilityScorer', () => {
  it('is the fake unless ETHOS_ENABLED', () => {
    const base = { ETHOS_CLIENT: 'ghosty@0.1.0', ETHOS_API_URL: 'https://api.ethos.network/api/v2' };
    assert.ok(createCredibilityScorer({ ...base, ETHOS_ENABLED: false }) instanceof FakeEthosScorer);
    assert.ok(createCredibilityScorer({ ...base, ETHOS_ENABLED: true }) instanceof EthosScorer);
  });
});
