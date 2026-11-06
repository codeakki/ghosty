import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { PrivateKey, Transaction, TransferTransaction } from '@hiero-ledger/sdk';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { createClientHederaSigner } from '@x402/hedera';
import Fastify, { type FastifyInstance } from 'fastify';
import { loadConfig, type Config } from '../src/config.js';
import { FakeEthosScorer } from '../src/credibility/ethos.js';
import type { NewsItem, NewsProvider } from '../src/news/types.js';
import { decodeAuditMessage, encodeAuditMessage, HcsAuditLog, readAuditLog, type HcsTransport } from '../src/payments/hcsAudit.js';
import { formatAmount, hashscanTxUrl, toMirrorTxId } from '../src/payments/hedera.js';
import { createPayments } from '../src/payments/index.js';
import { checkTransfer, verifyPaymentOnMirror, type ExpectedTransfer } from '../src/payments/mirror.js';
import { runSetup, type SetupOps } from '../src/payments/setup.js';
import { buildSignalDeskApp, corroborate, IntelService, severityOf, type IntelBundle } from '../src/payments/signalDesk.js';
import { HostNotAllowedError, isHostAllowed, SpendCap, SpendCapExceededError } from '../src/payments/spendControls.js';
import { PaymentPolicyError, PaymentQueueFullError, X402PaymentError, X402Payer } from '../src/payments/x402Client.js';

/**
 * No external network. The facilitator is a local Fastify stub on 127.0.0.1 speaking the x402 facilitator REST
 * API (/supported, /verify, /settle), so the real HTTPFacilitatorClient, x402ResourceServer, @x402/fetch and the
 * Hedera signer are exercised end to end. The mirror node is a mocked fetch; the HCS transport is a fake.
 */

const FEE_PAYER = '0.0.9185802';
const MERCHANT = '0.0.5005';
const PAYER = '0.0.1001';
const USDC = '0.0.429274';
const SETTLED_TX = `${FEE_PAYER}@1762400000.123456789`;
const HEADLINE = 'Missile strikes reported near Strait of Hormuz';

interface FakeFacilitator {
  url: string;
  verifyMode: 'ok' | 'invalid';
  settleMode: 'ok' | 'fail';
  calls: { supported: number; verify: unknown[]; settle: unknown[] };
  close(): Promise<void>;
}

async function startFacilitator(): Promise<FakeFacilitator> {
  const app = Fastify();
  const f: FakeFacilitator = { url: '', verifyMode: 'ok', settleMode: 'ok', calls: { supported: 0, verify: [], settle: [] }, close: () => app.close() };
  app.get('/supported', async () => {
    f.calls.supported++;
    return { kinds: [{ x402Version: 2, scheme: 'exact', network: 'hedera:testnet', extra: { feePayer: FEE_PAYER } }], extensions: [], signers: { 'hedera:*': [FEE_PAYER] } };
  });
  app.post('/verify', async (req) => {
    f.calls.verify.push(req.body);
    return f.verifyMode === 'invalid' ? { isValid: false, invalidReason: 'insufficient_funds', payer: PAYER } : { isValid: true, payer: PAYER };
  });
  app.post('/settle', async (req) => {
    f.calls.settle.push(req.body);
    if (f.settleMode === 'fail') return { success: false, errorReason: 'transaction_failed', transaction: '', network: 'hedera:testnet' };
    return { success: true, transaction: SETTLED_TX, network: 'hedera:testnet', payer: PAYER };
  });
  f.url = await app.listen({ port: 0, host: '127.0.0.1' });
  return f;
}

const item = (title: string, domain: string, minutesAgo = 5): NewsItem => ({
  id: `rss:${domain}:${title.length}`,
  source: 'rss',
  title,
  url: `https://${domain}/a`,
  domain,
  publishedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
});

const NEWS: NewsItem[] = [
  item('Missile strikes near the Strait of Hormuz rattle oil markets', 'reuters.com'),
  item('Oil jumps as missile strikes hit Hormuz shipping lane', 'bloomberg.com'),
  item('Hormuz missile strikes: tankers reroute', 'ft.com'),
  item('Bitcoin ETF flows steady', 'coindesk.com'),
];
const newsProvider: NewsProvider = { name: 'test', fetchLatest: async () => NEWS };
const intel = () => new IntelService({ news: [newsProvider], scorer: new FakeEthosScorer(), windowMinutes: 120 });

function cfg(over: Record<string, string> = {}): Config {
  return loadConfig({ X402_PAY_TO: MERCHANT, ...over });
}

describe('Signal Desk (x402 merchant)', () => {
  let fac: FakeFacilitator;
  before(async () => {
    fac = await startFacilitator();
  });
  after(() => fac.close());

  it('answers 402 offering USDC (HTS, 6 decimals) and HBAR (tinybars) to its own account', async () => {
    const desk = buildSignalDeskApp({ config: cfg({ X402_FACILITATOR_URL: fac.url }), intel: intel() });
    const res = await desk.inject({ method: 'GET', url: `/intel?headline=${encodeURIComponent(HEADLINE)}` });
    assert.equal(res.statusCode, 402);
    const body = res.json() as PaymentRequired;
    assert.deepEqual(decodePaymentRequiredHeader(String(res.headers['payment-required'])), body);
    assert.deepEqual(
      body.accepts.map((a) => [a.network, a.asset, a.amount, a.payTo]),
      [
        ['hedera:testnet', USDC, '10000', MERCHANT],
        ['hedera:testnet', '0.0.0', '1000000', MERCHANT],
      ],
    );
    assert.equal(body.accepts[0]?.extra?.feePayer, FEE_PAYER);
    await desk.close();
  });

  it('400 without a headline (before asking for money), 503 without a merchant account or facilitator', async () => {
    const desk = buildSignalDeskApp({ config: cfg({ X402_FACILITATOR_URL: fac.url }), intel: intel() });
    assert.equal((await desk.inject({ method: 'GET', url: '/intel' })).statusCode, 400);
    await desk.close();
    const noPayTo = buildSignalDeskApp({ config: loadConfig({ X402_FACILITATOR_URL: fac.url }), intel: intel() });
    assert.equal((await noPayTo.inject({ method: 'GET', url: '/intel?headline=x' })).json().error, 'payments_not_configured');
    await noPayTo.close();
    const down = buildSignalDeskApp({ config: cfg({ X402_FACILITATOR_URL: 'http://127.0.0.1:9' }), intel: intel() });
    assert.equal((await down.inject({ method: 'GET', url: '/intel?headline=x' })).json().error, 'facilitator_unavailable');
    await down.close();
  });

  it('builds a bundle from real inputs: Ethos score, corroborating outlets, shock category and severity', async () => {
    const b = await intel().bundle({ headline: HEADLINE, handle: 'reuters', domain: 'cnbc.com' });
    assert.equal(b.provider, 'ghosty-signal-desk');
    assert.equal(b.source.ethos?.level, 'exemplary');
    assert.deepEqual(b.corroboration.sources.sort(), ['bloomberg.com', 'ft.com', 'reuters.com']);
    assert.equal(b.corroboration.count, 3);
    assert.equal(b.shock.category, 'geopolitical_shock');
    assert.equal(b.shock.severity, 'high');
  });

  it('corroboration ignores the source itself and unrelated stories; severity follows the rule', () => {
    const { sources } = corroborate({ headline: HEADLINE, domain: 'reuters.com' }, NEWS);
    assert.ok(!sources.includes('reuters.com'));
    assert.ok(!sources.includes('coindesk.com'));
    assert.equal(severityOf(0, 5, 'exemplary'), 'none');
    assert.equal(severityOf(1, 0, 'neutral'), 'low');
    assert.equal(severityOf(1, 2, 'neutral'), 'medium');
    assert.equal(severityOf(2, 2, 'reputable'), 'high');
  });
});

describe('x402 client: the agent pays the Signal Desk', () => {
  let fac: FakeFacilitator;
  let desk: FastifyInstance;
  let url: string;
  let dir: string;
  const signer = createClientHederaSigner(PAYER, PrivateKey.generateECDSA(), { network: 'hedera:testnet' });
  const verified: ExpectedTransfer[] = [];

  before(async () => {
    fac = await startFacilitator();
    desk = buildSignalDeskApp({ config: cfg({ X402_FACILITATOR_URL: fac.url }), intel: intel() });
    url = `${await desk.listen({ port: 0, host: '127.0.0.1' })}/intel?headline=${encodeURIComponent(HEADLINE)}`;
    dir = mkdtempSync(join(tmpdir(), 'ghosty-x402-'));
  });
  after(async () => {
    await desk.close();
    await fac.close();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    fac.verifyMode = 'ok';
    fac.settleMode = 'ok';
    fac.calls = { supported: 0, verify: [], settle: [] };
    verified.length = 0;
  });

  const payer = (over: Record<string, string> = {}, extra: { fetch?: typeof fetch } = {}) => {
    const config = cfg(over);
    return new X402Payer({
      config,
      signer,
      fetch: extra.fetch,
      spendCap: new SpendCap({
        maxPerDay: { '0.0.0': BigInt(config.X402_MAX_SPEND_TINYBAR), [USDC]: BigInt(config.X402_MAX_SPEND_USDC_MICROS) },
        file: join(dir, `spend-${Math.random()}.json`),
      }),
      verify: async (expected) => {
        verified.push(expected);
        return { verified: true, consensusTimestamp: '1762400001.0', checkedAt: 'now' };
      },
    });
  };

  it('prefers USDC: signs an HTS token transfer agent → desk, gets the bundle and a verified receipt', async () => {
    const p = payer();
    const paid = await p.pay(url);
    assert.equal(paid.txId, SETTLED_TX);
    assert.equal(paid.hashscanUrl, hashscanTxUrl(SETTLED_TX));
    assert.equal(paid.asset, USDC);
    assert.equal(paid.amount, '10000');
    assert.equal((paid.body as IntelBundle).shock.category, 'geopolitical_shock');
    assert.equal(p.spendCap.spentToday(USDC), 10_000n);
    assert.equal(p.spendCap.spentToday('0.0.0'), 0n);
    assert.deepEqual(await paid.verification, { verified: true, consensusTimestamp: '1762400001.0', checkedAt: 'now' });
    assert.deepEqual(verified[0], { txId: SETTLED_TX, payer: PAYER, payTo: MERCHANT, asset: USDC, amount: '10000' });

    const verifyReq = fac.calls.verify[0] as { paymentPayload: { payload: { transaction: string } } };
    const tx = Transaction.fromBytes(Buffer.from(verifyReq.paymentPayload.payload.transaction, 'base64'));
    assert.ok(tx instanceof TransferTransaction);
    const moves = new Map([...(tx.tokenTransfers.get(USDC) ?? new Map())].map(([acct, n]) => [acct.toString(), n.toString()]));
    assert.equal(moves.get(PAYER), '-10000');
    assert.equal(moves.get(MERCHANT), '10000');
  });

  it('pays HBAR when X402_PREFERRED_ASSET=hbar', async () => {
    const p = payer({ X402_PREFERRED_ASSET: 'hbar' });
    const paid = await p.pay(url);
    assert.equal(paid.asset, '0.0.0');
    assert.equal(paid.amount, '1000000');
    assert.equal(p.spendCap.spentToday('0.0.0'), 1_000_000n);
  });

  it('per-asset daily cap: refuses before signing once the USDC budget is used up', async () => {
    const p = payer({ X402_MAX_SPEND_USDC_MICROS: '15000' });
    await p.pay(url);
    await assert.rejects(p.pay(url), (err: unknown) => err instanceof PaymentPolicyError && /spend cap/.test(err.message));
    assert.equal(fac.calls.verify.length, 1);
    assert.equal(p.spendCap.spentToday(USDC), 10_000n);
  });

  it('per-call cap: an over-priced asset is skipped (falls back to HBAR); with both over, nothing is signed', async () => {
    const paid = await payer({ X402_MAX_PER_CALL_USDC_MICROS: '9999' }).pay(url);
    assert.equal(paid.asset, '0.0.0', 'USDC over its per-call cap, HBAR within');
    fac.calls.verify = [];
    await assert.rejects(
      payer({ X402_MAX_PER_CALL_USDC_MICROS: '9999', X402_MAX_PER_CALL_TINYBAR: '999999' }).pay(url),
      /per-call cap|maxAmountPerPayment|No payment requirements/i,
    );
    assert.equal(fac.calls.verify.length, 0);
  });

  it('refuses hosts that are not allowlisted, before any request', async () => {
    await assert.rejects(payer({ X402_ALLOWED_HOSTS: 'desk.example' }).pay(url), HostNotAllowedError);
    assert.equal(fac.calls.supported + fac.calls.verify.length, 0);
  });

  it('refuses to pay its own account', async () => {
    const self = buildSignalDeskApp({ config: cfg({ X402_FACILITATOR_URL: fac.url, X402_PAY_TO: PAYER }), intel: intel() });
    const address = await self.listen({ port: 0, host: '127.0.0.1' });
    try {
      await assert.rejects(payer().pay(`${address}/intel?headline=x`), (err: unknown) => err instanceof PaymentPolicyError && /X402_PAY_TO/.test(err.message));
    } finally {
      await self.close();
    }
  });

  it('surfaces a failed verification or settlement as X402PaymentError, and never returns a receipt', async () => {
    fac.verifyMode = 'invalid';
    await assert.rejects(payer().pay(url), (err: unknown) => err instanceof X402PaymentError && err.reason === 'insufficient_funds');
    fac.verifyMode = 'ok';
    fac.settleMode = 'fail';
    await assert.rejects(payer().pay(url), (err: unknown) => err instanceof X402PaymentError && err.reason === 'transaction_failed');
    assert.equal(verified.length, 0, 'nothing to verify without a settlement');
  });

  it('bounded queue: with 2 payments in flight a third is refused, not queued', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slowFetch: typeof fetch = async (input, init) => {
      await gate;
      return fetch(input, init);
    };
    const p = payer({}, { fetch: slowFetch });
    const first = p.pay(url);
    const second = p.pay(url);
    await assert.rejects(p.pay(url), PaymentQueueFullError);
    release();
    await Promise.all([first, second]);
    assert.equal(fac.calls.settle.length, 2);
  });
});

describe('SpendCap (per asset, bigint)', () => {
  it('tracks each asset separately and refuses past its cap', () => {
    const cap = new SpendCap({ maxPerDay: { '0.0.0': 3_000_000n, [USDC]: 20_000n }, file: null });
    cap.record(USDC, 10_000n);
    cap.record('0.0.0', 3_000_000n);
    assert.equal(cap.remainingToday(USDC), 10_000n);
    assert.equal(cap.remainingToday('0.0.0'), 0n);
    assert.throws(() => cap.record('0.0.0', 1n), SpendCapExceededError);
    assert.equal(cap.canSpend('0.0.999', 1n), false, 'unlisted assets have no budget');
    assert.equal(cap.canSpend(USDC, 0n), false);
    assert.throws(() => new SpendCap({ maxPerDay: { [USDC]: 0n }, file: null }), RangeError);
  });

  it('persists across restarts and rolls over at UTC midnight', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghosty-spend-'));
    const file = join(dir, 'spend.json');
    let now = new Date('2026-11-07T23:00:00Z');
    new SpendCap({ maxPerDay: { [USDC]: 50_000n }, file, now: () => now }).record(USDC, 40_000n);
    const b = new SpendCap({ maxPerDay: { [USDC]: 50_000n }, file, now: () => now });
    assert.equal(b.spentToday(USDC), 40_000n);
    now = new Date('2026-11-08T00:00:01Z');
    assert.equal(b.spentToday(USDC), 0n);
    rmSync(dir, { recursive: true, force: true });
  });

  it('host allowlist', () => {
    const allowed = ['localhost', '127.0.0.1:3101', '*.ghosty.dev'];
    assert.equal(isHostAllowed('http://localhost:3101/intel', allowed), true);
    assert.equal(isHostAllowed('http://127.0.0.1:3101/intel', allowed), true);
    assert.equal(isHostAllowed('http://127.0.0.1:4000/intel', allowed), false);
    assert.equal(isHostAllowed('https://desk.ghosty.dev/intel', allowed), true);
    assert.equal(isHostAllowed('https://ghosty.dev.evil.com/intel', allowed), false);
    assert.equal(isHostAllowed('ftp://localhost/intel', allowed), false);
  });
});

describe('mirror-node verification', () => {
  const expected: ExpectedTransfer = { txId: SETTLED_TX, payer: PAYER, payTo: MERCHANT, asset: USDC, amount: '10000' };
  const usdcTx = (amount: number, result = 'SUCCESS') => ({
    result,
    consensus_timestamp: '1762400001.000000001',
    transfers: [{ account: FEE_PAYER, amount: -100_000 }],
    token_transfers: [
      { token_id: USDC, account: PAYER, amount: -amount },
      { token_id: USDC, account: MERCHANT, amount },
    ],
  });
  const mirror = (responses: Array<{ status: number; body?: unknown }>) => {
    const urls: string[] = [];
    const f: typeof fetch = async (input) => {
      urls.push(String(input));
      const r = responses[Math.min(urls.length - 1, responses.length - 1)] ?? { status: 404 };
      return new Response(r.body === undefined ? '{}' : JSON.stringify(r.body), { status: r.status });
    };
    return { f, urls };
  };
  const fastClock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  };

  it('success: polls the dashed tx id until the transfer shows up with the right asset and amount', async () => {
    const { f, urls } = mirror([{ status: 404 }, { status: 200, body: { transactions: [usdcTx(10_000)] } }]);
    const v = await verifyPaymentOnMirror(expected, { mirrorUrl: 'https://mirror.test', fetch: f, ...fastClock() });
    assert.equal(v.verified, true);
    assert.equal(urls.length, 2);
    assert.equal(urls[0], `https://mirror.test/api/v1/transactions/${toMirrorTxId(SETTLED_TX)}`);
    assert.equal(toMirrorTxId(SETTLED_TX), '0.0.9185802-1762400000-123456789');
  });

  it('wrong amount or failed result: not verified, with the reason, no more polling', async () => {
    const { f, urls } = mirror([{ status: 200, body: { transactions: [usdcTx(9_999)] } }]);
    const v = await verifyPaymentOnMirror(expected, { mirrorUrl: 'https://mirror.test', fetch: f, ...fastClock() });
    assert.equal(v.verified, false);
    assert.match(v.verified ? '' : v.reason, /received 9999, expected 10000/);
    assert.equal(urls.length, 1);
    assert.match(checkTransfer(usdcTx(10_000, 'INSUFFICIENT_PAYER_BALANCE'), expected) ?? '', /INSUFFICIENT/);
    assert.match(checkTransfer(usdcTx(10_000), { ...expected, asset: '0.0.0' }) ?? '', /received 0/, 'HBAR expected, token moved');
  });

  it('timeout: never on the mirror node within the window → not verified', async () => {
    const { f, urls } = mirror([{ status: 404 }]);
    const v = await verifyPaymentOnMirror(expected, { mirrorUrl: 'https://mirror.test', fetch: f, timeoutMs: 5000, intervalMs: 1000, ...fastClock() });
    assert.equal(v.verified, false);
    assert.match(v.verified ? '' : v.reason, /^timeout/);
    assert.equal(urls.length, 6);
  });

  it('formats amounts without floats', () => {
    assert.equal(formatAmount(USDC, '10000', USDC), '0.01 USDC');
    assert.equal(formatAmount('0.0.0', '1000000', USDC), '0.01 HBAR');
    assert.equal(formatAmount('0.0.0', 250_000_000n, USDC), '2.5 HBAR');
  });
});

describe('HCS audit log', () => {
  function fakeTransport() {
    const messages: Array<{ topicId: string; message: string }> = [];
    const transport: HcsTransport = {
      async submit(topicId, message) {
        messages.push({ topicId, message });
        return { sequenceNumber: String(messages.length), txId: `${PAYER}@1762400000.${messages.length}` };
      },
    };
    return { messages, transport };
  }

  it('writes structured v1 JSON to the pinned topic (no topic creation in the hot path)', async () => {
    const t = fakeTransport();
    const log = new HcsAuditLog({ transport: t.transport, topicId: '0.0.4242', now: () => new Date('2026-11-07T10:00:00Z') });
    const r = await log.record({ kind: 'payment', txId: SETTLED_TX, asset: USDC, amount: '10000', payTo: MERCHANT, verified: true });
    assert.deepEqual(r, { topicId: '0.0.4242', sequenceNumber: '1', txId: `${PAYER}@1762400000.1` });
    assert.deepEqual(JSON.parse(t.messages[0]?.message ?? ''), {
      v: 1,
      kind: 'payment',
      ts: '2026-11-07T10:00:00.000Z',
      txId: SETTLED_TX,
      asset: USDC,
      amount: '10000',
      payTo: MERCHANT,
      verified: true,
    });
    assert.equal(log.topicUrl(), 'https://hashscan.io/testnet/topic/0.0.4242');
  });

  it('stops at the daily message cap', async () => {
    const t = fakeTransport();
    const log = new HcsAuditLog({ transport: t.transport, topicId: '0.0.4242', maxMessagesPerDay: 2 });
    await log.record({ kind: 'decision', requestId: 'a' });
    await log.record({ kind: 'decision', requestId: 'b' });
    assert.equal(await log.record({ kind: 'decision', requestId: 'c' }), undefined);
    assert.equal(t.messages.length, 2);
  });

  it('every message stays a single HCS chunk; long fields are trimmed', () => {
    const text = encodeAuditMessage({ kind: 'trade', requestId: 'x'.repeat(5000), signal: 'y'.repeat(5000) });
    assert.ok(Buffer.byteLength(text) <= 1024);
  });

  it('the reader decodes base64 mirror messages, and keeps foreign ones as raw', async () => {
    const msg = encodeAuditMessage({ kind: 'decision', requestId: '0g-1', signal: 'geopolitical_shock', txId: SETTLED_TX });
    const f: typeof fetch = async (input) => {
      assert.equal(String(input), 'https://mirror.test/api/v1/topics/0.0.4242/messages?limit=2&order=desc');
      return Response.json({
        messages: [
          { sequence_number: 2, consensus_timestamp: '1762400002.0', message: Buffer.from(msg).toString('base64') },
          { sequence_number: 1, consensus_timestamp: '1762400001.0', message: Buffer.from('hello').toString('base64') },
        ],
      });
    };
    const rows = await readAuditLog('0.0.4242', 2, { mirrorUrl: 'https://mirror.test', fetch: f });
    assert.equal(rows[0]?.sequenceNumber, 2);
    assert.deepEqual(rows[0]?.message, decodeAuditMessage(msg));
    assert.equal((rows[0]?.message as { kind: string }).kind, 'decision');
    assert.deepEqual(rows[1]?.message, { raw: 'hello' });
  });

  it('is a no-op without the topic and its submit key', async () => {
    const log = HcsAuditLog.fromConfig(loadConfig({ HEDERA_ACCOUNT_ID: PAYER, HEDERA_PRIVATE_KEY: PrivateKey.generateECDSA().toStringDer() }));
    assert.equal(log.enabled, false);
    assert.equal(await log.record({ kind: 'payment' }), undefined);
  });
});

describe('hedera:setup (idempotent custody split)', () => {
  function fakeOps(initial: { agent?: boolean; associated?: boolean; tinybar?: bigint; usdc?: bigint; merchant?: boolean; key?: boolean; topic?: boolean }) {
    const calls: string[] = [];
    const s = { ...initial };
    const ops: SetupOps = {
      agent: async () => (s.agent ? { id: '0.0.7', tinybar: s.tinybar ?? 0n, usdcMicros: s.associated ? (s.usdc ?? 0n) : undefined } : undefined),
      createAgent: async (t) => (calls.push(`createAgent ${t}`), (s.agent = true), (s.tinybar = t), '0.0.7'),
      associateUsdc: async (who) => (calls.push(`associate ${who}`), who === 'agent' ? (s.associated = true) : (s.merchant = true), 'tx'),
      merchantUsdcAssociated: async () => Boolean(s.merchant),
      transferHbar: async (_to, n) => (calls.push(`hbar ${n}`), (s.tinybar = (s.tinybar ?? 0n) + n), 'tx'),
      transferUsdc: async (_to, n) => (calls.push(`usdc ${n}`), (s.usdc = (s.usdc ?? 0n) + n), 'tx'),
      hasHcsSubmitKey: () => Boolean(s.key),
      createHcsSubmitKey: () => void (calls.push('key'), (s.key = true)),
      topicId: () => (s.topic ? '0.0.9' : undefined),
      createTopic: async () => (calls.push('topic'), (s.topic = true), '0.0.9'),
    };
    return { ops, calls };
  }

  it('first run creates and funds everything; a second run changes nothing', async () => {
    const { ops, calls } = fakeOps({});
    const first = await runSetup(ops);
    assert.deepEqual(calls, ['createAgent 2000000000', 'associate agent', 'usdc 5000000', 'associate merchant', 'key', 'topic']);
    assert.equal(first.filter((s) => s.changed).length, 6);
    calls.length = 0;
    const second = await runSetup(ops);
    assert.deepEqual(calls, []);
    assert.equal(second.filter((s) => s.changed).length, 0);
  });

  it('only tops up what is low', async () => {
    const { ops, calls } = fakeOps({ agent: true, associated: true, tinybar: 500_000_000n, usdc: 4_000_000n, merchant: true, key: true, topic: true });
    await runSetup(ops);
    assert.deepEqual(calls, ['hbar 1500000000']);
  });
});

describe('payments factory', () => {
  it('test mode without Hedera keys: the fake payer answers with a bundle, never verified', async () => {
    const p = createPayments(loadConfig({}));
    assert.equal(p.mode, 'fake');
    assert.equal(p.audit.enabled, false);
    const paid = await p.payer.pay(`http://127.0.0.1:3101/intel?headline=${encodeURIComponent(HEADLINE)}`);
    assert.match(paid.txId, /^0\.0\.0@\d+\.000000000$/);
    assert.equal((paid.body as IntelBundle).shock.category, 'geopolitical_shock');
    assert.equal((await paid.verification).verified, false);
  });

  it('live mode without keys is not_configured', () => {
    assert.equal(createPayments(loadConfig({ GHOSTY_MODE: 'live' })).mode, 'not_configured');
  });
});
