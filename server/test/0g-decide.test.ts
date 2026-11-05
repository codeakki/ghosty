import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { BrainOfflineError, extractJson, ZeroGDecider, type DecideInput } from '../src/agent/decide.js';
import { defaultMemory } from '../src/agent/memory.js';
import { resetZeroGState, zeroGState } from '../src/agent/status.js';
import { FakeEthosScorer } from '../src/credibility/ethos.js';
import { isBrainOnline, resetBrainHealthCache } from '../src/safety/safeStop.js';

const ROUTER = 'https://router.test/v1';

const input = (over: Partial<DecideInput> = {}): DecideInput => ({
  transcript: 'what is happening with gold?',
  news: [
    {
      id: 'rss:reuters:1',
      source: 'rss',
      title: 'Missile strike reported near major oil route',
      url: 'https://example.com/1',
      publishedAt: '2026-11-07T09:00:00.000Z',
      handle: 'reuters',
    },
  ],
  memory: defaultMemory(),
  maxTradeUsd: 20,
  ...over,
});

function completion(content: string, opts: { id?: string; traceId?: string } = {}) {
  return {
    id: opts.id ?? 'chatcmpl-123',
    object: 'chat.completion',
    created: 1_762_500_000,
    model: 'glm-4.7',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    x_0g_trace: { request_id: opts.traceId ?? 'req_trace_1', provider: '0xProvider', billing: { total_cost: '1' } },
  };
}

interface Call {
  url: string;
  body: { messages: Array<{ role: string; content: string }>; response_format?: unknown; model: string };
}

/** fetch stub that serves queued responses and records requests. */
function mockFetch(responses: Array<() => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Call['body'] });
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    return next();
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const VALID = JSON.stringify({
  signal: 'geopolitical_shock',
  confidence: 0.82,
  rationale: 'Credible reports of a strike near an oil route. I suggest long gold and oil, short bitcoin. Press to confirm.',
  suggestedActions: [
    { venue: 'hyperliquid', market: 'xyz:GOLD', side: 'long', sizePct: 40 },
    { venue: 'hyperliquid', market: 'xyz:wti', side: 'buy', sizePct: 30 },
    { venue: 'hyperliquid', market: 'BTC', side: 'short', sizePct: 30 },
    { venue: 'hyperliquid', market: 'DOGE', side: 'long', sizePct: 10 },
    { venue: 'uniswap', market: 'ETH', side: 'long', sizePct: 10 },
  ],
});

const decider = (fetchImpl: typeof fetch, timeoutMs?: number) =>
  new ZeroGDecider({
    baseURL: ROUTER,
    apiKey: 'sk-test',
    model: 'glm-4.7',
    scorer: new FakeEthosScorer(),
    fetch: fetchImpl,
    timeoutMs,
  });

beforeEach(() => {
  resetBrainHealthCache();
  resetZeroGState();
});

describe('ZeroGDecider', () => {
  it('turns a valid router reply into a decision with request ids', async () => {
    const { impl, calls } = mockFetch([json(completion(VALID), 200, { 'x-request-id': 'hdr_req_9' })]);
    const d = await decider(impl).decide(input());

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, `${ROUTER}/chat/completions`);
    assert.equal(calls[0]!.body.model, 'glm-4.7');
    assert.deepEqual(calls[0]!.body.response_format, { type: 'json_object' });
    const user = JSON.parse(calls[0]!.body.messages[1]!.content) as { news: Array<{ credibility: { level: string } }> };
    assert.equal(user.news[0]!.credibility.level, 'exemplary', 'news carries Ethos credibility');

    assert.equal(d.signal, 'geopolitical_shock');
    assert.equal(d.confidence, 0.82);
    assert.equal(d.requestId, 'req_trace_1');
    assert.deepEqual(d.zeroG, {
      completionId: 'chatcmpl-123',
      traceRequestId: 'req_trace_1',
      headerRequestId: 'hdr_req_9',
      model: 'glm-4.7',
      provider: '0xProvider',
      attempts: 1,
    });
    assert.deepEqual(d.newsIds, ['rss:reuters:1']);
    // balanced → budget 20 × 0.5 = 10 USD; DOGE (not on watchlist) and uniswap are dropped.
    assert.deepEqual(
      d.suggestedActions.map((a) => [a.coin, a.side, a.sizeUsd]),
      [
        ['xyz:GOLD', 'long', 4],
        ['xyz:WTI', 'long', 3],
        ['BTC', 'short', 3],
      ],
    );
    assert.equal(zeroGState.lastRequestId, 'req_trace_1');
  });

  it('falls back to the router x-request-id header, then the completion id, when there is no x_0g_trace', async () => {
    const body: Record<string, unknown> = completion(VALID);
    delete body.x_0g_trace;
    const { impl } = mockFetch([json(body, 200, { 'x-request-id': '86a664df27a69c9a, bd06bc25-e349-48cb' }), json(body)]);
    const d1 = await decider(impl).decide(input());
    assert.equal(d1.requestId, 'bd06bc25-e349-48cb');
    assert.equal(d1.zeroG?.headerRequestId, '86a664df27a69c9a, bd06bc25-e349-48cb');
    const d2 = await decider(impl).decide(input());
    assert.equal(d2.requestId, 'chatcmpl-123');
  });

  it('retries once when the first reply is not valid JSON', async () => {
    const { impl, calls } = mockFetch([
      json(completion('Sure! Gold looks good.', { traceId: 'req_bad' })),
      json(completion('```json\n' + VALID + '\n```', { traceId: 'req_good' })),
    ]);
    const d = await decider(impl).decide(input());
    assert.equal(calls.length, 2);
    const retryMsgs = calls[1]!.body.messages;
    assert.equal(retryMsgs.length, 4);
    assert.equal(retryMsgs[2]!.role, 'assistant');
    assert.match(retryMsgs[3]!.content, /invalid/);
    assert.equal(d.requestId, 'req_good');
    assert.equal(d.zeroG?.attempts, 2);
  });

  it('retries on schema violations and gives up after two bad replies', async () => {
    const bad = JSON.stringify({ signal: 'moon', confidence: 3, rationale: '', suggestedActions: [] });
    const { impl, calls } = mockFetch([json(completion(bad)), json(completion(bad))]);
    await assert.rejects(decider(impl).decide(input()), (err: unknown) => {
      assert.ok(err instanceof BrainOfflineError);
      assert.equal(err.reason, 'invalid_output');
      return true;
    });
    assert.equal(calls.length, 2);
  });

  it('throws BrainOfflineError on a router error and trips safe-stop', async () => {
    const errorBody = { error: { message: 'no provider', type: 'server_error', code: 'no_available_provider' }, request_id: 'req_err_1' };
    const { impl } = mockFetch([json(errorBody, 503, { 'x-request-id': 'gw_1, req_err_1' })]);
    await assert.rejects(decider(impl).decide(input()), (err: unknown) => {
      assert.ok(err instanceof BrainOfflineError);
      assert.equal(err.reason, 'http_error');
      assert.equal(err.status, 503);
      assert.equal(err.requestId, 'req_err_1');
      return true;
    });
    // The failure is cached as "offline": no ping needed.
    const ping = mockFetch([]);
    const online = await isBrainOnline(
      { SAFE_STOP_ENABLED: true, SIMULATE_BRAIN_OFFLINE: false, OG_ROUTER_URL: ROUTER, OG_API_KEY: 'sk-test' },
      { fetch: ping.impl },
    );
    assert.equal(online, false);
    assert.equal(ping.calls.length, 0);
  });

  it('throws BrainOfflineError when the network is down', async () => {
    const { impl } = mockFetch([
      () => {
        throw new TypeError('fetch failed');
      },
    ]);
    await assert.rejects(decider(impl).decide(input()), BrainOfflineError);
  });

  it('throws BrainOfflineError(timeout) when the router hangs past the deadline', async () => {
    const hang = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      })) as typeof fetch;
    await assert.rejects(decider(hang, 50).decide(input()), (err: unknown) => {
      assert.ok(err instanceof BrainOfflineError);
      assert.equal(err.reason, 'timeout');
      return true;
    });
  });

  it('returns no actions for signal none', async () => {
    const none = JSON.stringify({ signal: 'none', confidence: 0.1, rationale: 'Quiet market.', suggestedActions: [] });
    const { impl } = mockFetch([json(completion(none))]);
    const d = await decider(impl).decide(input());
    assert.equal(d.signal, 'none');
    assert.deepEqual(d.suggestedActions, []);
  });
});

describe('extractJson', () => {
  it('strips think blocks and code fences', () => {
    assert.deepEqual(extractJson('<think>hmm {not this}</think>\n```json\n{"a":1}\n```'), { a: 1 });
  });

  it('throws when there is no object', () => {
    assert.throws(() => extractJson('nothing here'));
  });
});
