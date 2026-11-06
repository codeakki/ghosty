import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import { zeroGStatus, ZeroGEpisodeLog, type Agent } from './agent/index.js';
import { zeroGState } from './agent/status.js';
import type { Config } from './config.js';
import type { Executor } from './execution/executor.js';
import { HyperliquidVenue, parseFallbackCoins, resolveCoinIn, type MarketInfo } from './execution/hyperliquid.js';
import { HcsAuditLog, type Payments } from './payments/index.js';
import { HostNotAllowedError, SpendCap, SpendCapExceededError } from './payments/spendControls.js';
import { PaymentPolicyError, X402Payer, X402PaymentError } from './payments/x402Client.js';
import type { PodState } from './sim/state.js';
import { UniswapSpotLeg } from './wallet/uniswap.js';

/**
 * Read-only status routes for the integrations (0G, Hedera x402, Hyperliquid/Uniswap) and the
 * sim's "Pay for signal" button. None of these are called by the firmware.
 */
export interface IntegrationContext {
  config: Config;
  state: PodState;
  agent: Agent;
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

export interface LastPayment {
  mode: 'real' | 'fake';
  txId: string;
  hashscanUrl: string;
  amountTinybar?: number;
  requestId?: string;
  at: string;
}

/** 0G explorers: Galileo testnet unless the storage RPC points elsewhere. */
export function zeroGExplorers(config: Pick<Config, 'OG_RPC_URL'>): { chainscan: string; storagescan: string } {
  const testnet = /testnet|galileo/i.test(config.OG_RPC_URL);
  return testnet
    ? { chainscan: 'https://chainscan-galileo.0g.ai', storagescan: 'https://storagescan-galileo.0g.ai' }
    : { chainscan: 'https://chainscan.0g.ai', storagescan: 'https://storagescan.0g.ai' };
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
  // The real payer persists its daily cap in server/.ghosty/spend.json. The fake payer gets an in-memory cap
  // charged at the /signal price so the sim panel still shows the budget moving.
  const spendCap =
    payments.payer instanceof X402Payer
      ? payments.payer.spendCap
      : new SpendCap({ maxPerDayTinybar: config.X402_MAX_SPEND_TINYBAR, file: null });
  let lastPayment: LastPayment | null = null;

  app.get('/x402/status', async () => ({
    mode: payments.mode,
    network: `hedera:${config.HEDERA_NETWORK}`,
    payer: config.HEDERA_ACCOUNT_ID ?? null,
    payTo: config.X402_PAY_TO ?? config.HEDERA_ACCOUNT_ID ?? null,
    priceTinybar: config.X402_SIGNAL_PRICE_TINYBAR,
    maxPerCallTinybar: config.X402_MAX_PER_CALL_TINYBAR,
    spentToday: spendCap.spentToday(),
    cap: spendCap.maxPerDayTinybar,
    remainingToday: spendCap.remainingToday(),
    allowedHosts: config.X402_ALLOWED_HOSTS,
    hcsTopicUrl: payments.audit instanceof HcsAuditLog ? (payments.audit.topicUrl() ?? null) : null,
    lastPayment,
  }));

  // The agent pays for our own paywalled /signal with no human approval (real mode: x402 on hedera:testnet).
  app.post('/sim/pay-signal', { preHandler: ctx.requireDevice }, async (req, reply) => {
    const url = `http://127.0.0.1:${config.PORT}/signal`;
    try {
      if (payments.mode === 'fake') spendCap.assertCanSpend(config.X402_SIGNAL_PRICE_TINYBAR);
      const paid = await payments.payer.payForSignal(url);
      if (payments.mode === 'fake') spendCap.record(config.X402_SIGNAL_PRICE_TINYBAR, 'fake');
      const body = paid.body as { requestId?: unknown } | undefined;
      lastPayment = {
        mode: payments.mode,
        txId: paid.txId,
        hashscanUrl: paid.hashscanUrl,
        amountTinybar: paid.amountTinybar ?? (payments.mode === 'fake' ? config.X402_SIGNAL_PRICE_TINYBAR : undefined),
        requestId: typeof body?.requestId === 'string' ? body.requestId : undefined,
        at: new Date().toISOString(),
      };
      req.log.info({ txId: paid.txId, hashscanUrl: paid.hashscanUrl, mode: payments.mode }, 'sim paid for /signal');
      return { ...lastPayment, status: paid.status, body: paid.body, audit: paid.audit ?? null };
    } catch (err) {
      if (err instanceof PaymentPolicyError || err instanceof HostNotAllowedError || err instanceof SpendCapExceededError) {
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
      perpMode: executor.venue instanceof HyperliquidVenue ? 'real' : 'fake',
      spotMode: executor.spot instanceof UniswapSpotLeg ? 'real' : 'fake',
      testnet: config.HL_TESTNET,
      dexes: config.HL_DEXES.split(',').map((d) => d.trim()).filter(Boolean),
      spotLeg: executor.spotLeg ?? null,
      resolved,
      count: markets.length,
      markets: markets.slice(0, query.limit),
    };
  });
}
