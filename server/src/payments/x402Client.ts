import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { createClientHederaSigner, type ClientHederaSigner } from '@x402/hedera';
import { ExactHederaScheme } from '@x402/hedera/exact/client';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import { loadConfig, type Config } from '../config.js';
import { caip2, HBAR_ASSET_ID, hashscanTxUrl, parseHederaKey } from './hedera.js';
import { verifyPaymentOnMirror, type ExpectedTransfer, type Verification } from './mirror.js';
import { assertHostAllowed, SpendCap } from './spendControls.js';

/**
 * BUYER side of x402 on Hedera: the agent's own hot wallet pays a paywalled URL with no human approval.
 * Built on `@x402/fetch` (wrapFetchWithPayment) + the Hedera `exact` client scheme + `createClientHederaSigner`.
 *
 * One call to `pay(url)`:
 *   1. GET url → 402 with the merchant's `accepts` (HBAR and/or USDC)
 *   2. pick the preferred asset (X402_PREFERRED_ASSET), check our rules, sign a TransferTransaction
 *   3. retry with PAYMENT-SIGNATURE → the merchant's facilitator verifies + settles → 200 + PAYMENT-RESPONSE
 *   4. start an independent mirror-node check of that tx (`verification`), see mirror.ts
 *
 * Rules checked before anything is signed:
 * - host allowlist (X402_ALLOWED_HOSTS)
 * - right network, HBAR or our USDC token only, never paying our own account
 * - per-payment cap per asset (X402_MAX_PER_CALL_TINYBAR / _USDC_MICROS: checked here, and again by @x402/core spendControls)
 * - daily cap per asset (X402_MAX_SPEND_TINYBAR / _USDC_MICROS, SpendCap in server/.ghosty/spend.json)
 * - at most MAX_PENDING payments in flight; more are refused (PaymentQueueFullError), never queued forever
 */

export interface PaidResource {
  status: number;
  body: unknown;
  /** Facilitator's settlement tx id, e.g. 0.0.7162784@1730000000.000000000 */
  txId: string;
  hashscanUrl: string;
  /** `0.0.0` (HBAR) or the USDC token id. */
  asset: string;
  /** Atomic units (tinybars or USDC micro-units), as a decimal string. */
  amount: string;
  payTo: string;
  payer: string;
  /** Mirror-node confirmation, started right after settlement. Never rejects. */
  verification: Promise<Verification>;
}

export interface Payer {
  readonly mode: 'real' | 'fake' | 'not_configured';
  pay(url: string): Promise<PaidResource>;
}

export class X402PaymentError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
    readonly reason?: string,
  ) {
    super(message);
    this.name = 'X402PaymentError';
  }
}

export class PaymentPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentPolicyError';
  }
}

export class PaymentQueueFullError extends Error {
  constructor(readonly pending: number) {
    super(`x402 payment refused: ${pending} payments already in flight`);
    this.name = 'PaymentQueueFullError';
  }
}

/** Payments in flight at once (one running + one waiting). A burst of headlines must not stack up payments. */
export const MAX_PENDING = 2;

export interface X402PayerOptions {
  config?: Config;
  spendCap?: SpendCap;
  /** Override the signer (tests). Default: createClientHederaSigner(HEDERA_ACCOUNT_ID, HEDERA_PRIVATE_KEY). */
  signer?: ClientHederaSigner;
  fetch?: typeof globalThis.fetch;
  /** Override the mirror-node check (tests). Default: verifyPaymentOnMirror against HEDERA_MIRROR_URL. */
  verify?: (expected: ExpectedTransfer) => Promise<Verification>;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

/** Daily caps from config, keyed by asset id. */
export function dailyCaps(config: Config): Record<string, bigint> {
  return {
    [HBAR_ASSET_ID]: BigInt(config.X402_MAX_SPEND_TINYBAR),
    [config.HEDERA_USDC_TOKEN_ID]: BigInt(config.X402_MAX_SPEND_USDC_MICROS),
  };
}

/** Pick the preferred asset among the merchant's offers; fall back to the first one. */
export function preferAsset(preferred: string) {
  return (_version: number, accepts: PaymentRequirements[]): PaymentRequirements => {
    const match = accepts.find((r) => r.asset === preferred);
    const first = accepts[0];
    if (!match && !first) throw new PaymentPolicyError('merchant offered no payment option we accept');
    return (match ?? first) as PaymentRequirements;
  };
}

export class X402Payer implements Payer {
  readonly mode = 'real' as const;
  readonly spendCap: SpendCap;
  private readonly config: Config;
  private readonly signer: ClientHederaSigner;
  private readonly pay402: typeof globalThis.fetch;
  private readonly verify: (expected: ExpectedTransfer) => Promise<Verification>;
  /** Payments run one at a time so the daily cap can't be raced. */
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  /** Set by the before-payment hook so we can surface the real refusal instead of a wrapped string. */
  private refusal: Error | undefined;
  private signed: PaymentRequirements | undefined;

  constructor(private readonly opts: X402PayerOptions = {}) {
    this.config = opts.config ?? loadConfig();
    const { HEDERA_ACCOUNT_ID, HEDERA_PRIVATE_KEY } = this.config;
    const network = caip2(this.config.HEDERA_NETWORK);

    if (opts.signer) {
      this.signer = opts.signer;
    } else {
      if (!HEDERA_ACCOUNT_ID || !HEDERA_PRIVATE_KEY) throw new Error('X402Payer needs HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY');
      this.signer = createClientHederaSigner(HEDERA_ACCOUNT_ID, parseHederaKey(HEDERA_PRIVATE_KEY, this.config.HEDERA_KEY_TYPE), { network });
    }

    this.spendCap = opts.spendCap ?? new SpendCap({ maxPerDay: dailyCaps(this.config) });
    this.verify =
      opts.verify ?? ((expected) => verifyPaymentOnMirror(expected, { mirrorUrl: this.config.HEDERA_MIRROR_URL, fetch: opts.fetch }));

    const preferred = this.config.X402_PREFERRED_ASSET === 'usdc' ? this.config.HEDERA_USDC_TOKEN_ID : HBAR_ASSET_ID;
    const client = new x402Client(preferAsset(preferred))
      .register(network, new ExactHederaScheme(this.signer))
      // Opt both assets in with an atomic per-payment cap. HBAR is not a "default asset" for @x402/core, so
      // without this entry every HBAR 402 is refused; the USDC entry replaces the default $ cap with ours.
      .setSpendControls({
        allowedAssets: [
          { network, asset: HBAR_ASSET_ID, maxAmountPerPayment: String(this.config.X402_MAX_PER_CALL_TINYBAR) },
          { network, asset: this.config.HEDERA_USDC_TOKEN_ID, maxAmountPerPayment: String(this.config.X402_MAX_PER_CALL_USDC_MICROS) },
        ],
      })
      .onBeforePaymentCreation(async ({ selectedRequirements }) => {
        const refusal = this.checkPolicy(selectedRequirements);
        if (refusal) {
          this.refusal = refusal;
          return { abort: true, reason: refusal.message };
        }
      })
      .onAfterPaymentCreation(async ({ selectedRequirements }) => {
        // A signed transfer can be submitted by whoever holds it, so count it as spent now.
        this.spendCap.record(selectedRequirements.asset, BigInt(selectedRequirements.amount), selectedRequirements.payTo);
        this.signed = selectedRequirements;
      });

    this.pay402 = wrapFetchWithPayment(opts.fetch ?? globalThis.fetch, client);
  }

  get accountId(): string {
    return this.signer.accountId;
  }

  /** Pay for one resource. Runs after any payment already in flight; refused when MAX_PENDING are in flight. */
  pay(url: string): Promise<PaidResource> {
    if (this.pending >= MAX_PENDING) {
      this.opts.log?.('x402 payment dropped: queue full', { pending: this.pending, url });
      return Promise.reject(new PaymentQueueFullError(this.pending));
    }
    this.pending++;
    const run = this.queue.then(() => this.payOnce(url)).finally(() => this.pending--);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private checkPolicy(req: PaymentRequirements): Error | undefined {
    const network = caip2(this.config.HEDERA_NETWORK);
    if (req.network !== network) return new PaymentPolicyError(`refusing to pay on ${req.network}; configured for ${network}`);
    if (req.asset !== HBAR_ASSET_ID && req.asset !== this.config.HEDERA_USDC_TOKEN_ID) {
      return new PaymentPolicyError(`refusing to pay in asset ${req.asset}; HBAR (0.0.0) or USDC (${this.config.HEDERA_USDC_TOKEN_ID}) only`);
    }
    if (req.payTo === this.signer.accountId) {
      return new PaymentPolicyError('payTo is the paying account; set X402_PAY_TO on the Signal Desk to a different account');
    }
    if (!/^[1-9][0-9]*$/.test(req.amount)) return new PaymentPolicyError(`bad amount ${req.amount}`);
    const amount = BigInt(req.amount);
    const perCall = BigInt(req.asset === HBAR_ASSET_ID ? this.config.X402_MAX_PER_CALL_TINYBAR : this.config.X402_MAX_PER_CALL_USDC_MICROS);
    if (amount > perCall) return new PaymentPolicyError(`per-call cap: ${amount} > ${perCall} of ${req.asset}`);
    if (!this.spendCap.canSpend(req.asset, amount)) {
      return new PaymentPolicyError(
        `daily x402 spend cap reached for ${req.asset}: ${this.spendCap.spentToday(req.asset)} + ${amount} > ${this.spendCap.maxPerDay(req.asset)}`,
      );
    }
    return undefined;
  }

  private async payOnce(url: string): Promise<PaidResource> {
    assertHostAllowed(url, this.config.X402_ALLOWED_HOSTS);
    this.refusal = undefined;
    this.signed = undefined;

    let res: Response;
    try {
      res = await this.pay402(url, { headers: { accept: 'application/json' } });
    } catch (err) {
      if (this.refusal) throw this.refusal;
      throw err;
    }

    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // non-JSON body; keep the text
    }

    if (!res.ok) {
      let reason: string | undefined;
      const required = res.headers.get('PAYMENT-REQUIRED');
      if (required) {
        try {
          reason = decodePaymentRequiredHeader(required).error;
        } catch {
          // ignore
        }
      }
      throw new X402PaymentError(`GET ${url} failed with ${res.status}${reason ? ` (${reason})` : ''}`, res.status, body, reason);
    }

    const receipt = res.headers.get('PAYMENT-RESPONSE') ?? res.headers.get('X-PAYMENT-RESPONSE');
    const txId = receipt ? decodePaymentResponseHeader(receipt).transaction : (res.headers.get('x-payment-tx-id') ?? undefined);
    // Set by onAfterPaymentCreation during the fetch above (TypeScript can't see that, hence the cast).
    const signed = this.signed as PaymentRequirements | undefined;
    if (!txId || !signed) throw new X402PaymentError(`GET ${url} returned ${res.status} without a payment receipt`, res.status, body);

    const expected: ExpectedTransfer = { txId, payer: this.signer.accountId, payTo: signed.payTo, asset: signed.asset, amount: signed.amount };
    const verification = this.verify(expected).catch(
      (err: unknown): Verification => ({ verified: false, reason: `verify failed: ${String(err)}`, checkedAt: new Date().toISOString() }),
    );
    const hashscanUrl = hashscanTxUrl(txId, this.config.HEDERA_NETWORK);
    this.opts.log?.('x402 payment settled (facilitator); verifying on mirror node', { txId, hashscanUrl, asset: signed.asset, amount: signed.amount });
    return { status: res.status, body, hashscanUrl, ...expected, verification };
  }
}
