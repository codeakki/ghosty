import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { createClientHederaSigner, type ClientHederaSigner } from '@x402/hedera';
import { ExactHederaScheme } from '@x402/hedera/exact/client';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import { loadConfig, type Config } from '../config.js';
import type { AuditLog, AuditReceipt } from './hcsAudit.js';
import { caip2, HBAR_ASSET_ID, hashscanTxUrl, parseHederaKey } from './hedera.js';
import { assertHostAllowed, SpendCap } from './spendControls.js';

/**
 * Agent side of x402 on Hedera: the device's own Hedera account pays for `/signal` with no
 * human approval. Uses `@x402/fetch` (wrapFetchWithPayment) + the Hedera `exact` client scheme
 * (`@x402/hedera/exact/client`) + `createClientHederaSigner` from `@x402/hedera`.
 *
 * Guard rails, all checked before anything is signed:
 * - host allowlist (X402_ALLOWED_HOSTS)
 * - HBAR only, on the configured network, never paying our own account
 * - per-payment cap (X402_MAX_PER_CALL_TINYBAR, enforced by @x402/core spendControls)
 * - daily cap (X402_MAX_SPEND_TINYBAR, SpendCap persisted in server/.ghosty/spend.json)
 */

export interface PaidSignal {
  status: number;
  body: unknown;
  /** Hedera transaction id of the settled payment, e.g. 0.0.1234@1730000000.000000000 */
  txId: string;
  hashscanUrl: string;
  amountTinybar?: number;
  payTo?: string;
  /** HCS audit message for this payment, when the audit log is enabled and the write succeeded. */
  audit?: AuditReceipt;
}

export interface SignalPayer {
  readonly mode: 'real' | 'fake' | 'not_configured';
  payForSignal(url: string): Promise<PaidSignal>;
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

export interface X402PayerOptions {
  config?: Config;
  spendCap?: SpendCap;
  audit?: AuditLog;
  /** Override the signer (tests). Default: createClientHederaSigner(HEDERA_ACCOUNT_ID, HEDERA_PRIVATE_KEY). */
  signer?: ClientHederaSigner;
  fetch?: typeof globalThis.fetch;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export class X402Payer implements SignalPayer {
  readonly mode = 'real' as const;
  readonly spendCap: SpendCap;
  private readonly config: Config;
  private readonly signer: ClientHederaSigner;
  private readonly client: x402Client;
  private readonly pay: typeof globalThis.fetch;
  /** Payments are serialized so the daily cap can't be raced by concurrent calls. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Set by the before-payment hook so we can surface the real refusal instead of a wrapped string. */
  private refusal: Error | undefined;
  private lastPayment: { amountTinybar: number; payTo: string } | undefined;

  constructor(private readonly opts: X402PayerOptions = {}) {
    this.config = opts.config ?? loadConfig();
    const { HEDERA_ACCOUNT_ID, HEDERA_PRIVATE_KEY } = this.config;
    const network = caip2(this.config.HEDERA_NETWORK);

    if (opts.signer) {
      this.signer = opts.signer;
    } else {
      if (!HEDERA_ACCOUNT_ID || !HEDERA_PRIVATE_KEY) {
        throw new Error('X402Payer needs HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY');
      }
      this.signer = createClientHederaSigner(HEDERA_ACCOUNT_ID, parseHederaKey(HEDERA_PRIVATE_KEY, this.config.HEDERA_KEY_TYPE), {
        network,
      });
    }

    this.spendCap = opts.spendCap ?? new SpendCap({ maxPerDayTinybar: this.config.X402_MAX_SPEND_TINYBAR });

    this.client = new x402Client()
      .register(network, new ExactHederaScheme(this.signer))
      // HBAR is not a "default asset" for @x402/core (only USDC is), so it must be opted in explicitly,
      // with an atomic (tinybar) per-payment cap. Without this the client refuses every HBAR 402.
      .setSpendControls({
        allowedAssets: [{ network, asset: HBAR_ASSET_ID, maxAmountPerPayment: String(this.config.X402_MAX_PER_CALL_TINYBAR) }],
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
        const amountTinybar = Number(selectedRequirements.amount);
        this.spendCap.record(amountTinybar, selectedRequirements.payTo);
        this.lastPayment = { amountTinybar, payTo: selectedRequirements.payTo };
      });

    this.pay = wrapFetchWithPayment(opts.fetch ?? globalThis.fetch, this.client);
  }

  /** Pay for one signal. Serialized: concurrent calls run one after another. */
  payForSignal(url: string): Promise<PaidSignal> {
    const run = this.queue.then(() => this.payOnce(url));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private signedPayment(): { amountTinybar: number; payTo: string } | undefined {
    return this.lastPayment;
  }

  private checkPolicy(req: PaymentRequirements): Error | undefined {
    const network = caip2(this.config.HEDERA_NETWORK);
    if (req.network !== network) return new PaymentPolicyError(`refusing to pay on ${req.network}; configured for ${network}`);
    if (req.asset !== HBAR_ASSET_ID) return new PaymentPolicyError(`refusing to pay in asset ${req.asset}; HBAR (0.0.0) only`);
    if (req.payTo === this.signer.accountId) {
      return new PaymentPolicyError('payTo is the paying account; set X402_PAY_TO on the server to a second testnet account');
    }
    const amount = Number(req.amount);
    if (!Number.isSafeInteger(amount) || amount <= 0) return new PaymentPolicyError(`bad amount ${req.amount}`);
    if (!this.spendCap.canSpend(amount)) {
      return new PaymentPolicyError(
        `daily x402 spend cap reached: ${this.spendCap.spentToday()} + ${amount} > ${this.spendCap.maxPerDayTinybar} tinybar`,
      );
    }
    return undefined;
  }

  private async payOnce(url: string): Promise<PaidSignal> {
    assertHostAllowed(url, this.config.X402_ALLOWED_HOSTS);
    this.refusal = undefined;
    this.lastPayment = undefined;

    let res: Response;
    try {
      res = await this.pay(url, { headers: { accept: 'application/json' } });
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
    if (!txId) throw new X402PaymentError(`GET ${url} returned ${res.status} without a payment receipt`, res.status, body);

    const hashscanUrl = hashscanTxUrl(txId, this.config.HEDERA_NETWORK);
    const signed = this.signedPayment();
    const paid: PaidSignal = { status: res.status, body, txId, hashscanUrl, amountTinybar: signed?.amountTinybar, payTo: signed?.payTo };
    this.opts.log?.('x402 payment settled', { txId, hashscanUrl, amountTinybar: paid.amountTinybar });

    if (this.opts.audit?.enabled) {
      const requestId = isRecord(body) && typeof body.requestId === 'string' ? body.requestId : undefined;
      try {
        paid.audit = await this.opts.audit.record({
          kind: 'payment',
          txId,
          requestId,
          summary: `paid ${paid.amountTinybar ?? '?'} tinybar to ${paid.payTo ?? '?'} for ${url}`,
        });
      } catch (err) {
        this.opts.log?.('HCS audit write failed', { err: String(err) });
      }
    }
    return paid;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** One-shot helper: pay for a signal using env config (HEDERA_ACCOUNT_ID / HEDERA_PRIVATE_KEY). */
export async function payForSignal(url: string, opts: X402PayerOptions = {}): Promise<PaidSignal> {
  return new X402Payer(opts).payForSignal(url);
}
