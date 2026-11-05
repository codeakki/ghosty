import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { PrivateKey, Transaction, TransferTransaction } from '@hiero-ledger/sdk';
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http';
import type { PaymentPayload, PaymentRequired } from '@x402/core/types';
import { createClientHederaSigner } from '@x402/hedera';
import Fastify, { type FastifyInstance } from 'fastify';
import { loadConfig, type Config } from '../src/config.js';
import { HcsAuditLog, auditMessage, type HcsTransport } from '../src/payments/hcsAudit.js';
import { hashscanTxUrl } from '../src/payments/hedera.js';
import { createPayments } from '../src/payments/index.js';
import { HostNotAllowedError, isHostAllowed, SpendCap, SpendCapExceededError } from '../src/payments/spendControls.js';
import { PaymentPolicyError, X402PaymentError, X402Payer } from '../src/payments/x402Client.js';
import { registerPaidRoutes, type SettledPayment, type SignalPayload } from '../src/payments/x402Server.js';

/**
 * No external network: the facilitator is a local Fastify stub on 127.0.0.1 that speaks the
 * x402 facilitator REST API (/supported, /verify, /settle), so the real HTTPFacilitatorClient,
 * x402ResourceServer, @x402/fetch and Hedera signer are all exercised end to end.
 */

const FEE_PAYER = '0.0.9185802';
const MERCHANT = '0.0.5005';
const PAYER = '0.0.1001';
const SETTLED_TX = `${FEE_PAYER}@1762400000.123456789`;
const SIGNAL: SignalPayload = { signal: 'geopolitical_shock', confidence: 0.72, actions: [{ coin: 'xyz:GOLD', side: 'long' }], requestId: 'og-req-1' };

type VerifyMode = 'ok' | 'invalid' | 'http400';
type SettleMode = 'ok' | 'fail';

interface FakeFacilitator {
  url: string;
  verifyMode: VerifyMode;
  settleMode: SettleMode;
  calls: { supported: number; verify: unknown[]; settle: unknown[] };
  close(): Promise<void>;
}

async function startFacilitator(): Promise<FakeFacilitator> {
  const app = Fastify();
  const f: FakeFacilitator = {
    url: '',
    verifyMode: 'ok',
    settleMode: 'ok',
    calls: { supported: 0, verify: [], settle: [] },
    close: () => app.close(),
  };
  app.get('/supported', async () => {
    f.calls.supported++;
    return {
      kinds: [{ x402Version: 2, scheme: 'exact', network: 'hedera:testnet', extra: { feePayer: FEE_PAYER } }],
      extensions: [],
      signers: { 'hedera:*': [FEE_PAYER] },
    };
  });
  app.post('/verify', async (req, reply) => {
    f.calls.verify.push(req.body);
    if (f.verifyMode === 'http400') return reply.code(400).send({ isValid: false, invalidReason: 'invalid_exact_hedera_payload_signature_invalid' });
    if (f.verifyMode === 'invalid') return { isValid: false, invalidReason: 'insufficient_funds', payer: PAYER };
    return { isValid: true, payer: PAYER };
  });
  app.post('/settle', async (req) => {
    f.calls.settle.push(req.body);
    if (f.settleMode === 'fail') return { success: false, errorReason: 'transaction_failed', transaction: '', network: 'hedera:testnet' };
    return { success: true, transaction: SETTLED_TX, network: 'hedera:testnet', payer: PAYER };
  });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  f.url = address;
  return f;
}

function cfg(over: Record<string, string> = {}): Config {
  return loadConfig({ X402_PAY_TO: MERCHANT, ...over });
}

function paidApp(config: Config, extra: { getSignal?: () => SignalPayload; onSettled?: (p: SettledPayment) => void } = {}) {
  const app = Fastify();
  registerPaidRoutes(app, { config, getSignal: extra.getSignal ?? (() => SIGNAL), onSettled: extra.onSettled });
  return app;
}

function paymentFor(required: PaymentRequired): PaymentPayload {
  const accepted = required.accepts[0];
  assert.ok(accepted);
  return { x402Version: 2, resource: required.resource, accepted, payload: { transaction: Buffer.from('signed-transfer').toString('base64') } };
}

describe('x402 server: GET /signal', () => {
  let fac: FakeFacilitator;
  before(async () => {
    fac = await startFacilitator();
  });
  after(async () => {
    await fac.close();
  });
  beforeEach(() => {
    fac.verifyMode = 'ok';
    fac.settleMode = 'ok';
    fac.calls = { supported: 0, verify: [], settle: [] };
  });

  it('answers 402 with Hedera exact payment requirements (body and PAYMENT-REQUIRED header)', async () => {
    const app = paidApp(cfg({ X402_FACILITATOR_URL: fac.url }));
    const res = await app.inject({ method: 'GET', url: '/signal' });
    assert.equal(res.statusCode, 402);
    const body = res.json() as PaymentRequired;
    assert.equal(body.x402Version, 2);
    assert.equal(body.accepts.length, 1);
    assert.deepEqual(body.accepts[0], {
      scheme: 'exact',
      network: 'hedera:testnet',
      amount: '1000000',
      asset: '0.0.0',
      payTo: MERCHANT,
      maxTimeoutSeconds: 180,
      extra: { feePayer: FEE_PAYER },
    });
    assert.match(body.resource.url, /\/signal$/);
    const header = res.headers['payment-required'];
    assert.equal(typeof header, 'string');
    assert.deepEqual(decodePaymentRequiredHeader(header as string), body);
    assert.equal(fac.calls.verify.length, 0);
  });

  it('uses X402_SIGNAL_PRICE_TINYBAR and falls back to HEDERA_ACCOUNT_ID for payTo', async () => {
    const app = Fastify();
    registerPaidRoutes(app, { config: loadConfig({ X402_FACILITATOR_URL: fac.url, HEDERA_ACCOUNT_ID: '0.0.777', X402_SIGNAL_PRICE_TINYBAR: '2500000' }) });
    const res = await app.inject({ method: 'GET', url: '/signal' });
    const accepted = (res.json() as PaymentRequired).accepts[0];
    assert.equal(accepted?.amount, '2500000');
    assert.equal(accepted?.payTo, '0.0.777');
  });

  it('verify ok → settle ok → 200 with the signal and the settled tx id', async () => {
    const settled: SettledPayment[] = [];
    const app = paidApp(cfg({ X402_FACILITATOR_URL: fac.url }), { onSettled: (p) => void settled.push(p) });
    const required = (await app.inject({ method: 'GET', url: '/signal' })).json() as PaymentRequired;

    const res = await app.inject({ method: 'GET', url: '/signal', headers: { 'payment-signature': encodePaymentSignatureHeader(paymentFor(required)) } });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.signal, SIGNAL.signal);
    assert.equal(body.confidence, SIGNAL.confidence);
    assert.deepEqual(body.actions, SIGNAL.actions);
    assert.equal(body.requestId, SIGNAL.requestId);
    assert.equal(body.paidTxId, SETTLED_TX);
    assert.equal(body.hashscanUrl, 'https://hashscan.io/testnet/transaction/0.0.9185802-1762400000-123456789');
    assert.equal(res.headers['x-payment-tx-id'], SETTLED_TX);
    assert.equal(decodePaymentResponseHeader(res.headers['payment-response'] as string).transaction, SETTLED_TX);
    assert.equal(decodePaymentResponseHeader(res.headers['x-payment-response'] as string).transaction, SETTLED_TX);

    assert.equal(fac.calls.verify.length, 1);
    assert.equal(fac.calls.settle.length, 1);
    const verifyReq = fac.calls.verify[0] as { paymentRequirements: { payTo: string; amount: string } };
    assert.equal(verifyReq.paymentRequirements.payTo, MERCHANT);
    assert.equal(verifyReq.paymentRequirements.amount, '1000000');
    assert.equal(settled.length, 1);
    assert.equal(settled[0]?.txId, SETTLED_TX);
    assert.equal(settled[0]?.requestId, 'og-req-1');
    assert.equal(fac.calls.supported, 1, '/supported is fetched once and cached');
  });

  it('also accepts the payload in the v1 X-PAYMENT header', async () => {
    const app = paidApp(cfg({ X402_FACILITATOR_URL: fac.url }));
    const required = (await app.inject({ method: 'GET', url: '/signal' })).json() as PaymentRequired;
    const res = await app.inject({ method: 'GET', url: '/signal', headers: { 'x-payment': encodePaymentSignatureHeader(paymentFor(required)) } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-payment-tx-id'], SETTLED_TX);
  });

  for (const mode of ['invalid', 'http400'] as const) {
    it(`verify fail (${mode}) → 402 with the reason, nothing settled, handler not run`, async () => {
      fac.verifyMode = mode;
      let handlerRuns = 0;
      const app = paidApp(cfg({ X402_FACILITATOR_URL: fac.url }), { getSignal: () => (handlerRuns++, SIGNAL) });
      const required = (await app.inject({ method: 'GET', url: '/signal' })).json() as PaymentRequired;
      const res = await app.inject({ method: 'GET', url: '/signal', headers: { 'payment-signature': encodePaymentSignatureHeader(paymentFor(required)) } });
      assert.equal(res.statusCode, 402);
      const expected = mode === 'invalid' ? 'insufficient_funds' : 'invalid_exact_hedera_payload_signature_invalid';
      assert.equal((res.json() as PaymentRequired).error, expected);
      assert.equal(decodePaymentRequiredHeader(res.headers['payment-required'] as string).error, expected);
      assert.equal(fac.calls.verify.length, 1);
      assert.equal(fac.calls.settle.length, 0);
      assert.equal(handlerRuns, 0);
    });
  }

  it('settle fail → 402 and no tx id', async () => {
    fac.settleMode = 'fail';
    const app = paidApp(cfg({ X402_FACILITATOR_URL: fac.url }));
    const required = (await app.inject({ method: 'GET', url: '/signal' })).json() as PaymentRequired;
    const res = await app.inject({ method: 'GET', url: '/signal', headers: { 'payment-signature': encodePaymentSignatureHeader(paymentFor(required)) } });
    assert.equal(res.statusCode, 402);
    assert.equal(res.headers['x-payment-tx-id'], undefined);
    assert.equal((res.json() as PaymentRequired).error, 'transaction_failed');
  });

  it('garbage or mismatched payment header → 402 without calling the facilitator', async () => {
    const app = paidApp(cfg({ X402_FACILITATOR_URL: fac.url }));
    const required = (await app.inject({ method: 'GET', url: '/signal' })).json() as PaymentRequired;
    const bad = await app.inject({ method: 'GET', url: '/signal', headers: { 'payment-signature': 'not-base64-json' } });
    assert.equal(bad.statusCode, 402);
    assert.equal((bad.json() as PaymentRequired).error, 'invalid_payment_header');

    const cheap = paymentFor(required);
    cheap.accepted = { ...cheap.accepted, amount: '1' };
    const res = await app.inject({ method: 'GET', url: '/signal', headers: { 'payment-signature': encodePaymentSignatureHeader(cheap) } });
    assert.equal(res.statusCode, 402);
    assert.equal((res.json() as PaymentRequired).error, 'no_matching_payment_requirements');
    assert.equal(fac.calls.verify.length, 0);
  });

  it('503 when no payTo account or the facilitator is unreachable', async () => {
    const noPayTo = Fastify();
    registerPaidRoutes(noPayTo, { config: loadConfig({ X402_FACILITATOR_URL: fac.url }) });
    assert.equal((await noPayTo.inject({ method: 'GET', url: '/signal' })).statusCode, 503);

    const down = paidApp(cfg({ X402_FACILITATOR_URL: 'http://127.0.0.1:9' }));
    const res = await down.inject({ method: 'GET', url: '/signal' });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error, 'facilitator_unavailable');
  });
});

describe('x402 client: autonomous payment with @x402/fetch + Hedera exact scheme', () => {
  let fac: FakeFacilitator;
  let server: FastifyInstance;
  let signalUrl: string;
  let dir: string;
  const key = PrivateKey.generateECDSA();
  const signer = createClientHederaSigner(PAYER, key, { network: 'hedera:testnet' });

  before(async () => {
    fac = await startFacilitator();
    server = paidApp(cfg({ X402_FACILITATOR_URL: fac.url }));
    const address = await server.listen({ port: 0, host: '127.0.0.1' });
    signalUrl = `${address}/signal`;
    dir = mkdtempSync(join(tmpdir(), 'ghosty-x402-'));
  });
  after(async () => {
    await server.close();
    await fac.close();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    fac.verifyMode = 'ok';
    fac.settleMode = 'ok';
    fac.calls = { supported: 0, verify: [], settle: [] };
  });

  const payer = (over: Record<string, string> = {}, maxPerDay = 100_000_000) =>
    new X402Payer({
      config: cfg(over),
      signer,
      spendCap: new SpendCap({ maxPerDayTinybar: maxPerDay, file: join(dir, `spend-${Math.random()}.json`) }),
    });

  it('pays the 402, gets the signal and the settled tx id', async () => {
    const p = payer();
    const paid = await p.payForSignal(signalUrl);
    assert.equal(paid.status, 200);
    assert.equal(paid.txId, SETTLED_TX);
    assert.equal(paid.hashscanUrl, hashscanTxUrl(SETTLED_TX));
    assert.equal((paid.body as SignalPayload).requestId, 'og-req-1');
    assert.equal(paid.amountTinybar, 1_000_000);
    assert.equal(paid.payTo, MERCHANT);
    assert.equal(p.spendCap.spentToday(), 1_000_000);

    // The facilitator received a real, payer-signed Hedera TransferTransaction: -amount payer, +amount merchant, fee payer in the tx id.
    const verifyReq = fac.calls.verify[0] as { paymentPayload: { x402Version: number; payload: { transaction: string } } };
    assert.equal(verifyReq.paymentPayload.x402Version, 2);
    const tx = Transaction.fromBytes(Buffer.from(verifyReq.paymentPayload.payload.transaction, 'base64'));
    assert.ok(tx instanceof TransferTransaction);
    const transfers = new Map([...tx.hbarTransfers].map(([acct, hbar]) => [acct.toString(), hbar.toTinybars().toString()]));
    assert.equal(transfers.get(PAYER), '-1000000');
    assert.equal(transfers.get(MERCHANT), '1000000');
    assert.equal(tx.transactionId?.accountId?.toString(), FEE_PAYER);
  });

  it('refuses once the daily spend cap would be exceeded, without signing', async () => {
    const p = payer({}, 1_500_000);
    await p.payForSignal(signalUrl);
    await assert.rejects(p.payForSignal(signalUrl), (err: unknown) => err instanceof PaymentPolicyError && /spend cap/.test(err.message));
    assert.equal(fac.calls.verify.length, 1);
    assert.equal(p.spendCap.spentToday(), 1_000_000);
  });

  it('refuses a price above the per-call cap (@x402/core spendControls)', async () => {
    const p = payer({ X402_MAX_PER_CALL_TINYBAR: '999999' });
    await assert.rejects(p.payForSignal(signalUrl), /maxAmountPerPayment/);
    assert.equal(fac.calls.verify.length, 0);
  });

  it('refuses hosts that are not allowlisted, before any request', async () => {
    const p = payer({ X402_ALLOWED_HOSTS: 'signals.ghosty.example' });
    await assert.rejects(p.payForSignal(signalUrl), HostNotAllowedError);
    assert.equal(fac.calls.supported + fac.calls.verify.length, 0);
  });

  it('refuses to pay its own account', async () => {
    const self = Fastify();
    registerPaidRoutes(self, { config: loadConfig({ X402_FACILITATOR_URL: fac.url, X402_PAY_TO: PAYER }) });
    const address = await self.listen({ port: 0, host: '127.0.0.1' });
    try {
      await assert.rejects(payer().payForSignal(`${address}/signal`), (err: unknown) => err instanceof PaymentPolicyError && /X402_PAY_TO/.test(err.message));
    } finally {
      await self.close();
    }
  });

  it('surfaces a failed verification as X402PaymentError with the reason', async () => {
    fac.verifyMode = 'invalid';
    await assert.rejects(payer().payForSignal(signalUrl), (err: unknown) => err instanceof X402PaymentError && err.status === 402 && err.reason === 'insufficient_funds');
  });
});

describe('SpendCap', () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'ghosty-spend-'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('adds up spend and refuses past the cap (boundary inclusive)', () => {
    const cap = new SpendCap({ maxPerDayTinybar: 3_000_000, file: null });
    cap.record(1_000_000);
    cap.record(2_000_000);
    assert.equal(cap.spentToday(), 3_000_000);
    assert.equal(cap.remainingToday(), 0);
    assert.equal(cap.canSpend(1), false);
    assert.throws(() => cap.record(1), SpendCapExceededError);
    assert.equal(cap.spentToday(), 3_000_000, 'a refused record changes nothing');
  });

  it('rejects zero, negative and fractional amounts and bad caps', () => {
    const cap = new SpendCap({ maxPerDayTinybar: 10, file: null });
    assert.equal(cap.canSpend(0), false);
    assert.equal(cap.canSpend(-5), false);
    assert.equal(cap.canSpend(1.5), false);
    assert.throws(() => new SpendCap({ maxPerDayTinybar: 0, file: null }), RangeError);
  });

  it('persists across instances and resets on a new UTC day', () => {
    const file = join(dir, 'spend.json');
    let now = new Date('2026-11-06T23:59:00Z');
    const a = new SpendCap({ maxPerDayTinybar: 5_000_000, file, now: () => now });
    a.record(4_000_000, '0.0.5005');
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.day, '2026-11-06');
    assert.equal(saved.spentTinybar, 4_000_000);
    assert.equal(saved.payments[0].ref, '0.0.5005');

    const b = new SpendCap({ maxPerDayTinybar: 5_000_000, file, now: () => now });
    assert.equal(b.spentToday(), 4_000_000);
    assert.equal(b.canSpend(2_000_000), false);

    now = new Date('2026-11-07T00:00:01Z');
    assert.equal(b.spentToday(), 0);
    assert.equal(b.canSpend(5_000_000), true);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).day, '2026-11-07');
  });
});

describe('host allowlist', () => {
  const allowed = ['localhost', '127.0.0.1:3000', '*.ghosty.dev'];
  const cases: Array<[string, boolean]> = [
    ['http://localhost:3000/signal', true],
    ['http://LOCALHOST/signal', true],
    ['http://127.0.0.1:3000/signal', true],
    ['http://127.0.0.1:4000/signal', false],
    ['https://api.ghosty.dev/signal', true],
    ['https://ghosty.dev.evil.com/signal', false],
    ['https://evil.com/signal', false],
    ['ftp://localhost/signal', false],
    ['not a url', false],
  ];
  for (const [url, ok] of cases) {
    it(`${ok ? 'allows' : 'refuses'} ${url}`, () => assert.equal(isHostAllowed(url, allowed), ok));
  }
  it('parses X402_ALLOWED_HOSTS from config', () => {
    assert.deepEqual(loadConfig({}).X402_ALLOWED_HOSTS, ['localhost', '127.0.0.1']);
    assert.deepEqual(loadConfig({ X402_ALLOWED_HOSTS: ' A.com, b.com:8080 ,' }).X402_ALLOWED_HOSTS, ['a.com', 'b.com:8080']);
  });
});

describe('HCS audit log', () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'ghosty-hcs-'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  function fakeTransport() {
    const state = { created: 0, messages: [] as Array<{ topicId: string; message: string }> };
    const transport: HcsTransport = {
      async createTopic() {
        state.created++;
        return '0.0.4242';
      },
      async submit(topicId: string, message: string) {
        state.messages.push({ topicId, message });
        return { sequenceNumber: String(state.messages.length), txId: `0.0.1001@1762400000.${state.messages.length}` };
      },
    };
    return Object.assign(state, { transport });
  }

  it('creates the topic once, caches it, and writes {ts, kind, txId, requestId, summary}', async () => {
    const stateFile = join(dir, 'hcs.json');
    const t = fakeTransport();
    const now = () => new Date('2026-11-07T10:00:00Z');
    const log = new HcsAuditLog({ transport: t.transport, stateFile, now });
    assert.equal(log.topicUrl(), undefined);
    const [r1, r2] = await Promise.all([
      log.record({ kind: 'payment', txId: SETTLED_TX, requestId: 'og-req-1', summary: 'paid 1000000 tinybar' }),
      log.record({ kind: 'decision', requestId: 'og-req-1', summary: 'long xyz:GOLD' }),
    ]);
    assert.equal(t.created, 1);
    assert.equal(r1.topicId, '0.0.4242');
    assert.equal(r2.sequenceNumber, '2');
    assert.equal(log.topicUrl(), 'https://hashscan.io/testnet/topic/0.0.4242');
    assert.deepEqual(JSON.parse(t.messages[0]?.message ?? ''), {
      ts: '2026-11-07T10:00:00.000Z',
      kind: 'payment',
      txId: SETTLED_TX,
      requestId: 'og-req-1',
      summary: 'paid 1000000 tinybar',
    });

    const again = new HcsAuditLog({ transport: fakeTransport().transport, stateFile });
    assert.equal(again.topicUrl(), 'https://hashscan.io/testnet/topic/0.0.4242', 'topic id reloaded from hcs.json');
  });

  it('caps the summary length', () => {
    assert.equal(auditMessage({ kind: 'decision', summary: 'x'.repeat(2000) }).summary.length, 512);
  });

  it('is a no-op without Hedera keys', async () => {
    const log = HcsAuditLog.fromConfig(loadConfig({}));
    assert.equal(log.enabled, false);
    assert.equal(await log.record({ kind: 'payment', summary: 'x' }), undefined);
  });
});

describe('payments factory', () => {
  it('falls back to the fake payer without Hedera keys', async () => {
    const p = createPayments(loadConfig({}));
    assert.equal(p.mode, 'fake');
    assert.equal(p.audit.enabled, false);
    const paid = await p.payer.payForSignal('http://localhost:3000/signal');
    assert.match(paid.txId, /^0\.0\.0@\d+\.000000000$/);
    assert.match(paid.hashscanUrl, /^https:\/\/hashscan\.io\/testnet\/transaction\//);
  });
});
