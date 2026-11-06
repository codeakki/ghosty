import {
  describeError,
  parseAlert,
  parseDecision,
  parseEpisode,
  parseMarketTick,
  parseNews,
  parseOrder,
  parseProviders,
  parseSnapshot,
} from '../api/client';
import type {
  Alert,
  ApiResult,
  ButtonResult,
  ExecutionMarkets,
  HealthResponse,
  MarketHistory,
  MarketSnapshot,
  PaySignalResult,
  PlannedAction,
  PodSnapshot,
  ProvidersStatus,
  SseEventType,
  X402Status,
  ZeroGStatus,
} from '../api/types';
import { formatSignal, shortId } from '../lib/format';

/**
 * Everything the terminal shows, folded from SSE events and polled status endpoints.
 * The reducer is pure (time comes in on the action) so it is unit-tested without a browser.
 */

export type Connection = 'connecting' | 'open' | 'reconnecting';

export type StageId = 'news' | 'credibility' | 'brain' | 'alert' | 'confirm' | 'execute' | 'log' | 'pay';

/** Remote data whose endpoint may not exist yet. `pending` = 404, backend upgrade pending. */
export interface Remote<T> {
  status: 'loading' | 'live' | 'pending' | 'error';
  data: T | null;
  message?: string;
}

export interface ConsoleEntry {
  seq: number;
  at: number;
  /** SSE event type, or `ui` for actions taken from the terminal. */
  type: SseEventType | 'ui' | 'error';
  summary: string;
}

export interface TerminalState {
  connection: Connection;
  lastEventAt: number | null;
  snapshot: PodSnapshot | null;
  /** Legs of the latest decision, kept after the button clears plannedActions. */
  decisionActions: PlannedAction[];
  health: HealthResponse | null;
  serverReachable: boolean | null;
  zeroG: ZeroGStatus | null;
  x402: X402Status | null;
  execution: ExecutionMarkets | null;
  providers: Remote<ProvidersStatus>;
  market: Remote<MarketSnapshot>;
  /** Latest mid per coin from SSE `market` (or the snapshot). */
  mids: Record<string, number>;
  /** Rolling mid history per coin for sparklines. */
  series: Record<string, number[]>;
  /** Hourly closes per coin from GET /market/history (24 h). */
  history: Record<string, number[]>;
  midsAt: number | null;
  /** When each pipeline stage last saw activity (ms epoch). */
  stageHits: Partial<Record<StageId, number>>;
  lastButton: { result: ButtonResult; at: number } | null;
  lastPayment: { result: PaySignalResult; at: number } | null;
  /** Newest alert not yet dismissed or acknowledged. */
  banner: Alert | null;
  console: ConsoleEntry[];
  consoleSeq: number;
}

export const SERIES_LIMIT = 120;
export const CONSOLE_LIMIT = 300;

export const initialState: TerminalState = {
  connection: 'connecting',
  lastEventAt: null,
  snapshot: null,
  decisionActions: [],
  health: null,
  serverReachable: null,
  zeroG: null,
  x402: null,
  execution: null,
  providers: { status: 'loading', data: null },
  market: { status: 'loading', data: null },
  mids: {},
  series: {},
  history: {},
  midsAt: null,
  stageHits: {},
  lastButton: null,
  lastPayment: null,
  banner: null,
  console: [],
  consoleSeq: 0,
};

export type Action =
  | { type: 'connection'; status: Connection; at: number }
  | { type: 'sse'; event: SseEventType; data: unknown; at: number }
  | { type: 'health'; result: ApiResult<HealthResponse>; at: number }
  | { type: 'zerog'; data: ZeroGStatus }
  | { type: 'x402'; data: X402Status; at: number }
  | { type: 'execution'; data: ExecutionMarkets }
  | { type: 'providers'; result: ApiResult<ProvidersStatus> }
  | { type: 'market/snapshot'; result: ApiResult<MarketSnapshot>; at: number }
  | { type: 'market/history'; coin: string; result: ApiResult<MarketHistory> }
  | { type: 'button'; result: ButtonResult; at: number }
  | { type: 'payment'; result: PaySignalResult; at: number }
  | { type: 'banner/dismiss'; id: string }
  | { type: 'log'; level: 'ui' | 'error'; summary: string; at: number };

const EMPTY_SNAPSHOT: PodSnapshot = {
  news: [],
  credibility: {},
  lastDecision: null,
  plannedActions: [],
  orders: [],
  swaps: [],
  episodes: [],
  safeStop: false,
  alerts: [],
};

function log(state: TerminalState, type: ConsoleEntry['type'], summary: string, at: number): TerminalState {
  const seq = state.consoleSeq + 1;
  const console = [{ seq, at, type, summary }, ...state.console].slice(0, CONSOLE_LIMIT);
  return { ...state, console, consoleSeq: seq };
}

function hit(state: TerminalState, at: number, ...stages: StageId[]): TerminalState['stageHits'] {
  const next = { ...state.stageHits };
  for (const s of stages) next[s] = at;
  return next;
}

/** Append mids to the rolling series. Pure; exported for tests. */
export function appendMids(
  series: Record<string, number[]>,
  mids: Record<string, number>,
  limit = SERIES_LIMIT,
): Record<string, number[]> {
  const next = { ...series };
  for (const [coin, px] of Object.entries(mids)) {
    const prev = next[coin] ?? [];
    next[coin] = prev.length >= limit ? [...prev.slice(prev.length - limit + 1), px] : [...prev, px];
  }
  return next;
}

function foldSse(state: TerminalState, event: SseEventType, data: unknown, at: number): TerminalState {
  const base = { ...state, lastEventAt: at };
  const snap = state.snapshot ?? EMPTY_SNAPSHOT;

  switch (event) {
    case 'state': {
      const snapshot = parseSnapshot(data);
      if (!snapshot) return base;
      // The banner follows the server: drop it once the alert is acked elsewhere.
      let banner =
        state.banner && snapshot.alerts.find((a) => a.id === state.banner?.id)?.status === 'acked' ? null : state.banner;
      // First snapshot after (re)load: resurface the alert that is still waiting for a press.
      if (!state.snapshot && !banner && snapshot.plannedActions.length > 0) {
        banner =
          snapshot.alerts.find((a) => a.status !== 'acked' && a.requestId === snapshot.lastDecision?.requestId) ?? null;
      }
      const decisionActions =
        snapshot.plannedActions.length > 0
          ? snapshot.plannedActions
          : snapshot.lastDecision?.requestId === snap.lastDecision?.requestId
            ? state.decisionActions
            : [];
      return { ...base, snapshot, banner, decisionActions };
    }
    case 'news': {
      const item = parseNews(data);
      if (!item) return base;
      const news = [item, ...snap.news.filter((n) => n.id !== item.id)].slice(0, 50);
      const stages: StageId[] = item.credibility || item.weight !== undefined ? ['news', 'credibility'] : ['news'];
      return log(
        { ...base, snapshot: { ...snap, news }, stageHits: hit(state, at, ...stages) },
        'news',
        `${item.source}${item.handle ? ` @${item.handle.replace(/^@/, '')}` : ''}: ${item.title}`,
        at,
      );
    }
    case 'decision': {
      const d = parseDecision(data);
      if (!d) return base;
      const { actions, ...lastDecision } = d;
      return log(
        {
          ...base,
          snapshot: { ...snap, lastDecision, plannedActions: d.signal === 'none' ? [] : actions },
          decisionActions: actions,
          stageHits: hit(state, at, 'brain'),
        },
        'decision',
        `${formatSignal(d.signal)} ${(d.confidence * 100).toFixed(0)}% via ${d.trigger} · req ${shortId(d.requestId)}`,
        at,
      );
    }
    case 'alert': {
      const alert = parseAlert(data);
      if (!alert) return base;
      const alerts = [alert, ...snap.alerts.filter((a) => a.id !== alert.id)];
      return log(
        { ...base, snapshot: { ...snap, alerts }, banner: alert, stageHits: hit(state, at, 'alert') },
        'alert',
        `${alert.id} ${formatSignal(alert.signal)}: ${alert.text}`,
        at,
      );
    }
    case 'order': {
      const order = parseOrder(data);
      if (!order) return base;
      const orders = [order, ...snap.orders.filter((o) => !(o.orderId && o.orderId === order.orderId))];
      return log(
        { ...base, snapshot: { ...snap, orders }, stageHits: hit(state, at, 'confirm', 'execute') },
        'order',
        `${order.isBuy ? 'BUY' : 'SELL'} ${order.coin} $${order.sizeUsd} ${order.status}${order.error ? ` (${order.error})` : ''}`,
        at,
      );
    }
    case 'episode': {
      const ep = parseEpisode(data);
      if (!ep) return base;
      const episodes = [ep, ...snap.episodes.filter((e) => e.seq !== ep.seq)];
      return log(
        { ...base, snapshot: { ...snap, episodes }, stageHits: hit(state, at, 'log') },
        'episode',
        `#${ep.seq} ${ep.outcome} · req ${shortId(ep.requestId)}${ep.rootHash ? ` · root ${shortId(ep.rootHash)}` : ' · not on 0G Storage yet'}`,
        at,
      );
    }
    case 'market': {
      const tick = parseMarketTick(data);
      if (!tick) return base;
      // Market ticks are frequent: they never reach the console.
      return { ...base, mids: { ...state.mids, ...tick.mids }, series: appendMids(state.series, tick.mids), midsAt: at };
    }
    case 'providers': {
      const providers = parseProviders(data);
      if (!providers) return base;
      return log({ ...base, providers: { status: 'live', data: providers } }, 'providers', providerSummary(providers), at);
    }
  }
}

function providerSummary(p: ProvidersStatus): string {
  const live = p.providers.filter((x) => x.state === 'live').length;
  return `${live}/${p.providers.length} providers live`;
}

export function reducer(state: TerminalState, action: Action): TerminalState {
  switch (action.type) {
    case 'connection': {
      if (state.connection === action.status) return state;
      const next = { ...state, connection: action.status };
      const text = action.status === 'open' ? 'event stream connected' : 'event stream lost, retrying';
      return action.status === 'connecting' ? next : log(next, action.status === 'open' ? 'ui' : 'error', text, action.at);
    }
    case 'sse':
      return foldSse(state, action.event, action.data, action.at);
    case 'health': {
      if (action.result.ok) return { ...state, health: action.result.data, serverReachable: true };
      return { ...state, serverReachable: action.result.kind === 'network' ? false : state.serverReachable };
    }
    case 'zerog':
      return { ...state, zeroG: action.data };
    case 'x402': {
      const prevTx = state.x402?.lastPayment?.txId;
      const nextTx = action.data.lastPayment?.txId;
      const paid = state.x402 !== null && nextTx !== undefined && nextTx !== prevTx;
      return { ...state, x402: action.data, stageHits: paid ? hit(state, action.at, 'pay') : state.stageHits };
    }
    case 'execution':
      return { ...state, execution: action.data };
    case 'providers': {
      const r = action.result;
      if (r.ok) return { ...state, providers: { status: 'live', data: r.data } };
      if (r.kind === 'not_found') return { ...state, providers: { status: 'pending', data: null, message: r.message } };
      // Keep the last good list on a transient error.
      return { ...state, providers: { ...state.providers, status: state.providers.data ? 'live' : 'error', message: r.message } };
    }
    case 'market/snapshot': {
      const r = action.result;
      if (!r.ok) {
        const status = r.kind === 'not_found' ? 'pending' : state.market.data ? 'live' : 'error';
        return { ...state, market: { ...state.market, status, message: describeError(r) } };
      }
      const mids: Record<string, number> = {};
      for (const a of r.data.assets) if (a.mid !== null) mids[a.coin] = a.mid;
      return {
        ...state,
        market: { status: 'live', data: r.data },
        mids: { ...mids, ...state.mids },
        series: Object.keys(state.series).length === 0 ? appendMids(state.series, mids) : state.series,
        midsAt: state.midsAt ?? action.at,
      };
    }
    case 'market/history': {
      // History is a nice-to-have: a failure keeps the session sparkline.
      if (!action.result.ok || action.result.data.candles.length < 2) return state;
      return { ...state, history: { ...state.history, [action.coin]: action.result.data.candles.map((c) => c.c) } };
    }
    case 'button': {
      const { result, at } = action;
      const stages: StageId[] = result.executed ? ['confirm', 'execute'] : ['confirm'];
      const banner = state.banner?.requestId === result.requestId ? null : state.banner;
      const verb = result.action === 'confirm' ? (result.executed ? 'confirmed, executed' : 'confirmed, nothing to execute') : 'cancelled';
      return log(
        { ...state, lastButton: { result, at }, banner, stageHits: hit(state, at, ...stages) },
        'ui',
        `button ${verb} · ${result.orders.length} order(s), ${result.swaps.length} swap(s) · req ${shortId(result.requestId)}`,
        at,
      );
    }
    case 'payment': {
      const { result, at } = action;
      return log(
        { ...state, lastPayment: { result, at }, stageHits: hit(state, at, 'pay') },
        'ui',
        `x402 paid /signal (${result.mode}) tx ${shortId(result.txId)}`,
        at,
      );
    }
    case 'banner/dismiss':
      return state.banner?.id === action.id ? { ...state, banner: null } : state;
    case 'log':
      return log(state, action.level, action.summary, action.at);
  }
}
