import { randomUUID } from 'node:crypto';
import { BrainOfflineError, classifyText, isActionable, spokenRationale, type Decider, type Decision } from '../agent/decide.js';
import type { EpisodeOutcome } from '../agent/episode.js';
import { errorMessage, noopLogger, type Logger } from '../agent/log.js';
import { defaultMemory, type MemoryStore, type UserMemory } from '../agent/memory.js';
import type { OrderResult } from '../execution/hyperliquid.js';
import type { PlannedAction, Signal } from '../execution/playbook.js';
import { notConfiguredInfo } from '../mode.js';
import { shockDetector } from '../news/shock.js';
import type { NewsItem } from '../news/types.js';
import { intervalMs, priceAt, type CandleLoader, type CandleSet } from './candles.js';
import type { SimEpisodeEntry, SimEpisodeLog } from './episodes.js';
import type { SimLiveExecution, SimLiveOrder } from './liveOrders.js';
import { holdBaselinePnl, PaperVenue, type PaperFill } from './paperVenue.js';
import type { Scenario } from './scenarios.js';

/**
 * Simulation engine: replays a scenario (real past headlines, real historical prices) on a compressed clock.
 * Every headline goes through the shock pre-filter and, when it is a candidate, a REAL decider call (0G Compute
 * in live mode). Confirmed trades always fill on a PaperVenue. A run started with `liveOrders: true` (and the server's
 * SIM_LIVE_ORDERS switch on) also sends each confirmed leg to Hyperliquid mainnet at a small fixed size.
 * Every event a run emits carries `sim: true, runId`.
 */

export const DEFAULT_SPEED = 360;
export const TICK_MS = 250;
const STATUS_THROTTLE_MS = 500;
const MARKET_THROTTLE_MS = 1_000;
const MAX_CONTEXT_NEWS = 10;

export type SimStatus = 'idle' | 'running' | 'paused' | 'done';
export type SimEventType = 'sim' | 'market' | 'news' | 'decision' | 'alert' | 'order' | 'episode';

/** Market ms covered by `realMs` of wall-clock at `speed` (market seconds per real second). */
export function simAdvanceMs(realMs: number, speed: number): number {
  return Math.max(0, realMs) * speed;
}

/** Real ms needed to play `marketMs` at `speed`. */
export function realDurationMs(marketMs: number, speed: number): number {
  return marketMs / speed;
}

export interface SimDecisionEntry {
  sim: true;
  runId: string;
  simTime: string;
  headline: string;
  requestId: string | null;
  signal: Signal | null;
  confidence: number | null;
  rationale: string | null;
  actions: PlannedAction[];
  /** Why no decision was made: not a shock candidate, or safe-stop. */
  skipped?: 'no_shock' | 'brain_offline' | 'error';
  error?: string;
  zeroG?: Decision['zeroG'];
}

export interface SimRunStatus {
  sim: true;
  runId: string | null;
  scenarioId: string | null;
  status: SimStatus;
  pauseReason: 'user' | 'awaiting_press' | null;
  simTime: string | null;
  start: string | null;
  end: string | null;
  progress: number;
  speed: number;
  autoPauseOnAlert: boolean;
  /** Capital base for the percentages (MAX_TRADE_USD): the most one decision may deploy, and the hold notional. */
  notionalUsd: number;
  pnlUsd: number;
  /** pnlUsd / notionalUsd × 100. */
  pnlPct: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  baselinePnlUsd: number;
  /** baselinePnlUsd / notionalUsd × 100. */
  baselinePct: number;
  baseline: string;
  positions: ReturnType<PaperVenue['snapshot']>['positions'];
  fills: PaperFill[];
  mids: Record<string, number>;
  /** Number of headlines that went through the decision loop (incl. skipped). Details in decisionList. */
  decisions: number;
  decisionList: SimDecisionEntry[];
  /** Number of episodes written for this run. Details in episodeList. */
  episodes: number;
  episodeList: Array<Omit<SimEpisodeEntry, 'body'>>;
  /** Root of this run's newest episode (start GET /episodes/replay here), or null. */
  lastRootHash: string | null;
  pending: { requestId: string; signal: Signal; actions: PlannedAction[]; headline: string } | null;
  headlines: { total: number; delivered: number };
  /** Paper always; plus real Hyperliquid mainnet orders when the run opted in. */
  execution: SimExecutionStatus;
  memory: string | null;
  storage: 'local' | '0g';
  error: string | null;
}

export interface SimExecutionStatus {
  /** This run sends confirmed legs to Hyperliquid mainnet too. */
  liveOrders: boolean;
  /** The server allows real orders (SIM_LIVE_ORDERS on and mainnet keys set). */
  available: boolean;
  /** Why real orders are unavailable, or null. */
  unavailable: string | null;
  network: 'mainnet';
  orderUsd: number;
  maxRunUsd: number;
  spentUsd: number;
  orders: SimLiveOrder[];
}

export interface SimButtonResult {
  sim: true;
  runId: string;
  paper: true;
  /** Real Hyperliquid mainnet orders placed by this press (empty for a paper-only run). */
  liveOrders: SimLiveOrder[];
  action: 'confirm' | 'cancel';
  requestId: string;
  signal: Signal;
  executed: boolean;
  actions: PlannedAction[];
  orders: OrderResult[];
  swaps: [];
}

export interface SimEngineDeps {
  decider: Decider;
  memory: MemoryStore;
  episodes: SimEpisodeLog;
  loadCandles: CandleLoader;
  scenarios: () => Scenario[];
  /** Same safe-stop check as live (0G reachable and not simulated offline). */
  brainOnline: () => Promise<boolean>;
  /** Broadcast on the shared SSE stream; data already carries sim + runId. */
  publish: (type: SimEventType, data: object) => void;
  maxTradeUsd: number;
  /** Real orders on Hyperliquid mainnet. Omitted = never available. */
  live?: SimLiveExecution;
  slippageBps?: number;
  logger?: Logger;
  /** false = no interval timer; tests drive the clock with step(). Default true. */
  autoTick?: boolean;
  userId?: string;
}

export class SimRunError extends Error {
  constructor(
    message: string,
    readonly code: 'unknown_scenario' | 'no_run' | 'no_pending' | 'candles_failed' | 'live_unavailable',
  ) {
    super(message);
  }
}

interface Pending {
  decision: Decision;
  item: NewsItem;
  alertId: string;
}

class SimRun {
  readonly runId = `sim-${randomUUID().slice(0, 8)}`;
  status: Exclude<SimStatus, 'idle'> = 'running';
  pauseReason: 'user' | 'awaiting_press' | null = null;
  simTime: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly venue: PaperVenue;
  readonly startPx: Record<string, number> = {};
  readonly decisions: SimDecisionEntry[] = [];
  readonly episodes: SimEpisodeEntry[] = [];
  readonly seen: NewsItem[] = [];
  nextHeadline = 0;
  busy = false;
  pending: Pending | null = null;
  memory: UserMemory | null = null;
  memoryLabel: string | null = null;
  error: string | null = null;
  alertSeq = 0;
  lastMarketEmit = 0;
  liveSpentUsd = 0;
  readonly liveFills: SimLiveOrder[] = [];
  readonly inflight = new Set<Promise<unknown>>();

  constructor(
    readonly scenario: Scenario,
    readonly candles: CandleSet,
    readonly speed: number,
    readonly autoPauseOnAlert: boolean,
    slippageBps: number | undefined,
    readonly liveOrders: boolean,
  ) {
    this.startMs = Date.parse(scenario.start);
    this.endMs = Date.parse(scenario.end);
    this.simTime = this.startMs;
    this.venue = new PaperVenue({ price: (c) => this.price(c), now: () => this.simTime, slippageBps });
    for (const m of scenario.markets) {
      const p = this.price(m.coin);
      if (p !== null) this.startPx[m.coin] = p;
    }
  }

  price(coin: string): number | null {
    const series = this.candles[coin];
    return series ? priceAt(series, this.simTime, intervalMs(this.scenario.interval)) : null;
  }

  mids(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const m of this.scenario.markets) {
      const p = this.price(m.coin);
      if (p !== null) out[m.coin] = Math.round(p * 10_000) / 10_000;
    }
    return out;
  }

  tag<T extends object>(data: T): T & { sim: true; runId: string; scenarioId: string } {
    return { ...data, sim: true, runId: this.runId, scenarioId: this.scenario.id };
  }
}

export class SimEngine {
  private run: SimRun | null = null;
  private timer: NodeJS.Timeout | undefined;
  private lastTick = 0;
  private lastStatusEmit = 0;
  private statusTimer: NodeJS.Timeout | undefined;
  private readonly logger: Logger;
  private readonly userId: string;

  constructor(private readonly deps: SimEngineDeps) {
    this.logger = deps.logger ?? noopLogger;
    this.userId = deps.userId ?? 'device-0';
  }

  scenarios(): Scenario[] {
    return this.deps.scenarios();
  }

  /** True while a sim decision waits for a button press: POST /button then goes to the PaperVenue. */
  hasPending(): boolean {
    return this.run?.pending != null && this.run.status !== 'done';
  }

  async start(opts: { scenarioId: string; speed?: number; autoPauseOnAlert?: boolean; liveOrders?: boolean }): Promise<{ runId: string; liveOrders: boolean }> {
    const scenario = this.deps.scenarios().find((s) => s.id === opts.scenarioId);
    if (!scenario) throw new SimRunError(`unknown scenario "${opts.scenarioId}"`, 'unknown_scenario');
    const liveOrders = opts.liveOrders === true;
    if (liveOrders && !this.deps.live?.venue) {
      throw new SimRunError(this.deps.live?.unavailable ?? 'real orders are not available on this server', 'live_unavailable');
    }
    let candles: CandleSet;
    try {
      candles = await this.deps.loadCandles(scenario);
    } catch (err) {
      throw new SimRunError(`could not load historical prices: ${errorMessage(err)}`, 'candles_failed');
    }
    this.stopTimer();
    if (this.run && this.run.status !== 'done') this.run.status = 'done';
    const run = new SimRun(scenario, candles, opts.speed ?? DEFAULT_SPEED, opts.autoPauseOnAlert ?? true, this.deps.slippageBps, liveOrders);
    this.run = run;
    await this.loadMemory(run);
    this.logger.info({ runId: run.runId, scenario: scenario.id, speed: run.speed, memory: run.memoryLabel, liveOrders }, 'sim run started');
    this.emitMarket(run, true);
    this.emitStatus(true);
    if (this.deps.autoTick !== false) {
      this.lastTick = Date.now();
      this.timer = setInterval(() => {
        const now = Date.now();
        const elapsed = now - this.lastTick;
        this.lastTick = now;
        void this.step(elapsed);
      }, TICK_MS);
      this.timer.unref?.();
    }
    return { runId: run.runId, liveOrders };
  }

  control(action: 'pause' | 'resume' | 'stop'): SimRunStatus {
    const run = this.run;
    if (!run) throw new SimRunError('no simulation run', 'no_run');
    if (run.status !== 'done') {
      if (action === 'pause') {
        run.status = 'paused';
        run.pauseReason = 'user';
      } else if (action === 'resume') {
        run.status = 'running';
        run.pauseReason = null;
        this.lastTick = Date.now();
      } else {
        run.status = 'done';
        run.pauseReason = null;
        // Stopping drops the pending sim decision: a later press must not fill on a finished run.
        run.pending = null;
        this.stopTimer();
      }
    }
    this.emitStatus(true);
    return this.status();
  }

  /**
   * Advance the clock by `realMs` of wall time. The clock stops at each due headline, which is then run through
   * the decision loop (clock frozen while 0G thinks). Exported for tests; the interval timer calls it.
   */
  async step(realMs: number): Promise<void> {
    const run = this.run;
    if (!run || run.status !== 'running' || run.busy) return;
    const headline = run.scenario.headlines[run.nextHeadline];
    const target = Math.min(run.endMs, run.simTime + simAdvanceMs(realMs, run.speed));
    const headlineMs = headline ? Date.parse(headline.ts) : Infinity;
    run.simTime = Math.min(target, Math.max(run.simTime, headlineMs));
    this.emitMarket(run);

    if (headline && run.simTime >= headlineMs) {
      run.nextHeadline++;
      run.busy = true;
      try {
        await this.onHeadline(run, run.nextHeadline - 1);
      } catch (err) {
        run.error = errorMessage(err);
        this.logger.error({ err: run.error, runId: run.runId }, 'sim headline failed');
      } finally {
        run.busy = false;
      }
    } else if (run.simTime >= run.endMs && run.nextHeadline >= run.scenario.headlines.length) {
      run.status = 'done';
      run.pauseReason = null;
      this.stopTimer();
      this.logger.info({ runId: run.runId, ...run.venue.snapshot() }, 'sim run done');
    }
    this.emitStatus();
  }

  /** Play the run to the end as fast as possible (tests, CLI); stops at an auto-pause. */
  async runUntilIdle(maxSteps = 10_000): Promise<void> {
    for (let i = 0; i < maxSteps && this.run?.status === 'running'; i++) await this.step(60_000);
    await this.settle();
  }

  /** Wait for background episode writes. */
  async settle(): Promise<void> {
    const run = this.run;
    if (run) await Promise.allSettled([...run.inflight]);
    await this.deps.episodes.idle();
  }

  /**
   * Button press on the pending sim decision: confirm fills on the PaperVenue. Only a run started with
   * `liveOrders: true` also places real Hyperliquid mainnet orders (fixed small size, capped per run).
   */
  async press(action: 'confirm' | 'cancel'): Promise<SimButtonResult> {
    const run = this.run;
    const pending = run?.pending;
    if (!run || !pending) throw new SimRunError('no pending sim decision', 'no_pending');
    run.pending = null;
    const { decision } = pending;
    const orders: OrderResult[] = [];
    if (action === 'confirm') {
      for (const a of decision.suggestedActions) {
        const order = await run.venue.placeMarketOrder({ coin: a.coin, isBuy: a.side === 'long', sizeUsd: a.sizeUsd });
        orders.push(order);
        this.deps.publish('order', run.tag({ ...order, requestId: decision.requestId, paper: true, simTime: new Date(run.simTime).toISOString() }));
      }
    }
    const liveOrders = action === 'confirm' && run.liveOrders ? await this.placeLive(run, decision) : [];
    this.logEpisode(run, decision, pending.item, action === 'confirm' ? 'executed' : 'cancelled', [...orders, ...liveOrders]);
    if (run.status === 'paused' && run.pauseReason === 'awaiting_press') {
      run.status = 'running';
      run.pauseReason = null;
      this.lastTick = Date.now();
    }
    this.emitStatus(true);
    return {
      sim: true,
      runId: run.runId,
      paper: true,
      liveOrders,
      action,
      requestId: decision.requestId,
      signal: decision.signal,
      executed: action === 'confirm' && orders.some((o) => o.status !== 'rejected'),
      actions: decision.suggestedActions,
      orders,
      swaps: [],
    };
  }

  status(): SimRunStatus {
    const run = this.run;
    if (!run) {
      return {
        sim: true,
        runId: null,
        scenarioId: null,
        status: 'idle',
        pauseReason: null,
        simTime: null,
        start: null,
        end: null,
        progress: 0,
        speed: DEFAULT_SPEED,
        autoPauseOnAlert: true,
        notionalUsd: this.deps.maxTradeUsd,
        pnlUsd: 0,
        pnlPct: 0,
        realizedPnlUsd: 0,
        unrealizedPnlUsd: 0,
        baselinePnlUsd: 0,
        baselinePct: 0,
        baseline: baselineLabel(this.deps.maxTradeUsd),
        positions: [],
        fills: [],
        mids: {},
        decisions: 0,
        decisionList: [],
        episodes: 0,
        episodeList: [],
        lastRootHash: null,
        pending: null,
        headlines: { total: 0, delivered: 0 },
        execution: this.execution(null),
        memory: null,
        storage: this.deps.episodes.storageMode,
        error: null,
      };
    }
    const book = run.venue.snapshot();
    const span = run.endMs - run.startMs;
    const notional = this.deps.maxTradeUsd;
    const baselinePnl = holdBaselinePnl(run.startPx, (c) => run.price(c), notional);
    const pct = (usd: number) => (notional > 0 ? Math.round((usd / notional) * 100 * 10_000) / 10_000 : 0);
    return {
      sim: true,
      runId: run.runId,
      scenarioId: run.scenario.id,
      status: run.status,
      pauseReason: run.pauseReason,
      simTime: new Date(run.simTime).toISOString(),
      start: run.scenario.start,
      end: run.scenario.end,
      progress: span > 0 ? Math.round(Math.min(1, (run.simTime - run.startMs) / span) * 1000) / 1000 : 1,
      speed: run.speed,
      autoPauseOnAlert: run.autoPauseOnAlert,
      notionalUsd: notional,
      pnlUsd: book.pnlUsd,
      pnlPct: pct(book.pnlUsd),
      realizedPnlUsd: book.realizedPnlUsd,
      unrealizedPnlUsd: book.unrealizedPnlUsd,
      baselinePnlUsd: baselinePnl,
      baselinePct: pct(baselinePnl),
      baseline: baselineLabel(notional),
      positions: book.positions,
      fills: [...run.venue.fills],
      mids: run.mids(),
      decisions: run.decisions.length,
      decisionList: structuredClone(run.decisions),
      episodes: run.episodes.length,
      episodeList: run.episodes.map(({ body: _body, ...rest }) => rest),
      lastRootHash: run.episodes.at(-1)?.rootHash ?? null,
      pending: run.pending
        ? {
            requestId: run.pending.decision.requestId,
            signal: run.pending.decision.signal,
            actions: run.pending.decision.suggestedActions,
            headline: run.pending.item.title,
          }
        : null,
      headlines: { total: run.scenario.headlines.length, delivered: run.nextHeadline },
      execution: this.execution(run),
      memory: run.memoryLabel,
      storage: this.deps.episodes.storageMode,
      error: run.error,
    };
  }

  stop(): void {
    this.stopTimer();
    if (this.statusTimer) clearTimeout(this.statusTimer);
    if (this.run && this.run.status !== 'done') this.run.status = 'done';
  }

  // --- internals ------------------------------------------------------------

  private execution(run: SimRun | null): SimExecutionStatus {
    const live = this.deps.live;
    return {
      liveOrders: run?.liveOrders ?? false,
      available: Boolean(live?.venue),
      unavailable: live ? live.unavailable : 'real orders are not available on this server',
      network: 'mainnet',
      orderUsd: live?.orderUsd ?? 0,
      maxRunUsd: live?.maxRunUsd ?? 0,
      spentUsd: Math.round((run?.liveSpentUsd ?? 0) * 100) / 100,
      orders: run ? structuredClone(run.liveFills) : [],
    };
  }

  /** Real Hyperliquid mainnet legs for a confirmed sim decision. Never throws: failures come back as rejected orders. */
  private async placeLive(run: SimRun, decision: Decision): Promise<SimLiveOrder[]> {
    const live = this.deps.live;
    if (!live?.venue) return [];
    const out: SimLiveOrder[] = [];
    for (const a of decision.suggestedActions) {
      const isBuy = a.side === 'long';
      const sizeUsd = live.orderUsd;
      let order: OrderResult;
      if (run.liveSpentUsd + sizeUsd > live.maxRunUsd + 1e-9) {
        order = { orderId: '', coin: a.coin, isBuy, sizeUsd, status: 'rejected', error: `run cap of $${live.maxRunUsd} in real orders reached (SIM_LIVE_MAX_RUN_USD)` };
      } else {
        try {
          order = await live.venue.placeMarketOrder({ coin: a.coin, isBuy, sizeUsd });
        } catch (err) {
          order = { orderId: '', coin: a.coin, isBuy, sizeUsd, status: 'rejected', error: errorMessage(err) };
        }
        if (order.status !== 'rejected') run.liveSpentUsd += sizeUsd;
      }
      const entry: SimLiveOrder = {
        ...order,
        live: true,
        network: 'mainnet',
        requestId: decision.requestId,
        simTime: new Date(run.simTime).toISOString(),
        placedAt: new Date().toISOString(),
      };
      run.liveFills.push(entry);
      out.push(entry);
      this.logger.warn({ runId: run.runId, coin: entry.coin, isBuy, sizeUsd, status: entry.status, orderId: entry.orderId, error: entry.error }, 'sim real order (Hyperliquid mainnet)');
      this.deps.publish('order', run.tag({ ...entry, paper: false }));
    }
    return out;
  }

  private async onHeadline(run: SimRun, index: number): Promise<void> {
    const h = run.scenario.headlines[index]!;
    const item: NewsItem = {
      id: `sim:${run.runId}:${index + 1}`,
      source: 'sim',
      title: h.title,
      url: h.url,
      publishedAt: new Date(Date.parse(h.ts)).toISOString(),
      ...(h.handle ? { handle: h.handle } : {}),
      // Never put the scenario id here: the shock pre-filter reads the summary ("bybit-hack-2025" would match "hack").
      summary: `Historical headline from ${h.source}`,
    };
    run.seen.unshift(item);
    this.deps.publish('news', run.tag({ ...item, outlet: h.source, simTime: item.publishedAt }));

    const entryBase = { sim: true as const, runId: run.runId, simTime: item.publishedAt, headline: h.title, actions: [] as PlannedAction[] };
    // Same pre-filter as the live poller (news/shock.ts), plus the decider's keyword classes (SEC, lawsuit...).
    const candidate = shockDetector([item]).candidate !== 'none' || classifyText(item.title) !== 'none';
    if (!candidate) {
      this.record(run, { ...entryBase, requestId: null, signal: null, confidence: null, rationale: null, skipped: 'no_shock' });
      return;
    }
    if (!(await this.deps.brainOnline())) {
      this.record(run, { ...entryBase, requestId: null, signal: null, confidence: null, rationale: null, skipped: 'brain_offline' });
      return;
    }

    let decision: Decision;
    try {
      decision = await this.deps.decider.decide({
        transcript: '',
        news: run.seen.slice(0, MAX_CONTEXT_NEWS),
        memory: run.memory ?? simWatchlist(defaultMemory(), run.scenario),
        maxTradeUsd: this.deps.maxTradeUsd,
      });
    } catch (err) {
      // Safe-stop applies in sim too: no fake decision.
      const skipped = err instanceof BrainOfflineError ? 'brain_offline' : 'error';
      this.record(run, {
        ...entryBase,
        requestId: err instanceof BrainOfflineError ? (err.requestId ?? null) : null,
        signal: null,
        confidence: null,
        rationale: null,
        skipped,
        error: errorMessage(err),
      });
      return;
    }
    // Same rule as live: a decision with nothing to confirm never says "Press to confirm".
    decision.rationale = spokenRationale(decision);

    this.record(run, {
      ...entryBase,
      requestId: decision.requestId,
      signal: decision.signal,
      confidence: decision.confidence,
      rationale: decision.rationale,
      actions: decision.suggestedActions,
      ...(decision.zeroG ? { zeroG: decision.zeroG } : {}),
    });
    this.logEpisode(run, decision, item, 'proposed', []);

    if (isActionable(decision)) {
      const alertId = `sim-alert-${++run.alertSeq}`;
      run.pending = { decision, item, alertId };
      this.deps.publish(
        'alert',
        run.tag({
          id: alertId,
          text: decision.rationale,
          signal: decision.signal,
          actions: decision.suggestedActions,
          requestId: decision.requestId,
          confidence: decision.confidence,
          headline: item.title,
          status: 'pending',
          createdAt: new Date().toISOString(),
          simTime: item.publishedAt,
        }),
      );
      if (run.autoPauseOnAlert && run.status === 'running') {
        run.status = 'paused';
        run.pauseReason = 'awaiting_press';
        this.emitStatus(true);
      }
    }
  }

  private record(run: SimRun, entry: SimDecisionEntry): void {
    run.decisions.push(entry);
    this.deps.publish('decision', run.tag({ ...entry, trigger: 'sim' }));
    this.logger.info({ runId: run.runId, requestId: entry.requestId, signal: entry.signal, skipped: entry.skipped }, 'sim decision');
  }

  /** Background write (0G upload can take a while); the clock does not wait for it. */
  private logEpisode(run: SimRun, decision: Decision, item: NewsItem, outcome: EpisodeOutcome, orders: OrderResult[]): void {
    const job = this.deps.episodes
      .append({
        runId: run.runId,
        scenarioId: run.scenario.id,
        simTime: new Date(run.simTime).toISOString(),
        requestId: decision.requestId,
        newsIds: decision.newsIds ?? [item.id],
        headline: item.title,
        decision: {
          signal: decision.signal,
          confidence: decision.confidence,
          rationale: decision.rationale,
          ...(decision.zeroG ? { zeroG: decision.zeroG } : {}),
        },
        actions: decision.suggestedActions,
        orders,
        outcome,
        memory: run.memoryLabel ?? 'unknown',
      })
      .then((entry) => {
        run.episodes.push(entry);
        run.episodes.sort((a, b) => a.seq - b.seq);
        const { body: _body, ...summary } = entry;
        this.deps.publish('episode', run.tag(summary));
        this.emitStatus();
      })
      .catch((err: unknown) => this.logger.error({ err: errorMessage(err) }, 'sim episode write failed'))
      .finally(() => run.inflight.delete(job));
    run.inflight.add(job);
  }

  /**
   * The sim never needs OG_PRIVATE_KEY: without 0G memory it decides from the default memory, labelled so.
   * The watchlist is narrowed to the scenario's markets (the only ones we can price). Sim never saves memory.
   */
  private async loadMemory(run: SimRun): Promise<void> {
    if (notConfiguredInfo(this.deps.memory)) {
      run.memory = simWatchlist(defaultMemory(), run.scenario);
      run.memoryLabel = 'default snapshot: 0G memory not configured (OG_PRIVATE_KEY unset); watchlist = scenario markets';
      return;
    }
    try {
      run.memory = simWatchlist(await this.deps.memory.load(this.userId), run.scenario);
      run.memoryLabel = 'user memory (read-only in sim); watchlist = scenario markets';
    } catch (err) {
      run.memory = simWatchlist(defaultMemory(), run.scenario);
      run.memoryLabel = `default snapshot: memory unavailable (${errorMessage(err)}); watchlist = scenario markets`;
    }
  }

  private emitMarket(run: SimRun, force = false): void {
    const now = Date.now();
    if (!force && now - run.lastMarketEmit < MARKET_THROTTLE_MS) return;
    run.lastMarketEmit = now;
    this.deps.publish('market', run.tag({ ts: new Date(run.simTime).toISOString(), mids: run.mids() }));
  }

  /** SSE `sim` with the GET /sim/run shape, at most 2/s. */
  private emitStatus(force = false): void {
    const now = Date.now();
    const wait = STATUS_THROTTLE_MS - (now - this.lastStatusEmit);
    if (force || wait <= 0) {
      if (this.statusTimer) clearTimeout(this.statusTimer);
      this.statusTimer = undefined;
      this.lastStatusEmit = now;
      this.deps.publish('sim', this.status());
      return;
    }
    if (this.statusTimer) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = undefined;
      this.emitStatus(true);
    }, wait);
    this.statusTimer.unref?.();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

function simWatchlist(memory: UserMemory, scenario: Scenario): UserMemory {
  return { ...memory, preferences: { ...memory.preferences, watchlist: scenario.markets.map((m) => m.coin) } };
}

function baselineLabel(maxTradeUsd: number): string {
  return `hold: $${maxTradeUsd} equal-weight long across the scenario markets from the run start`;
}
