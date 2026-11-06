import { createHash } from 'node:crypto';
import type { preHandlerAsyncHookHandler } from 'fastify';

/**
 * Hedera x402 (track: "AI Agents That Pay"). HTTP 402 pay-per-request:
 * server answers 402 + requirements, client signs a partial Hedera TransferTransaction,
 * retries with `X-Payment`, a facilitator verifies and settles on hedera:testnet.
 * Fake/stub implementations kept for day-one wiring and tests. Real code: x402Server.ts, x402Client.ts, hcsAudit.ts.
 * Docs: https://docs.hedera.com/solutions/ai/x402
 */

export interface PaidResponse {
  /** Hedera transaction id of the settled payment, e.g. 0.0.1234@1730000000.000000000 */
  txId: string;
  status: number;
  body: unknown;
}

/**
 * Client side: the device's agent wallet pays for a signal with no human approval.
 * Stub: does not fetch or pay; returns a deterministic fake tx id derived from the URL.
 */
export async function payForSignal(url: string): Promise<PaidResponse> {
  const digest = createHash('sha256').update(url).digest('hex');
  const seconds = parseInt(digest.slice(0, 8), 16) % 1_000_000_000;
  return {
    txId: `0.0.0@${1_700_000_000 + seconds}.000000000`,
    status: 200,
    body: { stub: true, url },
  };
}

// Real client: ./x402Client.ts (X402Payer). Pick real vs fake with createPayments() in ./index.ts.

/**
 * Server side: protect a route (e.g. GET /signal) behind an x402 paywall.
 * Stub: returns a pass-through preHandler so routes can already be wired with it.
 */
export function protectRoute(_opts: { priceTinybar?: number; payTo?: string; facilitatorUrl?: string } = {}): preHandlerAsyncHookHandler {
  return async () => {
    // Real paywall: registerPaidRoutes() in ./x402Server.ts registers GET /signal behind x402.
  };
}
