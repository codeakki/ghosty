import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import { z } from 'zod';
import { BrainOfflineError, createAgent, MemoryUnavailableError, ZeroGBlobStore, type Agent, type BlobStore } from './agent/index.js';
import { consoleLogger } from './agent/log.js';
import { DEFAULT_DATA_DIR } from './agent/storage.js';
import type { Decision } from './agent/decide.js';
import { createStt } from './audio/stt.js';
import { ClaudeVoiceAssistant, type VoiceAssistant, type VoiceContext } from './claude/voice.js';
import { ClaudeOrderAgent } from './claude/orderAgent.js';
import { SIGN_TIMEOUT_MS, signerHub } from './execution/signerHub.js';
import { lookupFillHash } from './execution/hyperliquid.js';
import { ClaudeMarketPicker, runSignalChecks } from './signals/checks.js';
import { isAddress } from './wallet/account.js';
import { createTts, OUTPUT_SAMPLE_RATE } from './audio/tts.js';
import { parseWav, WavFormatError } from './audio/wav.js';
import { loadConfig, type Config } from './config.js';
import { createCredibilityScorer, type CredibilityScorer } from './credibility/ethos.js';
import { createExecutor, type Executor } from './execution/executor.js';
import type { PerpVenue } from './execution/hyperliquid.js';
import { registerIntegrationRoutes, zeroGExplorers } from './integrations.js';
import { createMarketService, type MarketService } from './market/service.js';
import { registerMarketRoutes } from './market/routes.js';
import { notConfiguredInfo, ProviderNotConfiguredError } from './mode.js';
import { ProviderRegistry } from './providers/registry.js';
import type { NewsAggregator } from './news/aggregator.js';
import { createNewsAggregator, createNewsProviders } from './news/factory.js';
import { shockDetector, type ShockResult } from './news/shock.js';
import type { NewsItem } from './news/types.js';
import { createPayments, type Payments } from './payments/index.js';
import { NothingPendingError, Pipeline, SafeStopEngagedError, type BoughtIntel, type PipelineDeps, type VoiceResult } from './pipeline.js';
import { BrainSwitch, isBrainOnline } from './safety/safeStop.js';
import { createCandleLoader, type CandleLoader } from './sim/candles.js';
import { SimEngine } from './sim/engine.js';
import { SimEpisodeLog } from './sim/episodes.js';
import { createSimLiveExecution } from './sim/liveOrders.js';
import { InjectedNewsProvider } from './sim/injected.js';
import { registerSimRunRoutes } from './sim/runRoutes.js';
import { loadScenarios, type Scenario } from './sim/scenarios.js';
import { registerSimRoutes } from './sim/routes.js';
import { PodState, type Alert } from './sim/state.js';
import { VERSION } from './version.js';
import { GuestAccess, type GuestSession } from './guest/access.js';
import { PodMirror, type PodMirrorEvent } from './pod/mirror.js';

/** server/public, from both src/ (tsx) and dist/ (built). Holds the virtual pod page. */
const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

/** <repo>/terminal/dist, from both src/ (tsx) and dist/ (built). Overridden by TERMINAL_DIST. */
const DEFAULT_TERMINAL_DIST = fileURLToPath(new URL('../../terminal/dist/', import.meta.url));

/** The built terminal's directory when its index.html exists, else undefined. */
export function terminalDistDir(config: Pick<Config, 'TERMINAL_DIST'>): string | undefined {
  const dir = config.TERMINAL_DIST ? resolve(process.cwd(), config.TERMINAL_DIST) : DEFAULT_TERMINAL_DIST;
  return existsSync(join(dir, 'index.html')) ? dir : undefined;
}

/** 30 s of 16 kHz 16-bit mono is ~960 KB; leave headroom. */
const AUDIO_BODY_LIMIT = 4 * 1024 * 1024;

const ButtonBody = z.object({ action: z.enum(['confirm', 'cancel']) });

const PodStateBody = z.object({
  state: z.enum(['listening', 'idle']),
  level: z.number().min(0).max(1).optional(),
});

/** Which credential a request carried: the owner's DEVICE_TOKEN (or none configured) or a guest token. */
type Scope = { kind: 'owner' } | { kind: 'guest'; session: GuestSession };

/** Client IP for guest issuance limits: the first X-Forwarded-For hop (Vercel/ALB put the client there), else the socket. */
function clientIp(req: FastifyRequest): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
  return first || req.ip;
}

/** The firmware tags its requests `x-ghosty-client: pod`; only those drive the web orb's pod mirror. */
const fromPod = (req: FastifyRequest) => req.headers['x-ghosty-client'] === 'pod';

export interface BuildAppOptions {
  config?: Config;
  deps?: Partial<PipelineDeps>;
  /** Scores news sources (pod state, decider, aggregator). Default: createCredibilityScorer(config). */
  scorer?: CredibilityScorer;
  /** Decider + memory + episode log. Default: createAgent(config), 0G when OG_* keys are set. */
  agent?: Agent;
  /** Hyperliquid venue + Uniswap spot leg. Default: createExecutor(config). */
  executor?: Executor;
  /** x402 payer + intel buyer + HCS audit log. Default: createPayments(config). */
  payments?: Payments;
  /** GET /providers/status. Default: real probes over the config (tests pass one with a mocked fetch). */
  providerRegistry?: ProviderRegistry;
  /** GET /market/*. Default: Hyperliquid info API on MARKET_DATA_NETWORK (tests pass one with a mocked fetch). */
  market?: MarketService;
  /**
   * Claude voice answers. Default: ClaudeVoiceAssistant when CLAUDE_VOICE_ENABLED (ANTHROPIC_API_KEY set).
   * null turns routing off (every turn is a 0G decision). Tests pass a mock.
   */
  assistant?: VoiceAssistant | null;
  /**
   * What answers guest questions. Default: a ClaudeVoiceAssistant whose context leaves out the owner's memory
   * (or `assistant` when a test passes one). null = guests get the "questions are off" line.
   */
  guestAssistant?: VoiceAssistant | null;
  /** Clock for guest tokens and limits (tests). */
  guestNow?: () => number;
  /** Spoken orders. Default: ClaudeOrderAgent when VOICE_ORDERS_ENABLED and ANTHROPIC_API_KEY are set. null = off. Tests pass a mock. */
  orderAgent?: PipelineDeps['orderAgent'] | null;
  logger?: FastifyServerOptions['logger'];
  /** Simulation runs: candle loader (tests pass a fake), scenarios, 0G store for sim episodes (null = local only). */
  sim?: {
    loadCandles?: CandleLoader;
    scenarios?: () => Scenario[];
    store?: BlobStore | null;
    autoTick?: boolean;
    slippageBps?: number;
    /** Stand-in for the Hyperliquid mainnet venue that real sim orders go to (tests). Still needs SIM_LIVE_ORDERS. */
    liveVenue?: PerpVenue;
  };
}

/** What the news poller did with one batch of fresh headlines. */
export interface FreshNewsOutcome {
  shock: ShockResult;
  decision: Decision | null;
  alert: Alert | null;
  /** Why no decision was made for a shock candidate. */
  skipped?: 'no_shock' | 'brain_offline' | 'memory_unavailable' | 'not_configured';
}

/** Handles index.ts needs (poller, shutdown) without reaching into buildApp's closures. */
export interface GhostyRuntime {
  config: Config;
  pipeline: Pipeline;
  state: PodState;
  agent: Agent;
  payments: Payments;
  executor: Executor;
  /** Provider health (GET /providers/status). index.ts polls it and emits SSE `providers`. */
  providers: ProviderRegistry;
  /** Live market data (GET /market/*). index.ts starts it and emits SSE `market`. */
  market: MarketService;
  /** Present only with NEWS_LIVE=true; index.ts polls it with NewsPoller. */
  aggregator?: NewsAggregator;
  /** Scenario replay with paper execution (POST /sim/run). */
  sim: SimEngine;
  /** NewsPoller listener: shockDetector → decision on the strongest headline → alert queue. */
  onFreshNews(items: NewsItem[]): Promise<FreshNewsOutcome>;
}

declare module 'fastify' {
  interface FastifyInstance {
    ghosty: GhostyRuntime;
  }
}

export interface Providers {
  deps: PipelineDeps;
  scorer: CredibilityScorer;
  agent: Agent;
  executor: Executor;
  aggregator?: NewsAggregator;
  /** The one 0G Storage client (shared by memory, live episodes and sim episodes so uploads never race on the nonce). */
  blobStore?: BlobStore;
}

/**
 * Every provider from its factory: the real one when its keys are set. Otherwise the deterministic fake in test
 * mode, and a NotConfigured implementation (throws ProviderNotConfiguredError, 503 not_configured) in live mode.
 */
export function createProviders(
  config: Config,
  opts: Pick<BuildAppOptions, 'scorer' | 'agent' | 'executor'> & { logger?: FastifyInstance['log'] } = {},
): Providers {
  const scorer = opts.scorer ?? createCredibilityScorer(config);
  const blobStore =
    !opts.agent && config.OG_PRIVATE_KEY
      ? new ZeroGBlobStore({ privateKey: config.OG_PRIVATE_KEY, rpcUrl: config.OG_RPC_URL, indexerUrl: config.OG_INDEXER_URL, logger: opts.logger ?? consoleLogger })
      : undefined;
  const agent = opts.agent ?? createAgent(config, { logger: opts.logger, scorer, blobStore });
  const executor = opts.executor ?? createExecutor(config);
  // Aggregate only live news: the fake headlines carry fixed timestamps and would fall out of the rolling window.
  const aggregator = config.NEWS_LIVE ? createNewsAggregator(config, { scorer }) : undefined;
  return {
    scorer,
    agent,
    executor,
    aggregator,
    blobStore,
    deps: {
      stt: createStt(config),
      tts: createTts(config),
      news: aggregator ? [aggregator] : createNewsProviders(config),
      decider: agent.decider,
      memory: agent.memory,
      episodes: agent.episodes,
      venue: executor.venue,
      spot: executor.spot,
      spotLeg: executor.spotLeg,
      maxTradeUsd: config.MAX_TRADE_USD,
    },
  };
}

/** Pipeline deps from the factories (test fakes or live NotConfigured stand-ins when keys are absent). */
export function defaultDeps(config: Config): PipelineDeps {
  return createProviders(config).deps;
}


/** `fallback` if `p` has not settled within `ms` (or rejects). Keeps the voice context from stalling a turn. */
async function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([p.catch(() => fallback), late]);
  } finally {
    clearTimeout(timer);
  }
}

function tokenMatches(got: string, expected: string): boolean {
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function buildApp(opts: BuildAppOptions = {}): FastifyInstance {
  const config = opts.config ?? loadConfig();
  const app = Fastify({ logger: opts.logger ?? false });
  // Starts from SIMULATE_BRAIN_OFFLINE; POST /sim/safe-stop flips it at runtime.
  const brain = new BrainSwitch(config.SIMULATE_BRAIN_OFFLINE);
  const brainOnline = () => isBrainOnline(config, { sim: brain });
  const providers = createProviders(config, { scorer: opts.scorer, agent: opts.agent, executor: opts.executor, logger: app.log });
  const payments = opts.payments ?? createPayments(config, { log: (msg, data) => app.log.info(data ?? {}, msg) });
  // Virtual pod state: the pipeline reports every step into it; /state and /events read it.
  const state = new PodState(providers.scorer, {
    safeStop: config.SAFE_STOP_ENABLED && config.SIMULATE_BRAIN_OFFLINE,
  });
  // Headlines posted to /news/inject join whatever news providers are configured.
  const injected = new InjectedNewsProvider();
  const deps = { ...providers.deps, ...opts.deps };
  // One buyer for the decision loop and POST /sim/pay-signal: same daily caps, same lastPayment.
  const { buyer } = payments;
  // X402_AUTOPAY: before deciding on a shock headline, the agent buys the Signal Desk intel itself, no human
  // approval. It pays only when the decision will actually run: not while safe-stop is on or 0G is unreachable,
  // not for non-shock headlines, and not when Hedera keys are missing.
  const buyIntel =
    config.X402_AUTOPAY && payments.mode !== 'not_configured'
      ? async (headline: NewsItem): Promise<BoughtIntel | undefined> => {
          if (shockDetector([headline]).candidate === 'none') return undefined;
          if (!(await brainOnline())) {
            app.log.info({ headline: headline.title }, 'not buying intel: brain offline / safe-stop, no decision will run');
            return undefined;
          }
          try {
            return await buyer.buy(headline, 'decision');
          } catch (err) {
            app.log.warn({ err: (err as Error).message }, 'intel purchase failed; deciding without it');
            throw err;
          }
        }
      : undefined;
  // HCS audit for decisions and trades: fire-and-forget, a slow or failed write never touches the decision.
  const audit = payments.audit.enabled
    ? (entry: Parameters<NonNullable<PipelineDeps['audit']>>[0]) => {
        payments.audit.record(entry).catch((err: unknown) => app.log.warn({ err: String(err) }, 'HCS audit write failed'));
      }
    : undefined;
  // Claude answers questions (never trades); `voiceContext` is defined below and only called per request.
  const assistant: VoiceAssistant | undefined =
    opts.assistant !== undefined
      ? (opts.assistant ?? undefined)
      : config.CLAUDE_VOICE_ENABLED && config.ANTHROPIC_API_KEY
        ? new ClaudeVoiceAssistant({ apiKey: config.ANTHROPIC_API_KEY, model: config.ANTHROPIC_MODEL, context: () => voiceContext() })
        : undefined;
  // Guests get the same Claude, minus the owner's stored memory (journal, risk profile).
  const guestAssistant: VoiceAssistant | undefined =
    opts.guestAssistant !== undefined
      ? (opts.guestAssistant ?? undefined)
      : opts.assistant !== undefined
        ? (opts.assistant ?? undefined)
        : config.CLAUDE_VOICE_ENABLED && config.ANTHROPIC_API_KEY
          ? new ClaudeVoiceAssistant({
              apiKey: config.ANTHROPIC_API_KEY,
              model: config.ANTHROPIC_MODEL,
              context: async () => ({ ...(await voiceContext()), memory: null }),
            })
          : undefined;
  // Memory, journal and trades are kept per Hyperliquid account (the master address), not per device.
  const accountId = isAddress(config.HL_MASTER_ADDRESS) ? config.HL_MASTER_ADDRESS.toLowerCase() : 'device-0';
  // Spoken orders: Claude hears every turn and places explicit orders on the venue, capped at MAX_TRADE_USD.
  const orderAgent: PipelineDeps['orderAgent'] =
    opts.orderAgent !== undefined
      ? (opts.orderAgent ?? undefined)
      : config.VOICE_ORDERS_ENABLED && config.ANTHROPIC_API_KEY
        ? new ClaudeOrderAgent({
            apiKey: config.ANTHROPIC_API_KEY,
            model: config.ANTHROPIC_MODEL,
            context: () => voiceContext(),
            venue: deps.venue,
            maxTradeUsd: config.MAX_TRADE_USD,
          })
        : undefined;
  // Only the live decision loop pays. The SimEngine below gets the bare decider, never buyIntel: sim decisions are paper-only.
  const pipeline = new Pipeline({
    buyIntel,
    intelWaitMs: config.X402_AUTOPAY_WAIT_MS,
    pendingTtlMs: config.PENDING_DECISION_TTL_SEC * 1000,
    audit,
    ...deps,
    news: [...deps.news, injected],
    observer: state,
    assistant,
    brainOnline,
    orderAgent,
    userId: accountId,
    recentNews: () => state.snapshot().news.slice(0, 3).map((n) => ({ title: n.title, source: n.source })),
    lookupFillHash: (orderId) => lookupFillHash(config, orderId),
    onMemoryError: (err) => app.log.warn({ err: String(err) }, '0G journal write failed'),
  });

  // 0G failures never become a fake decision: map them to 503 so the pod says "brain offline".
  app.setErrorHandler(async (err, req, reply) => {
    if (err instanceof ProviderNotConfiguredError) {
      req.log.warn({ provider: err.provider, missingEnv: err.missingEnv }, 'provider not configured');
      return reply.code(503).send(err.body());
    }
    if (err instanceof BrainOfflineError) {
      req.log.warn({ reason: err.reason, status: err.status, requestId: err.requestId }, '0G brain offline, trade blocked');
      return reply.code(503).send({
        error: 'brain_offline',
        reason: err.reason,
        requestId: err.requestId ?? null,
        ...(err.reason === 'not_configured' ? { provider: '0g-router', missingEnv: ['OG_API_KEY'] } : {}),
      });
    }
    if (err instanceof NothingPendingError) {
      // A press with no alert the wearer has heard (or an expired one): nothing was decided or executed.
      req.log.warn({ code: err.code, requestId: err.requestId }, 'button press with nothing pending: no trade');
      return reply.code(409).send(err.body());
    }
    if (err instanceof SafeStopEngagedError) {
      req.log.warn('trade request while safe-stop is engaged');
      return reply.code(503).send({ error: 'brain_offline' });
    }
    if (err instanceof MemoryUnavailableError) {
      req.log.warn({ err: err.message }, '0G memory unavailable, trade blocked');
      return reply.code(503).send({ error: 'memory_unavailable', message: err.message });
    }
    throw err;
  });

  const onFreshNews = async (items: NewsItem[]): Promise<FreshNewsOutcome> => {
    await state.onNews(items);
    const shock = shockDetector(items);
    const top = shock.matched[0];
    if (shock.signal === 'none' || !top) return { shock, decision: null, alert: null, skipped: 'no_shock' };
    if (!(await brainOnline())) {
      app.log.warn({ headline: top.item.title }, 'shock headline while brain offline: no decision');
      return { shock, decision: null, alert: null, skipped: 'brain_offline' };
    }
    try {
      const decision = await pipeline.decideOnHeadline(top.item);
      const alert = state.enqueueAlert(decision, top.item);
      app.log.info({ requestId: decision.requestId, signal: decision.signal, alert: alert?.id, headline: top.item.title }, 'news shock decision');
      if (decision.signal !== 'none') void announceSignal(top.item.title, decision);
      return { shock, decision, alert };
    } catch (err) {
      if (err instanceof BrainOfflineError) return { shock, decision: null, alert: null, skipped: 'brain_offline' };
      if (err instanceof MemoryUnavailableError) return { shock, decision: null, alert: null, skipped: 'memory_unavailable' };
      if (err instanceof ProviderNotConfiguredError) return { shock, decision: null, alert: null, skipped: 'not_configured' };
      throw err;
    }
  };

  /**
   * Every signal gets both checks (prediction-market odds now vs a minute ago, and the 1-5 minute price move on
   * Hyperliquid and Binance) before the pod speaks it. The result is queued for GET /announce and kept in the
   * wearer's 0G journal.
   */
  const marketPicker = config.ANTHROPIC_API_KEY ? new ClaudeMarketPicker({ apiKey: config.ANTHROPIC_API_KEY, model: config.ANTHROPIC_MODEL }) : undefined;
  async function announceSignal(headline: string, decision: Decision): Promise<void> {
    const checks = await within(
      runSignalChecks({ headline, actions: decision.suggestedActions }, { picker: marketPicker, testnet: config.HL_TESTNET }),
      15_000,
      null,
    );
    const text = [decision.rationale, ...(checks?.spoken ?? [])].join(' ');
    announcements.push({ id: decision.requestId, text, at: Date.now() });
    app.log.info({ requestId: decision.requestId, spoken: checks?.spoken, errors: checks?.errors }, 'signal checks');
    await pipeline.rememberSignal(headline, text, {
      signal: decision.signal,
      confidence: decision.confidence,
      actions: decision.suggestedActions.map((a) => ({ coin: a.coin, side: a.side, sizeUsd: a.sizeUsd })),
      checks: checks ?? { error: 'checks timed out' },
    });
  }

  // Simulation: real decider (0G in live mode), historical world, PaperVenue fills. A run may opt in to real
  // Hyperliquid mainnet orders (SIM_LIVE_ORDERS=true), sent through the sim's own mainnet venue, never the executor. Sim episodes go to 0G Storage
  // when OG_PRIVATE_KEY is set, else to <dataDir>/sim-episodes.jsonl labelled storage "local".
  const dataDir = config.OG_DATA_DIR ?? DEFAULT_DATA_DIR;
  const simStore = opts.sim?.store === null ? undefined : (opts.sim?.store ?? providers.blobStore);
  const simLog = new SimEpisodeLog({ dataDir, store: simStore, logger: app.log });
  const sim = new SimEngine({
    decider: deps.decider,
    memory: deps.memory,
    episodes: simLog,
    loadCandles: opts.sim?.loadCandles ?? createCandleLoader({ dataDir }),
    scenarios: opts.sim?.scenarios ?? (() => loadScenarios()),
    brainOnline,
    publish: (type, data) => state.publishSim(type, data),
    maxTradeUsd: config.MAX_TRADE_USD,
    live: createSimLiveExecution(config, opts.sim?.liveVenue),
    slippageBps: opts.sim?.slippageBps,
    logger: app.log,
    autoTick: opts.sim?.autoTick,
  });
  app.addHook('onClose', async () => sim.stop());

  const providerRegistry = opts.providerRegistry ?? new ProviderRegistry({ config });
  const market = opts.market ?? createMarketService(config, { logger: app.log });

  // What Claude sees for a question: live prices, latest headlines with credibility, last 0G decision, pending
  // alert and trade, recent orders, mode. Slow sources fall back to "unknown" instead of stalling the turn.
  const voiceContext = async (): Promise<VoiceContext> => {
    const snap = state.snapshot();
    const [online, marketSnap, stored] = await Promise.all([
      within(brainOnline(), 2_000, !snap.safeStop),
      within(market.snapshot().then((m) => m as typeof m | null), 3_000, null),
      // The wearer's memory from 0G (cached in this process after the first download).
      within(deps.memory.load(accountId).then((m) => m as typeof m | null), 4_000, null),
    ]);
    const simStatus = sim.status().status;
    // Only what a press would actually act on: the live pending decision (not expired) and its alert.
    const pending = pipeline.pendingDecision();
    const pendingAlert = (pending && snap.alerts.find((a) => a.status !== 'acked' && a.requestId === pending.decision.requestId)) || null;
    return {
      mode: config.GHOSTY_MODE,
      simRunActive: simStatus === 'running' || simStatus === 'paused',
      safeStop: !online,
      market: marketSnap ? marketSnap.assets.map((a) => ({ coin: a.coin, label: a.label, mid: a.mid, change24hPct: a.change24hPct })) : null,
      headlines: snap.news.slice(0, 10).map((n) => ({
        title: n.title,
        source: n.summary && n.source === 'claude-scout' ? `${n.summary} (via Claude scout)` : n.source,
        publishedAt: n.publishedAt,
        ...(n.weight === undefined ? {} : { weight: n.weight }),
        credibility: n.credibility?.level ?? null,
      })),
      lastDecision: snap.lastDecision
        ? {
            signal: snap.lastDecision.signal,
            confidence: snap.lastDecision.confidence,
            rationale: snap.lastDecision.rationale,
            at: snap.lastDecision.at,
            trigger: snap.lastDecision.trigger,
          }
        : null,
      pendingAlert: pendingAlert
        ? { text: pendingAlert.text, signal: pendingAlert.signal, createdAt: pendingAlert.createdAt, ...(pendingAlert.headline ? { headline: pendingAlert.headline } : {}) }
        : null,
      pendingTrade: pending ? pending.decision.suggestedActions : [],
      recentOrders: snap.orders.slice(0, 5).map((o) => ({ coin: o.coin, isBuy: o.isBuy, sizeUsd: o.sizeUsd, status: o.status, at: o.at })),
      memory: stored ? { riskProfile: stored.riskProfile, journal: stored.journal ?? [] } : null,
    };
  };

  app.decorate('ghosty', {
    config,
    pipeline,
    state,
    agent: providers.agent,
    payments,
    executor: providers.executor,
    providers: providerRegistry,
    market,
    aggregator: providers.aggregator,
    sim,
    onFreshNews,
  } satisfies GhostyRuntime);

  // CORS for the terminal's Vite dev server (live mode). The built terminal is same-origin and needs none.
  const corsOrigins = new Set(config.GHOSTY_MODE === 'live' ? config.CORS_ORIGINS : []);
  if (corsOrigins.size > 0) {
    app.addHook('onRequest', async (req, reply) => {
      const origin = req.headers.origin;
      if (!origin || !corsOrigins.has(origin)) return;
      reply.header('access-control-allow-origin', origin).header('vary', 'Origin');
      if (req.method === 'OPTIONS') {
        return reply
          .header('access-control-allow-methods', 'GET,POST,OPTIONS')
          .header('access-control-allow-headers', String(req.headers['access-control-request-headers'] ?? 'content-type,x-device-token,x-ghosty-client'))
          .header('access-control-max-age', '600')
          .code(204)
          .send();
      }
      reply.header('access-control-expose-headers', 'x-request-id,x-signal,x-answered-by,x-sample-rate,payment-required,payment-response,retry-after');
    });
  }

  app.addHook('onReady', async () => {
    pipeline.refreshNews().catch((err: unknown) => app.log.warn({ err }, 'initial news fetch failed'));
  });

  // The device posts WAV; accept the common audio types plus octet-stream as a raw Buffer.
  app.addContentTypeParser(
    ['audio/wav', 'audio/x-wav', 'audio/wave', 'application/octet-stream'],
    { parseAs: 'buffer', bodyLimit: AUDIO_BODY_LIMIT },
    (_req, body, done) => done(null, body),
  );

  // Guest access (GUEST_ACCESS=true): question-only tokens. Owner routes answer a guest token with 403.
  const guests = config.GUEST_ACCESS
    ? new GuestAccess(
        {
          ttlSec: config.GUEST_TTL_SEC,
          maxPerHour: config.GUEST_MAX_PER_HOUR,
          maxPerDay: config.GUEST_MAX_PER_DAY,
          issuePerIpPerHour: config.GUEST_ISSUE_PER_IP_PER_HOUR,
          maxActive: config.GUEST_MAX_ACTIVE,
        },
        {
          // Live servers keep (hashed) guest tokens across restarts; tests stay in memory.
          persistPath: config.GHOSTY_MODE === 'live' ? join(config.OG_DATA_DIR ?? DEFAULT_DATA_DIR, 'guests.json') : undefined,
          now: opts.guestNow,
          onPersistError: (err) => app.log.warn({ err: String(err) }, 'guest token store failed'),
        },
      )
    : undefined;
  const scopes = new WeakMap<FastifyRequest, Scope>();
  const scopeOf = (req: FastifyRequest): Scope => scopes.get(req) ?? { kind: 'owner' };

  /** owner | guest | why not (401 body). Never logs or echoes the token. */
  const identify = (req: FastifyRequest): Scope | { error: 'unauthorized' | 'guest_expired' } => {
    if (!config.DEVICE_TOKEN) return { kind: 'owner' }; // local dev: no token configured
    const got = req.headers['x-device-token'];
    if (typeof got !== 'string') return { error: 'unauthorized' };
    if (tokenMatches(got, config.DEVICE_TOKEN)) return { kind: 'owner' };
    const session = guests?.verify(got);
    if (session) return { kind: 'guest', session };
    return { error: guests?.wasExpired(got) ? 'guest_expired' : 'unauthorized' };
  };

  const GUEST_FORBIDDEN = { error: 'guest_forbidden', message: "Guests can ask questions; this needs the owner's device token." };

  /** Owner only (decisions, orders, payments, injects, the button, pod state). A guest token gets 403. */
  const requireDevice = async (req: FastifyRequest, reply: FastifyReply) => {
    const who = identify(req);
    if ('error' in who) return reply.code(401).send({ error: who.error });
    if (who.kind === 'guest') return reply.code(403).send(GUEST_FORBIDDEN);
    scopes.set(req, who);
  };

  const meterGuest = (reply: FastifyReply, session: GuestSession) => {
    const turn = guests!.consumeTurn(session);
    if (turn.ok) return undefined;
    return reply.header('retry-after', String(turn.retryAfterSec)).code(429).send({ error: turn.error, retryAfterSec: turn.retryAfterSec });
  };

  /** Owner, or a guest within its limits: /voice and /voice/text. Guest turns are routed question-only below. */
  const requireTalk = async (req: FastifyRequest, reply: FastifyReply) => {
    const who = identify(req);
    if ('error' in who) return reply.code(401).send({ error: who.error });
    if (who.kind === 'guest') {
      const limited = meterGuest(reply, who.session);
      if (limited) return limited;
    }
    scopes.set(req, who);
  };

  /** POST /sim/run: owner, or a guest when GUEST_SIM=true and the run is paper-only. */
  const requireSimRun = async (req: FastifyRequest, reply: FastifyReply) => {
    const who = identify(req);
    if ('error' in who) return reply.code(401).send({ error: who.error });
    if (who.kind === 'guest') {
      const live = (req.body as { liveOrders?: unknown } | undefined)?.liveOrders === true;
      if (!config.GUEST_SIM || live) return reply.code(403).send(GUEST_FORBIDDEN);
      const limited = meterGuest(reply, who.session);
      if (limited) return limited;
    }
    scopes.set(req, who);
  };

  // The web orb mirrors the physical pod (SSE `pod`). Only pod-tagged owner requests drive it.
  const podMirror = new PodMirror({
    publish: (event: PodMirrorEvent) => state.publish('pod', event),
    sampleRate: OUTPUT_SAMPLE_RATE,
  });
  app.addHook('onClose', async () => podMirror.close());
  const mirrorsPod = (req: FastifyRequest) => fromPod(req) && scopeOf(req).kind === 'owner';

  const requireBrain = async (_req: FastifyRequest, reply: FastifyReply) => {
    if (!(await brainOnline())) {
      return reply.code(503).send({ error: 'brain_offline' });
    }
  };

  // Live mode: a /voice round trip needs real STT and TTS. Refuse up front (503 not_configured) instead of
  // transcribing nothing or answering with a placeholder sound.
  const requireVoice = async (_req: FastifyRequest, reply: FastifyReply) => {
    for (const slot of [deps.stt, deps.tts]) {
      const info = notConfiguredInfo(slot);
      if (info) return reply.code(503).send(new ProviderNotConfiguredError(info).body());
    }
  };

  app.get('/health', async () => ({
    ok: true,
    version: VERSION,
    // true = safe-stop engaged: 0G unreachable, trading blocked.
    safeStop: !(await brainOnline()),
    guestAccess: config.GUEST_ACCESS,
  }));

  // What the web needs to offer guest access, and (with a token) which scope that token has.
  app.get('/access', async (req) => {
    const got = req.headers['x-device-token'];
    let scope: 'owner' | 'guest' | null = null;
    let expiresAt: string | null = null;
    if (typeof got === 'string' && got.length > 0) {
      const who = identify(req);
      if (!('error' in who)) {
        scope = who.kind;
        if (who.kind === 'guest') expiresAt = new Date(who.session.expiresAt).toISOString();
      }
    }
    return {
      guestAccess: config.GUEST_ACCESS,
      guestSim: config.GUEST_ACCESS && config.GUEST_SIM,
      guestTtlSec: config.GUEST_TTL_SEC,
      guestMaxPerHour: config.GUEST_MAX_PER_HOUR,
      scope,
      expiresAt,
    };
  });

  // Self-serve guest token: questions only. Per-IP and global caps; the token is shown once and stored hashed.
  app.post('/guest/token', async (req, reply) => {
    if (!guests) return reply.code(404).send({ error: 'guest_access_off', message: 'Guest access is switched off on this server.' });
    const issued = guests.issue(clientIp(req));
    if (!issued.ok) {
      req.log.warn({ error: issued.error }, 'guest token refused');
      return reply.header('retry-after', String(issued.retryAfterSec)).code(429).send({ error: issued.error, retryAfterSec: issued.retryAfterSec });
    }
    req.log.info({ active: guests.activeCount() }, 'guest token issued');
    return {
      token: issued.token,
      scope: 'guest',
      expiresAt: new Date(issued.expiresAt).toISOString(),
      ttlSec: issued.ttlSec,
      limits: { perHour: config.GUEST_MAX_PER_HOUR },
      can: ['ask questions (voice or text)'],
      cannot: ['trade', 'confirm alerts', 'pay for intel', 'inject news', ...(config.GUEST_SIM ? [] : ['run simulations'])],
    };
  });

  // The pod reports its button: listening while recording (optional mic level, at most 10/s), idle on cancel.
  app.post('/pod/state', { preHandler: [requireDevice] }, async (req, reply) => {
    const parsed = PodStateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', message: 'body must be {"state": "listening"|"idle", "level"?: 0..1}' });
    const { state: next, level } = parsed.data;
    if (next === 'idle') {
      podMirror.set('idle');
      return { ok: true, state: 'idle' };
    }
    if (podMirror.state !== 'listening') {
      podMirror.set('listening');
      return { ok: true, state: 'listening' };
    }
    const accepted = level === undefined ? true : podMirror.level(level);
    return { ok: true, state: 'listening', ...(accepted ? {} : { dropped: true }) };
  });

  // With Claude on, questions do not need 0G: the pipeline checks safe-stop on the trade path only.
  const voicePreHandlers = assistant ? [requireTalk, requireVoice] : [requireTalk, requireVoice, requireBrain];
  /** Signals waiting for the pod to fetch and speak (GET /announce). Old ones expire unspoken. */
  const announcements: Array<{ id: string; text: string; at: number }> = [];
  const ANNOUNCE_TTL_MS = 10 * 60_000;

  // The pod polls this while idle: 200 + PCM for the oldest fresh announcement, 204 when there is none.
  app.get('/announce', { preHandler: [requireDevice] }, async (req, reply) => {
    while (announcements.length && Date.now() - announcements[0]!.at > ANNOUNCE_TTL_MS) announcements.shift();
    const next = announcements.shift();
    if (!next) return reply.code(204).send();
    const audio = await deps.tts.synthesize(next.text);
    req.log.info({ id: next.id, text: next.text }, 'announcement sent to the pod');
    if (mirrorsPod(req)) podMirror.speaking(audio);
    return reply
      .header('content-type', 'application/octet-stream')
      .header('x-sample-rate', String(OUTPUT_SAMPLE_RATE))
      .header('x-announce-id', next.id)
      .send(audio);
  });

  /** Voice turns paused on a Dabao signature, by sign request id. */
  const openTurns = new Map<string, { result: Promise<VoiceResult | undefined>; pod: boolean }>();
  app.post('/voice', { preHandler: voicePreHandlers }, async (req, reply) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return reply.code(400).send({ error: 'expected_wav_body' });
    }
    let wav;
    try {
      wav = parseWav(req.body);
    } catch (err) {
      if (err instanceof WavFormatError) return reply.code(400).send({ error: 'bad_wav', message: err.message });
      throw err;
    }
    if (wav.sampleRate !== 16000) req.log.warn({ sampleRate: wav.sampleRate }, 'expected 16 kHz input');

    if (scopeOf(req).kind === 'guest') {
      // Guests: question-only, and never part of a Dabao sign relay (that belongs to the owner's turn).
      const result = await pipeline.handleGuestVoice(wav, guestAssistant, req.headers['x-listen'] === 'always');
      return sendTurn(result, req, reply);
    }
    const pod = mirrorsPod(req);
    const always = req.headers['x-listen'] === 'always';
    // Hands-free pod: room noise also posts here, so "thinking" waits for the wake word (204 → idle).
    if (pod && !always) podMirror.set('thinking');

    // X-Listen: always = the pod records on its own, so only speech that says "Ghosty" gets an answer (204 otherwise).
    const turn: Promise<VoiceResult | undefined> =
      always
        ? pipeline.handleListening(wav, pod ? () => podMirror.set('thinking') : undefined).then((heard) => {
            if (!heard.result) req.log.info({ transcript: heard.transcript }, 'no wake word, ignored');
            return heard.result;
          })
        : pipeline.handleVoice(wav);
    return relayTurn(turn, req, reply, pod);
  });

  // The Dabao's reply to a 202 sign request (the frame, byte for byte). Resumes the voice turn that asked for it.
  app.post('/sign', { preHandler: [requireDevice] }, async (req, reply) => {
    const id = req.headers['x-sign-id'];
    const turn = typeof id === 'string' ? openTurns.get(id) : undefined;
    if (!turn || typeof id !== 'string') return reply.code(404).send({ error: 'unknown_sign_id' });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return reply.code(400).send({ error: 'expected_signer_frame' });
    openTurns.delete(id);
    if (!signerHub.deliver(id, req.body)) req.log.warn({ signId: id }, 'sign reply after the request expired');
    return relayTurn(turn.result, req, reply, turn.pod);
  });

  /**
   * Answer the pod for a running voice turn: 202 + a Dabao frame when the turn needs a signature (the pod relays it and
   * POSTs the reply to /sign), else the turn's audio (200) or 204 when it was not for us.
   */
  async function relayTurn(turn: Promise<VoiceResult | undefined>, req: FastifyRequest, reply: FastifyReply, pod = false) {
    turn.catch(() => undefined);  // awaited below or by /sign; never an unhandled rejection meanwhile
    const next = signerHub.nextRequest();
    let outcome;
    try {
      outcome = await Promise.race([
        turn.then((result) => ({ kind: 'done' as const, result })),
        next.promise.then((request) => ({ kind: 'sign' as const, request })),
      ]).finally(next.cancel);
    } catch (err) {
      if (pod) podMirror.set('idle');
      throw err;
    }
    if (outcome.kind === 'sign') {
      // The pod relays the frame to its Dabao and stays "thinking" until /sign resumes the turn.
      const { id, frame } = outcome.request;
      openTurns.set(id, { result: turn, pod });
      setTimeout(() => openTurns.delete(id), 2 * SIGN_TIMEOUT_MS).unref();
      req.log.info({ signId: id }, 'order needs the Dabao: sign request sent to the pod');
      return reply.code(202).header('content-type', 'application/octet-stream').header('x-sign-id', id).send(frame);
    }
    const result = outcome.result;
    if (pod) {
      if (result && result.audio.length > 0) podMirror.speaking(result.audio);
      else podMirror.set('idle');
    }
    return sendTurn(result, req, reply);
  }

  /** 200 + the turn's PCM, or 204 when the turn was not for us (no wake word). */
  function sendTurn(result: VoiceResult | undefined, req: FastifyRequest, reply: FastifyReply) {
    if (!result) return reply.code(204).send();
    req.log.info(
      {
        answeredBy: result.answeredBy,
        intent: result.intent,
        requestId: result.requestId,
        signal: result.decision?.signal,
        orders: result.orders?.map((o) => ({ coin: o.coin, status: o.status, orderId: o.orderId, error: o.error })),
        confidence: result.decision?.confidence,
        assistantError: result.assistantError,
      },
      scopeOf(req).kind === 'guest' ? 'guest voice turn' : 'voice turn',
    );
    return reply
      .header('content-type', 'application/octet-stream')
      .header('x-sample-rate', String(OUTPUT_SAMPLE_RATE))
      .header('x-request-id', result.requestId)
      .header('x-signal', result.decision?.signal ?? 'none')
      .header('x-answered-by', result.answeredBy)
      .send(result.audio);
  }

  app.post('/button', { preHandler: [requireDevice, requireBrain] }, async (req, reply) => {
    const parsed = ButtonBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', message: 'body must be {"action":"confirm"|"cancel"}' });
    }
    // A pending SIM decision always takes the press, and only ever fills on the PaperVenue.
    if (sim.hasPending()) return sim.press(parsed.data.action);
    // Live mode without Hyperliquid keys: refuse before the pending decision is consumed.
    const venue = notConfiguredInfo(deps.venue);
    if (parsed.data.action === 'confirm' && venue) return reply.code(503).send(new ProviderNotConfiguredError(venue).body());
    // Only a decision the wearer has heard can trade: nothing pending (or an expired alert) throws
    // NothingPendingError → 409, without a new 0G decision and without touching any venue.
    return pipeline.handleButton(parsed.data.action);
  });

  // Virtual pod web UI: a single static page, no build step. `serve: false` exposes only /sim.
  app.register(fastifyStatic, { root: PUBLIC_DIR, serve: false });
  app.get('/sim', (_req, reply) => reply.sendFile('sim.html'));

  // The trading terminal (Vite build) at `/`, when terminal/dist/index.html (or TERMINAL_DIST) exists.
  // API routes are registered as exact paths, so they win over the static wildcard. Unknown GETs that accept
  // text/html get index.html (SPA client-side routing); everything else keeps the JSON 404.
  const terminalDir = terminalDistDir(config);
  if (terminalDir) {
    app.register(fastifyStatic, { root: terminalDir, prefix: '/', decorateReply: false, wildcard: true, index: ['index.html'] });
    app.setNotFoundHandler((req, reply) => {
      const accept = String(req.headers.accept ?? '');
      if (req.method === 'GET' && accept.includes('text/html')) return reply.sendFile('index.html', terminalDir);
      return reply.code(404).send({ error: 'not_found', message: `Route ${req.method}:${req.url} not found` });
    });
  }

  app.get('/providers/status', async () => providerRegistry.status());
  registerMarketRoutes(app, market);

  registerSimRoutes(app, {
    state,
    pipeline,
    injected,
    brain,
    safeStopEngaged: async () => !(await brainOnline()),
    requireDevice,
    requireBrain,
    requireTalk,
    // Guest text turns are question-only; owner turns run the full pipeline.
    textTurn: (req, text) =>
      scopeOf(req).kind === 'guest' ? pipeline.handleGuestText(text, guestAssistant) : pipeline.handleText(text),
    voiceRouting: assistant !== undefined,
  });

  registerSimRunRoutes(app, {
    engine: sim,
    simLog,
    liveEpisodes: providers.agent.episodes,
    store: simStore,
    storagescan: zeroGExplorers(config).storagescan,
    requireDevice,
    requireRun: requireSimRun,
  });

  // The paid resource lives on the Signal Desk (its own process, `npm run signal-desk`), not on this server.
  registerIntegrationRoutes(app, {
    config,
    state,
    agent: providers.agent,
    payments,
    executor: providers.executor,
    brainOnline,
    requireDevice,
  });

  return app;
}
