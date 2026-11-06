import type {
  Alert,
  ApiFailure,
  ApiResult,
  ButtonResult,
  Candle,
  DecisionEvent,
  EpisodeRecord,
  ExecutionMarkets,
  HealthResponse,
  InjectResult,
  MarketAsset,
  MarketHistory,
  MarketSnapshot,
  MarketTick,
  NewsEntry,
  OrderEntry,
  PaySignalResult,
  PlannedAction,
  PodSnapshot,
  ProviderState,
  ProviderStatus,
  ProvidersStatus,
  SafeStopResult,
  Signal,
  SourceCredibility,
  SwapEntry,
  TextTurnResult,
  Track,
  VoiceReply,
  X402Status,
  ZeroGStatus,
} from './types';

// ---------------------------------------------------------------------------
// Settings (server URL + device token), persisted per browser
// ---------------------------------------------------------------------------

export interface ClientSettings {
  /** "" = same origin (Vite proxy in dev, the Ghosty server in production). */
  baseUrl: string;
  /** Sent as X-Device-Token on guarded routes when the server has DEVICE_TOKEN set. */
  deviceToken: string;
}

const SETTINGS_KEY = 'ghosty.terminal.settings.v1';
export const DEFAULT_SETTINGS: ClientSettings = { baseUrl: '', deviceToken: '' };

export function loadSettings(): ClientSettings {
  try {
    const raw = globalThis.localStorage?.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return DEFAULT_SETTINGS;
    return { baseUrl: normalizeBaseUrl(str(parsed.baseUrl)), deviceToken: str(parsed.deviceToken) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: ClientSettings): void {
  try {
    globalThis.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Private mode or blocked storage: settings last for this tab only.
  }
}

/** Trim and drop a trailing slash; "" stays "". */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// Tiny runtime guards. The server is ours, but a half-deployed backend must not crash the UI.
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

export function isRecord(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}
function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}
function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function records(v: unknown): Rec[] {
  return arr(v).filter(isRecord);
}

const SIGNALS: readonly Signal[] = ['geopolitical_shock', 'regulatory_crackdown', 'none'];
function signal(v: unknown): Signal {
  return SIGNALS.includes(v as Signal) ? (v as Signal) : 'none';
}

function parseAction(r: Rec): PlannedAction | null {
  const coin = optStr(r.coin);
  const sizeUsd = num(r.sizeUsd);
  if (!coin || sizeUsd === null) return null;
  return {
    venue: 'hyperliquid',
    kind: 'perp',
    coin,
    side: r.side === 'short' ? 'short' : 'long',
    sizeUsd,
    reason: str(r.reason),
  };
}
export function parseActions(v: unknown): PlannedAction[] {
  return records(v).flatMap((r) => parseAction(r) ?? []);
}

function parseCredibility(v: unknown): SourceCredibility | null {
  if (!isRecord(v)) return null;
  const level = str(v.level, 'neutral') as SourceCredibility['level'];
  return { handle: str(v.handle), score: num(v.score), level, weight: num(v.weight) ?? 0.5 };
}

export function parseNews(v: unknown): NewsEntry | null {
  if (!isRecord(v)) return null;
  const id = optStr(v.id);
  const title = optStr(v.title);
  if (!id || !title) return null;
  return {
    id,
    title,
    source: str(v.source, 'unknown'),
    url: str(v.url),
    publishedAt: str(v.publishedAt),
    handle: optStr(v.handle),
    domain: optStr(v.domain),
    summary: optStr(v.summary),
    sentiment: num(v.sentiment) ?? undefined,
    probability: num(v.probability) ?? undefined,
    probabilityChange24h: num(v.probabilityChange24h) ?? undefined,
    weight: num(v.weight) ?? undefined,
    credibility: parseCredibility(v.credibility),
    signal: signal(v.signal),
  };
}

export function parseDecision(v: unknown): DecisionEvent | null {
  if (!isRecord(v)) return null;
  const requestId = optStr(v.requestId);
  if (!requestId) return null;
  return {
    requestId,
    signal: signal(v.signal),
    confidence: num(v.confidence) ?? 0,
    rationale: str(v.rationale),
    trigger: (optStr(v.trigger) ?? 'button') as DecisionEvent['trigger'],
    transcript: str(v.transcript),
    headline: optStr(v.headline),
    at: str(v.at),
    actions: parseActions(v.actions),
  };
}

export function parseOrder(v: unknown): OrderEntry | null {
  if (!isRecord(v)) return null;
  const coin = optStr(v.coin);
  if (!coin) return null;
  const status = str(v.status, 'rejected') as OrderEntry['status'];
  return {
    orderId: str(v.orderId),
    coin,
    isBuy: v.isBuy === true,
    sizeUsd: num(v.sizeUsd) ?? 0,
    status,
    requestedCoin: optStr(v.requestedCoin),
    assetId: num(v.assetId) ?? undefined,
    filled: num(v.filled) ?? undefined,
    avgPx: num(v.avgPx) ?? undefined,
    fallback: v.fallback === true ? true : undefined,
    url: optStr(v.url),
    error: optStr(v.error),
    requestId: str(v.requestId),
    at: str(v.at),
  };
}

function parseSwap(v: unknown): SwapEntry | null {
  if (!isRecord(v) || !isRecord(v.action)) return null;
  const a = v.action;
  const result = isRecord(v.result)
    ? {
        quoteId: str(v.result.quoteId),
        txHash: str(v.result.txHash),
        status: v.result.status === 'confirmed' ? ('confirmed' as const) : ('simulated' as const),
        explorerUrl: optStr(v.result.explorerUrl),
        route: optStr(v.result.route),
      }
    : undefined;
  return {
    action: {
      venue: 'uniswap',
      kind: 'spot',
      tokenIn: str(a.tokenIn),
      tokenOut: str(a.tokenOut),
      amount: str(a.amount),
      chainId: num(a.chainId) ?? 0,
      reason: str(a.reason),
    },
    result,
    error: optStr(v.error),
    requestId: str(v.requestId),
    at: str(v.at),
  };
}

export function parseEpisode(v: unknown): EpisodeRecord | null {
  if (!isRecord(v)) return null;
  const seq = num(v.seq);
  const requestId = optStr(v.requestId);
  if (seq === null || !requestId) return null;
  const d = isRecord(v.decision) ? v.decision : null;
  const z = d && isRecord(d.zeroG) ? d.zeroG : null;
  return {
    seq,
    at: str(v.at),
    requestId,
    outcome: str(v.outcome, 'proposed') as EpisodeRecord['outcome'],
    actions: parseActions(v.actions),
    receipts: arr(v.receipts).filter((x): x is string => typeof x === 'string'),
    rootHash: optStr(v.rootHash),
    txHash: optStr(v.txHash),
    decision: d
      ? {
          signal: signal(d.signal),
          confidence: num(d.confidence) ?? 0,
          rationale: str(d.rationale),
          zeroG: z
            ? {
                completionId: optStr(z.completionId) ?? null,
                traceRequestId: optStr(z.traceRequestId) ?? null,
                headerRequestId: optStr(z.headerRequestId) ?? null,
                model: str(z.model),
                provider: optStr(z.provider) ?? null,
                attempts: num(z.attempts) ?? 1,
              }
            : undefined,
        }
      : undefined,
  };
}

export function parseAlert(v: unknown): Alert | null {
  if (!isRecord(v)) return null;
  const id = optStr(v.id);
  if (!id) return null;
  return {
    id,
    text: str(v.text),
    signal: signal(v.signal),
    actions: parseActions(v.actions),
    requestId: str(v.requestId),
    confidence: num(v.confidence) ?? 0,
    headline: optStr(v.headline),
    status: (optStr(v.status) ?? 'pending') as Alert['status'],
    createdAt: str(v.createdAt),
    deliveredAt: optStr(v.deliveredAt),
    ackedAt: optStr(v.ackedAt),
  };
}

const nonNull = <T>(x: T | null): x is T => x !== null;

export function parseSnapshot(v: unknown): PodSnapshot | null {
  if (!isRecord(v)) return null;
  const credibility: Record<string, SourceCredibility> = {};
  if (isRecord(v.credibility)) {
    for (const [k, c] of Object.entries(v.credibility)) {
      const parsed = parseCredibility(c);
      if (parsed) credibility[k] = parsed;
    }
  }
  const last = parseDecision(v.lastDecision);
  return {
    news: arr(v.news).map(parseNews).filter(nonNull),
    credibility,
    lastDecision: last ? stripActions(last) : null,
    plannedActions: parseActions(v.plannedActions),
    orders: arr(v.orders).map(parseOrder).filter(nonNull),
    swaps: arr(v.swaps).map(parseSwap).filter(nonNull),
    episodes: arr(v.episodes).map(parseEpisode).filter(nonNull),
    safeStop: v.safeStop === true,
    alerts: arr(v.alerts).map(parseAlert).filter(nonNull),
  };
}

function stripActions(d: DecisionEvent): PodSnapshot['lastDecision'] {
  const { actions: _actions, ...rest } = d;
  return rest;
}

const TRACKS: readonly Track[] = ['0g', 'hedera', 'uniswap', 'hyperliquid', 'data', 'audio'];
const PROVIDER_STATES: readonly ProviderState[] = ['live', 'degraded', 'offline', 'not_configured'];

export function parseProviders(v: unknown): ProvidersStatus | null {
  if (!isRecord(v) || !Array.isArray(v.providers)) return null;
  const providers: ProviderStatus[] = records(v.providers).flatMap((p) => {
    const id = optStr(p.id);
    if (!id) return [];
    const track = TRACKS.includes(p.track as Track) ? (p.track as Track) : 'data';
    const state = PROVIDER_STATES.includes(p.state as ProviderState) ? (p.state as ProviderState) : 'offline';
    return [
      {
        id,
        label: str(p.label, id),
        track,
        state,
        detail: str(p.detail),
        missingEnv: arr(p.missingEnv).filter((x): x is string => typeof x === 'string'),
        lastOkAt: optStr(p.lastOkAt),
        latencyMs: num(p.latencyMs) ?? undefined,
      },
    ];
  });
  return { providers };
}

export function parseMarketSnapshot(v: unknown): MarketSnapshot | null {
  if (!isRecord(v) || !Array.isArray(v.assets)) return null;
  const assets: MarketAsset[] = records(v.assets).flatMap((a) => {
    const coin = optStr(a.coin);
    if (!coin) return [];
    return [
      {
        coin,
        dex: str(a.dex),
        label: str(a.label, coin),
        mid: num(a.mid),
        prevDayPx: num(a.prevDayPx),
        change24hPct: num(a.change24hPct),
        funding: num(a.funding),
        openInterest: num(a.openInterest),
        openInterestUsd: num(a.openInterestUsd),
        volume24h: num(a.volume24h),
      },
    ];
  });
  return {
    network: v.network === 'mainnet' ? 'mainnet' : 'testnet',
    ts: str(v.ts),
    assets,
    missing: arr(v.missing).filter((x): x is string => typeof x === 'string'),
  };
}

/** Candles from GET /market/history. Accepts numbers or numeric strings (raw candleSnapshot uses strings). */
export function parseMarketHistory(v: unknown): MarketHistory | null {
  if (!isRecord(v) || !Array.isArray(v.candles)) return null;
  const candles: Candle[] = records(v.candles).flatMap((c) => {
    const t = num(c.t);
    const close = num(c.c);
    if (t === null || close === null) return [];
    return [{ t, o: num(c.o) ?? close, h: num(c.h) ?? close, l: num(c.l) ?? close, c: close, v: num(c.v) ?? 0 }];
  });
  candles.sort((a, b) => a.t - b.t);
  return { network: v.network === 'mainnet' ? 'mainnet' : 'testnet', coin: str(v.coin), interval: str(v.interval, '1h'), candles };
}

export function parseMarketTick(v: unknown): MarketTick | null {
  if (!isRecord(v) || !isRecord(v.mids)) return null;
  const mids: Record<string, number> = {};
  for (const [coin, px] of Object.entries(v.mids)) {
    const n = num(px);
    if (n !== null && n > 0) mids[coin] = n;
  }
  return { ts: str(v.ts, new Date().toISOString()), mids };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export class GhostyClient {
  constructor(private settings: ClientSettings = DEFAULT_SETTINGS) {}

  configure(settings: ClientSettings): void {
    this.settings = { ...settings, baseUrl: normalizeBaseUrl(settings.baseUrl) };
  }

  url(path: string): string {
    return `${this.settings.baseUrl}${path}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (this.settings.deviceToken) h['x-device-token'] = this.settings.deviceToken;
    return h;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    parse: (body: unknown) => T | null,
    body?: unknown,
  ): Promise<ApiResult<T>> {
    let res: Response;
    try {
      res = await fetch(this.url(path), {
        method,
        headers: this.headers(body === undefined ? {} : { 'content-type': 'application/json' }),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      return { ok: false, kind: 'network', status: 0, message: errorText(err) };
    }
    return toResult(res, parse);
  }

  health() {
    return this.request<HealthResponse>('GET', '/health', (b) =>
      isRecord(b) ? { ok: b.ok === true, version: str(b.version), safeStop: b.safeStop === true } : null,
    );
  }
  state() {
    return this.request('GET', '/state', parseSnapshot);
  }
  providers() {
    return this.request('GET', '/providers/status', parseProviders);
  }
  marketSnapshot() {
    return this.request('GET', '/market/snapshot', parseMarketSnapshot);
  }
  marketHistory(coin: string, hours = 24, interval = '1h') {
    const q = new URLSearchParams({ coin, interval, hours: String(hours) });
    return this.request('GET', `/market/history?${q.toString()}`, parseMarketHistory);
  }
  zeroG() {
    return this.request<ZeroGStatus>('GET', '/zerog/status', (b) => (isRecord(b) ? (b as unknown as ZeroGStatus) : null));
  }
  x402() {
    return this.request<X402Status>('GET', '/x402/status', (b) => (isRecord(b) ? (b as unknown as X402Status) : null));
  }
  executionMarkets() {
    return this.request<ExecutionMarkets>('GET', '/execution/markets?limit=1', (b) =>
      isRecord(b) ? (b as unknown as ExecutionMarkets) : null,
    );
  }
  injectNews(title: string, source?: string) {
    return this.request<InjectResult>(
      'POST',
      '/news/inject',
      (b) => (isRecord(b) && isRecord(b.decision) ? (b as unknown as InjectResult) : null),
      source ? { title, source } : { title },
    );
  }
  button(action: 'confirm' | 'cancel') {
    return this.request<ButtonResult>(
      'POST',
      '/button',
      (b) => (isRecord(b) && typeof b.requestId === 'string' ? (b as unknown as ButtonResult) : null),
      { action },
    );
  }
  safeStop(enabled: boolean) {
    return this.request<SafeStopResult>(
      'POST',
      '/sim/safe-stop',
      (b) => (isRecord(b) ? { safeStop: b.safeStop === true, simulateOffline: b.simulateOffline === true } : null),
      { enabled },
    );
  }
  paySignal() {
    return this.request<PaySignalResult>(
      'POST',
      '/sim/pay-signal',
      (b) => (isRecord(b) && typeof b.txId === 'string' ? (b as unknown as PaySignalResult) : null),
      {},
    );
  }
  ackAlert(id: string) {
    return this.request('POST', `/alerts/${encodeURIComponent(id)}/ack`, (b) => (isRecord(b) ? parseAlert(b.alert) : null), {});
  }
  /** Pop the oldest pending alert (marks it delivered, like the pod's poll). `alert: null` on 204. */
  alertsNext() {
    return this.request<{ alert: Alert | null }>('GET', '/alerts/next', (b) => ({ alert: parseAlert(b) }));
  }
  voiceText(text: string) {
    return this.request<TextTurnResult>(
      'POST',
      '/voice/text',
      (b) => (isRecord(b) && typeof b.requestId === 'string' ? (b as unknown as TextTurnResult) : null),
      { text },
    );
  }

  /** WAV in, raw PCM s16le out. Measures the round trip for the pod dock. */
  async voice(wav: ArrayBuffer): Promise<ApiResult<VoiceReply>> {
    const t0 = performance.now();
    let res: Response;
    try {
      res = await fetch(this.url('/voice'), {
        method: 'POST',
        headers: this.headers({ 'content-type': 'audio/wav' }),
        body: wav,
      });
    } catch (err) {
      return { ok: false, kind: 'network', status: 0, message: errorText(err) };
    }
    if (!res.ok) return toResult<VoiceReply>(res, () => null);
    const pcm = await res.arrayBuffer();
    return {
      ok: true,
      status: res.status,
      data: {
        pcm,
        sampleRate: Number(res.headers.get('x-sample-rate')) || 16000,
        requestId: res.headers.get('x-request-id') ?? '',
        signal: res.headers.get('x-signal') ?? 'none',
        latencyMs: Math.round(performance.now() - t0),
      },
    };
  }
}

/** Map an HTTP response to an ApiResult. Exported for tests. */
export async function toResult<T>(res: Response, parse: (body: unknown) => T | null): Promise<ApiResult<T>> {
  let body: unknown = null;
  const text = await res.text().catch(() => '');
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  const code = isRecord(body) ? str(body.error) : '';
  const message = isRecord(body) ? str(body.message) || code : typeof body === 'string' ? body.slice(0, 200) : '';

  if (res.ok) {
    const data = parse(body);
    if (data === null) return { ok: false, kind: 'parse', status: res.status, message: 'unexpected response shape' };
    return { ok: true, status: res.status, data };
  }
  // A provider without keys (live mode): 503 {error:"not_configured", provider, missingEnv},
  // or brain_offline with reason "not_configured" when the 0G router key is missing.
  const reason = isRecord(body) ? str(body.reason) : '';
  if (code === 'not_configured' || reason === 'not_configured') {
    const missingEnv = isRecord(body) ? arr(body.missingEnv).filter((x): x is string => typeof x === 'string') : [];
    const provider = isRecord(body) ? optStr(body.provider) : undefined;
    return { ok: false, kind: 'not_configured', status: res.status, message: message || code, provider, missingEnv };
  }
  // A bare framework 404 means the route does not exist yet; a JSON 404 with our own error code is a real answer.
  if (res.status === 404 && (!code || code === 'Not Found')) {
    return { ok: false, kind: 'not_found', status: 404, message: message || 'endpoint not found' };
  }
  if (res.status === 401) return { ok: false, kind: 'unauthorized', status: 401, message: 'device token rejected' };
  if (res.status === 503 && (code === 'brain_offline' || code === 'memory_unavailable')) {
    return { ok: false, kind: 'brain_offline', status: 503, message: code };
  }
  return { ok: false, kind: 'http', status: res.status, message: message || res.statusText || `HTTP ${res.status}` };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One sentence a panel can show for a failed call. */
export function describeError(r: ApiFailure): string {
  switch (r.kind) {
    case 'not_found':
      return 'Backend upgrade pending: this endpoint is not on the server yet.';
    case 'not_configured':
      return r.missingEnv && r.missingEnv.length > 0
        ? `Not configured: set ${r.missingEnv.join(' + ')}${r.provider ? ` (${r.provider})` : ''}.`
        : `Not configured${r.provider ? `: ${r.provider}` : ''}. ${r.message}`.trim();
    case 'brain_offline':
      return r.message === 'memory_unavailable'
        ? '0G memory unavailable: trading blocked (safe-stop).'
        : 'Brain offline: trading blocked (safe-stop).';
    case 'unauthorized':
      return 'Device token rejected. Set the server’s DEVICE_TOKEN in Settings → Device token.';
    case 'network':
      return 'Server unreachable. Start it with `cd server && npm run dev`, or fix the URL in Settings.';
    case 'parse':
      return 'Server answered with an unexpected shape. Update the terminal and server to the same version.';
    default:
      return `HTTP ${r.status}: ${r.message}`;
  }
}
