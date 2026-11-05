import { classifyText, type Decision } from '../agent/decide.js';
import type { EpisodeRecord } from '../agent/episode.js';
import { credibilityWeight, type CredibilityLevel, type CredibilityScorer } from '../credibility/ethos.js';
import type { OrderResult } from '../execution/hyperliquid.js';
import type { PlannedAction, Signal } from '../execution/playbook.js';
import type { NewsItem } from '../news/types.js';
import type { ButtonResult, DecisionContext, DecisionTrigger, PipelineObserver } from '../pipeline.js';

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

export interface NewsEntry extends NewsItem {
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
  /** Newest first. */
  episodes: EpisodeRecord[];
  /** true = safe-stop engaged, trading blocked. */
  safeStop: boolean;
  /** Newest first. */
  alerts: Alert[];
}

export type PodEventType = 'state' | 'news' | 'decision' | 'alert' | 'order' | 'episode';

export interface PodEvent {
  id: number;
  type: PodEventType;
  data: unknown;
}

export type PodListener = (event: PodEvent) => void;

const LIMITS = { news: 50, orders: 100, episodes: 100, alerts: 50 } as const;

export class PodState implements PipelineObserver {
  private news: NewsEntry[] = [];
  private credibility: Record<string, SourceCredibility> = {};
  private lastDecision: DecisionEntry | null = null;
  private plannedActions: PlannedAction[] = [];
  private orders: OrderEntry[] = [];
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
      episodes: this.episodes,
      safeStop: this.safeStop,
      alerts: this.alerts,
    });
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

  // --- Alerts -------------------------------------------------------------

  /** Queue a spoken alert for an actionable decision. Returns null when the signal is `none`. */
  enqueueAlert(decision: Decision, headline?: NewsItem): Alert | null {
    if (decision.signal === 'none') return null;
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
      const s = await this.scorer.scoreHandle(item.handle);
      credibility = { handle: s.handle, score: s.score, level: s.level, weight: credibilityWeight(s.level) };
      this.credibility[s.handle] = credibility;
    }
    return { ...item, credibility, signal: classifyText(item.title) };
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
