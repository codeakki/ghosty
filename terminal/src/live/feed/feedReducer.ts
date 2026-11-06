import { describeError, parseAlert, parseDecision, parseEpisode, parseMarketTick, parseNews, parseOrder, parseProviders, parseSnapshot } from '../../api/client';
import type {
  Alert,
  ApiFailure,
  EpisodeRecord,
  LastPayment,
  NewsEntry,
  OrderEntry,
  PlannedAction,
  ProviderState,
  ProviderStatus,
  ReplayEpisode,
  Signal,
  SimTag,
  SwapEntry,
  Track,
} from '../../api/types';
import type { Action as TerminalAction } from '../../state/reducer';
import { describeProviders, describeSafeStop, type ProviderEntry, type SystemText } from './system';
import { DEFAULT_MOVE_OPTIONS, detectMoves, seedRange, type DetectorState, type MarketMove, type MoveOptions } from './moveDetector';

/**
 * The Live feed: every real thing that happened, as cards, newest first.
 * It folds the same actions the terminal reducer sees (SSE events + polls), plus two local actions for
 * "a request from this page is in flight on 0G". Pure, so every event → card mapping is unit-tested.
 */

export type FeedFilter = 'all' | 'market' | 'news' | 'agent' | 'tx';

export type TxTrack = Extract<Track, '0g' | 'hedera' | 'uniswap' | 'hyperliquid'>;

interface CardBase {
  id: string;
  /** When the card entered the feed (ms epoch). Sim cards sort by arrival too, so they never sink below live ones. */
  at: number;
  /** Set on cards from a simulation run: the run and the HISTORICAL sim clock time shown on the card. */
  sim?: SimCardTag;
}

export interface SimCardTag {
  runId: string;
  /** Sim clock time (ms epoch), from the event's own timestamp. */
  simAt: number;
}

/** One episode played back from GET /episodes/replay. */
export interface ReplayCard extends CardBase {
  kind: 'replay';
  episode: ReplayEpisode;
  /** 1-based position in the replay and its length ("2 of 5"). */
  index: number;
  total: number;
}

export interface MarketCard extends CardBase {
  kind: 'market';
  move: MarketMove;
  /** Recent session mids for the sparkline, ending at the move. */
  points: number[];
}

export interface NewsCard extends CardBase {
  kind: 'news';
  item: NewsEntry;
}

export interface BrainCard extends CardBase {
  kind: 'brain';
  status: 'thinking' | 'done' | 'failed';
  /** What triggered it, in words: the headline or what was said. */
  prompt: string;
  trigger: string;
  requestId?: string;
  signal?: Signal;
  confidence?: number;
  rationale?: string;
  actions: PlannedAction[];
  /** For failures: one sentence that says what is missing. */
  message?: string;
  /** Local id of the in-flight request that this card tracks. */
  localId?: string;
}

export interface AlertCard extends CardBase {
  kind: 'alert';
  alert: Alert;
}

export type TxCard = CardBase & { kind: 'tx'; track: TxTrack } & (
    | { tx: 'order'; order: OrderEntry }
    | { tx: 'swap'; swap: SwapEntry }
    | { tx: 'payment'; payment: LastPayment }
    | { tx: 'episode'; episode: EpisodeRecord }
  );

export type SystemCard = CardBase & {
  kind: 'system';
  /** Last change folded into this card. Changes within FLAP_WINDOW_MS update the card in place. */
  updatedAt: number;
  /** How many changes this card has absorbed. */
  flips: number;
} & ({ topic: 'provider'; providers: ProviderEntry[] } | { topic: 'safe-stop'; safeStop: boolean });

export type FeedCard = MarketCard | NewsCard | BrainCard | AlertCard | TxCard | SystemCard | ReplayCard;

export interface FeedState {
  cards: FeedCard[];
  seq: number;
  detector: DetectorState;
  moveOptions: MoveOptions;
  /** Rolling session mids per coin, for sparklines on move cards. */
  series: Record<string, number[]>;
  /** Watched coins (from /market/snapshot); detection waits until known. */
  watch: string[];
  labels: Record<string, string>;
  /** Previous day's close per coin (from /market/snapshot), for the ±2% day crossing. */
  prevDay: Record<string, number>;
  /** Known ids, so a re-sent snapshot never duplicates a card. */
  seen: Record<string, true>;
  providers: Record<string, ProviderState> | null;
  safeStop: boolean | null;
  paymentTx: string | null;
  seeded: boolean;
  /** Ids of the cards that the last applied batch added, newest first (drives the staggered entrance). */
  lastBatch: string[];
}

export const FEED_LIMIT = 100;
const SERIES_POINTS = 90;
const SEED_NEWS = 6;

export function initialFeed(moveOptions: MoveOptions = DEFAULT_MOVE_OPTIONS): FeedState {
  return {
    cards: [],
    seq: 0,
    detector: {},
    moveOptions,
    series: {},
    watch: [],
    labels: {},
    prevDay: {},
    seen: {},
    providers: null,
    safeStop: null,
    paymentTx: null,
    seeded: false,
    lastBatch: [],
  };
}

export type FeedLocalAction =
  | { type: 'feed/brain-pending'; localId: string; prompt: string; trigger: string; at: number }
  | {
      type: 'feed/brain-result';
      localId: string;
      at: number;
      result:
        | { ok: true; requestId: string; signal: Signal; confidence: number; rationale: string; actions: PlannedAction[] }
        | { ok: false; failure: ApiFailure };
    };

export type FeedSimAction =
  /** Leaving the simulation: drop every sim card so the feed is live-only again. */
  | { type: 'feed/sim-clear' }
  /** One step of a replay: the next episode, oldest first. */
  | { type: 'feed/replay'; replayId: string; episode: ReplayEpisode; index: number; total: number; at: number }
  | { type: 'feed/replay-clear' };

export type FeedAction = TerminalAction | FeedLocalAction | FeedSimAction;

// ---------------------------------------------------------------------------

function push(state: FeedState, cards: FeedCard[]): FeedState {
  if (cards.length === 0) return state;
  const seen = { ...state.seen };
  for (const c of cards) seen[c.id] = true;
  // Newest first; cards created in one step keep their given order.
  const merged = [...cards, ...state.cards].sort((a, b) => b.at - a.at).slice(0, FEED_LIMIT);
  return { ...state, cards: merged, seen };
}

function fresh(state: FeedState, id: string): boolean {
  return state.seen[id] !== true;
}

/**
 * Insert a card, or replace the card with the same id in place (keeping its slot and time), so a transaction
 * going pending → confirmed is the same card changing, never a second card.
 */
function upsert(state: FeedState, card: FeedCard): FeedState {
  const idx = state.cards.findIndex((c) => c.id === card.id);
  if (idx === -1) return push(state, [card]);
  const cards = [...state.cards];
  cards[idx] = { ...card, at: state.cards[idx]!.at };
  return { ...state, cards };
}

function newsCard(item: NewsEntry, at: number): NewsCard {
  return { kind: 'news', id: `news:${item.id}`, at, item };
}

function episodeCard(ep: EpisodeRecord, at: number): TxCard {
  return { kind: 'tx', track: '0g', tx: 'episode', id: `episode:${ep.seq}`, at, episode: ep };
}

function orderCard(order: OrderEntry, at: number): TxCard {
  const key = order.orderId || `${order.requestId}:${order.coin}:${order.at}`;
  return { kind: 'tx', track: 'hyperliquid', tx: 'order', id: `order:${key}`, at, order };
}

function swapCard(swap: SwapEntry, at: number): TxCard {
  const key = `${swap.requestId}:${swap.action.tokenIn}:${swap.action.tokenOut}`;
  return { kind: 'tx', track: 'uniswap', tx: 'swap', id: `swap:${key}`, at, swap };
}

/** Parse an ISO time, falling back to `at` (and never placing a card in the future). */
function timeOf(iso: string | undefined, at: number): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Math.min(t, at) : at;
}

function decisionCard(state: FeedState, d: NonNullable<ReturnType<typeof parseDecision>>, at: number): FeedState {
  const id = `brain:${d.requestId}`;
  if (!fresh(state, id)) return state;
  // A request from this page is waiting: the decision replaces its "thinking" card in place.
  const pendingIdx = state.cards.findIndex((c) => c.kind === 'brain' && c.status === 'thinking');
  const done: BrainCard = {
    kind: 'brain',
    id,
    at,
    status: 'done',
    prompt: d.headline ?? d.transcript,
    trigger: d.trigger,
    requestId: d.requestId,
    signal: d.signal,
    confidence: d.confidence,
    rationale: d.rationale,
    actions: d.actions,
  };
  if (pendingIdx !== -1) {
    const pending = state.cards[pendingIdx] as BrainCard;
    const cards = [...state.cards];
    cards[pendingIdx] = { ...done, at: pending.at, prompt: done.prompt || pending.prompt, localId: pending.localId };
    return { ...state, cards, seen: { ...state.seen, [id]: true } };
  }
  return push(state, [done]);
}

/** Historical time of a sim event, for the card's clock; arrival time if the payload has none. */
function simTag(tag: SimTag, iso: string | undefined, at: number): SimCardTag {
  const t = iso ? Date.parse(iso) : NaN;
  return { runId: tag.runId, simAt: Number.isFinite(t) ? t : at };
}

/**
 * Events from a simulation run (`sim: true, runId`). They become ordinary cards tagged SIM, keyed apart from live
 * ids so a replayed request id never updates a live card. Sim `market` ticks are historical prices: no cards, no
 * move detection, and they never touch the live series.
 */
function foldSimSse(state: FeedState, event: string, data: unknown, at: number): FeedState | null {
  switch (event) {
    case 'market': {
      const tick = parseMarketTick(data);
      return tick?.sim ? state : null;
    }
    case 'news': {
      const item = parseNews(data);
      if (!item?.sim) return null;
      const id = `sim:news:${item.sim.runId}:${item.id}`;
      return fresh(state, id) ? push(state, [{ kind: 'news', id, at, item, sim: simTag(item.sim, item.publishedAt, at) }]) : state;
    }
    case 'decision': {
      const d = parseDecision(data);
      if (!d?.sim) return null;
      const id = `sim:brain:${d.sim.runId}:${d.requestId}`;
      if (!fresh(state, id)) return state;
      return push(state, [
        {
          kind: 'brain',
          id,
          at,
          status: 'done',
          prompt: d.headline ?? d.transcript,
          trigger: d.trigger,
          requestId: d.requestId,
          signal: d.signal,
          confidence: d.confidence,
          rationale: d.rationale,
          actions: d.actions,
          sim: simTag(d.sim, d.at, at),
        },
      ]);
    }
    case 'alert': {
      const alert = parseAlert(data);
      if (!alert?.sim) return null;
      const id = `sim:alert:${alert.sim.runId}:${alert.id}`;
      return fresh(state, id) ? push(state, [{ kind: 'alert', id, at, alert, sim: simTag(alert.sim, alert.createdAt, at) }]) : state;
    }
    case 'order': {
      const order = parseOrder(data);
      if (!order?.sim) return null;
      const c = orderCard(order, at);
      return upsert(state, { ...c, id: `sim:${order.sim.runId}:${c.id}`, sim: simTag(order.sim, order.at, at) });
    }
    case 'episode': {
      const ep = parseEpisode(data);
      if (!ep?.sim) return null;
      const c = episodeCard(ep, at);
      return upsert(state, { ...c, id: `sim:${ep.sim.runId}:${c.id}`, sim: simTag(ep.sim, ep.at, at) });
    }
    default:
      return null;
  }
}

function foldSse(state: FeedState, event: string, data: unknown, at: number): FeedState {
  const simmed = foldSimSse(state, event, data, at);
  if (simmed) return simmed;
  switch (event) {
    case 'state': {
      const snap = parseSnapshot(data);
      if (!snap) return state;
      let next = state;
      const cards: FeedCard[] = [];
      if (!state.seeded) {
        // First snapshot: show the latest real headlines so the feed is not empty on load.
        for (const item of snap.news.slice(0, SEED_NEWS)) {
          const c = newsCard(item, timeOf(item.publishedAt, at));
          if (fresh(next, c.id)) cards.push(c);
        }
        for (const ep of snap.episodes.slice(0, 3)) cards.push(episodeCard(ep, timeOf(ep.at, at)));
        for (const o of snap.orders.slice(0, 3)) cards.push(orderCard(o, timeOf(o.at, at)));
      }
      for (const s of snap.swaps) {
        const c = swapCard(s, state.seeded ? at : timeOf(s.at, at));
        const existing = next.cards.find((x) => x.id === c.id);
        if (existing) {
          if (existing.kind === 'tx' && existing.tx === 'swap' && existing.swap.result?.status !== s.result?.status) next = upsert(next, c);
        } else if (!cards.some((x) => x.id === c.id)) cards.push(c);
      }
      const flipped = state.safeStop !== null && state.safeStop !== snap.safeStop;
      next = push({ ...next, seeded: true, safeStop: snap.safeStop }, cards);
      return flipped ? foldSafeStop(next, snap.safeStop, at) : next;
    }
    case 'news': {
      const item = parseNews(data);
      if (!item) return state;
      const c = newsCard(item, at);
      return fresh(state, c.id) ? push(state, [c]) : state;
    }
    case 'decision': {
      const d = parseDecision(data);
      return d ? decisionCard(state, d, at) : state;
    }
    case 'alert': {
      const alert = parseAlert(data);
      if (!alert) return state;
      const id = `alert:${alert.id}`;
      return fresh(state, id) ? push(state, [{ kind: 'alert', id, at, alert }]) : state;
    }
    case 'order': {
      const order = parseOrder(data);
      return order ? upsert(state, orderCard(order, at)) : state;
    }
    case 'episode': {
      const ep = parseEpisode(data);
      return ep ? upsert(state, episodeCard(ep, at)) : state;
    }
    case 'market': {
      const tick = parseMarketTick(data);
      if (!tick) return state;
      return foldMids(state, tick.mids, at);
    }
    case 'providers': {
      const p = parseProviders(data);
      return p ? foldProviders(state, p.providers, at) : state;
    }
    default:
      return state;
  }
}

function appendSeries(series: Record<string, number[]>, mids: Record<string, number>): Record<string, number[]> {
  const next = { ...series };
  for (const [coin, px] of Object.entries(mids)) {
    const prev = next[coin] ?? [];
    next[coin] = prev.length >= SERIES_POINTS ? [...prev.slice(prev.length - SERIES_POINTS + 1), px] : [...prev, px];
  }
  return next;
}

function foldMids(state: FeedState, mids: Record<string, number>, at: number): FeedState {
  const series = appendSeries(state.series, mids);
  if (state.watch.length === 0) return { ...state, series };
  const { state: detector, moves } = detectMoves(state.detector, mids, at, state.moveOptions, new Set(state.watch), state.prevDay);
  const cards: MarketCard[] = moves.map((move) => ({
    kind: 'market',
    id: `move:${move.coin}:${at}`,
    at,
    move,
    points: series[move.coin] ?? [],
  }));
  return push({ ...state, series, detector }, cards);
}

/** Flapping (on/off/on) within this window folds into one card that updates in place. */
export const FLAP_WINDOW_MS = 60_000;

function recentSystem(state: FeedState, topic: SystemCard['topic'], at: number): number {
  return state.cards.findIndex((c) => c.kind === 'system' && c.topic === topic && at - c.updatedAt <= FLAP_WINDOW_MS);
}

function foldProviders(state: FeedState, providers: ProviderStatus[], at: number): FeedState {
  const map: Record<string, ProviderState> = {};
  for (const p of providers) map[p.id] = p.state;
  if (state.providers === null) return { ...state, providers: map };
  const changes: ProviderEntry[] = [];
  for (const p of providers) {
    const before = state.providers[p.id];
    if (before === undefined || before === p.state) continue;
    // A provider that is not set up belongs to the Setup notice, not to a System card.
    if (p.state === 'not_configured') continue;
    changes.push({ id: p.id, label: p.label, state: p.state, before, detail: p.detail, missingEnv: p.missingEnv });
  }
  const next = { ...state, providers: map };
  if (changes.length === 0) return next;
  const idx = recentSystem(state, 'provider', at);
  if (idx !== -1) {
    const card = state.cards[idx] as Extract<SystemCard, { topic: 'provider' }>;
    const entries = [...card.providers];
    for (const c of changes) {
      const i = entries.findIndex((e) => e.id === c.id);
      if (i === -1) entries.push(c);
      else entries[i] = { ...c, before: entries[i]!.before };
    }
    const cards = [...state.cards];
    cards[idx] = { ...card, providers: entries, updatedAt: at, flips: card.flips + 1 };
    return { ...next, cards };
  }
  return push(next, [{ kind: 'system', topic: 'provider', id: `providers:${at}`, at, updatedAt: at, flips: 1, providers: changes }]);
}

function foldSafeStop(state: FeedState, on: boolean, at: number): FeedState {
  const idx = recentSystem(state, 'safe-stop', at);
  if (idx !== -1) {
    const card = state.cards[idx] as Extract<SystemCard, { topic: 'safe-stop' }>;
    const cards = [...state.cards];
    cards[idx] = { ...card, safeStop: on, updatedAt: at, flips: card.flips + 1 };
    return { ...state, cards };
  }
  return push(state, [{ kind: 'system', topic: 'safe-stop', id: `safestop:${at}`, at, updatedAt: at, flips: 1, safeStop: on }]);
}

export function feedReducer(state: FeedState, action: FeedAction): FeedState {
  switch (action.type) {
    case 'sse':
      return foldSse(state, action.event, action.data, action.at);
    case 'market/snapshot': {
      if (!action.result.ok) return state;
      const watch = action.result.data.assets.map((a) => a.coin);
      const labels: Record<string, string> = {};
      const prevDay: Record<string, number> = {};
      for (const a of action.result.data.assets) {
        labels[a.coin] = a.label;
        if (a.prevDayPx !== null && a.prevDayPx > 0) prevDay[a.coin] = a.prevDayPx;
      }
      return { ...state, watch, labels, prevDay };
    }
    case 'market/history': {
      if (!action.result.ok) return state;
      return { ...state, detector: seedRange(state.detector, action.coin, action.result.data.candles, action.result.data.candles.at(-1)?.t ?? 0) };
    }
    case 'providers': {
      return action.result.ok ? foldProviders(state, action.result.data.providers, Date.now()) : state;
    }
    case 'health': {
      if (!action.result.ok) return state;
      const on = action.result.data.safeStop;
      if (state.safeStop === null || state.safeStop === on) return { ...state, safeStop: on };
      return foldSafeStop({ ...state, safeStop: on }, on, action.at);
    }
    case 'x402': {
      const p = action.data.lastPayment;
      if (!p || p.txId === state.paymentTx) return state;
      const id = `payment:${p.txId}`;
      const next = { ...state, paymentTx: p.txId };
      return fresh(state, id) ? push(next, [{ kind: 'tx', track: 'hedera', tx: 'payment', id, at: timeOf(p.at, action.at), payment: p }]) : next;
    }
    case 'payment': {
      const p = action.result;
      const id = `payment:${p.txId}`;
      return fresh(state, id) ? push({ ...state, paymentTx: p.txId }, [{ kind: 'tx', track: 'hedera', tx: 'payment', id, at: action.at, payment: p }]) : state;
    }
    case 'feed/sim-clear': {
      const cards = state.cards.filter((c) => !c.sim);
      return cards.length === state.cards.length ? state : { ...state, cards };
    }
    case 'feed/replay': {
      const id = `replay:${action.replayId}:${action.index}`;
      return fresh(state, id)
        ? push(state, [{ kind: 'replay', id, at: action.at, episode: action.episode, index: action.index, total: action.total }])
        : state;
    }
    case 'feed/replay-clear': {
      const cards = state.cards.filter((c) => c.kind !== 'replay');
      return cards.length === state.cards.length ? state : { ...state, cards };
    }
    case 'feed/brain-pending':
      return push(state, [
        { kind: 'brain', id: `pending:${action.localId}`, at: action.at, status: 'thinking', prompt: action.prompt, trigger: action.trigger, actions: [], localId: action.localId },
      ]);
    case 'feed/brain-result': {
      const idx = state.cards.findIndex((c) => c.kind === 'brain' && c.localId === action.localId);
      const r = action.result;
      if (idx === -1) return state;
      const card = state.cards[idx] as BrainCard;
      const cards = [...state.cards];
      if (r.ok) {
        const id = `brain:${r.requestId}`;
        // The SSE `decision` usually lands first and already replaced this card.
        if (card.status === 'done') return state;
        cards[idx] = { ...card, id, status: 'done', requestId: r.requestId, signal: r.signal, confidence: r.confidence, rationale: r.rationale, actions: r.actions };
        return { ...state, cards, seen: { ...state.seen, [id]: true } };
      }
      // A setup problem (missing key, brain offline) is not an agent event: the Setup notice explains it.
      if (isSetupFailure(r.failure)) {
        cards.splice(idx, 1);
        return { ...state, cards };
      }
      cards[idx] = { ...card, status: 'failed', message: describeError(r.failure) };
      return { ...state, cards };
    }
    default:
      return state;
  }
}

/** Fold a coalesced burst of actions; records which cards it added (for the staggered entrance). */
export function applyBatch(state: FeedState, actions: readonly FeedAction[]): FeedState {
  let next = state;
  for (const a of actions) next = feedReducer(next, a);
  if (next === state) return state;
  const before = new Set(state.cards.map((c) => c.id));
  const added = next.cards.filter((c) => !before.has(c.id)).map((c) => c.id);
  // The first snapshot is history, not news: no entrance glow for the seed.
  return { ...next, lastBatch: state.seeded ? added : [] };
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export function isSetupFailure(f: ApiFailure): boolean {
  return f.kind === 'not_configured' || f.kind === 'brain_offline' || f.kind === 'unauthorized';
}

export function systemText(card: SystemCard): SystemText {
  return card.topic === 'provider' ? describeProviders(card.providers, card.flips) : describeSafeStop(card.safeStop, card.flips);
}

export function cardFilter(card: FeedCard): Exclude<FeedFilter, 'all'> | null {
  switch (card.kind) {
    case 'market':
      return 'market';
    case 'news':
      return 'news';
    case 'brain':
    case 'alert':
    case 'replay':
      return 'agent';
    case 'tx':
      return 'tx';
    case 'system':
      return null;
  }
}

export function filterCards(cards: readonly FeedCard[], filter: FeedFilter): FeedCard[] {
  return filter === 'all' ? [...cards] : cards.filter((c) => cardFilter(c) === filter);
}
