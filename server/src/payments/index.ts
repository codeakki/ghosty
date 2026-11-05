import { loadConfig, type Config } from '../config.js';
import { HcsAuditLog, NoopAuditLog, type AuditLog } from './hcsAudit.js';
import { hashscanTxUrl } from './hedera.js';
import { payForSignal as fakePayForSignal } from './x402.js';
import { X402Payer, type PaidSignal, type SignalPayer, type X402PayerOptions } from './x402Client.js';

export { registerPaidRoutes, decisionToSignal, type PaidRoutesOptions, type SignalPayload, type GetSignal } from './x402Server.js';
export { X402Payer, X402PaymentError, PaymentPolicyError, payForSignal, type PaidSignal, type SignalPayer } from './x402Client.js';
export { SpendCap, SpendCapExceededError, HostNotAllowedError, isHostAllowed } from './spendControls.js';
export { HcsAuditLog, NoopAuditLog, type AuditLog, type AuditEntry } from './hcsAudit.js';
export { hashscanTxUrl, hashscanTopicUrl } from './hedera.js';

/** Day-one stub: no network, deterministic fake tx id (keeps the original x402.ts interface). */
export class FakeSignalPayer implements SignalPayer {
  readonly mode = 'fake' as const;
  async payForSignal(url: string): Promise<PaidSignal> {
    const res = await fakePayForSignal(url);
    return { ...res, hashscanUrl: hashscanTxUrl(res.txId) };
  }
}

export interface Payments {
  mode: 'real' | 'fake';
  payer: SignalPayer;
  audit: AuditLog;
}

/**
 * Real x402 payer + HCS audit log when HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY are set;
 * otherwise the fake payer and a no-op audit log, so `npm run dev` works with an empty .env.
 */
export function createPayments(config: Config = loadConfig(), opts: Omit<X402PayerOptions, 'config' | 'audit'> = {}): Payments {
  if (config.HEDERA_ACCOUNT_ID && config.HEDERA_PRIVATE_KEY) {
    const audit = HcsAuditLog.fromConfig(config);
    return { mode: 'real', audit, payer: new X402Payer({ ...opts, config, audit }) };
  }
  return { mode: 'fake', audit: new NoopAuditLog(), payer: new FakeSignalPayer() };
}
