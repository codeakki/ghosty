import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { BrainOfflineError, type Decider, type DecideInput, type Decision } from '../src/agent/decide.js';
import { buildApp } from '../src/app.js';
import type { AssistantReply, VoiceAssistant } from '../src/claude/voice.js';
import { defaultFacilitatorUrl, loadConfig } from '../src/config.js';
import { IntelBuyer, NoopAuditLog, SpendCap, type Payments } from '../src/payments/index.js';
import type { Verification } from '../src/payments/mirror.js';
import { dailyCaps, type PaidResource, type Payer } from '../src/payments/x402Client.js';
import type { CandleSet } from '../src/sim/candles.js';
import type { Scenario } from '../src/sim/scenarios.js';

/**
 * The decision loop buys Signal Desk intel on its own (X402_AUTOPAY) BEFORE the 0G decision on a shock headline.
 * Every payer here is in-process.
 */

const WAR = 'War breaks out: missile strikes hit Gulf oil terminals';

class CountingPayer implements Payer {
  readonly mode = 'real' as const;
  calls: string[] = [];
  constructor(private readonly behaviour: 'ok' | 'fail' | 'slow' = 'ok') {}
  async pay(url: string): Promise<PaidResource> {
    this.calls.push(url);
    if (this.behaviour === 'fail') throw new Error('facilitator said no');
    if (this.behaviour === 'slow') await new Promise((r) => setTimeout(r, 300));
    const txId = `0.0.1001@1730000000.00000000${this.calls.length}`;
    const verification: Promise<Verification> = Promise.resolve({ verified: true, consensusTimestamp: '1730000001.0', checkedAt: 'now' });
    return {
      status: 200,
      body: { provider: 'ghosty-signal-desk', requestId: `desk-${this.calls.length}`, shock: { category: 'geopolitical_shock', severity: 'medium', keywords: ['war'] } },
      txId,
      hashscanUrl: `https://hashscan.io/testnet/transaction/${txId}`,
      asset: '0.0.429274',
      amount: '10000',
      payTo: '0.0.5005',
      payer: '0.0.1001',
      verification,
    };
  }
}

function paymentsWith(payer: Payer, over: Record<string, string> = {}): Payments {
  const config = loadConfig(over);
  const audit = new NoopAuditLog();
  const spendCap = new SpendCap({ maxPerDay: dailyCaps(config), file: null });
  return { mode: 'real', payer, audit, buyer: new IntelBuyer({ config, payer, spendCap, audit }) };
}

async function proposed(app: ReturnType<typeof buildApp>) {
  const state = (await app.inject({ method: 'GET', url: '/state' })).json();
  return state.episodes.find((e: { outcome: string }) => e.outcome === 'proposed');
}

/** 0G decider stand-in: a shock decision, or a 0G failure (timeout / router down). Records what it was given. */
class StubDecider implements Decider {
  calls = 0;
  inputs: DecideInput[] = [];
  constructor(private readonly behaviour: 'short' | 'offline' = 'short') {}
  async decide(input: DecideInput): Promise<Decision> {
    this.calls++;
    this.inputs.push(input);
    if (this.behaviour === 'offline') throw new BrainOfflineError('0G call timed out', 'timeout', { requestId: 'rq-timeout' });
    return {
      signal: 'geopolitical_shock',
      confidence: 0.8,
      rationale: 'Shock. Short BTC. Press to confirm.',
      requestId: `0g-stub-${this.calls}`,
      suggestedActions: [{ venue: 'hyperliquid', kind: 'perp', coin: 'BTC', side: 'short', sizeUsd: 12.5, reason: 'test' }],
      newsIds: input.news.map((n) => n.id),
    };
  }
}

describe('x402 autopay: buy intel before the 0G decision', () => {
  it('buys the bundle once per shock headline, hands it to the decider, and cites it on the episode', async () => {
    const payer = new CountingPayer();
    const decider = new StubDecider();
    const app = buildApp({ config: loadConfig({ SIGNAL_DESK_URL: 'http://127.0.0.1:4555' }), payments: paymentsWith(payer, { SIGNAL_DESK_URL: 'http://127.0.0.1:4555' }), deps: { decider } });

    const res = await app.inject({ method: 'POST', url: '/news/inject', payload: { title: WAR } });
    assert.equal(res.statusCode, 200);
    assert.equal(payer.calls.length, 1);
    assert.match(payer.calls[0] ?? '', /^http:\/\/127\.0\.0\.1:4555\/intel\?headline=War\+breaks\+out/);
    assert.equal(decider.inputs[0]?.paidIntel?.provider, 'ghosty-signal-desk');
    assert.equal(decider.inputs[0]?.paidIntel?.txId, '0.0.1001@1730000000.000000001');

    const episode = await proposed(app);
    assert.deepEqual(episode.receipts, ['0.0.1001@1730000000.000000001']);
    assert.equal(episode.decision.paidIntel.provider, 'ghosty-signal-desk');
    assert.equal(episode.decision.paidIntel.verified, true);

    const status = (await app.inject({ method: 'GET', url: '/x402/status' })).json();
    assert.equal(status.autopay, true);
    assert.equal(status.lastPayment.trigger, 'decision');
    assert.equal(status.lastPayment.verified, true);
    assert.equal(status.lastPayment.amountLabel, '0.01 USDC');
    await app.close();
  });

  it('does not buy for a non-shock headline', async () => {
    const payer = new CountingPayer();
    const app = buildApp({ config: loadConfig({}), payments: paymentsWith(payer) });
    await app.inject({ method: 'POST', url: '/news/inject', payload: { title: 'Quarterly earnings beat estimates' } });
    assert.equal(payer.calls.length, 0);
    await app.close();
  });

  it('a failed payment never blocks the decision', async () => {
    const payer = new CountingPayer('fail');
    const app = buildApp({ config: loadConfig({}), payments: paymentsWith(payer) });
    const res = await app.inject({ method: 'POST', url: '/news/inject', payload: { title: WAR } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().decision.signal, 'geopolitical_shock');
    assert.equal(payer.calls.length, 1);
    assert.equal((await proposed(app)).receipts, undefined);
    assert.equal((await app.inject({ method: 'GET', url: '/x402/status' })).json().lastPayment, null);
    await app.close();
  });

  it('a slow purchase is not waited on past X402_AUTOPAY_WAIT_MS, but still lands in lastPayment', async () => {
    const payer = new CountingPayer('slow');
    const decider = new StubDecider();
    const app = buildApp({ config: loadConfig({ X402_AUTOPAY_WAIT_MS: '20' }), payments: paymentsWith(payer, { SIGNAL_DESK_URL: 'http://127.0.0.1:4555' }), deps: { decider } });
    await app.inject({ method: 'POST', url: '/news/inject', payload: { title: WAR } });
    assert.equal(decider.inputs[0]?.paidIntel, undefined, 'decided without the late bundle');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal((await app.inject({ method: 'GET', url: '/x402/status' })).json().lastPayment.trigger, 'decision');
    await app.close();
  });

  it('does not pay while safe-stop is on, or when X402_AUTOPAY=false', async () => {
    const offline = new CountingPayer();
    const app = buildApp({ config: loadConfig({}), payments: paymentsWith(offline) });
    await app.inject({ method: 'POST', url: '/sim/safe-stop', payload: { enabled: true } });
    assert.equal((await app.inject({ method: 'POST', url: '/news/inject', payload: { title: WAR } })).statusCode, 503);
    assert.equal(offline.calls.length, 0);
    await app.close();

    const off = new CountingPayer();
    const manual = buildApp({ config: loadConfig({ X402_AUTOPAY: 'false' }), payments: paymentsWith(off) });
    await manual.inject({ method: 'POST', url: '/news/inject', payload: { title: WAR } });
    assert.equal(off.calls.length, 0);
    // The sim button still pays (for the newest headline), and says so.
    const paid = await manual.inject({ method: 'POST', url: '/sim/pay-signal' });
    assert.equal(paid.statusCode, 200);
    assert.equal(paid.json().trigger, 'sim');
    await manual.close();
  });

  it('merges two buys for the same headline into one payment', async () => {
    const payer = new CountingPayer('slow');
    const payments = paymentsWith(payer);
    const [a, b] = await Promise.all([payments.buyer.buy({ title: WAR }, 'sim'), payments.buyer.buy({ title: WAR }, 'decision')]);
    assert.equal(payer.calls.length, 1);
    assert.equal(a.txId, b.txId);
  });
});

class FakeAssistant implements VoiceAssistant {
  async answer(): Promise<AssistantReply> {
    return { id: 'msg_fake_1', text: 'Gold is up about one percent.' };
  }
}

const H = 3_600_000;
const START = Date.parse('2025-01-01T00:00:00Z');
const SCENARIO: Scenario = {
  id: 'autopay-sim',
  title: 'test',
  description: 'synthetic',
  start: '2025-01-01T00:00:00Z',
  end: '2025-01-01T04:00:00Z',
  interval: '1h',
  markets: [{ coin: 'BTC', source: 'binance', symbol: 'BTCUSDT' }],
  headlines: [{ ts: '2025-01-01T02:00:00Z', title: 'Missile strike reported near the Strait', source: 'Reuters', url: 'https://example.com/b', handle: 'Reuters' }],
  sources: [],
};
const CANDLES: CandleSet = {
  BTC: [100, 100, 100, 95, 90].map((c, i) => ({ t: START + (i - 1) * H, o: 100, h: 101, l: 89, c })),
};

describe('x402 autopay guards', () => {
  it('never pays for simulation decisions (paper only), even when a sim decision is confirmed', async () => {
    const payer = new CountingPayer();
    const decider = new StubDecider();
    const app = buildApp({
      config: loadConfig({ OG_DATA_DIR: mkdtempSync(join(tmpdir(), 'ghosty-autopay-')) }),
      payments: paymentsWith(payer),
      deps: { decider },
      sim: { loadCandles: async () => structuredClone(CANDLES), scenarios: () => [SCENARIO], autoTick: false, store: null },
    });
    assert.equal((await app.inject({ method: 'POST', url: '/sim/run', payload: { scenarioId: 'autopay-sim', speed: 1800 } })).statusCode, 200);
    await app.ghosty.sim.runUntilIdle();
    assert.ok(decider.calls >= 1, 'the sim asked the decider');
    const press = await app.inject({ method: 'POST', url: '/button', payload: { action: 'confirm' } });
    assert.equal(press.json().sim, true);
    await app.ghosty.sim.runUntilIdle();
    assert.equal(payer.calls.length, 0, 'a sim decision triggered a real payment');
    assert.equal((await app.inject({ method: 'GET', url: '/x402/status' })).json().lastPayment, null);
    await app.close();
  });

  it('does not pay when the brain probe says 0G is unreachable', async () => {
    const payer = new CountingPayer();
    // Live mode with OG_API_KEY set but an unreachable router: the health probe fails, so no decision will run.
    const app = buildApp({
      config: loadConfig({ GHOSTY_MODE: 'test', OG_API_KEY: 'k', OG_ROUTER_URL: 'http://127.0.0.1:9/v1' }),
      payments: paymentsWith(payer),
      deps: { decider: new StubDecider('offline') },
    });
    const res = await app.inject({ method: 'POST', url: '/news/inject', payload: { title: WAR } });
    assert.equal(res.statusCode, 503);
    assert.equal(payer.calls.length, 0);
    await app.close();
  });

  it('never pays for voice turns: Claude answers and 0G trade turns are not tied to a headline', async () => {
    const payer = new CountingPayer();
    const app = buildApp({ config: loadConfig({}), payments: paymentsWith(payer), assistant: new FakeAssistant() });
    const q = await app.inject({ method: 'POST', url: '/voice/text', payload: { text: "What's moving gold right now?" } });
    assert.equal(q.json().answeredBy, 'claude');
    const t = await app.inject({ method: 'POST', url: '/voice/text', payload: { text: 'Should I go long oil?' } });
    assert.equal(t.json().answeredBy, '0g');
    assert.equal(payer.calls.length, 0);
    await app.close();
  });
});

describe('x402 facilitator default', () => {
  it('uses Blocky402 for the configured Hedera network unless X402_FACILITATOR_URL is set', () => {
    assert.equal(loadConfig({}).X402_FACILITATOR_URL, 'https://api.testnet.blocky402.com');
    assert.equal(loadConfig({ HEDERA_NETWORK: 'mainnet' }).X402_FACILITATOR_URL, 'https://api.blocky402.com');
    assert.equal(loadConfig({ X402_FACILITATOR_URL: 'https://www.x402.org/facilitator' }).X402_FACILITATOR_URL, 'https://www.x402.org/facilitator');
    assert.equal(defaultFacilitatorUrl('testnet'), 'https://api.testnet.blocky402.com');
  });
});
