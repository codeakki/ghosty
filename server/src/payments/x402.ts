import { createHash } from 'node:crypto';
import type { preHandlerAsyncHookHandler } from 'fastify';

/**
 * Hedera x402 (track: "AI Agents That Pay"). HTTP 402 pay-per-request:
 * server answers 402 + requirements, client signs a partial Hedera TransferTransaction,
 * retries with `X-Payment`, a facilitator verifies and settles on hedera:testnet.
 * Packages (not installed yet): @x402/core, @x402/fetch, @x402/hedera, @x402/express, @hiero-ledger/sdk.
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

// TODO(hedera): real client (UNVERIFIED combination from research):
// import { x402Client, wrapFetchWithPayment } from '@x402/fetch';
// import { createClientHederaSigner } from '@x402/hedera';
// import { ExactHederaScheme } from '@x402/hedera/exact/client';
// import { PrivateKey } from '@hiero-ledger/sdk';
// const signer = createClientHederaSigner(HEDERA_ACCOUNT_ID, PrivateKey.fromString(HEDERA_PRIVATE_KEY), { network: 'hedera:testnet' });
// const client = new x402Client().register('hedera:*', new ExactHederaScheme(signer));
// const pay = wrapFetchWithPayment(fetch, client);
// const res = await pay(url);  // read settled tx id from the X-Payment-Response header → README + HashScan link.
// Extra credit: enforce a per-day spend cap here and write each payment to an HCS audit topic.

/**
 * Server side: protect a route (e.g. GET /signal) behind an x402 paywall.
 * Stub: returns a pass-through preHandler so routes can already be wired with it.
 */
export function protectRoute(_opts: { priceTinybar?: number; payTo?: string; facilitatorUrl?: string } = {}): preHandlerAsyncHookHandler {
  return async () => {
    // TODO(hedera): @x402/express ships Express middleware; for Fastify use @x402/core directly:
    // const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: X402_FACILITATOR_URL }))
    //   .register('hedera:*', new ExactHederaScheme({ ... }));
    // 1. no X-Payment header → reply 402 with { accepts: [{ scheme: 'exact', price, network: 'hedera:testnet', payTo }] }
    // 2. X-Payment present → server.verify(...) then server.settle(...) via the facilitator, set X-Payment-Response.
    // Testnet facilitators: https://x402.org/facilitator, https://testnet.facilitator.launa.dev, https://api.testnet.blocky402.com
    // HBAR asset 0.0.0 (tinybars); testnet USDC 0.0.429274.
  };
}
