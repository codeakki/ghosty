import { classifyText, isActionable, type Decision } from '../agent/decide.js';
import type { EpisodeRecord } from '../agent/episode.js';
import { credibilityWeight, type CredibilityLevel, type CredibilityScorer } from '../credibility/ethos.js';
import type { SpotOutcome } from '../execution/executor.js';
import type { OrderResult } from '../execution/hyperliquid.js';
import type { PlannedAction, Signal } from '../execution/playbook.js';
import type { NewsItem } from '../news/types.js';
import type { ButtonResult, DecisionContext, DecisionTrigger, PipelineObserver, VoiceTurn } from '../pipeline.js';

/**
 * In-memory picture of what the pod knows: the virtual pod's single source of truth.
 * The pipeline writes into it through PipelineObserver; `GET /state` and `GET /events` read it.
 * Nothing here is persisted; a restart clears it.
 */

export interface SourceCredibility {
  handle: string;
  score: number | null;
  level: CredibilityLevel;
  weight: number;
}

export interface NewsEntry extends Omit<NewsItem, 'credibility'> {
  /** 0.2..1.0 weight from credibility/weightItems (NewsItem.credibility), when the aggregator attached one. */
  weight?: number;
  /** Credibility of `handle`, or null when the item has no handle. */
  credibility: SourceCredibility | null;
  /** Keyword pre-classification of the title alone. */
  signal: Signal;
}

export interface DecisionEntry {
  requestId: string;
  signal: Signal;
  confidence: number;
  rationale: string;
  trigger: DecisionTrigger;
  transcript: string;
  headline?: string;
  at: string;
}

export interface OrderEntry extends OrderResult {
  requestId: string;
  at: string;
}

export interface SwapEntry extends SpotOutcome {
  requestId: string;
  at: string;
}

export type AlertStatus = 'pending' | 'delivered' | 'acked';

export interface Alert {
  id: string;
  /** What the pod should say. */
  text: string;
  signal: Signal;
  actions: PlannedAction[];
  requestId: string;
  confidence: number;
  headline?: string;
  status: AlertStatus;
  createdAt: string;
  deliveredAt?: string;
  ackedAt?: string;
}

export interface PodSnapshot {
  /** Newest first. */
  news: NewsEntry[];
  /** Latest credibility per source handle. */
  credibility: Record<string, SourceCredibility>;
  lastDecision: DecisionEntry | null;
  /** Actions waiting for a button press (empty once confirmed or cancelled). */
  plannedActions: PlannedAction[];
  /** Newest first. */
  orders: OrderEntry[];
  /** Uniswap spot legs, newest first. */
  swaps: SwapEntry[];
  /** Newest first. */
  episodes: EpisodeRecord[];
  /** true = safe-stop engaged, trading blocked. */
  safeStop: boolean;
  /** Newest first. */
  alerts: Alert[];
}

/**
 * `providers` and `market` come from index.ts (provider poller, market stream), never from the pipeline.
 * `voice` is one conversation turn {transcript, reply, answeredBy, requestId?}; it is not part of the snapshot.
 */
export type PodEventType = 'state' | 'news' | 'decision' | 'alert' | 'order' | 'episode' | 'providers' | 'market' | 'sim' | 'voice';

export interface PodEvent {
  id: number;
  type: PodEventType;
  data: unknown;
}

export type PodListener = (event: PodEvent) => void;

const LIMITS = { news: 50, orders: 100, swaps: 50, episodes: 100, alerts: 50 } as const;

export class PodState implements PipelineObserver {
  private news: NewsEntry[] = [];
  private credibility: Record<string, SourceCredibility> = {};
  private lastDecision: DecisionEntry | null = null;
  private plannedActions: PlannedAction[] = [];
  private orders: OrderEntry[] = [];
  private swaps: SwapEntry[] = [];
  private latest: Decision | null = null;
  private episodes: EpisodeRecord[] = [];
  private safeStop: boolean;
  private alerts: Alert[] = [];

  private readonly listeners = new Set<PodListener>();
  private eventSeq = 0;
  private alertSeq = 0;
  private stateQueued = false;

  constructor(
    private readonly scorer?: CredibilityScorer,
    opts: { safeStop?: boolean } = {},
  ) {
    this.safeStop = opts.safeStop ?? false;
  }

  snapshot(): PodSnapshot {
    return structuredClone({
      news: this.news,
      credibility: this.credibility,
      lastDecision: this.lastDecision,
      plannedActions: this.plannedActions,
      orders: this.orders,
      swaps: this.swaps,
      episodes: this.episodes,
      safeStop: this.safeStop,
      alerts: this.alerts,
    });
  }

  /** The full latest decision (with its planned legs), e.g. for the paid `/signal`. null before the first one. */
  latestDecision(): Decision | null {
    return this.latest ? structuredClone(this.latest) : null;
  }

  /** Returns an unsubscribe function. */
  subscribe(listener: PodListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // --- PipelineObserver ----------------------------------------------------

  async onNews(items: NewsItem[]): Promise<void> {
    const entries = await Promise.all(items.map((item) => this.annotate(item)));
    const known = new Set(this.news.map((n) => n.id));
    const fresh = entries.filter((e) => !known.has(e.id));
    const byId = new Map(entries.map((e) => [e.id, e]));
    this.news = [...fresh, ...this.news.map((n) => byId.get(n.id) ?? n)]
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
      .slice(0, LIMITS.news);
    for (const entry of fresh) this.emit('news', entry, false);
    if (fresh.length > 0) this.queueState();
  }

  onDecision(decision: Decision, ctx: DecisionContext): void {
    this.latest = decision;
    this.lastDecision = {
      requestId: decision.requestId,
      signal: decision.signal,
      confidence: decision.confidence,
      rationale: decision.rationale,
      trigger: ctx.trigger,
      transcript: ctx.transcript,
      ...(ctx.headline ? { headline: ctx.headline.title } : {}),
      at: new Date().toISOString(),
    };
    this.plannedActions = decision.suggestedActions;
    this.emit('decision', { ...this.lastDecision, actions: decision.suggestedActions });
  }

  onButton(result: ButtonResult): void {
    this.plannedActions = [];
    const at = new Date().toISOString();
    for (const swap of result.swaps) {
      this.swaps = [{ ...swap, requestId: result.requestId, at }, ...this.swaps].slice(0, LIMITS.swaps);
    }
    for (const order of result.orders) {
      const entry: OrderEntry = { ...order, requestId: result.requestId, at };
      this.orders = [entry, ...this.orders].slice(0, LIMITS.orders);
      this.emit('order', entry, false);
    }
    this.queueState();
  }

  onEpisode(record: EpisodeRecord): void {
    this.episodes = [record, ...this.episodes].slice(0, LIMITS.episodes);
    this.emit('episode', record);
  }

  /** A voice/text turn (Claude answer, 0G decision or confirm hint): SSE `voice` for the Live feed. */
  onVoice(turn: VoiceTurn): void {
    this.emit('voice', turn, false);
  }

  // --- Alerts -------------------------------------------------------------

  /** Queue a spoken alert for an actionable decision. Returns null when there is nothing to confirm (signal `none` or no legs). */
  enqueueAlert(decision: Decision, headline?: NewsItem): Alert | null {
    if (!isActionable(decision)) return null;
    const alert: Alert = {
      id: `alert-${++this.alertSeq}`,
      text: decision.rationale,
      signal: decision.signal,
      actions: decision.suggestedActions,
      requestId: decision.requestId,
      confidence: decision.confidence,
      ...(headline ? { headline: headline.title } : {}),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.alerts = [alert, ...this.alerts].slice(0, LIMITS.alerts);
    this.emit('alert', alert);
    return structuredClone(alert);
  }

  /** Oldest pending alert, marked delivered. undefined when the queue is empty. */
  nextAlert(): Alert | undefined {
    // alerts are newest first, so the oldest pending one is the last match.
    const next = this.alerts.filter((a) => a.status === 'pending').at(-1);
    if (!next) return undefined;
    next.status = 'delivered';
    next.deliveredAt = new Date().toISOString();
    this.queueState();
    return structuredClone(next);
  }

  ackAlert(id: string): Alert | undefined {
    const alert = this.alerts.find((a) => a.id === id);
    if (!alert) return undefined;
    alert.status = 'acked';
    alert.ackedAt = new Date().toISOString();
    this.queueState();
    return structuredClone(alert);
  }

  /** Broadcast an event that is not part of the pod snapshot (provider health, market mids). */
  publish(type: 'providers' | 'market', data: unknown): void {
    this.emit(type, data, false);
  }

  /**
   * Broadcast a simulation-run event (data tagged `sim: true, runId` by the engine). Never touches the pod
   * snapshot: sim news, decisions, alerts and orders stay out of /state, /signal and the live ticker.
   */
  publishSim(type: 'sim' | 'market' | 'news' | 'decision' | 'alert' | 'order' | 'episode', data: object): void {
    this.emit(type, data, false);
  }

  // --- Safe-stop ----------------------------------------------------------

  setSafeStop(safeStop: boolean): void {
    if (this.safeStop === safeStop) return;
    this.safeStop = safeStop;
    this.queueState();
  }

  // --- internals ----------------------------------------------------------

  private async annotate(item: NewsItem): Promise<NewsEntry> {
    let credibility: SourceCredibility | null = null;
    if (item.handle && this.scorer) {
      try {
        const s = await this.scorer.scoreHandle(item.handle);
        credibility = { handle: s.handle, score: s.score, level: s.level, weight: credibilityWeight(s.level) };
        this.credibility[s.handle] = credibility;
      } catch {
        // Scorer down or not configured (live mode, ETHOS_ENABLED=false): credibility unknown, never invented.
        credibility = null;
      }
    }
    const { credibility: weight, ...rest } = item;
    return { ...rest, ...(weight === undefined ? {} : { weight }), credibility, signal: classifyText(item.title) };
  }

  /** Emit a typed event; by default also schedule a coalesced `state` snapshot. */
  private emit(type: PodEventType, data: unknown, withState = true): void {
    const event: PodEvent = { id: ++this.eventSeq, type, data: structuredClone(data) };
    for (const listener of this.listeners) listener(event);
    if (withState) this.queueState();
  }

  /** Several mutations in one tick produce one `state` event. */
  private queueState(): void {
    if (this.stateQueued) return;
    this.stateQueued = true;
    queueMicrotask(() => {
      this.stateQueued = false;
      const event: PodEvent = { id: ++this.eventSeq, type: 'state', data: this.snapshot() };
      for (const listener of this.listeners) listener(event);
    });
  }
}
