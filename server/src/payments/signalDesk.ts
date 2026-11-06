import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { FacilitatorClient } from '@x402/core/server';
import type { Config } from '../config.js';
import { createCredibilityScorer, type CredibilityLevel, type CredibilityScorer } from '../credibility/ethos.js';
import { createNewsProviders } from '../news/factory.js';
import { shockDetector, type ShockCategory } from '../news/shock.js';
import { fetchAll, type NewsItem, type NewsProvider } from '../news/types.js';
import { HBAR_ASSET_ID } from './hedera.js';
import { registerPaidRoute, type Price } from './x402Server.js';

/**
 * SIGNAL DESK: an x402 merchant that sells "headline intelligence". The agent buys one bundle per shock
 * headline, right before its 0G decision, and the bundle goes into the decision prompt.
 *
 * It is designed to be an independent third party: its own process, its own port (SIGNAL_DESK_PORT), its own
 * Hedera account (X402_PAY_TO) and, in production, its own host. For the demo it runs next to the Ghosty server
 * (`npm run signal-desk`). It shares code with Ghosty but no state and no keys: it never sees the agent's key.
 *
 * What a bundle contains (all computed from real data, nothing invented):
 * - source credibility: the Ethos score of the headline's handle (credibility/ethos.ts)
 * - corroboration: how many OTHER outlets in the desk's own news window carry the same story
 * - shock: category + matched keywords from the shock detector (news/shock.ts), and a severity derived from them
 *
 *   GET /intel?headline=...&handle=...&domain=...   paid (402 → USDC or HBAR)
 *   GET /health                                    free: who gets paid and the prices
 */

export const SIGNAL_DESK_PROVIDER = 'ghosty-signal-desk';

export type Severity = 'none' | 'low' | 'medium' | 'high';

export interface IntelBundle {
  provider: typeof SIGNAL_DESK_PROVIDER;
  /** Desk-side id of this bundle. */
  requestId: string;
  generatedAt: string;
  headline: string;
  source: {
    handle: string | null;
    domain: string | null;
    /** Ethos score 0-2800 and level, or null when there is no handle or Ethos does not know it. */
    ethos: { score: number | null; level: CredibilityLevel; ethosLevel?: string } | null;
  };
  corroboration: {
    /** Distinct other outlets in the window carrying the same story. */
    count: number;
    sources: string[];
    windowMinutes: number;
    examples: Array<{ title: string; outlet: string; publishedAt: string }>;
  };
  shock: { category: ShockCategory | 'none'; keywords: string[]; severity: Severity };
}

export interface IntelQuery {
  headline: string;
  handle?: string;
  domain?: string;
}

const STOPWORDS = new Set(['about', 'after', 'again', 'amid', 'from', 'have', 'into', 'more', 'near', 'over', 'reported', 'reports', 'says', 'said', 'than', 'that', 'their', 'there', 'this', 'with', 'will', 'were', 'what', 'when', 'test']);

/** Content words of a title: lowercase, 4+ letters, no stopwords. */
export function contentWords(title: string): Set<string> {
  return new Set((title.toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? []).filter((w) => !STOPWORDS.has(w)));
}

function outletOf(item: NewsItem): string {
  return (item.domain ?? item.handle ?? item.source).toLowerCase();
}

/** Other outlets whose headline shares at least 2 content words with ours. */
export function corroborate(query: IntelQuery, window: NewsItem[]): { sources: string[]; examples: IntelBundle['corroboration']['examples'] } {
  const words = contentWords(query.headline);
  const own = new Set([query.domain, query.handle].filter((s): s is string => Boolean(s)).map((s) => s.toLowerCase()));
  const sources = new Set<string>();
  const examples: IntelBundle['corroboration']['examples'] = [];
  for (const item of window) {
    const outlet = outletOf(item);
    if (own.has(outlet) || item.title.trim().toLowerCase() === query.headline.trim().toLowerCase()) continue;
    const shared = [...contentWords(item.title)].filter((w) => words.has(w)).length;
    if (shared < 2 || sources.has(outlet)) continue;
    sources.add(outlet);
    if (examples.length < 3) examples.push({ title: item.title, outlet, publishedAt: item.publishedAt });
  }
  return { sources: [...sources], examples };
}

/**
 * Severity: one point per distinct shock keyword (max 2), +1 when 2+ other outlets corroborate,
 * +1 when the source is reputable or exemplary on Ethos. 1 = low, 2 = medium, 3+ = high.
 */
export function severityOf(keywords: number, corroborations: number, level: CredibilityLevel | undefined): Severity {
  if (keywords === 0) return 'none';
  const points = Math.min(keywords, 2) + (corroborations >= 2 ? 1 : 0) + (level === 'reputable' || level === 'exemplary' ? 1 : 0);
  return points >= 3 ? 'high' : points === 2 ? 'medium' : 'low';
}

export interface IntelServiceOptions {
  news: NewsProvider[];
  scorer: CredibilityScorer;
  windowMinutes: number;
  /** How long the desk reuses one news fetch. Default 60 s. */
  cacheMs?: number;
  now?: () => number;
}

/** Builds bundles. Separate from the HTTP layer so tests can call it directly. */
export class IntelService {
  private cache: { at: number; items: NewsItem[] } | undefined;
  private readonly now: () => number;

  constructor(private readonly opts: IntelServiceOptions) {
    this.now = opts.now ?? Date.now;
  }

  private async window(): Promise<NewsItem[]> {
    if (!this.cache || this.now() - this.cache.at > (this.opts.cacheMs ?? 60_000)) {
      this.cache = { at: this.now(), items: await fetchAll(this.opts.news, 30) };
    }
    const cutoff = this.now() - this.opts.windowMinutes * 60_000;
    return this.cache.items.filter((n) => Date.parse(n.publishedAt) >= cutoff || Number.isNaN(Date.parse(n.publishedAt)));
  }

  private async ethos(handle: string | undefined): Promise<IntelBundle['source']['ethos']> {
    if (!handle) return null;
    try {
      const s = await this.opts.scorer.scoreHandle(handle);
      return { score: s.score, level: s.level, ...(s.ethosLevel ? { ethosLevel: s.ethosLevel } : {}) };
    } catch {
      return null;
    }
  }

  async bundle(query: IntelQuery): Promise<IntelBundle> {
    const [window, ethos] = await Promise.all([this.window(), this.ethos(query.handle)]);
    const { sources, examples } = corroborate(query, window);
    const probe: NewsItem = { id: 'query', source: 'query', title: query.headline, url: '', publishedAt: new Date(this.now()).toISOString() };
    const match = shockDetector([probe]).all[0];
    const keywords = match?.keywords ?? [];
    return {
      provider: SIGNAL_DESK_PROVIDER,
      requestId: `desk-${randomUUID()}`,
      generatedAt: new Date(this.now()).toISOString(),
      headline: query.headline,
      source: { handle: query.handle ?? null, domain: query.domain ?? null, ethos },
      corroboration: { count: sources.length, sources, windowMinutes: this.opts.windowMinutes, examples },
      shock: { category: match?.category ?? 'none', keywords, severity: severityOf(keywords.length, sources.length, ethos?.level) },
    };
  }
}

/** The two prices the desk offers, USDC first. */
export function deskPrices(config: Pick<Config, 'HEDERA_USDC_TOKEN_ID' | 'X402_INTEL_PRICE_USDC_MICROS' | 'X402_INTEL_PRICE_TINYBAR'>): Price[] {
  return [
    { asset: config.HEDERA_USDC_TOKEN_ID, amount: String(config.X402_INTEL_PRICE_USDC_MICROS) },
    { asset: HBAR_ASSET_ID, amount: String(config.X402_INTEL_PRICE_TINYBAR) },
  ];
}

export interface SignalDeskOptions {
  config: Config;
  intel?: IntelService;
  facilitator?: FacilitatorClient;
  logger?: FastifyServerOptions['logger'];
}

function queryOf(raw: unknown): IntelQuery {
  const q = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : undefined);
  return { headline: str(q.headline) ?? '', handle: str(q.handle), domain: str(q.domain) };
}

export function buildSignalDeskApp(opts: SignalDeskOptions): FastifyInstance {
  const { config } = opts;
  const app = Fastify({ logger: opts.logger ?? false });
  const intel =
    opts.intel ??
    new IntelService({ news: createNewsProviders(config), scorer: createCredibilityScorer(config), windowMinutes: config.NEWS_WINDOW_MINUTES });
  const prices = deskPrices(config);

  app.get('/health', async () => ({
    ok: true,
    provider: SIGNAL_DESK_PROVIDER,
    network: `hedera:${config.HEDERA_NETWORK}`,
    payTo: config.X402_PAY_TO ?? null,
    facilitator: config.X402_FACILITATOR_URL,
    prices,
  }));

  registerPaidRoute(app, {
    config,
    path: '/intel',
    description: 'Headline intelligence: Ethos source credibility, cross-source corroboration, shock category and severity',
    payTo: config.X402_PAY_TO,
    prices,
    facilitator: opts.facilitator,
    validate: (req) => (queryOf(req.query).headline ? undefined : 'query parameter "headline" is required'),
    produce: (req) => intel.bundle(queryOf(req.query)),
  });
  return app;
}

/** The URL the agent pays for one headline. */
export function intelUrl(deskUrl: string, headline: Pick<NewsItem, 'title' | 'handle' | 'domain'>): string {
  const u = new URL('/intel', deskUrl);
  u.searchParams.set('headline', headline.title.slice(0, 300));
  if (headline.handle) u.searchParams.set('handle', headline.handle);
  if (headline.domain) u.searchParams.set('domain', headline.domain);
  return u.toString();
}
