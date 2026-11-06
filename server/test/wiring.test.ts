import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FacilitatorClient } from '@x402/core/server';
import { BrainOfflineError, type Decider } from '../src/agent/decide.js';
import { MemoryUnavailableError } from '../src/agent/memory.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { FakeHyperliquid, type PerpVenue } from '../src/execution/hyperliquid.js';
import type { NewsItem } from '../src/news/types.js';
import { FakeSpotLeg } from '../src/wallet/uniswap.js';

/** Wiring of the integrations into buildApp: every provider is a fake, nothing touches the network. */

const WAR = 'War breaks out: missile strikes hit Gulf oil terminals';

const offlineDecider: Decider = {
  decide: async () => {
    throw new BrainOfflineError('0G router unreachable', 'network_error', { requestId: 'router-req-1' });
  },
};

/** In-process x402 facilitator: answers /supported, never verifies (the 402 path never reaches it). */
const facilitator: FacilitatorClient = {
  getSupported: async () => ({
    kinds: [{ x402Version: 2, scheme: 'exact', network: 'hedera:testnet', extra: { feePayer: '0.0.9185802' } }],
    extensions: [],
    signers: { 'hedera:*': ['0.0.9185802'] },
  }),
  verify: async () => ({ isValid: false, invalidReason: 'not_used_in_tests' }),
  settle: async () => ({ success: false, errorReason: 'not_used_in_tests', transaction: '', network: 'hedera:testnet' }),
};

const headline = (title: string): NewsItem => ({
  id: `rss:test:${title.length}`,
  source: 'rss',
  title,
  url: 'https://example.com/a',
  publishedAt: new Date().toISOString(),
  handle: 'Reuters',
});

describe('safe-stop error mapping', () => {
  it('maps BrainOfflineError from the decider to 503 brain_offline', async () => {
    const app = buildApp({ config: loadConfig({}), deps: { decider: offlineDecider } });
    for (const [url, payload] of [
      ['/voice/text', { text: 'is gold moving?' }],
      ['/button', { action: 'confirm' }],
      ['/news/inject', { title: WAR }],
    ] as const) {
      const res = await app.inject({ method: 'POST', url, payload });
      assert.equal(res.statusCode, 503, url);
      assert.equal(res.json().error, 'brain_offline', url);
    }
    const voice = await app.inject({ method: 'POST', url: '/voice/text', payload: { text: 'hi' } });
    assert.equal(voice.json().requestId, 'router-req-1');
    // Nothing was decided, so nothing was ordered.
    const state = (await app.inject({ method: 'GET', url: '/state' })).json();
    assert.equal(state.orders.length, 0);
    assert.equal(state.lastDecision, null);
    await app.close();
  });

  it('maps MemoryUnavailableError to 503 memory_unavailable', async () => {
    const memory = {
      load: async () => {
        throw new MemoryUnavailableError('memory blob failed to decrypt');
      },
      save: async () => {},
    };
    const app = buildApp({ config: loadConfig({}), deps: { memory } });
    const res = await app.inject({ method: 'POST', url: '/voice/text', payload: { text: 'hi' } });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error, 'memory_unavailable');
    await app.close();
  });

  it('keeps other errors as 500', async () => {
    const decider: Decider = {
      decide: async () => {
        throw new Error('boom');
      },
    };
    const app = buildApp({ config: loadConfig({}), deps: { decider } });
    const res = await app.inject({ method: 'POST', url: '/voice/text', payload: { text: 'hi' } });
    assert.equal(res.statusCode, 500);
    await app.close();
  });
});

describe('GET /zerog/status', () => {
  it('reports fake compute and in-memory storage without OG keys, plus the latest decision', async () => {
    const app = buildApp({ config: loadConfig({}) });
    let body = (await app.inject({ method: 'GET', url: '/zerog/status' })).json();
    assert.equal(body.computeOnline, true);
    assert.equal(body.computeMode, 'fake');
    assert.equal(body.storageMode, 'memory');
    assert.equal(body.lastDecisionRequestId, null);
    assert.equal(body.links.storagescan, 'https://storagescan-galileo.0g.ai');

    const said = (await app.inject({ method: 'POST', url: '/voice/text', payload: { text: 'war?' } })).json();
    body = (await app.inject({ method: 'GET', url: '/zerog/status' })).json();
    assert.equal(body.lastDecisionRequestId, said.requestId);

    await app.inject({ method: 'POST', url: '/sim/safe-stop', payload: { enabled: true } });
    body = (await app.inject({ method: 'GET', url: '/zerog/status' })).json();
    assert.equal(body.computeOnline, false, 'follows the sim safe-stop switch like /health');
    await app.close();
  });
});

describe('x402', () => {
  it('GET /signal answers 402 with Hedera requirements when no payment is attached', async () => {
    const app = buildApp({ config: loadConfig({ X402_PAY_TO: '0.0.5005' }), x402: { facilitator } });
    const res = await app.inject({ method: 'GET', url: '/signal' });
    assert.equal(res.statusCode, 402);
    assert.ok(res.headers['payment-required'], 'PAYMENT-REQUIRED header');
    const accepted = res.json().accepts[0];
    assert.equal(accepted.network, 'hedera:testnet');
    assert.equal(accepted.asset, '0.0.0');
    assert.equal(accepted.payTo, '0.0.5005');
    assert.equal(accepted.amount, '1000000');
    await app.close();
  });

  it('GET /signal answers 503 when no merchant account is configured', async () => {
    const app = buildApp({ config: loadConfig({}), x402: { facilitator } });
    const res = await app.inject({ method: 'GET', url: '/signal' });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error, 'payments_not_configured');
    await app.close();
  });

  it('GET /x402/status shows the budget; POST /sim/pay-signal (fake payer) spends from it', async () => {
    const app = buildApp({ config: loadConfig({ X402_MAX_SPEND_TINYBAR: '2000000' }) });
    let status = (await app.inject({ method: 'GET', url: '/x402/status' })).json();
    assert.equal(status.mode, 'fake');
    assert.equal(status.spentToday, 0);
    assert.equal(status.cap, 2_000_000);
    assert.deepEqual(status.allowedHosts, ['localhost', '127.0.0.1']);
    assert.equal(status.hcsTopicUrl, null);
    assert.equal(status.lastPayment, null);

    const paid = await app.inject({ method: 'POST', url: '/sim/pay-signal' });
    assert.equal(paid.statusCode, 200);
    assert.match(paid.json().hashscanUrl, /^https:\/\/hashscan\.io\/testnet\/transaction\//);

    status = (await app.inject({ method: 'GET', url: '/x402/status' })).json();
    assert.equal(status.spentToday, 1_000_000);
    assert.equal(status.lastPayment.txId, paid.json().txId);

    await app.inject({ method: 'POST', url: '/sim/pay-signal' });
    const refused = await app.inject({ method: 'POST', url: '/sim/pay-signal' });
    assert.equal(refused.statusCode, 409, 'daily cap reached');
    assert.equal(refused.json().error, 'payment_refused');
    await app.close();
  });

  it('POST /sim/pay-signal checks X-Device-Token', async () => {
    const app = buildApp({ config: loadConfig({ DEVICE_TOKEN: 's3cret' }) });
    assert.equal((await app.inject({ method: 'POST', url: '/sim/pay-signal' })).statusCode, 401);
    await app.close();
  });
});

describe('execution', () => {
  it('GET /execution/markets resolves the playbook aliases', async () => {
    const app = buildApp({ config: loadConfig({}) });
    const res = await app.inject({ method: 'GET', url: '/execution/markets?dex=xyz' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.perpMode, 'fake');
    assert.equal(body.spotMode, 'fake');
    assert.deepEqual(
      body.resolved.map((r: { alias: string; coin: string; fallback: boolean }) => [r.alias, r.coin, r.fallback]),
      [
        ['GOLD', 'xyz:GOLD', false],
        ['WTI', 'xyz:CL', false],
        ['BTC', 'BTC', false],
      ],
    );
    assert.ok(body.markets.every((m: { dex: string }) => m.dex === 'xyz'));
    await app.close();
  });

  it('GET /execution/markets answers 502 when the venue is down', async () => {
    const venue: PerpVenue = {
      placeMarketOrder: (req) => new FakeHyperliquid().placeMarketOrder(req),
      listMarkets: async () => {
        throw new Error('info endpoint timeout');
      },
    };
    const app = buildApp({ config: loadConfig({}), executor: { venue, spot: new FakeSpotLeg() } });
    const res = await app.inject({ method: 'GET', url: '/execution/markets' });
    assert.equal(res.statusCode, 502);
    assert.equal(res.json().error, 'venue_unavailable');
    await app.close();
  });

  it('confirm runs the Uniswap spot leg before the perp legs when one is configured', async () => {
    const calls: string[] = [];
    const venue: PerpVenue = {
      placeMarketOrder: async (req) => {
        calls.push(`perp:${req.coin}`);
        return { orderId: 'o1', coin: req.coin, isBuy: req.isBuy, sizeUsd: req.sizeUsd, status: 'simulated' };
      },
      listMarkets: async () => [],
    };
    const fakeSpot = new FakeSpotLeg();
    const spot = {
      quoteAndSwap: async (req: Parameters<FakeSpotLeg['quoteAndSwap']>[0]) => {
        calls.push('spot');
        return fakeSpot.quoteAndSwap(req);
      },
    };
    const spotLeg = { tokenIn: '0xin', tokenOut: '0xout', amount: '1000', chainId: 84532 };
    const app = buildApp({ config: loadConfig({}), executor: { venue, spot, spotLeg } });
    await app.inject({ method: 'POST', url: '/news/inject', payload: { title: WAR } });
    const press = (await app.inject({ method: 'POST', url: '/button', payload: { action: 'confirm' } })).json();
    assert.deepEqual(calls, ['spot', 'perp:xyz:GOLD']);
    assert.equal(press.swaps.length, 1);
    assert.equal(press.swaps[0].result.status, 'simulated');
    const state = (await app.inject({ method: 'GET', url: '/state' })).json();
    assert.equal(state.swaps.length, 1);
    assert.equal(state.episodes[0].receipts[0], press.swaps[0].result.txHash);
    await app.close();
  });
});

describe('news poller wiring', () => {
  it('a fresh shock headline becomes a decision and a pending alert; a quiet one does not', async () => {
    const app = buildApp({ config: loadConfig({}), deps: { news: [] } });
    await app.ready();
    const quiet = await app.ghosty.onFreshNews([headline('Ether ETF inflows steady')]);
    assert.equal(quiet.skipped, 'no_shock');
    assert.equal(quiet.alert, null);

    const shock = await app.ghosty.onFreshNews([headline('Ether ETF inflows steady'), headline(WAR)]);
    assert.equal(shock.shock.candidate, 'geopolitical_shock');
    assert.equal(shock.decision?.signal, 'geopolitical_shock');
    assert.equal(shock.alert?.status, 'pending');
    const state = (await app.inject({ method: 'GET', url: '/state' })).json();
    assert.equal(state.lastDecision.headline, WAR);
    assert.equal(state.alerts.length, 1);
    await app.close();
  });

  it('skips the decision while the brain is offline', async () => {
    const app = buildApp({ config: loadConfig({ SIMULATE_BRAIN_OFFLINE: 'true' }), deps: { news: [] } });
    const out = await app.ghosty.onFreshNews([headline(WAR)]);
    assert.equal(out.skipped, 'brain_offline');
    assert.equal(out.decision, null);
    await app.close();
  });

  it('builds no aggregator unless NEWS_LIVE=true', async () => {
    const app = buildApp({ config: loadConfig({}) });
    assert.equal(app.ghosty.aggregator, undefined);
    await app.close();
  });
});
