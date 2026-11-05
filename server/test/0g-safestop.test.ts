import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { CACHE_TTL_MS, isBrainOnline, resetBrainHealthCache } from '../src/safety/safeStop.js';

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
    assert.equal(await isBrainOnline(base, opts), false, '503 → offline');
    assert.equal(p.urls.length, 2);
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
