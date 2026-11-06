import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import { z } from 'zod';
import { BrainOfflineError, createAgent, MemoryUnavailableError, type Agent } from './agent/index.js';
import type { Decision } from './agent/decide.js';
import { createStt } from './audio/stt.js';
import { createTts, OUTPUT_SAMPLE_RATE } from './audio/tts.js';
import { parseWav, WavFormatError } from './audio/wav.js';
import { loadConfig, type Config } from './config.js';
import { createCredibilityScorer, type CredibilityScorer } from './credibility/ethos.js';
import { createExecutor, type Executor } from './execution/executor.js';
import { registerIntegrationRoutes } from './integrations.js';
import type { NewsAggregator } from './news/aggregator.js';
import { createNewsAggregator, createNewsProviders } from './news/factory.js';
import { shockDetector, type ShockResult } from './news/shock.js';
import type { NewsItem } from './news/types.js';
import { createPayments, decisionToSignal, registerPaidRoutes, type PaidRoutesOptions, type Payments, type SignalPayload } from './payments/index.js';
import { Pipeline, type PipelineDeps } from './pipeline.js';
import { BrainSwitch, isBrainOnline } from './safety/safeStop.js';
import { InjectedNewsProvider } from './sim/injected.js';
import { registerSimRoutes } from './sim/routes.js';
import { PodState, type Alert } from './sim/state.js';
import { VERSION } from './version.js';

/** server/public, from both src/ (tsx) and dist/ (built). Holds the virtual pod page. */
const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

/** 30 s of 16 kHz 16-bit mono is ~960 KB; leave headroom. */
const AUDIO_BODY_LIMIT = 4 * 1024 * 1024;

const ButtonBody = z.object({ action: z.enum(['confirm', 'cancel']) });

export interface BuildAppOptions {
  config?: Config;
  deps?: Partial<PipelineDeps>;
  /** Scores news sources (pod state, decider, aggregator). Default: createCredibilityScorer(config). */
  scorer?: CredibilityScorer;
  /** Decider + memory + episode log. Default: createAgent(config), 0G when OG_* keys are set. */
  agent?: Agent;
  /** Hyperliquid venue + Uniswap spot leg. Default: createExecutor(config). */
  executor?: Executor;
  /** x402 payer + HCS audit log. Default: createPayments(config). */
  payments?: Payments;
  /** Paywall overrides, e.g. an in-process facilitator in tests. */
  x402?: Pick<PaidRoutesOptions, 'facilitator' | 'onSettled'>;
  logger?: FastifyServerOptions['logger'];
}

/** What the news poller did with one batch of fresh headlines. */
export interface FreshNewsOutcome {
  shock: ShockResult;
  decision: Decision | null;
  alert: Alert | null;
  /** Why no decision was made for a shock candidate. */
  skipped?: 'no_shock' | 'brain_offline' | 'memory_unavailable';
}

/** Handles index.ts needs (poller, shutdown) without reaching into buildApp's closures. */
export interface GhostyRuntime {
  config: Config;
  pipeline: Pipeline;
  state: PodState;
  agent: Agent;
  payments: Payments;
  executor: Executor;
  /** Present only with NEWS_LIVE=true; index.ts polls it with NewsPoller. */
  aggregator?: NewsAggregator;
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
}

/**
 * Every provider from its factory: the real one when its keys are set, the fake otherwise.
 * An empty .env gives the same deterministic fakes as day one.
 */
export function createProviders(
  config: Config,
  opts: Pick<BuildAppOptions, 'scorer' | 'agent' | 'executor'> & { logger?: FastifyInstance['log'] } = {},
): Providers {
  const scorer = opts.scorer ?? createCredibilityScorer(config);
  const agent = opts.agent ?? createAgent(config, { logger: opts.logger, scorer });
  const executor = opts.executor ?? createExecutor(config);
  // Aggregate only live news: the fake headlines carry fixed timestamps and would fall out of the rolling window.
  const aggregator = config.NEWS_LIVE ? createNewsAggregator(config, { scorer }) : undefined;
  return {
    scorer,
    agent,
    executor,
    aggregator,
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

/** Pipeline deps from the factories (fakes when keys are absent). */
export function defaultDeps(config: Config): PipelineDeps {
  return createProviders(config).deps;
}

const NO_SIGNAL: SignalPayload = { signal: 'none', confidence: 0, actions: [], requestId: 'no-decision-yet' };

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
  const payments = opts.payments ?? createPayments(config);
  // Virtual pod state: the pipeline reports every step into it; /state and /events read it.
  const state = new PodState(providers.scorer, {
    safeStop: config.SAFE_STOP_ENABLED && config.SIMULATE_BRAIN_OFFLINE,
  });
  // Headlines posted to /news/inject join whatever news providers are configured.
  const injected = new InjectedNewsProvider();
  const deps = { ...providers.deps, ...opts.deps };
  const pipeline = new Pipeline({ ...deps, news: [...deps.news, injected], observer: state });

  // 0G failures never become a fake decision: map them to 503 so the pod says "brain offline".
  app.setErrorHandler(async (err, req, reply) => {
    if (err instanceof BrainOfflineError) {
      req.log.warn({ reason: err.reason, status: err.status, requestId: err.requestId }, '0G brain offline, trade blocked');
      return reply.code(503).send({ error: 'brain_offline', reason: err.reason, requestId: err.requestId ?? null });
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
      return { shock, decision, alert };
    } catch (err) {
      if (err instanceof BrainOfflineError) return { shock, decision: null, alert: null, skipped: 'brain_offline' };
      if (err instanceof MemoryUnavailableError) return { shock, decision: null, alert: null, skipped: 'memory_unavailable' };
      throw err;
    }
  };

  app.decorate('ghosty', {
    config,
    pipeline,
    state,
    agent: providers.agent,
    payments,
    executor: providers.executor,
    aggregator: providers.aggregator,
    onFreshNews,
  } satisfies GhostyRuntime);

  app.addHook('onReady', async () => {
    pipeline.refreshNews().catch((err: unknown) => app.log.warn({ err }, 'initial news fetch failed'));
  });

  // The device posts WAV; accept the common audio types plus octet-stream as a raw Buffer.
  app.addContentTypeParser(
    ['audio/wav', 'audio/x-wav', 'audio/wave', 'application/octet-stream'],
    { parseAs: 'buffer', bodyLimit: AUDIO_BODY_LIMIT },
    (_req, body, done) => done(null, body),
  );

  const requireDevice = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!config.DEVICE_TOKEN) return; // local dev: no token configured
    const got = req.headers['x-device-token'];
    if (typeof got !== 'string' || !tokenMatches(got, config.DEVICE_TOKEN)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  };

  const requireBrain = async (_req: FastifyRequest, reply: FastifyReply) => {
    if (!(await brainOnline())) {
      return reply.code(503).send({ error: 'brain_offline' });
    }
  };

  app.get('/health', async () => ({
    ok: true,
    version: VERSION,
    // true = safe-stop engaged: 0G unreachable, trading blocked.
    safeStop: !(await brainOnline()),
  }));

  app.post('/voice', { preHandler: [requireDevice, requireBrain] }, async (req, reply) => {
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

    const result = await pipeline.handleVoice(wav);
    req.log.info(
      { requestId: result.decision.requestId, signal: result.decision.signal, confidence: result.decision.confidence },
      'voice decision',
    );
    return reply
      .header('content-type', 'application/octet-stream')
      .header('x-sample-rate', String(OUTPUT_SAMPLE_RATE))
      .header('x-request-id', result.decision.requestId)
      .header('x-signal', result.decision.signal)
      .send(result.audio);
  });

  app.post('/button', { preHandler: [requireDevice, requireBrain] }, async (req, reply) => {
    const parsed = ButtonBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', message: 'body must be {"action":"confirm"|"cancel"}' });
    }
    return pipeline.handleButton(parsed.data.action);
  });

  // Virtual pod web UI: a single static page, no build step. `serve: false` exposes only /sim.
  app.register(fastifyStatic, { root: PUBLIC_DIR, serve: false });
  app.get('/sim', (_req, reply) => reply.sendFile('sim.html'));

  registerSimRoutes(app, {
    state,
    pipeline,
    injected,
    brain,
    safeStopEngaged: async () => !(await brainOnline()),
    requireDevice,
    requireBrain,
  });

  // Paid GET /signal (x402 on Hedera): serves the latest decision from the pod state.
  registerPaidRoutes(app, {
    config,
    getSignal: () => {
      const latest = state.latestDecision();
      return latest ? decisionToSignal(latest) : NO_SIGNAL;
    },
    ...opts.x402,
  });

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
