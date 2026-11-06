import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from '@x402/core/http';
import { HTTPFacilitatorClient, x402ResourceServer, type FacilitatorClient } from '@x402/core/server';
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from '@x402/core/types';
import { ExactHederaScheme } from '@x402/hedera/exact/server';
import type { Config } from '../config.js';
import { caip2, hashscanTxUrl } from './hedera.js';

/**
 * SELLER side of x402 on Hedera: one paid GET route on a Fastify app. Used by the Signal Desk (signalDesk.ts).
 *
 * Built on `@x402/core/server` (x402ResourceServer + HTTPFacilitatorClient) and the Hedera `exact` scheme from
 * `@x402/hedera/exact/server`. We drive the resource server from the route ourselves so the 402 body is plain
 * JSON you can read with curl. The facilitator (Blocky402 by default) holds the fee-payer key; this process
 * never does.
 *
 * Flow per request: no payment header → 402 with `accepts` (one entry per price, e.g. USDC and HBAR) →
 * client retries with PAYMENT-SIGNATURE → facilitator verify → build the resource → facilitator settle →
 * 200 with the resource + PAYMENT-RESPONSE. The resource is built BEFORE settling, so a broken handler never
 * charges the buyer.
 *
 * Wire format (x402 v2, what `@x402/fetch` 2.x speaks): `PAYMENT-REQUIRED` header (base64 JSON) + the same
 * object as the JSON body; `X-PAYMENT` (v1 header name) is accepted too; the 200 carries `PAYMENT-RESPONSE`,
 * `X-PAYMENT-RESPONSE` and `x-payment-tx-id`.
 */

/** One way to pay: an asset id (`0.0.0` = HBAR, or an HTS token id) and an atomic amount. */
export interface Price {
  asset: string;
  amount: string;
}

/** Settlement details handed to `onSettled` (logging, audit). */
export interface SettledPayment {
  txId: string;
  hashscanUrl: string;
  payer?: string;
  amount: string;
  asset: string;
  payTo: string;
}

export interface PaidRouteOptions<T> {
  config: Pick<Config, 'HEDERA_NETWORK' | 'X402_FACILITATOR_URL'>;
  path: string;
  description: string;
  /** Merchant account that receives the payment. Undefined → 503 payments_not_configured. */
  payTo: string | undefined;
  /** Accepted prices, in the order offered. */
  prices: Price[];
  /** Return an error message to answer 400 before any payment is asked for (e.g. a missing query param). */
  validate?: (req: FastifyRequest) => string | undefined;
  /** Build the paid resource. Runs after verify and before settle. */
  produce: (req: FastifyRequest) => Promise<T>;
  /** Override the facilitator (tests, or a local facilitator). Default: HTTPFacilitatorClient(X402_FACILITATOR_URL). */
  facilitator?: FacilitatorClient;
  /** Called after a successful settlement. Errors are logged, never surfaced to the payer. */
  onSettled?: (payment: SettledPayment) => void | Promise<void>;
}

/**
 * Register one paid GET route. Synchronous so it can be called while building the app; the facilitator's
 * `/supported` (which carries the fee payer account) is fetched lazily on the first request and cached.
 */
export function registerPaidRoute<T extends object>(app: FastifyInstance, opts: PaidRouteOptions<T>): void {
  const { config, payTo } = opts;
  const network = caip2(config.HEDERA_NETWORK);
  const facilitator = opts.facilitator ?? new HTTPFacilitatorClient({ url: config.X402_FACILITATOR_URL, timeoutMs: 60_000 });
  const server = new x402ResourceServer(facilitator).register(network, new ExactHederaScheme());

  let ready: Promise<PaymentRequirements[]> | undefined;
  const requirements = (): Promise<PaymentRequirements[]> => {
    ready ??= (async () => {
      await server.initialize();
      const lists = await Promise.all(
        opts.prices.map((price) =>
          // Explicit AssetAmount per asset: a "$0.01" Money price would always convert to USDC, never HBAR.
          server.buildPaymentRequirements({ scheme: 'exact', network, payTo: payTo as string, price, maxTimeoutSeconds: 180 }),
        ),
      );
      return lists.flat();
    })().catch((err: unknown) => {
      ready = undefined; // retry on the next request
      throw err;
    });
    return ready;
  };

  const paymentRequired = async (req: FastifyRequest, accepts: PaymentRequirements[], error?: string) =>
    server.createPaymentRequiredResponse(
      accepts,
      { url: `${req.protocol}://${req.host}${req.url}`, description: opts.description, mimeType: 'application/json' },
      error,
    );

  const send402 = (reply: FastifyReply, body: PaymentRequired) =>
    reply.code(402).header('PAYMENT-REQUIRED', encodePaymentRequiredHeader(body)).header('cache-control', 'no-store').send(body);

  app.get(opts.path, async (req, reply) => {
    if (!payTo) return reply.code(503).send({ error: 'payments_not_configured', message: 'set X402_PAY_TO' });
    const invalid = opts.validate?.(req);
    if (invalid) return reply.code(400).send({ error: 'bad_request', message: invalid });

    let accepts: PaymentRequirements[];
    try {
      accepts = await requirements();
    } catch (err) {
      req.log.error({ err }, 'x402 facilitator unavailable');
      return reply.code(503).send({ error: 'facilitator_unavailable', facilitator: config.X402_FACILITATOR_URL });
    }

    const header = req.headers['payment-signature'] ?? req.headers['x-payment'];
    if (typeof header !== 'string' || header.length === 0) {
      return send402(reply, await paymentRequired(req, accepts, 'payment required'));
    }

    let payload: PaymentPayload;
    try {
      payload = decodePaymentSignatureHeader(header);
    } catch {
      return send402(reply, await paymentRequired(req, accepts, 'invalid_payment_header'));
    }

    const matched = server.findMatchingRequirements(accepts, payload);
    if (!matched) return send402(reply, await paymentRequired(req, accepts, 'no_matching_payment_requirements'));

    try {
      const verified = await server.verifyPayment(payload, matched);
      if (!verified.isValid) {
        req.log.warn({ reason: verified.invalidReason, payer: verified.payer }, 'x402 verify rejected');
        return send402(reply, await paymentRequired(req, accepts, verified.invalidReason ?? 'payment_invalid'));
      }
    } catch (err) {
      req.log.warn({ err }, 'x402 verify failed');
      return send402(reply, await paymentRequired(req, accepts, errorReason(err, 'verify_failed')));
    }

    // Produce the resource before settling so a broken handler never charges the payer.
    const resource = await opts.produce(req);

    let settled: SettleResponse;
    try {
      settled = await server.settlePayment(payload, matched);
    } catch (err) {
      req.log.error({ err }, 'x402 settle failed');
      return send402(reply, await paymentRequired(req, accepts, errorReason(err, 'settle_failed')));
    }
    if (!settled.success || !settled.transaction) {
      req.log.error({ reason: settled.errorReason }, 'x402 settle rejected');
      return send402(reply, await paymentRequired(req, accepts, settled.errorReason ?? 'settle_failed'));
    }

    const txId = settled.transaction;
    const hashscanUrl = hashscanTxUrl(txId, config.HEDERA_NETWORK);
    req.log.info({ txId, hashscanUrl, payer: settled.payer, asset: matched.asset, amount: matched.amount }, 'x402 payment settled');

    if (opts.onSettled) {
      try {
        await opts.onSettled({ txId, hashscanUrl, payer: settled.payer, amount: matched.amount, asset: matched.asset, payTo: matched.payTo });
      } catch (err) {
        req.log.warn({ err }, 'onSettled hook failed');
      }
    }

    const receipt = encodePaymentResponseHeader(settled);
    return reply
      .header('PAYMENT-RESPONSE', receipt)
      .header('X-PAYMENT-RESPONSE', receipt)
      .header('x-payment-tx-id', txId)
      .header('cache-control', 'no-store')
      .send({ ...resource, paidTxId: txId, hashscanUrl });
  });
}

function errorReason(err: unknown, fallback: string): string {
  if (err && typeof err === 'object') {
    const e = err as { invalidReason?: unknown; errorReason?: unknown };
    if (typeof e.invalidReason === 'string') return e.invalidReason;
    if (typeof e.errorReason === 'string') return e.errorReason;
  }
  return fallback;
}
