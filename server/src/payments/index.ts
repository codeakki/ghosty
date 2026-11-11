import { DabaoHederaSigner } from '../execution/dabaoWallets.js';
import { createHash } from 'node:crypto';
import { loadConfig, type Config } from '../config.js';
import { FakeEthosScorer } from '../credibility/ethos.js';
import { isTestMode } from '../mode.js';
import { createNewsProviders } from '../news/factory.js';
import { missingKeys, NotConfiguredPayer } from '../notConfigured.js';
import { HcsAuditLog, NoopAuditLog, type AuditLog } from './hcsAudit.js';
import { hashscanTxUrl } from './hedera.js';
import { IntelBuyer } from './intelBuyer.js';
import { IntelService } from './signalDesk.js';
import { SpendCap } from './spendControls.js';
import { dailyCaps, X402Payer, type PaidResource, type Payer, type X402PayerOptions } from './x402Client.js';

/**
 * Payments wiring. Pick the real x402 payer, a test-mode fake, or a live-mode "not configured" stand-in, and
 * build the one IntelBuyer the app uses. Map of this folder:
 *
 *   signalDesk.ts   the merchant (separate process): sells intel bundles behind x402
 *   x402Server.ts   generic paid GET route (402 → verify → produce → settle), used by the desk
 *   x402Client.ts   the agent's wallet: pays a 402, with allowlist + per-asset caps + bounded queue
 *   mirror.ts       independent on-chain check of each payment; topic reader
 *   intelBuyer.ts   "buy intel for this headline", verification + HCS payment message in the background
 *   hcsAudit.ts     structured JSON audit messages on HCS, and the reader for GET /hedera/audit
 *   spendControls.ts daily caps per asset (bigint) + host allowlist
 *   setup.ts        the idempotent custody split behind `npm run hedera:setup`
 *   hedera.ts       ids, keys, HashScan links
 */

export { registerPaidRoute, type PaidRouteOptions, type Price, type SettledPayment } from './x402Server.js';
export { X402Payer, X402PaymentError, PaymentPolicyError, PaymentQueueFullError, type PaidResource, type Payer } from './x402Client.js';
export { SpendCap, SpendCapExceededError, HostNotAllowedError, isHostAllowed } from './spendControls.js';
export { HcsAuditLog, NoopAuditLog, readAuditLog, type AuditLog, type AuditEntry } from './hcsAudit.js';
export { IntelBuyer, type LastPayment, type PaidIntel } from './intelBuyer.js';
export { hashscanTxUrl, hashscanTopicUrl } from './hedera.js';

/**
 * Test mode only: answers like the Signal Desk (bundle from the fake news + fake Ethos), with a deterministic
 * fake tx id. Its payments are never "verified": the verification says so.
 */
export class FakePayer implements Payer {
  readonly mode = 'fake' as const;
  private readonly intel: IntelService;

  constructor(private readonly config: Config) {
    this.intel = new IntelService({ news: createNewsProviders(config), scorer: new FakeEthosScorer(), windowMinutes: 100_000 });
  }

  async pay(url: string): Promise<PaidResource> {
    const u = new URL(url);
    const body = await this.intel.bundle({
      headline: u.searchParams.get('headline') ?? '',
      handle: u.searchParams.get('handle') ?? undefined,
      domain: u.searchParams.get('domain') ?? undefined,
    });
    const digest = createHash('sha256').update(url).digest('hex');
    const txId = `0.0.0@${1_700_000_000 + (parseInt(digest.slice(0, 8), 16) % 1_000_000_000)}.000000000`;
    return {
      status: 200,
      body,
      txId,
      hashscanUrl: hashscanTxUrl(txId),
      asset: this.config.HEDERA_USDC_TOKEN_ID,
      amount: String(this.config.X402_INTEL_PRICE_USDC_MICROS),
      payTo: this.config.X402_PAY_TO ?? '0.0.0',
      payer: '0.0.0',
      verification: Promise.resolve({ verified: false, reason: 'fake payer (test mode): nothing on chain', checkedAt: new Date().toISOString() }),
    };
  }
}

export interface Payments {
  mode: 'real' | 'fake' | 'not_configured';
  payer: Payer;
  audit: AuditLog;
  buyer: IntelBuyer;
}

/**
 * Real x402 payer + HCS audit log when HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY are set. Otherwise the fake
 * payer in test mode, or NotConfiguredPayer (throws not_configured) in live mode.
 */
export function createPayments(
  config: Config = loadConfig(),
  opts: Omit<X402PayerOptions, 'config'> & { audit?: AuditLog; log?: X402PayerOptions['log'] } = {},
): Payments {
  let mode: Payments['mode'];
  let payer: Payer;
  let spendCap: SpendCap;
  let audit: AuditLog = new NoopAuditLog();
  // X402_SIGNER=dabao: payments come from the Dabao's Hedera account and only the Dabao signs them.
  const dabao =
    config.X402_SIGNER === 'dabao' && config.HEDERA_DABAO_ACCOUNT_ID && config.HEDERA_DABAO_PUBLIC_KEY
      ? new DabaoHederaSigner({
          accountId: config.HEDERA_DABAO_ACCOUNT_ID,
          publicKeyHex: config.HEDERA_DABAO_PUBLIC_KEY,
          network: config.HEDERA_NETWORK,
        })
      : undefined;
  if (dabao || (config.X402_SIGNER !== 'dabao' && config.HEDERA_ACCOUNT_ID && config.HEDERA_PRIVATE_KEY)) {
    const real = new X402Payer({ ...opts, config, ...(dabao && !opts.signer ? { signer: dabao } : {}) });
    mode = 'real';
    payer = real;
    spendCap = real.spendCap;
    audit = opts.audit ?? HcsAuditLog.fromConfig(config);
  } else if (!isTestMode(config)) {
    mode = 'not_configured';
    payer = new NotConfiguredPayer(
      config.X402_SIGNER === 'dabao'
        ? missingKeys(config, ['HEDERA_DABAO_ACCOUNT_ID', 'HEDERA_DABAO_PUBLIC_KEY'])
        : missingKeys(config, ['HEDERA_ACCOUNT_ID', 'HEDERA_PRIVATE_KEY']),
    );
    spendCap = new SpendCap({ maxPerDay: dailyCaps(config), file: null });
  } else {
    mode = 'fake';
    const fake = new FakePayer(config);
    // The fake payer charges an in-memory cap so the sim panel still shows the budget moving.
    spendCap = new SpendCap({ maxPerDay: dailyCaps(config), file: null });
    payer = {
      mode: 'fake',
      pay: async (url) => {
        const paid = await fake.pay(url);
        spendCap.record(paid.asset, BigInt(paid.amount), 'fake');
        return paid;
      },
    };
  }
  const buyer = new IntelBuyer({ config, payer, spendCap, audit, log: opts.log });
  return { mode, payer, audit, buyer };
}
