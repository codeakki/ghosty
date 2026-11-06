import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { BrainOfflineError, type Decider, type DecideInput, type Decision } from '../src/agent/decide.js';
import { buildApp } from '../src/app.js';
import type { AssistantReply, VoiceAssistant } from '../src/claude/voice.js';
import { defaultFacilitatorUrl, loadConfig } from '../src/config.js';
import { NoopAuditLog, type Payments } from '../src/payments/index.js';
import type { PaidSignal, SignalPayer } from '../src/payments/x402Client.js';
import type { CandleSet } from '../src/sim/candles.js';
import type { Scenario } from '../src/sim/scenarios.js';

/** The decision loop pays for GET /signal on its own (X402_AUTOPAY). Every payer here is in-process. */

const WAR = 'War breaks out: missile strikes hit Gulf oil terminals';

class CountingPayer implements SignalPayer {
  readonly mode = 'real' as const;
  calls: string[] = [];
  constructor(private readonly behaviour: 'ok' | 'fail' | 'slow' = 'ok') {}
  async payForSignal(url: string): Promise<PaidSignal> {
    this.calls.push(url);
    if (this.behaviour === 'fail') throw new Error('facilitator said no');
    if (this.behaviour === 'slow') await new Promise((r) => setTimeout(r, 300));
    const txId = `0.0.1001@1730000000.00000000${this.calls.length}`;
    return { status: 200, body: { requestId: 'prev' }, txId, hashscanUrl: `https://hashscan.io/testnet/transaction/${txId}`, amountTinybar: 1_000_000 };
  }
}

const paymentsWith = (payer: SignalPayer): Payments => ({ mode: 'real', payer, audit: new NoopAuditLog() });

async function receiptsOfProposed(app: ReturnType<typeof buildApp>): Promise<string[] | undefined> {
  const state = (await app.inject({ method: 'GET', url: '/state' })).json();
  return state.episodes.find((e: { outcome: string }) => e.outcome === 'proposed')?.receipts;
}

describe('x402 autopay in the decision loop', () => {
  it('pays /signal once per decision with no button press, and logs the tx on the episode', async () => {
    const payer = new CountingPayer();
    const app = buildApp({ config: loadConfig({ PORT: '4555' }), payments: paymentsWith(payer) });

    const res = await app.inject({ method: 'POST', url: '/news/inject', payload: { title: WAR } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(payer.calls, ['http://127.0.0.1:4555/signal']);
    assert.deepEqual(await receiptsOfProposed(app), ['0.0.1001@1730000000.000000001']);

    const status = (await app.inject({ method: 'GET', url: '/x402/status' })).json();
    assert.equal(status.autopay, true);
    assert.equal(status.lastPayment.trigger, 'decision');
    assert.equal(status.lastPayment.txId, '0.0.1001@1730000000.000000001');

    await app.inject({ method: 'POST', url: '/voice/text', payload: { text: 'what is gold doing?' } });
    assert.equal(payer.calls.length, 2);
    await app.close();
  });

  it('a failed payment never blocks the decision', async () => {
    const payer = new CountingPayer('fail');
    const app = buildApp({ config: loadConfig({}), payments: paymentsWith(payer) });
    const res = await app.inject({ method: 'POST', url: '/news/inject', payload: { title: WAR } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().decision.signal, 'geopolitical_shock');
    assert.equal(payer.calls.length, 1);
    assert.equal(await receiptsOfProposed(app), undefined);
    assert.equal((await app.inject({ method: 'GET', url: '/x402/status' })).json().lastPayment, null);
    await app.close();
  });

  it('a slow payment is not waited on past X402_AUTOPAY_WAIT_MS, but still lands in lastPayment', async () => {
    const payer = new CountingPayer('slow');
    const app = buildApp({ config: loadConfig({ X402_AUTOPAY_WAIT_MS: '20' }), payments: paymentsWith(payer) });
    await app.inject({ method: 'POST', url: '/news/inject', payload: { title: WAR } });
    assert.equal(await receiptsOfProposed(app), undefined, 'decision answered before settlement');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal((await app.inject({ method: 'GET', url: '/x402/status' })).json().lastPayment.trigger, 'decision');
    await app.close();
  });

  it('does not pay while the brain is offline, or when X402_AUTOPAY=false', async () => {
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
    // The sim button still pays, and says so.
    const paid = await manual.inject({ method: 'POST', url: '/sim/pay-signal' });
    assert.equal(paid.statusCode, 200);
    assert.equal(paid.json().trigger, 'sim');
    await manual.close();
  });
});

/** 0G decider stand-in: a shock decision, or a 0G failure (timeout / router down). */
class StubDecider implements Decider {
  calls = 0;
  constructor(private readonly behaviour: 'short' | 'offline' = 'short') {}
  async decide(input: DecideInput): Promise<Decision> {
    this.calls++;
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
    assert.equal(payer.calls.length, 0, 'a sim decision triggered a real /signal payment');
    assert.equal((await app.inject({ method: 'GET', url: '/x402/status' })).json().lastPayment, null);
    await app.close();
  });

  it('does not pay when the 0G call fails (timeout -> brain_offline)', async () => {
    const payer = new CountingPayer();
    const app = buildApp({ config: loadConfig({}), payments: paymentsWith(payer), deps: { decider: new StubDecider('offline') } });
    const res = await app.inject({ method: 'POST', url: '/news/inject', payload: { title: WAR } });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error, 'brain_offline');
    assert.equal(payer.calls.length, 0);
    await app.close();
  });

  it('does not pay for Claude-answered voice turns, only for 0G trade turns', async () => {
    const payer = new CountingPayer();
    const app = buildApp({ config: loadConfig({}), payments: paymentsWith(payer), assistant: new FakeAssistant() });
    const q = await app.inject({ method: 'POST', url: '/voice/text', payload: { text: "What's moving gold right now?" } });
    assert.equal(q.json().answeredBy, 'claude');
    assert.equal(payer.calls.length, 0);
    const t = await app.inject({ method: 'POST', url: '/voice/text', payload: { text: 'Should I go long oil?' } });
    assert.equal(t.json().answeredBy, '0g');
    assert.equal(payer.calls.length, 1);
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
