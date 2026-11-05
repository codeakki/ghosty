/**
 * Hyperliquid perps, including HIP-3 builder-deployed markets on trade.xyz (dex `xyz`):
 * gold, oil, stocks, indices, 24/7, same API as crypto perps.
 * Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids
 * SDK: @nktkas/hyperliquid (InfoClient / ExchangeClient over HttpTransport).
 */
import { ExchangeClient, HttpTransport, InfoClient } from '@nktkas/hyperliquid';
import { formatPrice } from '@nktkas/hyperliquid/utils';
import { privateKeyToAccount } from 'viem/accounts';
import type { Config } from '../config.js';
import { isAddress, normalizePrivateKey } from '../wallet/account.js';

/** Hyperliquid rejects orders under $10 notional. */
export const HL_MIN_NOTIONAL_USD = 10;
export const MARKET_CACHE_MS = 5 * 60 * 1000;
export const DEFAULT_SLIPPAGE_BPS = 100;

/**
 * Asset id for a market on a builder-deployed (HIP-3) perp dex:
 *   100000 + perpDexIndex * 10000 + indexInMeta
 * perpDexIndex comes from the `perpDexs` info call (0 is the main dex, whose assets use indexInMeta directly);
 * indexInMeta is the market's position in `meta({ dex })`'s universe.
 */
export function hip3AssetId(dexIndex: number, metaIndex: number): number {
  if (!Number.isInteger(dexIndex) || dexIndex < 1) {
    throw new RangeError(`dexIndex must be an integer >= 1 for builder-deployed dexes, got ${dexIndex}`);
  }
  if (!Number.isInteger(metaIndex) || metaIndex < 0 || metaIndex >= 10000) {
    throw new RangeError(`metaIndex must be an integer in [0, 10000), got ${metaIndex}`);
  }
  return 100000 + dexIndex * 10000 + metaIndex;
}

export interface MarketOrderRequest {
  /** Hyperliquid coin ("BTC", "xyz:GOLD") or a playbook alias ("GOLD", "WTI"). */
  coin: string;
  isBuy: boolean;
  sizeUsd: number;
  /** Aggressive IOC limit at mid ± slippage. Default 100 bps. */
  slippageBps?: number;
}

export interface OrderResult {
  orderId: string;
  /** Coin actually traded (after alias resolution / fallback). */
  coin: string;
  isBuy: boolean;
  sizeUsd: number;
  status: 'simulated' | 'filled' | 'resting' | 'rejected';
  /** Coin the caller asked for, when it differs from `coin`. */
  requestedCoin?: string;
  assetId?: number;
  /** Filled size in coin units. */
  filled?: number;
  avgPx?: number;
  /** True when a missing HIP-3 market was replaced via HL_FALLBACK_COINS. */
  fallback?: boolean;
  /** app.hyperliquid(-testnet).xyz link for the order / account. */
  url?: string;
  error?: string;
}

export interface MarketInfo {
  /** Full coin name as Hyperliquid uses it: "BTC" or "xyz:GOLD". */
  coin: string;
  /** "" for the main dex. */
  dex: string;
  dexIndex: number;
  metaIndex: number;
  assetId: number;
  szDecimals: number;
  delisted: boolean;
}

export interface MarketFilter {
  /** Only this dex ("" = main dex). */
  dex?: string;
  /** Case-insensitive regex or substring matched against the coin name. */
  query?: string | RegExp;
  includeDelisted?: boolean;
}

export interface PerpVenue {
  placeMarketOrder(req: MarketOrderRequest): Promise<OrderResult>;
  listMarkets(filter?: MarketFilter): Promise<MarketInfo[]>;
}

/** Fake venue: deterministic incrementing order ids, never touches the network. */
export class FakeHyperliquid implements PerpVenue {
  private nextId = 1;

  async placeMarketOrder(req: MarketOrderRequest): Promise<OrderResult> {
    const orderId = `fake-hl-${String(this.nextId++).padStart(6, '0')}`;
    return { orderId, coin: req.coin, isBuy: req.isBuy, sizeUsd: req.sizeUsd, status: 'simulated' };
  }

  async listMarkets(filter: MarketFilter = {}): Promise<MarketInfo[]> {
    return filterMarkets(FAKE_MARKETS, filter);
  }
}

const FAKE_MARKETS: MarketInfo[] = [
  { coin: 'BTC', dex: '', dexIndex: 0, metaIndex: 0, assetId: 0, szDecimals: 5, delisted: false },
  { coin: 'ETH', dex: '', dexIndex: 0, metaIndex: 1, assetId: 1, szDecimals: 4, delisted: false },
  { coin: 'xyz:TSLA', dex: 'xyz', dexIndex: 1, metaIndex: 1, assetId: 110001, szDecimals: 3, delisted: false },
  { coin: 'xyz:GOLD', dex: 'xyz', dexIndex: 1, metaIndex: 3, assetId: 110003, szDecimals: 4, delisted: false },
  { coin: 'xyz:CL', dex: 'xyz', dexIndex: 1, metaIndex: 29, assetId: 110029, szDecimals: 3, delisted: false },
];

// ---------------------------------------------------------------------------
// Market map

/** Minimal views of the SDK clients (structural, so tests can pass fakes). */
export interface HlInfoApi {
  perpDexs(): Promise<Array<{ name: string } | null>>;
  meta(params: { dex?: string }): Promise<{ universe: Array<{ name: string; szDecimals: number; isDelisted?: boolean }> }>;
  allMids(params: { dex?: string }): Promise<Record<string, string>>;
}

export interface HlOrderParams {
  orders: Array<{ a: number; b: boolean; p: string; s: string; r: boolean; t: { limit: { tif: 'Ioc' } } }>;
  grouping: 'na';
}

type HlOrderStatus =
  | { resting: { oid: number } }
  | { filled: { totalSz: string; avgPx: string; oid: number } }
  | { error: string }
  | 'waitingForFill'
  | 'waitingForTrigger';

export interface HlExchangeApi {
  order(params: HlOrderParams): Promise<{ response: { data: { statuses: HlOrderStatus[] } } }>;
}

/** HIP-3 coin names already carry the dex prefix ("xyz:GOLD"); add it if a deployer ever omits it. */
function coinName(dex: string, name: string): string {
  return dex === '' || name.includes(':') ? name : `${dex}:${name}`;
}

/** Ticker without the dex prefix: "xyz:GOLD" → "GOLD". */
export function tickerOf(coin: string): string {
  const i = coin.indexOf(':');
  return (i === -1 ? coin : coin.slice(i + 1)).toUpperCase();
}

/**
 * Build {coin → market} from `perpDexs` + `meta({dex})`. Only the main dex and `dexes` are loaded:
 * testnet lists 250+ builder dexes and info calls are rate limited.
 */
export async function buildMarketMap(info: Pick<HlInfoApi, 'perpDexs' | 'meta'>, dexes: string[]): Promise<Map<string, MarketInfo>> {
  const all = await info.perpDexs();
  const wanted: Array<{ dex: string; dexIndex: number }> = [{ dex: '', dexIndex: 0 }];
  for (const dex of dexes) {
    const dexIndex = all.findIndex((d, i) => i > 0 && d?.name === dex);
    if (dexIndex > 0) wanted.push({ dex, dexIndex });
  }
  const metas = await Promise.all(wanted.map((w) => info.meta(w.dex ? { dex: w.dex } : {})));
  const map = new Map<string, MarketInfo>();
  wanted.forEach(({ dex, dexIndex }, i) => {
    metas[i]?.universe.forEach((u, metaIndex) => {
      const coin = coinName(dex, u.name);
      map.set(coin, {
        coin,
        dex,
        dexIndex,
        metaIndex,
        assetId: dexIndex === 0 ? metaIndex : hip3AssetId(dexIndex, metaIndex),
        szDecimals: u.szDecimals,
        delisted: Boolean(u.isDelisted),
      });
    });
  });
  return map;
}

function filterMarkets(markets: Iterable<MarketInfo>, filter: MarketFilter): MarketInfo[] {
  const re =
    filter.query === undefined ? undefined : filter.query instanceof RegExp ? filter.query : new RegExp(escapeRe(filter.query), 'i');
  return [...markets].filter(
    (m) =>
      (filter.dex === undefined || m.dex === filter.dex) &&
      (filter.includeDelisted || !m.delisted) &&
      (re === undefined || re.test(m.coin)),
  );
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------------------
// Alias resolution

/**
 * Playbook aliases → where to look. Patterns are anchored on the ticker (after "dex:"):
 * an unanchored /CL/ would hit "xyz:CRCL" (Circle) before "xyz:CL" (WTI crude).
 * Verified 2026-11-06: trade.xyz lists gold as xyz:GOLD and WTI as xyz:CL on testnet and mainnet (no "WTI" ticker).
 */
export const COIN_ALIASES: Record<string, { dex: string; ticker: RegExp }> = {
  GOLD: { dex: 'xyz', ticker: /^(GOLD|XAU|XAUUSD)$/ },
  WTI: { dex: 'xyz', ticker: /^(WTI|CL|USOIL|WTIOIL|OIL)$/ },
  BTC: { dex: '', ticker: /^BTC$/ },
};

/** "GOLD=BTC,WTI=ETH" → { GOLD: 'BTC', WTI: 'ETH' }. Keys are upper-cased aliases. */
export function parseFallbackCoins(spec: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (spec ?? '').split(',')) {
    const [k, v] = pair.split('=').map((x) => x.trim());
    if (k && v) out[k.toUpperCase()] = v;
  }
  return out;
}

export interface ResolvedCoin {
  market: MarketInfo;
  fallback: boolean;
}

export class UnknownMarketError extends Error {
  constructor(readonly coin: string) {
    super(`no Hyperliquid market for "${coin}" on this network (set HL_FALLBACK_COINS, e.g. "GOLD=BTC")`);
    this.name = 'UnknownMarketError';
  }
}

/** Pure resolver over a market map. Exact coin → alias pattern → HL_FALLBACK_COINS. */
export function resolveCoinIn(markets: Map<string, MarketInfo>, input: string, fallbacks: Record<string, string>): ResolvedCoin {
  const live = (m: MarketInfo | undefined) => (m && !m.delisted ? m : undefined);

  const exact = live(markets.get(input));
  if (exact) return { market: exact, fallback: false };

  const alias = tickerOf(input);
  const rule = COIN_ALIASES[alias];
  if (rule) {
    for (const m of markets.values()) {
      if (m.dex === rule.dex && !m.delisted && rule.ticker.test(tickerOf(m.coin))) return { market: m, fallback: false };
    }
  }

  const fb = fallbacks[alias] ?? fallbacks[input.toUpperCase()];
  if (fb) {
    const target = live(markets.get(fb));
    if (target) return { market: target, fallback: true };
  }
  throw new UnknownMarketError(input);
}

// ---------------------------------------------------------------------------
// Sizing

/**
 * Size in coin units for `sizeUsd` at `px`, rounded to szDecimals. If the rounded size is worth less than
 * the venue minimum at `checkPx` (default `px`), bump it to the smallest size that clears it. Returns 0 if impossible.
 */
export function sizeForNotional(
  sizeUsd: number,
  px: number,
  szDecimals: number,
  minNotionalUsd = HL_MIN_NOTIONAL_USD,
  checkPx = px,
): number {
  if (!(px > 0) || !(checkPx > 0) || !(sizeUsd > 0)) return 0;
  const lots = 10 ** szDecimals;
  let units = Math.round((sizeUsd / px) * lots);
  if ((units / lots) * checkPx < minNotionalUsd) units = Math.ceil((minNotionalUsd / checkPx) * lots);
  return units / lots;
}

function formatSz(sz: number, szDecimals: number): string {
  return sz.toFixed(szDecimals).replace(/\.?0+$/, '') || '0';
}

// ---------------------------------------------------------------------------
// Real venue

export interface HyperliquidVenueOptions {
  info: HlInfoApi;
  /** Omit for a read-only venue (hl:check, sim). */
  exchange?: HlExchangeApi;
  testnet: boolean;
  masterAddress?: string;
  dexes?: string[];
  fallbackCoins?: Record<string, string>;
  now?: () => number;
}

export function appUrl(testnet: boolean): string {
  return testnet ? 'https://app.hyperliquid-testnet.xyz' : 'https://app.hyperliquid.xyz';
}

export class HyperliquidVenue implements PerpVenue {
  private cache: { at: number; markets: Map<string, MarketInfo> } | undefined;
  private readonly now: () => number;

  constructor(private readonly opts: HyperliquidVenueOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Market map, refreshed every 5 min. */
  async markets(): Promise<Map<string, MarketInfo>> {
    if (!this.cache || this.now() - this.cache.at > MARKET_CACHE_MS) {
      this.cache = { at: this.now(), markets: await buildMarketMap(this.opts.info, this.opts.dexes ?? ['xyz']) };
    }
    return this.cache.markets;
  }

  async listMarkets(filter: MarketFilter = {}): Promise<MarketInfo[]> {
    return filterMarkets((await this.markets()).values(), filter);
  }

  async resolveCoin(alias: string): Promise<ResolvedCoin> {
    return resolveCoinIn(await this.markets(), alias, this.opts.fallbackCoins ?? {});
  }

  async mid(market: MarketInfo): Promise<number | undefined> {
    const mids = await this.opts.info.allMids(market.dex ? { dex: market.dex } : {});
    const px = Number(mids[market.coin]);
    return Number.isFinite(px) && px > 0 ? px : undefined;
  }

  async placeMarketOrder(req: MarketOrderRequest): Promise<OrderResult> {
    const base = { coin: req.coin, isBuy: req.isBuy, sizeUsd: req.sizeUsd };
    const reject = (error: string, extra: Partial<OrderResult> = {}): OrderResult => ({
      ...base,
      ...extra,
      orderId: '',
      status: 'rejected',
      error,
    });

    if (!(req.sizeUsd >= HL_MIN_NOTIONAL_USD)) {
      return reject(`order notional $${req.sizeUsd} is below the Hyperliquid minimum of $${HL_MIN_NOTIONAL_USD}`);
    }
    if (!this.opts.exchange) return reject('read-only venue: HL_AGENT_PRIVATE_KEY is not set');

    let resolved: ResolvedCoin;
    try {
      resolved = await this.resolveCoin(req.coin);
    } catch (err) {
      return reject((err as Error).message);
    }
    const { market, fallback } = resolved;
    const tagged: Partial<OrderResult> = {
      coin: market.coin,
      assetId: market.assetId,
      ...(market.coin !== req.coin ? { requestedCoin: req.coin } : {}),
      ...(fallback ? { fallback: true } : {}),
      url: this.url(market.coin),
    };

    const mid = await this.mid(market);
    if (mid === undefined) return reject(`no mid price for ${market.coin}`, tagged);

    const bps = req.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
    const limitPx = Number(formatPrice(mid * (1 + ((req.isBuy ? 1 : -1) * bps) / 10000), market.szDecimals, 'perp'));
    // Size from mid; check the minimum at the worse of mid and limit, so a sell at mid − slippage still clears $10.
    const sz = sizeForNotional(req.sizeUsd, mid, market.szDecimals, HL_MIN_NOTIONAL_USD, Math.min(mid, limitPx));
    if (sz <= 0) return reject(`size rounds to 0 for ${market.coin} at ${mid}`, tagged);

    try {
      const res = await this.opts.exchange.order({
        orders: [
          {
            a: market.assetId,
            b: req.isBuy,
            p: String(limitPx),
            s: formatSz(sz, market.szDecimals),
            r: false,
            t: { limit: { tif: 'Ioc' } },
          },
        ],
        grouping: 'na',
      });
      const status = res.response.data.statuses[0];
      if (status && typeof status === 'object' && 'filled' in status) {
        return {
          ...base,
          ...tagged,
          orderId: String(status.filled.oid),
          status: 'filled',
          filled: Number(status.filled.totalSz),
          avgPx: Number(status.filled.avgPx),
        };
      }
      if (status && typeof status === 'object' && 'resting' in status) {
        return { ...base, ...tagged, orderId: String(status.resting.oid), status: 'resting' };
      }
      if (status && typeof status === 'object' && 'error' in status) return reject(status.error, tagged);
      return reject(`unexpected order status ${JSON.stringify(status)}`, tagged);
    } catch (err) {
      // The SDK throws ApiRequestError for error statuses, e.g. an IOC that found no liquidity inside the slippage band.
      return reject((err as Error).message, tagged);
    }
  }

  private url(coin: string): string {
    const app = appUrl(this.opts.testnet);
    return this.opts.masterAddress ? `${app}/explorer/address/${this.opts.masterAddress}` : `${app}/trade/${encodeURIComponent(coin)}`;
  }
}

/** SDK clients for the configured network. `exchange` only when an agent key is set. */
export function createHyperliquidClients(config: Pick<Config, 'HL_TESTNET' | 'HL_AGENT_PRIVATE_KEY'>): {
  info: InfoClient;
  exchange?: ExchangeClient;
} {
  const transport = new HttpTransport({ isTestnet: config.HL_TESTNET });
  const info = new InfoClient({ transport });
  const key = normalizePrivateKey(config.HL_AGENT_PRIVATE_KEY);
  // The API (agent) wallet signs; the master holds funds and must have approved this agent.
  const exchange = key ? new ExchangeClient({ transport, wallet: privateKeyToAccount(key) }) : undefined;
  return { info, exchange };
}

export function hyperliquidVenueOptions(
  config: Pick<Config, 'HL_TESTNET' | 'HL_AGENT_PRIVATE_KEY' | 'HL_MASTER_ADDRESS' | 'HL_DEXES' | 'HL_FALLBACK_COINS'>,
): HyperliquidVenueOptions {
  const { info, exchange } = createHyperliquidClients(config);
  return {
    info,
    exchange,
    testnet: config.HL_TESTNET,
    masterAddress: isAddress(config.HL_MASTER_ADDRESS) ? config.HL_MASTER_ADDRESS : undefined,
    dexes: config.HL_DEXES.split(',').map((d) => d.trim()).filter(Boolean),
    fallbackCoins: parseFallbackCoins(config.HL_FALLBACK_COINS),
  };
}

/** Real venue when HL_AGENT_PRIVATE_KEY and HL_MASTER_ADDRESS are set, else the fake. */
export function createPerpVenue(
  config: Pick<Config, 'HL_TESTNET' | 'HL_AGENT_PRIVATE_KEY' | 'HL_MASTER_ADDRESS' | 'HL_DEXES' | 'HL_FALLBACK_COINS'>,
): PerpVenue {
  if (!normalizePrivateKey(config.HL_AGENT_PRIVATE_KEY) || !isAddress(config.HL_MASTER_ADDRESS)) return new FakeHyperliquid();
  return new HyperliquidVenue(hyperliquidVenueOptions(config));
}
