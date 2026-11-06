import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { CACHE_TTL_MS, isBrainOnline, reportBrainFailure, resetBrainHealthCache } from '../src/safety/safeStop.js';

const base = {
  SAFE_STOP_ENABLED: true,
  SIMULATE_BRAIN_OFFLINE: false,
  OG_ROUTER_URL: 'https://router.test/v1/',
  OG_API_KEY: 'sk-test',
};

function pinger(statuses: Array<number | 'throw'>) {
  const urls: string[] = [];
  const impl = (async (url: string | URL | Request) => {
    urls.push(String(url));
    const s = statuses.shift() ?? 200;
    if (s === 'throw') throw new TypeError('fetch failed');
    return new Response('{"data":[]}', { status: s });
  }) as typeof fetch;
  return { impl, urls };
}

beforeEach(() => resetBrainHealthCache());

describe('isBrainOnline', () => {
  it('is online without probing when 0G Compute is not configured (fake brain)', async () => {
    const p = pinger([]);
    assert.equal(await isBrainOnline({ ...base, OG_API_KEY: undefined }, { fetch: p.impl }), true);
    assert.equal(p.urls.length, 0);
  });

  it('SIMULATE_BRAIN_OFFLINE forces offline even with a healthy router', async () => {
    const p = pinger([200]);
    assert.equal(await isBrainOnline({ ...base, SIMULATE_BRAIN_OFFLINE: true }, { fetch: p.impl }), false);
    assert.equal(p.urls.length, 0);
  });

  it('SAFE_STOP_ENABLED=false bypasses everything', async () => {
    assert.equal(await isBrainOnline({ ...base, SAFE_STOP_ENABLED: false, SIMULATE_BRAIN_OFFLINE: true }), true);
  });

  it('pings GET /models and caches the answer for 10 s', async () => {
    let now = 1_000;
    const p = pinger([200, 503]);
    const opts = { fetch: p.impl, now: () => now };
    assert.equal(await isBrainOnline(base, opts), true);
    assert.deepEqual(p.urls, ['https://router.test/v1/models']);

    now += CACHE_TTL_MS - 1;
    assert.equal(await isBrainOnline(base, opts), true);
    assert.equal(p.urls.length, 1, 'cached');

    now += 2;
    assert.equal(await isBrainOnline(base, opts), true, 'one 503 after a success is not enough to flip offline');
    assert.equal(p.urls.length, 2);
  });

  it('hysteresis: offline after 2 consecutive failures, back online after 1 success', async () => {
    let now = 1_000;
    const p = pinger([200, 503, 'throw', 503, 200]);
    const opts = { fetch: p.impl, now: () => now };
    const step = async () => {
      const online = await isBrainOnline(base, opts);
      now += CACHE_TTL_MS;
      return online;
    };
    assert.equal(await step(), true, '200');
    assert.equal(await step(), true, '503 (1st failure)');
    assert.equal(await step(), false, 'network error (2nd failure) → offline');
    assert.equal(await step(), false, 'still failing');
    assert.equal(await step(), true, 'one success → online');
    assert.equal(p.urls.length, 5);
  });

  it('a failed decide() counts as one failure', async () => {
    let now = 1_000;
    const p = pinger([200]);
    const opts = { fetch: p.impl, now: () => now };
    assert.equal(await isBrainOnline(base, opts), true);
    reportBrainFailure(base.OG_ROUTER_URL, () => now);
    assert.equal(await isBrainOnline(base, opts), true, 'one failure keeps a known-good brain online');
    reportBrainFailure(base.OG_ROUTER_URL, () => now);
    assert.equal(await isBrainOnline(base, opts), false, 'two in a row → offline');
    now += CACHE_TTL_MS;
  });

  it('uses OG_HEALTH_TIMEOUT_MS for the probe', async () => {
    let signal: AbortSignal | undefined;
    const hang = (async (_url: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })));
      });
    }) as typeof fetch;
    const started = Date.now();
    // AbortSignal.timeout timers are unref'd: keep the event loop alive while the probe waits.
    const keepAlive = setTimeout(() => undefined, 2_000);
    assert.equal(await isBrainOnline({ ...base, OG_HEALTH_TIMEOUT_MS: 30 }, { fetch: hang }), false);
    clearTimeout(keepAlive);
    assert.ok(signal?.aborted);
    assert.ok(Date.now() - started < 2_000);
  });

  it('treats a network error as offline', async () => {
    const p = pinger(['throw']);
    assert.equal(await isBrainOnline(base, { fetch: p.impl }), false);
  });

  it('coalesces concurrent probes', async () => {
    const p = pinger([200]);
    const results = await Promise.all([1, 2, 3].map(() => isBrainOnline(base, { fetch: p.impl })));
    assert.deepEqual(results, [true, true, true]);
    assert.equal(p.urls.length, 1);
  });
});
