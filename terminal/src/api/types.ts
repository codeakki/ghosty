/**
 * The whole server contract the terminal depends on, in one file.
 * Shapes mirror server/src (sim/state.ts, sim/routes.ts, integrations.ts, pipeline.ts, agent/episode.ts).
 * Endpoints marked NEW are being added by the backend; the client degrades to "backend upgrade pending" on 404.
 */

// ---------------------------------------------------------------------------
// Pod state (GET /state, SSE `state`)
// ---------------------------------------------------------------------------

export type Signal = 'geopolitical_shock' | 'regulatory_crackdown' | 'none';

export type CredibilityLevel = 'untrusted' | 'questionable' | 'neutral' | 'reputable' | 'exemplary';

export interface SourceCredibility {
  handle: string;
  /** Ethos score 0..2800, null when Ethos has no score for the handle. */
  score: number | null;
  level: CredibilityLevel;
  weight: number;
}

export interface NewsEntry {
  id: string;
  /** Provider: rss, cryptopanic, polymarket, grok, inject. */
  source: string;
  title: string;
  url: string;
  publishedAt: string;
  handle?: string;
  domain?: string;
  summary?: string;
  sentiment?: number;
  probability?: number;
  probabilityChange24h?: number;
  /** 0.2..1.0 weight from the aggregator, when present. */
  weight?: number;
  credibility: SourceCredibility | null;
  /** Keyword pre-classification of the title. */
  signal: Signal;
  /** Set on events emitted by a simulation run (SSE during /sim/run). */
  sim?: SimTag;
}

/** Hyperliquid perp leg. */
export interface PlannedAction {
  venue: 'hyperliquid';
  kind: 'perp';
  coin: string;
  side: 'long' | 'short';
  sizeUsd: number;
  reason: string;
}

/** Uniswap Trading API spot leg. */
export interface SpotAction {
  venue: 'uniswap';
  kind: 'spot';
  tokenIn: string;
  tokenOut: string;
  amount: string;
  chainId: number;
  reason: string;
}

export type DecisionTrigger = 'voice' | 'text' | 'button' | 'inject';

export interface DecisionEntry {
  requestId: string;
  signal: Signal;
  confidence: number;
  rationale: string;
  trigger: DecisionTrigger;
  transcript: string;
  headline?: string;
  at: string;
  sim?: SimTag;
}

export type OrderStatus = 'simulated' | 'filled' | 'resting' | 'rejected';

export interface OrderEntry {
  orderId: string;
  coin: string;
  isBuy: boolean;
  sizeUsd: number;
  status: OrderStatus;
  requestedCoin?: string;
  assetId?: number;
  filled?: number;
  avgPx?: number;
  fallback?: boolean;
  url?: string;
  error?: string;
  requestId: string;
  at: string;
  sim?: SimTag;
  /** A REAL order placed from a simulation run (Hyperliquid mainnet), as opposed to its paper fill. */
  live?: boolean;
  network?: 'mainnet' | 'testnet';
}

export interface SwapResult {
  quoteId: string;
  txHash: string;
  status: 'simulated' | 'confirmed';
  explorerUrl?: string;
  route?: string;
  approvalTxHashes?: string[];
  amountOut?: string;
}

export interface SwapEntry {
  action: SpotAction;
  result?: SwapResult;
  error?: string;
  requestId: string;
  at: string;
}

export interface ZeroGTrace {
  completionId: string | null;
  traceRequestId: string | null;
  headerRequestId: string | null;
  model: string;
  provider: string | null;
  attempts: number;
}

export type EpisodeOutcome = 'proposed' | 'executed' | 'cancelled' | 'blocked_safe_stop' | 'failed';

export interface EpisodeRecord {
  seq: number;
  at: string;
  requestId: string;
  outcome: EpisodeOutcome;
  actions: PlannedAction[];
  receipts?: string[];
  /** Set once the episode is on 0G Storage. */
  rootHash?: string;
  txHash?: string;
  decision?: { signal: Signal; confidence: number; rationale: string; zeroG?: ZeroGTrace };
  sim?: SimTag;
}

export type AlertStatus = 'pending' | 'delivered' | 'acked';

export interface Alert {
  id: string;
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
  sim?: SimTag;
}

export interface PodSnapshot {
  news: NewsEntry[];
  credibility: Record<string, SourceCredibility>;
  lastDecision: DecisionEntry | null;
  plannedActions: PlannedAction[];
  orders: OrderEntry[];
  swaps: SwapEntry[];
  episodes: EpisodeRecord[];
  safeStop: boolean;
  alerts: Alert[];
}

/** SSE `decision` payload: the decision entry plus its planned legs. */
export interface DecisionEvent extends DecisionEntry {
  actions: PlannedAction[];
}

// ---------------------------------------------------------------------------
// Action endpoints
// ---------------------------------------------------------------------------

export interface HealthResponse {
  ok: boolean;
  version: string;
  safeStop: boolean;
}

export interface ButtonResult {
  action: 'confirm' | 'cancel';
  requestId: string;
  signal: Signal;
  executed: boolean;
  actions: PlannedAction[];
  orders: Omit<OrderEntry, 'requestId' | 'at'>[];
  swaps: Omit<SwapEntry, 'requestId' | 'at'>[];
}

export interface InjectResult {
  item: { id: string; source: string; title: string; url: string; publishedAt: string; handle?: string };
  decision: { requestId: string; signal: Signal; confidence: number; rationale: string; actions: PlannedAction[] };
  alert: Alert | null;
}

export interface TextTurnResult {
  transcript: string;
  requestId: string;
  signal: Signal;
  confidence: number;
  rationale: string;
  actions: PlannedAction[];
  sampleRate: number;
  audioBytes: number;
  audioBase64: string;
  /** Live mode without TTS keys: the decision stands and the audio is empty. */
  tts?: { error: string; provider?: string; missingEnv?: string[] } | null;
}

export interface VoiceReply {
  pcm: ArrayBuffer;
  sampleRate: number;
  requestId: string;
  signal: string;
  latencyMs: number;
}

export interface SafeStopResult {
  safeStop: boolean;
  simulateOffline: boolean;
}

// ---------------------------------------------------------------------------
// Integration status (existing)
// ---------------------------------------------------------------------------

export interface ZeroGStatus {
  computeOnline: boolean;
  computeMode: '0g' | 'fake' | 'not_configured';
  storageMode: '0g' | 'memory' | 'not_configured';
  model: string | null;
  routerUrl: string;
  lastRequestId: string | null;
  lastDecisionRequestId: string | null;
  lastDecisionAt: string | null;
  memoryRootHash: string | null;
  memoryTxHash: string | null;
  episodeCount: number;
  lastEpisodeRoot: string | null;
  lastEpisodeTxHash: string | null;
  pendingEpisodes: number;
  lastStorageError: string | null;
  links: { storagescan: string; memoryTx: string | null; lastEpisodeTx: string | null };
}

export interface LastPayment {
  mode: 'real' | 'fake';
  txId: string;
  hashscanUrl: string;
  amountTinybar?: number;
  requestId?: string;
  /** `decision`: paid by the decision loop on its own (X402_AUTOPAY). `sim`: the "Pay for signal" button. */
  trigger?: 'decision' | 'sim';
  at: string;
}

export interface X402Status {
  mode: 'real' | 'fake' | 'not_configured';
  network: string;
  payer: string | null;
  payTo: string | null;
  priceTinybar: number;
  maxPerCallTinybar: number;
  spentToday: number;
  cap: number;
  remainingToday: number;
  allowedHosts: string[];
  hcsTopicUrl: string | null;
  /** X402_AUTOPAY: every decision pays for /signal with no human approval. */
  autopay?: boolean;
  lastPayment: LastPayment | null;
}

export interface PaySignalResult extends LastPayment {
  status: number;
  body: unknown;
}

export interface ResolvedMarket {
  alias: string;
  coin: string | null;
  assetId: number | null;
  dex: string | null;
  fallback: boolean;
  error: string | null;
}

export interface ExecutionMarkets {
  /** 'not_configured': live mode without keys (orders answer 503); 'fake' only exists in test mode. */
  perpMode: 'real' | 'fake' | 'not_configured';
  spotMode: 'real' | 'fake' | 'not_configured';
  testnet: boolean;
  dexes: string[];
  spotLeg: unknown;
  resolved: ResolvedMarket[];
  count: number;
}

// ---------------------------------------------------------------------------
// NEW endpoints (backend upgrade in flight)
// ---------------------------------------------------------------------------

export type Track = '0g' | 'hedera' | 'uniswap' | 'hyperliquid' | 'data' | 'audio';

export type ProviderState = 'live' | 'degraded' | 'offline' | 'not_configured';

export interface ProviderStatus {
  id: string;
  label: string;
  track: Track;
  state: ProviderState;
  detail: string;
  missingEnv: string[];
  lastOkAt?: string;
  latencyMs?: number;
}

/** GET /providers/status and SSE `providers`. */
export interface ProvidersStatus {
  providers: ProviderStatus[];
}

export interface MarketAsset {
  coin: string;
  dex: string;
  label: string;
  mid: number | null;
  prevDayPx: number | null;
  change24hPct: number | null;
  funding: number | null;
  /** Open interest in coin units. */
  openInterest: number | null;
  /** Open interest in USD, when the server computes it. */
  openInterestUsd: number | null;
  volume24h: number | null;
}

/** GET /market/snapshot. */
export interface MarketSnapshot {
  network: 'testnet' | 'mainnet';
  ts: string;
  assets: MarketAsset[];
  /** Watch-list coins the venue does not list (e.g. a HIP-3 market missing on testnet). */
  missing: string[];
}

/** SSE `market`, every ~2 s. */
export interface MarketTick {
  ts: string;
  mids: Record<string, number>;
  /** Simulation ticks are HISTORICAL prices: never mixed into the live ticker. */
  sim?: SimTag;
}

/** One Hyperliquid candle (candleSnapshot), numbers already parsed. */
export interface Candle {
  /** Open time, ms epoch. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** GET /market/history?coin=&interval=1h&hours=24. */
export interface MarketHistory {
  network: 'testnet' | 'mainnet';
  coin: string;
  interval: string;
  candles: Candle[];
}

// ---------------------------------------------------------------------------
// Client result wrapper
// ---------------------------------------------------------------------------

/**
 * Every call resolves (never throws) so panels can render an explicit state:
 * ok, missing endpoint (backend upgrade pending), safe-stop, auth, or a plain error.
 */
export type ApiResult<T> =
  | { ok: true; data: T; status: number }
  | {
      ok: false;
      kind: 'not_found' | 'not_configured' | 'brain_offline' | 'unauthorized' | 'http' | 'network' | 'parse';
      status: number;
      message: string;
      /** 503 not_configured: which provider and which env vars to set. */
      provider?: string;
      missingEnv?: string[];
    };

export type ApiFailure = Extract<ApiResult<unknown>, { ok: false }>;

export type SseEventType = 'state' | 'news' | 'decision' | 'alert' | 'order' | 'episode' | 'market' | 'providers' | 'sim';

// ---------------------------------------------------------------------------
// Simulation (NEW: /sim/scenarios, /sim/run, /sim/control, SSE `sim`, /episodes/replay)
// ---------------------------------------------------------------------------

/** Every SSE event emitted during a run carries `sim: true, runId`. */
export interface SimTag {
  runId: string;
}

export interface SimHeadline {
  ts: string;
  title: string;
  source: string;
  url: string;
}

/** GET /sim/scenarios item. */
export interface SimScenario {
  id: string;
  title: string;
  description: string;
  /** "geopolitical shock", "hack", "regulatory"… */
  category: string | null;
  start: string;
  end: string;
  /** Hyperliquid coin names ("BTC", "xyz:GOLD"). */
  markets: string[];
  /** coin → what stands in for its history ("PAXG (gold-backed token) as the gold price"). */
  proxies: Record<string, string>;
  headlines: SimHeadline[];
}

export type SimStatus = 'idle' | 'running' | 'paused' | 'done';

export interface SimPosition {
  market: string;
  side: 'long' | 'short';
  sizeUsd: number;
  entryPx: number;
  markPx: number;
  pnlUsd: number;
}

/** One headline the run has played and what the brain did with it. */
export interface SimDecisionRow {
  simTime: string;
  headline: string;
  requestId: string | null;
  signal: Signal | null;
  confidence: number | null;
  /** Why no decision was made. */
  skipped: 'no_shock' | 'brain_offline' | 'error' | null;
  /** Server's reason when skipped for brain_offline / error. */
  error: string | null;
  actions: number;
}

/** A real Hyperliquid mainnet order placed from a sim run. */
export interface SimLiveOrder {
  orderId: string;
  coin: string;
  isBuy: boolean;
  sizeUsd: number;
  status: OrderStatus;
  avgPx?: number;
  url?: string;
  error?: string;
  requestId: string;
  placedAt: string;
}

/** Paper always; plus real orders on Hyperliquid mainnet when the run opted in. */
export interface SimExecution {
  /** This run also sends confirmed legs to Hyperliquid mainnet. */
  liveOrders: boolean;
  /** The server allows real orders (SIM_LIVE_ORDERS on, mainnet keys set). */
  available: boolean;
  /** Why real orders are unavailable. */
  unavailable: string | null;
  orderUsd: number;
  maxRunUsd: number;
  spentUsd: number;
  orders: SimLiveOrder[];
}

/** GET /sim/run and SSE `sim`. */
export interface SimRun {
  runId: string;
  scenarioId: string;
  status: SimStatus;
  pauseReason: 'user' | 'awaiting_press' | null;
  /** Historical clock of the run (ISO). */
  simTime: string;
  start: string;
  end: string;
  /** 0..1. */
  progress: number;
  /** Market seconds per real second. */
  speed: number;
  /** Capital base for the percentages (MAX_TRADE_USD). 0 when the server does not say. */
  notionalUsd: number;
  pnlUsd: number;
  baselinePnlUsd: number;
  /** null when the server does not send it. */
  pnlPct: number | null;
  baselinePct: number | null;
  positions: SimPosition[];
  decisions: number;
  decisionList: SimDecisionRow[];
  episodes: number;
  headlines: { total: number; delivered: number };
  pending: { requestId: string; headline: string; actions: PlannedAction[] } | null;
  execution: SimExecution;
  error: string | null;
}

export type SimAction = 'pause' | 'resume' | 'stop';

/** GET /episodes/replay item (oldest → newest). */
export interface ReplayEpisode {
  ts: string;
  requestId: string;
  decision: { signal: Signal; confidence: number; rationale: string } | null;
  actions: PlannedAction[];
  orders: number;
  storage: '0g' | 'local';
  rootHash?: string;
  storagescanUrl?: string;
}
