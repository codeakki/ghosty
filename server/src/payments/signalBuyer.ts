import type { Config } from '../config.js';
import type { Payments } from './index.js';
import { SpendCap } from './spendControls.js';
import { X402Payer, type PaidSignal } from './x402Client.js';

/** The most recent `/signal` payment, shown by `GET /x402/status` and the terminal's proof log. */
export interface LastPayment {
  mode: Payments['mode'];
  txId: string;
  hashscanUrl: string;
  amountTinybar?: number;
  requestId?: string;
  /** What made the agent pay: the decision loop on its own, or the sim's "Pay for signal" button. */
  trigger: 'decision' | 'sim';
  at: string;
}

export interface SignalPurchase {
  paid: PaidSignal;
  payment: LastPayment;
}

/**
 * Buys one paywalled `GET /signal` from this server with the agent's own Hedera account (x402).
 * Shared by the decision loop (X402_AUTOPAY, no human approval) and `POST /sim/pay-signal`, so both
 * spend from the same daily cap and update the same `lastPayment`.
 */
export class SignalBuyer {
  readonly spendCap: SpendCap;
  private last: LastPayment | null = null;

  constructor(
    private readonly config: Pick<Config, 'PORT' | 'X402_SIGNAL_PRICE_TINYBAR' | 'X402_MAX_SPEND_TINYBAR'>,
    private readonly payments: Payments,
  ) {
    // The real payer persists its daily cap in server/.ghosty/spend.json. The fake payer gets an in-memory cap
    // charged at the /signal price so the sim panel still shows the budget moving.
    this.spendCap =
      payments.payer instanceof X402Payer
        ? payments.payer.spendCap
        : new SpendCap({ maxPerDayTinybar: config.X402_MAX_SPEND_TINYBAR, file: null });
  }

  get mode(): Payments['mode'] {
    return this.payments.mode;
  }

  get lastPayment(): LastPayment | null {
    return this.last;
  }

  get url(): string {
    return `http://127.0.0.1:${this.config.PORT}/signal`;
  }

  /** Pay for one signal. Throws the payer's errors (policy, cap, not_configured, payment failure). */
  async buy(trigger: LastPayment['trigger']): Promise<SignalPurchase> {
    const fake = this.payments.mode === 'fake';
    if (fake) this.spendCap.assertCanSpend(this.config.X402_SIGNAL_PRICE_TINYBAR);
    const paid = await this.payments.payer.payForSignal(this.url);
    if (fake) this.spendCap.record(this.config.X402_SIGNAL_PRICE_TINYBAR, 'fake');
    const body = paid.body as { requestId?: unknown } | undefined;
    const payment: LastPayment = {
      mode: this.payments.mode,
      txId: paid.txId,
      hashscanUrl: paid.hashscanUrl,
      amountTinybar: paid.amountTinybar ?? (fake ? this.config.X402_SIGNAL_PRICE_TINYBAR : undefined),
      requestId: typeof body?.requestId === 'string' ? body.requestId : undefined,
      trigger,
      at: new Date().toISOString(),
    };
    this.last = payment;
    return { paid, payment };
  }
}
