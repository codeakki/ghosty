import type { Config } from '../config.js';
import type { NewsItem } from '../news/types.js';
import type { AuditLog, AuditReceipt } from './hcsAudit.js';
import { formatAmount, HBAR_ASSET_ID } from './hedera.js';
import type { Verification } from './mirror.js';
import { intelUrl, SIGNAL_DESK_PROVIDER, type IntelBundle } from './signalDesk.js';
import type { SpendCap } from './spendControls.js';
import type { Payer } from './x402Client.js';

/**
 * INTEL BUYER: the one place the agent decides to spend. Given a shock headline it buys the Signal Desk bundle
 * (x402), then, in the background, waits for the mirror-node verification and writes the HCS "payment" message.
 *
 * Shared by the decision loop (X402_AUTOPAY) and POST /sim/pay-signal, so both spend from the same daily caps
 * and update the same `lastPayment` (GET /x402/status). Two buys for the same headline at once share one
 * payment instead of paying twice.
 */

/** The most recent payment, shown by GET /x402/status and the terminal. */
export interface LastPayment {
  mode: Payer['mode'];
  txId: string;
  hashscanUrl: string;
  asset: string;
  /** Atomic units as a string, plus a readable form ("0.01 USDC"). */
  amount: string;
  amountLabel: string;
  /** Kept for the terminal: set only for HBAR payments. */
  amountTinybar?: number;
  payTo: string;
  provider: string;
  headline: string;
  /** null while the mirror-node check is still running; true/false once it finished. Never "success" before. */
  verified: boolean | null;
  verifyReason?: string;
  audit?: AuditReceipt;
  /** What made the agent pay: the decision loop on its own, or the sim's "Pay" button. */
  trigger: 'decision' | 'sim';
  at: string;
  /** Kept for the terminal (it used to show the /signal request id). Here: the desk's bundle id. */
  requestId?: string;
}

/** What the decision gets: the bundle and a short receipt to cite. */
export interface PaidIntel {
  bundle: IntelBundle;
  txId: string;
  provider: string;
  hashscanUrl: string;
  asset: string;
  amount: string;
  /** Resolves when the mirror node confirmed (or refuted, or timed out). Never rejects. */
  verification: Promise<Verification>;
}

export interface IntelBuyerOptions {
  config: Pick<Config, 'SIGNAL_DESK_URL' | 'HEDERA_USDC_TOKEN_ID'>;
  payer: Payer;
  spendCap: SpendCap;
  audit: AuditLog;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export class IntelBuyer {
  private last: LastPayment | null = null;
  private readonly inFlight = new Map<string, Promise<PaidIntel>>();

  constructor(private readonly opts: IntelBuyerOptions) {}

  get mode(): Payer['mode'] {
    return this.opts.payer.mode;
  }

  get spendCap(): SpendCap {
    return this.opts.spendCap;
  }

  get lastPayment(): LastPayment | null {
    return this.last;
  }

  /** Buy the bundle for one headline. Throws the payer's errors (policy, caps, queue full, payment failure). */
  buy(headline: Pick<NewsItem, 'title' | 'handle' | 'domain'>, trigger: LastPayment['trigger']): Promise<PaidIntel> {
    const key = headline.title.trim().toLowerCase();
    const running = this.inFlight.get(key);
    if (running) {
      this.opts.log?.('intel purchase merged with one already in flight', { headline: headline.title });
      return running;
    }
    const purchase = this.buyOnce(headline, trigger).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, purchase);
    return purchase;
  }

  private async buyOnce(headline: Pick<NewsItem, 'title' | 'handle' | 'domain'>, trigger: LastPayment['trigger']): Promise<PaidIntel> {
    const paid = await this.opts.payer.pay(intelUrl(this.opts.config.SIGNAL_DESK_URL, headline));
    const bundle = paid.body as IntelBundle;
    const payment: LastPayment = {
      mode: this.opts.payer.mode,
      txId: paid.txId,
      hashscanUrl: paid.hashscanUrl,
      asset: paid.asset,
      amount: paid.amount,
      amountLabel: formatAmount(paid.asset, paid.amount, this.opts.config.HEDERA_USDC_TOKEN_ID),
      ...(paid.asset === HBAR_ASSET_ID ? { amountTinybar: Number(paid.amount) } : {}),
      payTo: paid.payTo,
      provider: bundle?.provider ?? SIGNAL_DESK_PROVIDER,
      headline: headline.title,
      verified: null,
      trigger,
      at: new Date().toISOString(),
      requestId: bundle?.requestId,
    };
    this.last = payment;
    this.opts.log?.('agent bought intel via x402', { txId: paid.txId, amount: payment.amountLabel, trigger });

    // Background: record the verification result and the HCS message. Never throws.
    const verification = paid.verification.then(async (v) => {
      payment.verified = v.verified;
      if (!v.verified) payment.verifyReason = v.reason;
      this.opts.log?.(v.verified ? 'intel payment verified on mirror node' : 'intel payment NOT verified', { txId: paid.txId, ...v });
      try {
        payment.audit = await this.opts.audit.record({
          kind: 'payment',
          txId: paid.txId,
          asset: paid.asset,
          amount: paid.amount,
          payTo: paid.payTo,
          verified: v.verified,
        });
      } catch (err) {
        this.opts.log?.('HCS audit write failed', { err: String(err) });
      }
      return v;
    });

    return {
      bundle,
      txId: paid.txId,
      provider: payment.provider,
      hashscanUrl: paid.hashscanUrl,
      asset: paid.asset,
      amount: paid.amount,
      verification,
    };
  }
}
