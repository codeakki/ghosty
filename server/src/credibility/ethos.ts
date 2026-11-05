/**
 * Signal credibility via Ethos Network. Not a sponsor; optional weighting layer.
 * Ethos scores run 0–2800. We map them to a 0.2–1.0 weight and a coarse level the decision loop can use.
 */
import type { Config } from '../config.js';
import type { NewsItem } from '../news/types.js';
import { sourceWeight } from './sources.js';

export type CredibilityLevel = 'untrusted' | 'questionable' | 'neutral' | 'reputable' | 'exemplary';

export interface CredibilityScore {
  handle: string;
  /** Ethos score 0–2800, or null when unknown. */
  score: number | null;
  level: CredibilityLevel;
  /** 0.2–1.0 weight from weightFromScore; UNKNOWN_WEIGHT when the score is unknown. */
  weight?: number;
  /** Ethos's own level string (e.g. "known", "renowned"), when the API returned one. */
  ethosLevel?: string;
}

export interface CredibilityScorer {
  scoreHandle(handle: string): Promise<CredibilityScore>;
  /** Optional bulk variant; weightItems uses it when present. */
  scoreHandles?(handles: string[]): Promise<Map<string, CredibilityScore>>;
}

export const MAX_ETHOS_SCORE = 2800;
export const MIN_WEIGHT = 0.2;
export const MAX_WEIGHT = 1.0;
/** Weight for a handle Ethos does not know. */
export const UNKNOWN_WEIGHT = 0.5;

/** Approximate thresholds for our coarse level; Ethos's own `level` is kept in `ethosLevel`. */
export function levelFromScore(score: number): CredibilityLevel {
  if (score < 800) return 'untrusted';
  if (score < 1200) return 'questionable';
  if (score < 1600) return 'neutral';
  if (score < 2000) return 'reputable';
  return 'exemplary';
}

/** Linear map of an Ethos score (0–2800, clamped) to a weight in 0.2–1.0. */
export function weightFromScore(score: number | null | undefined): number {
  if (score === null || score === undefined || !Number.isFinite(score)) return UNKNOWN_WEIGHT;
  const clamped = Math.min(MAX_ETHOS_SCORE, Math.max(0, score));
  return Math.round((MIN_WEIGHT + (MAX_WEIGHT - MIN_WEIGHT) * (clamped / MAX_ETHOS_SCORE)) * 1000) / 1000;
}

/** Multiplier applied to a signal's confidence. */
export function credibilityWeight(level: CredibilityLevel): number {
  switch (level) {
    case 'untrusted':
      return 0.2;
    case 'questionable':
      return 0.5;
    case 'neutral':
      return 0.8;
    case 'reputable':
      return 1.0;
    case 'exemplary':
      return 1.1;
  }
}

const unknownScore = (handle: string): CredibilityScore => ({ handle, score: null, level: 'questionable', weight: UNKNOWN_WEIGHT });

function knownScore(handle: string, score: number, ethosLevel?: string): CredibilityScore {
  return { handle, score, level: levelFromScore(score), weight: weightFromScore(score), ...(ethosLevel ? { ethosLevel } : {}) };
}

const FAKE_SCORES: Record<string, number> = {
  reuters: 2300,
  deitaone: 1900,
  coindesk: 1850,
  cointelegraph: 1500,
  watcherguru: 1300,
  randomtrader123: 600,
};

/** Deterministic fake: known outlets score high, unknown handles are "questionable". */
export class FakeEthosScorer implements CredibilityScorer {
  async scoreHandle(handle: string): Promise<CredibilityScore> {
    const score = FAKE_SCORES[handle.replace(/^@/, '').toLowerCase()];
    if (score === undefined) return unknownScore(handle);
    return knownScore(handle, score);
  }
}

export const ETHOS_API_URL = 'https://api.ethos.network/api/v2';
export const ETHOS_CACHE_TTL_MS = 60 * 60 * 1000;
/** Above this many uncached keys we use the bulk POST endpoints. */
export const ETHOS_BULK_THRESHOLD = 3;
const BULK_CHUNK = 50;

export const xUserkey = (handle: string) => `service:x.com:username:${handle.replace(/^@/, '')}`;

export interface EthosScorerOptions {
  /** X-Ethos-Client header value, e.g. ghosty@0.1.0. */
  client?: string;
  baseUrl?: string;
  ttlMs?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

type EthosBody = { score?: unknown; level?: unknown };

/**
 * Ethos API v2 scorer (no key; X-Ethos-Client header required).
 *  GET  /score/userkey?userkey=service:x.com:username:<handle>  → { score, level }  (404 = unknown user)
 *  GET  /score/address?address=0x…                               → { score, level }
 *  POST /score/userkeys  { userkeys: [...] }                     → { "<userkey>": { score, level } }
 *  POST /score/addresses { addresses: [...] }                    → { "<address>": { score, level } }
 * All four verified live on 2026-11-06. Results (including 404s) are cached in memory for 1 h.
 * Network errors and 5xx return "unknown" and are not cached, so the scorer never blocks a decision.
 */
export class EthosScorer implements CredibilityScorer {
  private readonly cache = new Map<string, { at: number; value: { score: number | null; level?: string } }>();
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: EthosScorerOptions = {}) {
    this.base = (opts.baseUrl ?? ETHOS_API_URL).replace(/\/$/, '');
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  private headers(json = false): Record<string, string> {
    return { 'X-Ethos-Client': this.opts.client ?? 'ghosty@0.1.0', ...(json ? { 'content-type': 'application/json' } : {}) };
  }

  private cached(key: string) {
    const hit = this.cache.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at > (this.opts.ttlMs ?? ETHOS_CACHE_TTL_MS)) {
      this.cache.delete(key);
      return undefined;
    }
    return hit.value;
  }

  private remember(key: string, body: EthosBody | null) {
    const score = body && typeof body.score === 'number' ? body.score : null;
    const level = body && typeof body.level === 'string' ? body.level : undefined;
    const value = { score, level };
    this.cache.set(key, { at: this.now(), value });
    return value;
  }

  /** GET one key. undefined = transient failure (not cached). */
  private async getOne(path: 'userkey' | 'address', key: string) {
    const hit = this.cached(key);
    if (hit) return hit;
    try {
      const res = await this.fetchImpl(`${this.base}/score/${path}?${path}=${encodeURIComponent(key)}`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5_000),
      });
      if (res.status === 404) return this.remember(key, null);
      if (!res.ok) return undefined;
      return this.remember(key, (await res.json()) as EthosBody);
    } catch {
      return undefined;
    }
  }

  /** Score many keys: cached first, then GETs (≤ 3 missing) or bulk POSTs (> 3 missing). */
  private async many(kind: 'userkey' | 'address', keys: string[]) {
    const unique = [...new Set(keys)];
    const out = new Map<string, { score: number | null; level?: string } | undefined>();
    const missing: string[] = [];
    for (const key of unique) {
      const hit = this.cached(key);
      if (hit) out.set(key, hit);
      else missing.push(key);
    }
    if (missing.length > ETHOS_BULK_THRESHOLD) {
      const path = kind === 'userkey' ? 'userkeys' : 'addresses';
      for (let i = 0; i < missing.length; i += BULK_CHUNK) {
        const chunk = missing.slice(i, i + BULK_CHUNK);
        try {
          const res = await this.fetchImpl(`${this.base}/score/${path}`, {
            method: 'POST',
            headers: this.headers(true),
            body: JSON.stringify({ [path]: chunk }),
            signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5_000),
          });
          if (!res.ok) throw new Error(`ethos bulk ${res.status}`);
          const body = (await res.json()) as Record<string, EthosBody | undefined>;
          // Keys absent from the bulk reply are users Ethos does not know: same as a 404.
          for (const key of chunk) out.set(key, this.remember(key, body[key] ?? null));
        } catch {
          for (const key of chunk) out.set(key, undefined);
        }
      }
    } else {
      await Promise.all(missing.map(async (key) => out.set(key, await this.getOne(kind, key))));
    }
    return out;
  }

  async scoreHandle(handle: string): Promise<CredibilityScore> {
    return (await this.scoreHandles([handle])).get(handle) ?? unknownScore(handle);
  }

  async scoreHandles(handles: string[]): Promise<Map<string, CredibilityScore>> {
    const byKey = await this.many('userkey', handles.map(xUserkey));
    const result = new Map<string, CredibilityScore>();
    for (const handle of handles) {
      const v = byKey.get(xUserkey(handle));
      result.set(handle, v && v.score !== null ? knownScore(handle, v.score, v.level) : unknownScore(handle));
    }
    return result;
  }

  async scoreAddress(address: string): Promise<CredibilityScore> {
    return (await this.scoreAddresses([address])).get(address) ?? unknownScore(address);
  }

  async scoreAddresses(addresses: string[]): Promise<Map<string, CredibilityScore>> {
    const byKey = await this.many('address', addresses);
    const result = new Map<string, CredibilityScore>();
    for (const address of addresses) {
      const v = byKey.get(address);
      result.set(address, v && v.score !== null ? knownScore(address, v.score, v.level) : unknownScore(address));
    }
    return result;
  }

  weightItems(items: NewsItem[]): Promise<NewsItem[]> {
    return weightItems(items, this);
  }
}

/**
 * Attach `credibility` (0.2–1.0) to each item:
 *  - known publisher domain (credibility/sources.ts): max(domain weight, Ethos weight of the handle)
 *  - otherwise: Ethos weight of the handle when Ethos knows it, else the domain table's "unknown" weight.
 * The weight informs the agent; it is never a hard filter.
 */
export async function weightItems(items: NewsItem[], scorer: CredibilityScorer): Promise<NewsItem[]> {
  const handles = [...new Set(items.map((i) => i.handle).filter((h): h is string => !!h))];
  let scores: Map<string, CredibilityScore>;
  try {
    scores = scorer.scoreHandles
      ? await scorer.scoreHandles(handles)
      : new Map(await Promise.all(handles.map(async (h) => [h, await scorer.scoreHandle(h)] as const)));
  } catch {
    scores = new Map();
  }
  return items.map((item) => {
    const domain = sourceWeight(item.domain);
    const s = item.handle ? scores.get(item.handle) : undefined;
    const ethos = s && s.score !== null ? (s.weight ?? weightFromScore(s.score)) : undefined;
    const credibility = domain.known ? Math.max(domain.weight, ethos ?? 0) : (ethos ?? domain.weight);
    return { ...item, credibility };
  });
}

/** Real Ethos when ETHOS_ENABLED=true (no key needed), else the deterministic fake. */
export function createCredibilityScorer(config: Pick<Config, 'ETHOS_ENABLED' | 'ETHOS_CLIENT' | 'ETHOS_API_URL'>): CredibilityScorer {
  if (config.ETHOS_ENABLED) return new EthosScorer({ client: config.ETHOS_CLIENT, baseUrl: config.ETHOS_API_URL });
  return new FakeEthosScorer();
}
