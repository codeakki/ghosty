import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import { zeroGStatus, ZeroGEpisodeLog, type Agent } from './agent/index.js';
import { zeroGState } from './agent/status.js';
import type { Config } from './config.js';
import { notConfiguredInfo, ProviderNotConfiguredError } from './mode.js';
import type { Executor } from './execution/executor.js';
import { HyperliquidVenue, parseFallbackCoins, resolveCoinIn, type MarketInfo } from './execution/hyperliquid.js';
import { HcsAuditLog, readAuditLog, type Payments } from './payments/index.js';
import { HBAR_ASSET_ID } from './payments/hedera.js';
import { HostNotAllowedError, SpendCapExceededError } from './payments/spendControls.js';
import { PaymentPolicyError, PaymentQueueFullError, X402PaymentError } from './payments/x402Client.js';
import type { PodState } from './sim/state.js';
import { UniswapSpotLeg } from './wallet/uniswap.js';

/**
 * Read-only status routes for the integrations (0G, Hedera x402, Hyperliquid/Uniswap) and the
 * sim's "Pay" button. None of these are called by the firmware.
 */
export interface IntegrationContext {
  config: Config;
  state: PodState;
  agent: Agent;
  /** Payer, IntelBuyer (shared with the decision loop: same caps, same lastPayment) and HCS audit log. */
  payments: Payments;
  executor: Executor;
  /** Same source as /health (includes the sim safe-stop switch). */
  brainOnline: () => Promise<boolean>;
  requireDevice: preHandlerAsyncHookHandler;
}

/** Playbook aliases shown as "resolved markets" in the sim. */
const PLAYBOOK_ALIASES = ['GOLD', 'WTI', 'BTC'] as const;

const MarketsQuery = z.object({
  dex: z.string().max(40).optional(),
  q: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100).catch(100),
});

export type { LastPayment } from './payments/intelBuyer.js';

const AuditQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20).catch(20) });

/** 0G explorers: Galileo testnet unless the storage RPC points elsewhere. */
export function zeroGExplorers(config: Pick<Config, 'OG_RPC_URL'>): { chainscan: string; storagescan: string } {
  const testnet = /testnet|galileo/i.test(config.OG_RPC_URL);
  return testnet
    ? { chainscan: 'https://chainscan-galileo.0g.ai', storagescan: 'https://storagescan-galileo.0g.ai' }
    : { chainscan: 'https://chainscan.0g.ai', storagescan: 'https://storagescan.0g.ai' };
}

/** 'real' for the real class, 'not_configured' for a live-mode stand-in, else 'fake' (test mode only). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function modeOfSlot(slot: unknown, real: abstract new (...args: any[]) => unknown): 'real' | 'fake' | 'not_configured' {
  if (slot instanceof real) return 'real';
  return notConfiguredInfo(slot) ? 'not_configured' : 'fake';
}

export function registerIntegrationRoutes(app: FastifyInstance, ctx: IntegrationContext): void {
  const { config, state, agent, payments, executor } = ctx;

  // ---------- 0G ----------
  app.get('/zerog/status', async () => {
    const status = await zeroGStatus(config);
    const explorers = zeroGExplorers(config);
    const lastEpisode = agent.episodes instanceof ZeroGEpisodeLog ? agent.episodes.listIndex(1)[0] : undefined;
    const latest = state.latestDecision();
    return {
      ...status,
      // Include the sim safe-stop switch, like /health.
      computeOnline: await ctx.brainOnline(),
      model: status.computeMode === '0g' ? config.OG_MODEL : null,
      routerUrl: config.OG_ROUTER_URL,
      lastDecisionAt: zeroGState.lastDecisionAt,
      lastDecisionRequestId: latest?.requestId ?? null,
      memoryTxHash: zeroGState.memoryTxHash,
      lastEpisodeTxHash: lastEpisode?.txHash ?? null,
      links: {
        storagescan: explorers.storagescan,
        memoryTx: zeroGState.memoryTxHash ? `${explorers.chainscan}/tx/${zeroGState.memoryTxHash}` : null,
        lastEpisodeTx: lastEpisode ? `${explorers.chainscan}/tx/${lastEpisode.txHash}` : null,
      },
    };
  });

  // ---------- Hedera x402 ----------
  const { buyer } = payments;
  const spendCap = buyer.spendCap;
  const usdc = config.HEDERA_USDC_TOKEN_ID;
  const budget = (asset: string, perCall: number, price: number) => ({
    asset,
    price: String(price),
    maxPerCall: String(perCall),
    spentToday: spendCap.spentToday(asset).toString(),
    cap: spendCap.maxPerDay(asset).toString(),
    remainingToday: spendCap.remainingToday(asset).toString(),
  });

  app.get('/x402/status', async () => ({
    mode: payments.mode,
    network: `hedera:${config.HEDERA_NETWORK}`,
    payer: config.HEDERA_ACCOUNT_ID ?? null,
    payTo: config.X402_PAY_TO ?? null,
    signalDesk: config.SIGNAL_DESK_URL,
    preferredAsset: config.X402_PREFERRED_ASSET,
    budgets: {
      HBAR: budget(HBAR_ASSET_ID, config.X402_MAX_PER_CALL_TINYBAR, config.X402_INTEL_PRICE_TINYBAR),
      USDC: budget(usdc, config.X402_MAX_PER_CALL_USDC_MICROS, config.X402_INTEL_PRICE_USDC_MICROS),
    },
    // HBAR numbers at the top level, as the terminal reads them.
    priceTinybar: config.X402_INTEL_PRICE_TINYBAR,
    maxPerCallTinybar: config.X402_MAX_PER_CALL_TINYBAR,
    spentToday: Number(spendCap.spentToday(HBAR_ASSET_ID)),
    cap: Number(spendCap.maxPerDay(HBAR_ASSET_ID)),
    remainingToday: Number(spendCap.remainingToday(HBAR_ASSET_ID)),
    allowedHosts: config.X402_ALLOWED_HOSTS,
    hcsTopicUrl: payments.audit instanceof HcsAuditLog ? payments.audit.topicUrl() : null,
    autopay: config.X402_AUTOPAY,
    lastPayment: buyer.lastPayment,
  }));

  // HCS audit log, read back from the mirror node and decoded. Anyone can do the same on HashScan.
  app.get('/hedera/audit', async (req, reply) => {
    if (!(payments.audit instanceof HcsAuditLog)) {
      return reply.code(503).send({ error: 'not_configured', missingEnv: ['HEDERA_HCS_TOPIC_ID', 'HEDERA_HCS_SUBMIT_KEY'] });
    }
    const { limit } = AuditQuery.parse(req.query ?? {});
    const topicId = payments.audit.topicId;
    try {
      const messages = await readAuditLog(topicId, limit, { mirrorUrl: config.HEDERA_MIRROR_URL });
      return { topicId, topicUrl: payments.audit.topicUrl(), count: messages.length, messages };
    } catch (err) {
      return reply.code(502).send({ error: 'mirror_unavailable', message: (err as Error).message });
    }
  });

  // The agent buys intel for a headline with no human approval (real mode: x402 on hedera:testnet).
  // Body {headline?}: defaults to the newest headline the pod has seen.
  app.post('/sim/pay-signal', { preHandler: ctx.requireDevice }, async (req, reply) => {
    // Live mode without Hedera keys: 503 not_configured (via the app error handler), before anything else.
    const missing = notConfiguredInfo(payments.payer);
    if (missing) throw new ProviderNotConfiguredError(missing);
    const asked = (req.body as { headline?: unknown } | undefined)?.headline;
    const newest = state.snapshot().news[0];
    const headline = typeof asked === 'string' && asked.trim() ? { title: asked.trim() } : newest;
    if (!headline) return reply.code(409).send({ error: 'no_headline', message: 'no headline yet: pass {"headline": "..."}' });
    try {
      const intel = await buyer.buy(headline, 'sim');
      req.log.info({ txId: intel.txId, hashscanUrl: intel.hashscanUrl, mode: payments.mode }, 'sim bought intel');
      return { ...buyer.lastPayment, bundle: intel.bundle };
    } catch (err) {
      // Live mode without Hedera keys: 503 not_configured from the app error handler.
      if (err instanceof ProviderNotConfiguredError) throw err;
      if (
        err instanceof PaymentPolicyError ||
        err instanceof HostNotAllowedError ||
        err instanceof SpendCapExceededError ||
        err instanceof PaymentQueueFullError
      ) {
        return reply.code(409).send({ error: 'payment_refused', message: err.message });
      }
      if (err instanceof X402PaymentError) {
        return reply.code(502).send({ error: 'payment_failed', message: err.message, status: err.status ?? null, reason: err.reason ?? null });
      }
      req.log.error({ err }, 'sim pay-signal failed');
      return reply.code(502).send({ error: 'payment_failed', message: (err as Error).message });
    }
  });

  // ---------- Execution ----------
  app.get('/execution/markets', async (req, reply) => {
    const query = MarketsQuery.parse(req.query ?? {});
    let all: MarketInfo[];
    try {
      all = await executor.venue.listMarkets({ includeDelisted: true });
    } catch (err) {
      if (err instanceof ProviderNotConfiguredError) throw err;
      req.log.warn({ err }, 'Hyperliquid market list failed');
      return reply.code(502).send({ error: 'venue_unavailable', message: (err as Error).message });
    }
    const byCoin = new Map(all.map((m) => [m.coin, m]));
    const fallbacks = parseFallbackCoins(config.HL_FALLBACK_COINS);
    const resolved = PLAYBOOK_ALIASES.map((alias) => {
      try {
        const { market, fallback } = resolveCoinIn(byCoin, alias, fallbacks);
        return { alias, coin: market.coin, assetId: market.assetId, dex: market.dex, fallback, error: null };
      } catch (err) {
        return { alias, coin: null, assetId: null, dex: null, fallback: false, error: (err as Error).message };
      }
    });
    const needle = query.q?.toLowerCase();
    const markets = all.filter(
      (m) => !m.delisted && (query.dex === undefined || m.dex === query.dex) && (!needle || m.coin.toLowerCase().includes(needle)),
    );
    return {
      perpMode: modeOfSlot(executor.venue, HyperliquidVenue),
      spotMode: modeOfSlot(executor.spot, UniswapSpotLeg),
      testnet: config.HL_TESTNET,
      dexes: config.HL_DEXES.split(',').map((d) => d.trim()).filter(Boolean),
      spotLeg: executor.spotLeg ?? null,
      resolved,
      count: markets.length,
      markets: markets.slice(0, query.limit),
    };
  });
}
