/**
 * Live market data for the terminal, read from the Hyperliquid info API with no keys.
 *
 * Network: MARKET_DATA_NETWORK (default mainnet, read-only real prices). Execution follows HL_TESTNET; the
 * snapshot labels both so a mainnet price is never mistaken for the testnet book the orders hit.
 *
 * Sources:
 *  - mids: websocket `allMids` (one subscription per dex: main + each HIP-3 dex in the watchlist), reconnect with
 *    backoff; while the socket is down, POST /info {type:"allMids", dex} every 2 s.
 *  - context: POST /info {type:"metaAndAssetCtxs", dex} every 30 s (prevDayPx, funding, openInterest, dayNtlVlm),
 *    which also resolves which watchlist coins exist. Missing or delisted coins are reported, never invented.
 *  - history: POST /info {type:"candleSnapshot"} on demand.
 * Nothing starts in the constructor: index.ts calls start(); routes work on demand without it.
 */

export type MarketNetwork = 'mainnet' | 'testnet';

export const HL_INFO_URL: Record<MarketNetwork, string> = {
  mainnet: 'https://api.hyperliquid.xyz/info',
  testnet: 'https://api.hyperliquid-testnet.xyz/info',
};
export const HL_WS_URL: Record<MarketNetwork, string> = {
  mainnet: 'wss://api.hyperliquid.xyz/ws',
  testnet: 'wss://api.hyperliquid-testnet.xyz/ws',
};

export const POLL_MIDS_MS = 2_000;
export const CTX_REFRESH_MS = 30_000;
export const EMIT_THROTTLE_MS = 1_000;
export const INFO_TIMEOUT_MS = 8_000;
const WS_PING_MS = 50_000;
const WS_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

export const CANDLE_INTERVALS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d', '3d', '1w', '1M'] as const;
export type CandleInterval = (typeof CANDLE_INTERVALS)[number];

/** Display names for the default watchlist; anything else shows its ticker. */
export const MARKET_LABELS: Record<string, string> = {
  BTC: 'Bitcoin',
  ETH: 'Ether',
  SOL: 'Solana',
  'xyz:GOLD': 'Gold',
  'xyz:SILVER': 'Silver',
  'xyz:CL': 'WTI crude oil',
  'xyz:BRENTOIL': 'Brent crude oil',
  'xyz:TSLA': 'Tesla',
  'xyz:NVDA': 'Nvidia',
  'xyz:SPX': 'S&P 500',
  'xyz:SP500': 'S&P 500',
  'xyz:XYZ100': 'XYZ 100 (Nasdaq-100 style index)',
};

export interface MarketAsset {
  /** Hyperliquid coin, e.g. "BTC" or "xyz:GOLD". */
  coin: string;
  /** "" for the main dex, else the HIP-3 dex name ("xyz"). */
  dex: string;
  label: string;
  mid: number | null;
  prevDayPx: number | null;
  /** (mid − prevDayPx) / prevDayPx × 100, 2 decimals. null without both prices. */
  change24hPct: number | null;
  /** Hourly funding rate (fraction, e.g. 0.0000125). */
  funding: number | null;
  /** Open interest in coin units, as Hyperliquid reports it. */
  openInterest: number | null;
  /** openInterest × mid, USD. */
  openInterestUsd: number | null;
  /** 24 h notional volume, USD (dayNtlVlm). */
  volume24h: number | null;
}

export interface MarketSnapshot {
  /** Where these prices come from (MARKET_DATA_NETWORK). */
  network: MarketNetwork;
  /** Where orders go (HL_TESTNET). */
  executionNetwork: MarketNetwork;
  ts: string;
  /** "ws" while the websocket is up, "poll" while polling, "rest" for on-demand fetches before start(). */
  source: 'ws' | 'poll' | 'rest';
  assets: MarketAsset[];
  /** Watchlist coins that do not exist (or are delisted) on `network`. */
  missing: string[];
}

export interface Candle {
  /** Open time, ms. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Base-asset volume. */
  v: number;
  /** Trade count. */
  n: number;
}

export interface MarketHistory {
  network: MarketNetwork;
  coin: string;
  interval: CandleInterval;
  candles: Candle[];
}

export interface MidsEvent {
  ts: string;
  /** Watchlist coin → mid. */
  mids: Record<string, number>;
}

export class MarketDataError extends Error {
  override readonly name = 'MarketDataError';
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export class UnknownCoinError extends Error {
  override readonly name = 'UnknownCoinError';
  constructor(readonly coin: string) {
    super(`unknown coin "${coin}"`);
  }
}

/** Minimal WebSocket surface (Node 22+ global WebSocket, or a test double). */
export interface WsLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}
export type WsFactory = (url: string) => WsLike;

export interface MarketLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

export interface MarketServiceOptions {
  network: MarketNetwork;
  executionNetwork: MarketNetwork;
  watchlist: string[];
  fetch?: typeof fetch;
  /** null disables the websocket (poll only). Default: global WebSocket when present. */
  webSocket?: WsFactory | null;
  now?: () => number;
  logger?: MarketLogger;
  infoUrl?: string;
  wsUrl?: string;
}

interface AssetCtx {
  dex: string;
  delisted: boolean;
  prevDayPx: number | null;
  funding: number | null;
  openInterest: number | null;
  dayNtlVlm: number | null;
  midPx: number | null;
}

type RawCtx = { prevDayPx?: string; funding?: string; openInterest?: string; dayNtlVlm?: string; midPx?: string | null; markPx?: string };
type RawMeta = { universe: Array<{ name: string; isDelisted?: boolean }> };

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** "xyz:GOLD" → "xyz"; "BTC" → "". */
export function dexOf(coin: string): string {
  const i = coin.indexOf(':');
  return i === -1 ? '' : coin.slice(0, i);
}

/** Percent change, rounded to 2 decimals. null when either price is missing or prevDayPx is 0. */
export function change24hPct(mid: number | null, prevDayPx: number | null): number | null {
  if (mid === null || prevDayPx === null || prevDayPx === 0) return null;
  return Math.round(((mid - prevDayPx) / prevDayPx) * 10000) / 100;
}

const noopLogger: MarketLogger = { info: () => {}, warn: () => {} };

export class MarketService {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly logger: MarketLogger;
  private readonly infoUrl: string;
  private readonly wsUrl: string;
  private readonly wsFactory: WsFactory | null;
  /** Dexes to load: "" plus every HIP-3 prefix in the watchlist. */
  readonly dexes: string[];

  private ctx = new Map<string, AssetCtx>();
  private ctxAt = 0;
  private mids = new Map<string, number>();
  private source: MarketSnapshot['source'] = 'rest';
  private running = false;
  private ws: WsLike | undefined;
  private wsUp = false;
  private wsAttempt = 0;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private ctxTimer: ReturnType<typeof setInterval> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private listeners = new Set<(e: MidsEvent) => void>();
  private lastEmit = 0;
  private emitTimer: ReturnType<typeof setTimeout> | undefined;
  private ctxInFlight: Promise<void> | undefined;

  constructor(private readonly opts: MarketServiceOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.logger = opts.logger ?? noopLogger;
    this.infoUrl = opts.infoUrl ?? HL_INFO_URL[opts.network];
    this.wsUrl = opts.wsUrl ?? HL_WS_URL[opts.network];
    const globalWs = (globalThis as { WebSocket?: new (url: string) => WsLike }).WebSocket;
    this.wsFactory = opts.webSocket === undefined ? (globalWs ? (url) => new globalWs(url) : null) : opts.webSocket;
    this.dexes = ['', ...new Set(opts.watchlist.map(dexOf).filter((d) => d !== ''))];
  }

  get watchlist(): string[] {
    return [...this.opts.watchlist];
  }

  // ---------------------------------------------------------------- info API

  private async info<T>(body: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.infoUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(INFO_TIMEOUT_MS),
      });
    } catch (err) {
      throw new MarketDataError(`Hyperliquid info ${String(body.type)} failed: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new MarketDataError(`Hyperliquid info ${String(body.type)} ${res.status}: ${detail}`, res.status);
    }
    return (await res.json()) as T;
  }

  /** metaAndAssetCtxs for every dex: resolves the watchlist and refreshes 24 h context. */
  async refreshContext(): Promise<void> {
    this.ctxInFlight ??= (async () => {
      const results = await Promise.all(
        this.dexes.map((dex) => this.info<[RawMeta, RawCtx[]]>({ type: 'metaAndAssetCtxs', ...(dex ? { dex } : {}) })),
      );
      const next = new Map<string, AssetCtx>();
      results.forEach(([meta, ctxs], i) => {
        const dex = this.dexes[i] ?? '';
        meta.universe.forEach((u, j) => {
          const c = ctxs[j] ?? {};
          const coin = dex && !u.name.includes(':') ? `${dex}:${u.name}` : u.name;
          next.set(coin, {
            dex,
            delisted: Boolean(u.isDelisted),
            prevDayPx: num(c.prevDayPx),
            funding: num(c.funding),
            openInterest: num(c.openInterest),
            dayNtlVlm: num(c.dayNtlVlm),
            midPx: num(c.midPx ?? c.markPx),
          });
        });
      });
      this.ctx = next;
      this.ctxAt = this.now();
    })().finally(() => {
      this.ctxInFlight = undefined;
    });
    return this.ctxInFlight;
  }

  /** allMids for every dex (REST). */
  async refreshMids(): Promise<void> {
    const all = await Promise.all(this.dexes.map((dex) => this.info<Record<string, string>>({ type: 'allMids', ...(dex ? { dex } : {}) })));
    for (const mids of all) this.applyMids(mids);
  }

  private applyMids(raw: Record<string, unknown>): void {
    let changed = false;
    for (const coin of this.opts.watchlist) {
      const px = num(raw[coin]);
      if (px !== null && px > 0 && this.mids.get(coin) !== px) {
        this.mids.set(coin, px);
        changed = true;
      }
    }
    if (changed) this.scheduleEmit();
  }

  // ---------------------------------------------------------------- snapshot

  /** Current snapshot. Fetches context and mids first when there is no data yet (or the context is stale). */
  async snapshot(): Promise<MarketSnapshot> {
    if (this.ctx.size === 0 || this.now() - this.ctxAt > CTX_REFRESH_MS * 2) await this.refreshContext();
    if (!this.running || this.mids.size === 0) await this.refreshMids().catch((err: unknown) => this.logger.warn({ err }, 'allMids failed'));
    return this.buildSnapshot();
  }

  buildSnapshot(): MarketSnapshot {
    const assets: MarketAsset[] = [];
    const missing: string[] = [];
    for (const coin of this.opts.watchlist) {
      const c = this.ctx.get(coin);
      if (!c || c.delisted) {
        missing.push(coin);
        continue;
      }
      const mid = this.mids.get(coin) ?? c.midPx;
      assets.push({
        coin,
        dex: c.dex,
        label: MARKET_LABELS[coin] ?? coin.slice(coin.indexOf(':') + 1),
        mid,
        prevDayPx: c.prevDayPx,
        change24hPct: change24hPct(mid, c.prevDayPx),
        funding: c.funding,
        openInterest: c.openInterest,
        openInterestUsd: c.openInterest !== null && mid !== null ? Math.round(c.openInterest * mid) : null,
        volume24h: c.dayNtlVlm !== null ? Math.round(c.dayNtlVlm) : null,
      });
    }
    return {
      network: this.opts.network,
      executionNetwork: this.opts.executionNetwork,
      ts: new Date(this.now()).toISOString(),
      source: this.running ? this.source : 'rest',
      assets,
      missing,
    };
  }

  /** Candles for the main chart. `coin` must exist on the market-data network. */
  async history(coin: string, interval: CandleInterval = '1h', hours = 24): Promise<MarketHistory> {
    if (this.ctx.size === 0) await this.refreshContext();
    const c = this.ctx.get(coin);
    if (!c || c.delisted) throw new UnknownCoinError(coin);
    const endTime = this.now();
    const startTime = endTime - Math.round(hours * 3_600_000);
    const raw = await this.info<Array<Record<string, unknown>>>({ type: 'candleSnapshot', req: { coin, interval, startTime, endTime } });
    const candles = (Array.isArray(raw) ? raw : [])
      .map((k) => ({ t: Number(k.t), o: num(k.o), h: num(k.h), l: num(k.l), c: num(k.c), v: num(k.v), n: Number(k.n ?? 0) }))
      .filter((k): k is Candle => Number.isFinite(k.t) && k.o !== null && k.h !== null && k.l !== null && k.c !== null && k.v !== null);
    return { network: this.opts.network, coin, interval, candles };
  }

  // ---------------------------------------------------------------- streaming

  /** Throttled (1/s) mids for the watchlist. Returns an unsubscribe function. */
  onMids(listener: (e: MidsEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private scheduleEmit(): void {
    if (this.listeners.size === 0 || this.emitTimer) return;
    const wait = Math.max(0, this.lastEmit + EMIT_THROTTLE_MS - this.now());
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      this.lastEmit = this.now();
      const event: MidsEvent = { ts: new Date(this.lastEmit).toISOString(), mids: Object.fromEntries(this.mids) };
      for (const l of this.listeners) l(event);
    }, wait);
  }

  /** Start streaming: context now and every 30 s, websocket mids (poll fallback). Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.refreshContext().catch((err: unknown) => this.logger.warn({ err: (err as Error).message }, 'market context refresh failed'));
    this.ctxTimer = setInterval(() => {
      this.refreshContext().catch((err: unknown) => this.logger.warn({ err: (err as Error).message }, 'market context refresh failed'));
    }, CTX_REFRESH_MS);
    this.ctxTimer.unref?.();
    if (this.wsFactory) this.connect();
    else this.startPolling();
  }

  stop(): void {
    this.running = false;
    clearInterval(this.ctxTimer);
    clearInterval(this.pingTimer);
    clearTimeout(this.emitTimer);
    this.emitTimer = undefined;
    this.stopPolling();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    const ws = this.ws;
    this.ws = undefined;
    if (ws) {
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
  }

  private startPolling(): void {
    if (this.pollTimer || !this.running) return;
    this.source = 'poll';
    const tick = () => this.refreshMids().catch((err: unknown) => this.logger.warn({ err: (err as Error).message }, 'allMids poll failed'));
    void tick();
    this.pollTimer = setInterval(tick, POLL_MIDS_MS);
    this.pollTimer.unref?.();
  }

  private stopPolling(): void {
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  private connect(): void {
    if (!this.running || !this.wsFactory) return;
    let ws: WsLike;
    try {
      ws = this.wsFactory(this.wsUrl);
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'market websocket failed to open');
      this.startPolling();
      this.reconnectLater();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.wsUp = true;
      this.wsAttempt = 0;
      for (const dex of this.dexes) {
        ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'allMids', ...(dex ? { dex } : {}) } }));
      }
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => ws.send(JSON.stringify({ method: 'ping' })), WS_PING_MS);
      this.pingTimer.unref?.();
      this.logger.info({ url: this.wsUrl, dexes: this.dexes }, 'market websocket connected');
    };
    ws.onmessage = (ev) => {
      let msg: { channel?: string; data?: { mids?: Record<string, unknown> } };
      try {
        msg = JSON.parse(String(ev.data)) as typeof msg;
      } catch {
        return;
      }
      if (msg.channel === 'allMids' && msg.data?.mids) {
        // Live data arrived: stop the REST fallback.
        if (this.pollTimer) this.stopPolling();
        this.source = 'ws';
        this.applyMids(msg.data.mids);
      }
    };
    ws.onerror = () => {
      /* onclose follows */
    };
    ws.onclose = () => {
      const wasUp = this.wsUp;
      this.wsUp = false;
      clearInterval(this.pingTimer);
      if (this.ws === ws) this.ws = undefined;
      if (!this.running) return;
      if (wasUp) this.logger.warn({}, 'market websocket closed, polling until it reconnects');
      this.startPolling();
      this.reconnectLater();
    };
  }

  private reconnectLater(): void {
    const delay = WS_BACKOFF_MS[Math.min(this.wsAttempt, WS_BACKOFF_MS.length - 1)] ?? 30_000;
    this.wsAttempt++;
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.connect();
    }, delay);
    t.unref?.();
    this.timers.add(t);
  }
}

/** Service for the configured network and watchlist. */
export function createMarketService(
  config: { MARKET_DATA_NETWORK: MarketNetwork; HL_TESTNET: boolean; MARKET_WATCHLIST: string[] },
  opts: Pick<MarketServiceOptions, 'fetch' | 'webSocket' | 'logger' | 'now'> = {},
): MarketService {
  return new MarketService({
    network: config.MARKET_DATA_NETWORK,
    executionNetwork: config.HL_TESTNET ? 'testnet' : 'mainnet',
    watchlist: config.MARKET_WATCHLIST,
    ...opts,
  });
}
