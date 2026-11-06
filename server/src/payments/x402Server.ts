import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from '@x402/core/http';
import { HTTPFacilitatorClient, x402ResourceServer, type FacilitatorClient } from '@x402/core/server';
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from '@x402/core/types';
import { ExactHederaScheme } from '@x402/hedera/exact/server';
import type { Decision } from '../agent/decide.js';
import { loadConfig, type Config } from '../config.js';
import { caip2, HBAR_ASSET_ID, hashscanTxUrl } from './hedera.js';

/**
 * Paid `GET /signal` behind x402 on Hedera, as a Fastify plugin.
 *
 * Built on `@x402/core/server` (x402ResourceServer + HTTPFacilitatorClient) and the Hedera
 * `exact` server scheme from `@x402/hedera/exact/server`. We drive the resource server from a
 * Fastify route ourselves (instead of `@x402/express` / `@x402/fastify` middleware) so the
 * handler can stay injectable and the 402 body is plain JSON a judge can read with curl.
 *
 * Wire format (x402 v2, what `@x402/fetch` 2.x speaks):
 * - 402: `PAYMENT-REQUIRED` header (base64 JSON) and the same PaymentRequired object as the JSON body.
 * - Client retries with `PAYMENT-SIGNATURE` (v2). `X-PAYMENT` (the v1 header name) is accepted too.
 * - 200: `PAYMENT-RESPONSE` and `X-PAYMENT-RESPONSE` (base64 SettleResponse) + `x-payment-tx-id`.
 */

/** What a paid `/signal` call returns (plus the payment receipt fields). */
export interface SignalPayload {
  signal: string;
  confidence: number;
  actions: unknown[];
  /** 0G Compute request id of the decision behind this signal. */
  requestId: string;
}

export type GetSignal = () => SignalPayload | Promise<SignalPayload>;

/** Settlement details handed to `onSettled` (e.g. for an HCS audit entry). */
export interface SettledPayment {
  txId: string;
  hashscanUrl: string;
  payer?: string;
  amount: string;
  asset: string;
  payTo: string;
  requestId: string;
}

export interface PaidRoutesOptions {
  config?: Config;
  /** Latest signal. Defaults to a neutral placeholder so the route works without the agent branch. */
  getSignal?: GetSignal;
  /** Override the facilitator (tests, or a local facilitator). Default: HTTPFacilitatorClient(X402_FACILITATOR_URL). */
  facilitator?: FacilitatorClient;
  /** Called after a successful settlement. Errors are logged, never surfaced to the payer. */
  onSettled?: (payment: SettledPayment) => void | Promise<void>;
  /** Route path. Default `/signal`. */
  path?: string;
}

/** Map an agent Decision to the /signal payload. */
export function decisionToSignal(d: Decision): SignalPayload {
  return { signal: d.signal, confidence: d.confidence, actions: d.suggestedActions, requestId: d.requestId };
}

const PLACEHOLDER_SIGNAL: SignalPayload = { signal: 'none', confidence: 0, actions: [], requestId: 'no-decision-yet' };

const DESCRIPTION = 'Ghosty premium market signal (credibility-weighted, decided on 0G Compute)';

/**
 * Register `GET /signal` behind an x402 paywall that settles HBAR on Hedera.
 * Synchronous so it can be called inside `buildApp()`; the facilitator's `/supported`
 * (which carries the fee payer account) is fetched lazily on the first request and cached.
 */
export function registerPaidRoutes(app: FastifyInstance, opts: PaidRoutesOptions = {}): void {
  const config = opts.config ?? loadConfig();
  const network = caip2(config.HEDERA_NETWORK);
  const payTo = config.X402_PAY_TO ?? config.HEDERA_ACCOUNT_ID;
  const getSignal = opts.getSignal ?? (() => PLACEHOLDER_SIGNAL);
  const path = opts.path ?? '/signal';

  const facilitator = opts.facilitator ?? new HTTPFacilitatorClient({ url: config.X402_FACILITATOR_URL, timeoutMs: 60_000 });
  const server = new x402ResourceServer(facilitator).register(network, new ExactHederaScheme());

  let ready: Promise<PaymentRequirements[]> | undefined;
  const requirements = (): Promise<PaymentRequirements[]> => {
    ready ??= (async () => {
      await server.initialize();
      return server.buildPaymentRequirements({
        scheme: 'exact',
        network,
        payTo: payTo as string,
        // HBAR must be an explicit AssetAmount: on Hedera a "$0.01" Money price converts to USDC (0.0.429274), never HBAR.
        price: { asset: HBAR_ASSET_ID, amount: String(config.X402_SIGNAL_PRICE_TINYBAR) },
        maxTimeoutSeconds: 180,
      });
    })().catch((err: unknown) => {
      ready = undefined; // retry on the next request
      throw err;
    });
    return ready;
  };

  const paymentRequired = async (req: FastifyRequest, accepts: PaymentRequirements[], error?: string) =>
    server.createPaymentRequiredResponse(
      accepts,
      { url: `${req.protocol}://${req.host}${req.url}`, description: DESCRIPTION, mimeType: 'application/json' },
      error,
    );

  const send402 = (reply: FastifyReply, body: PaymentRequired) =>
    reply
      .code(402)
      .header('PAYMENT-REQUIRED', encodePaymentRequiredHeader(body))
      .header('cache-control', 'no-store')
      .send(body);

  app.get(path, async (req, reply) => {
    if (!payTo) {
      return reply.code(503).send({ error: 'payments_not_configured', message: 'set X402_PAY_TO or HEDERA_ACCOUNT_ID' });
    }

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
    if (!matched) {
      return send402(reply, await paymentRequired(req, accepts, 'no_matching_payment_requirements'));
    }

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
    const signal = await getSignal();

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
    req.log.info({ txId, hashscanUrl, payer: settled.payer, requestId: signal.requestId }, 'x402 payment settled');

    if (opts.onSettled) {
      try {
        await opts.onSettled({
          txId,
          hashscanUrl,
          payer: settled.payer,
          amount: matched.amount,
          asset: matched.asset,
          payTo: matched.payTo,
          requestId: signal.requestId,
        });
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
      .send({ ...signal, paidTxId: txId, hashscanUrl });
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
