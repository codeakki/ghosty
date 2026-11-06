import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import { z } from 'zod';
import { credibilityWeight, type CredibilityLevel, type CredibilityScorer } from '../credibility/ethos.js';
import { fitLegsToMinimum, planActions, RISK_MULTIPLIER, type PlannedAction, type Signal } from '../execution/playbook.js';
import type { NewsItem } from '../news/types.js';
import { reportBrainFailure } from '../safety/safeStop.js';
import { errorMessage, noopLogger, type Logger } from './log.js';
import { defaultMemory, type UserMemory } from './memory.js';
import { updateZeroGState } from './status.js';

export interface Decision {
  signal: Signal;
  /** 0..1 */
  confidence: number;
  suggestedActions: PlannedAction[];
  /** 0G Compute request id once real; `fake-<uuid>` for the stub. Logged per episode. */
  requestId: string;
  /** One or two sentences Ghosty speaks to the user. */
  rationale: string;
  /** Ids of the news items the decision was made from (episode log). */
  newsIds?: string[];
  /** Raw 0G Compute identifiers, present only for ZeroGDecider decisions. */
  zeroG?: ZeroGTrace;
}

export interface ZeroGTrace {
  /** Chat completion `id` from the response body. */
  completionId: string | null;
  /** `x_0g_trace.request_id` from the response body (the Router's own request id). */
  traceRequestId: string | null;
  /** `x-request-id` response header, if the Router sets one. */
  headerRequestId: string | null;
  model: string;
  /** `x_0g_trace.provider`: on-chain address of the provider that served the call. */
  provider: string | null;
  attempts: number;
}

export interface DecideInput {
  transcript: string;
  news: NewsItem[];
  memory: UserMemory;
  maxTradeUsd: number;
}

export interface Decider {
  decide(input: DecideInput): Promise<Decision>;
}

const GEOPOLITICAL = /\b(war|strike|missile|invasion)\b/i;
const REGULATORY = /\b(sec|ban|crackdown|lawsuit|sanction(s|ed)?)\b/i;

/** Classify a single headline. Exported for tests and for a pre-filter before the LLM call. */
export function classifyText(text: string): Signal {
  if (GEOPOLITICAL.test(text)) return 'geopolitical_shock';
  if (REGULATORY.test(text)) return 'regulatory_crackdown';
  return 'none';
}

/**
 * Keyword decider: no LLM. Picks the strongest signal across transcript + headlines,
 * weights confidence by the credibility of the sources that triggered it.
 */
export class FakeDecider implements Decider {
  constructor(private readonly scorer?: CredibilityScorer) {}

  async decide(input: DecideInput): Promise<Decision> {
    const texts: Array<{ text: string; handle?: string }> = [
      { text: input.transcript },
      ...input.news.map((n) => ({ text: n.title, handle: n.handle })),
    ];

    const hits: Record<Signal, Array<{ text: string; handle?: string }>> = {
      geopolitical_shock: [],
      regulatory_crackdown: [],
      none: [],
    };
    for (const t of texts) hits[classifyText(t.text)].push(t);

    const signal: Signal =
      hits.geopolitical_shock.length > 0
        ? 'geopolitical_shock'
        : hits.regulatory_crackdown.length > 0
          ? 'regulatory_crackdown'
          : 'none';

    let confidence = 0;
    if (signal !== 'none') {
      const matched = hits[signal];
      const scorer = this.scorer;
      let weight = 0.8;
      if (scorer) {
        const weights = await Promise.all(
          matched.map(async (m) => (m.handle ? credibilityWeight((await scorer.scoreHandle(m.handle)).level) : 0.5)),
        );
        weight = Math.max(...weights);
      }
      // More independent sources → more confidence, weighted by the best source, capped below 1.
      const raw = (0.4 + 0.15 * Math.min(matched.length, 4)) * weight;
      confidence = Math.round(Math.min(0.95, raw) * 100) / 100;
    }

    const suggestedActions = planActions(signal, input.memory, { maxTradeUsd: input.maxTradeUsd });
    const top = hits[signal][0]?.text;
    const rationale =
      signal === 'geopolitical_shock'
        ? `Geopolitical shock detected: "${top}". I suggest going long gold and oil and shorting bitcoin. Press to confirm.`
        : signal === 'regulatory_crackdown'
          ? `Regulatory pressure detected: "${top}". I suggest reducing bitcoin exposure. Press to confirm.`
          : 'Nothing market-moving right now. I will keep watching.';

    return { signal, confidence, suggestedActions, requestId: `fake-${randomUUID()}`, rationale };
  }
}

// ---------------------------------------------------------------------------
// 0G Compute decider
// ---------------------------------------------------------------------------

export type BrainOfflineReason = 'not_configured' | 'timeout' | 'http_error' | 'network_error' | 'invalid_output';

/**
 * 0G Compute could not produce a decision. Never caught and replaced with a fake decision:
 * the caller must treat this as safe-stop ("brain offline", no trade).
 */
export class BrainOfflineError extends Error {
  override readonly name = 'BrainOfflineError';
  readonly reason: BrainOfflineReason;
  readonly status: number | undefined;
  /** Router request id when the failure came back from the Router (error body or header). */
  readonly requestId: string | undefined;

  constructor(
    message: string,
    reason: BrainOfflineReason,
    opts: { cause?: unknown; status?: number; requestId?: string } = {},
  ) {
    super(message, { cause: opts.cause });
    this.reason = reason;
    this.status = opts.status;
    this.requestId = opts.requestId;
  }
}

const SIDE = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.enum(['long', 'short', 'buy', 'sell']))
  .transform((v): 'long' | 'short' => (v === 'buy' ? 'long' : v === 'sell' ? 'short' : v));

/** Strict shape the model must return. */
export const LlmDecisionSchema = z.object({
  signal: z.enum(['geopolitical_shock', 'regulatory_crackdown', 'none']),
  confidence: z.number().min(0).max(1),
  rationale: z.string().trim().min(1).max(600),
  suggestedActions: z
    .array(
      z.object({
        venue: z.string().trim().min(1),
        market: z.string().trim().min(1),
        side: SIDE,
        sizePct: z.number().min(0).max(100),
      }),
    )
    .max(6),
});

export type LlmDecision = z.infer<typeof LlmDecisionSchema>;

export const SYSTEM_PROMPT = `You are Ghosty, a private trading copilot that lives in a wearable pod.
You read market-moving news, weigh each item by its source credibility, and propose at most a few small hedging trades.
The wearer confirms every trade with a button press; you never execute anything yourself.

Input (JSON): transcript (what the wearer just said, may be empty), news (items with an Ethos credibility score 0-2800 and level),
memory (risk profile, preferences incl. watchlist, recent decision history), constraints (allowed venues and markets, budget).

Rules:
- signal is one of "geopolitical_shock", "regulatory_crackdown", "none".
- Discount low-credibility sources (level "untrusted" or "questionable"); a single untrusted headline alone is not a signal.
- If nothing is market-moving, return signal "none" and an empty suggestedActions array.
- Only use venues and markets listed in constraints. side is "long" or "short".
- sizePct is the percent (0-100) of constraints.budgetUsd for that leg; all legs together must not exceed 100.
- Respect the risk profile: conservative wearers get fewer, smaller legs.
- rationale: one or two short spoken sentences for the wearer, ending with "Press to confirm." when you suggest trades.

Reply with ONLY one JSON object, no prose, no code fences:
{"signal": "...", "confidence": 0.0, "rationale": "...", "suggestedActions": [{"venue": "hyperliquid", "market": "BTC", "side": "short", "sizePct": 50}]}`;

const MAX_NEWS = 15;
const MAX_HISTORY = 10;
/** Per-attempt deadline (OG_DECIDE_TIMEOUT_MS). Slow networks and busy providers need far more than 20 s. */
export const DECIDE_TIMEOUT_MS = 45_000;

/** Error code anywhere on the cause chain (undici puts ECONNRESET a level or two down). */
function causeCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur && typeof cur === 'object'; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Transport failures worth exactly one more try: our deadline / SDK timeout, or a reset connection. Nothing else. */
export function isRetryableTransportError(err: unknown): boolean {
  if (err instanceof OpenAI.APIConnectionTimeoutError || err instanceof OpenAI.APIUserAbortError) return true;
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) return true;
  return causeCode(err) === 'ECONNRESET';
}

/** Pull the JSON object out of a model reply (tolerates code fences and <think> blocks). */
export function extractJson(content: string): unknown {
  const cleaned = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in reply');
  return JSON.parse(cleaned.slice(start, end + 1));
}

/**
 * The Router answers with two `X-Request-Id` headers (gateway, then router), which fetch joins as "a, b".
 * The last one is the Router request id that also appears as `request_id` in error bodies.
 */
export function routerRequestIdFromHeader(header: string | null | undefined): string | undefined {
  return header?.split(',').map((s) => s.trim()).filter(Boolean).at(-1);
}

function watchlistOf(memory: UserMemory): string[] {
  const w = memory.preferences.watchlist ?? defaultMemory().preferences.watchlist ?? [];
  return (Array.isArray(w) ? w : String(w).split(',')).map((s) => s.trim()).filter(Boolean);
}

/**
 * Model output → executable actions. Only Hyperliquid legs on watchlisted markets survive. The legs' sizePct
 * become weights over budget × min(total sizePct, 100)%, where budget = MAX_TRADE_USD × risk multiplier, and are
 * then fitted to the Hyperliquid $10 minimum exactly like the playbook (fitLegsToMinimum): the smallest legs are
 * dropped and the budget re-split, a lone short leg is raised to $10 only when that stays within MAX_TRADE_USD.
 * The total never exceeds MAX_TRADE_USD. Legs removed for size are reported in `dropped`.
 */
export function toPlannedActions(
  llm: LlmDecision,
  memory: UserMemory,
  maxTradeUsd: number,
  opts: { minNotionalUsd?: number } = {},
): { actions: PlannedAction[]; dropped: LlmDecision['suggestedActions'] } {
  if (llm.signal === 'none') return { actions: [], dropped: llm.suggestedActions };
  const cap = Math.max(0, maxTradeUsd);
  const budget = cap * RISK_MULTIPLIER[memory.riskProfile];
  const allowed = new Map(watchlistOf(memory).map((m) => [m.toUpperCase(), m]));

  const dropped: LlmDecision['suggestedActions'] = [];
  const kept: Array<LlmDecision['suggestedActions'][number] & { coin: string; weight: number }> = [];
  for (const a of llm.suggestedActions) {
    const coin = allowed.get(a.market.toUpperCase());
    if (a.venue.toLowerCase() !== 'hyperliquid' || !coin || a.sizePct <= 0) dropped.push(a);
    else kept.push({ ...a, coin, weight: a.sizePct });
  }
  const totalPct = kept.reduce((sum, a) => sum + a.sizePct, 0);
  const legBudget = budget * Math.min(totalPct, 100) / 100;
  const fitted = fitLegsToMinimum(kept, legBudget, { maxTradeUsd: cap, minNotionalUsd: opts.minNotionalUsd });
  const survivors = new Set(fitted.map((f) => f.leg));
  for (const leg of kept) {
    if (!survivors.has(leg)) dropped.push({ venue: leg.venue, market: leg.market, side: leg.side, sizePct: leg.sizePct });
  }
  const actions = fitted.map(({ leg, sizeUsd }) => ({
    venue: 'hyperliquid' as const,
    kind: 'perp' as const,
    coin: leg.coin,
    side: leg.side,
    sizeUsd,
    reason: llm.rationale,
  }));
  return { actions, dropped };
}

export interface ZeroGDeciderOptions {
  /** e.g. https://router-api-testnet.integratenetwork.work/v1 */
  baseURL: string;
  apiKey: string;
  model: string;
  scorer?: CredibilityScorer;
  logger?: Logger;
  /** Per-attempt deadline. Default 45 s. A timeout or ECONNRESET is retried once; nothing else is. */
  timeoutMs?: number;
  /** Send response_format json_object. Default true. */
  jsonMode?: boolean;
  /** Injected fetch (tests). */
  fetch?: typeof fetch;
}

interface RouterTrace {
  request_id?: string;
  provider?: string;
}

/**
 * Decision loop on 0G Compute through the OpenAI-compatible Router.
 * Strict JSON out, validated with zod, one retry on invalid output. Any failure throws BrainOfflineError.
 */
export class ZeroGDecider implements Decider {
  private readonly client: OpenAI;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly jsonMode: boolean;

  constructor(private readonly opts: ZeroGDeciderOptions) {
    this.timeoutMs = opts.timeoutMs ?? DECIDE_TIMEOUT_MS;
    this.client = new OpenAI({
      baseURL: opts.baseURL,
      apiKey: opts.apiKey,
      timeout: this.timeoutMs,
      // No silent retries: a slow brain must surface as safe-stop, not a long hang.
      maxRetries: 0,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    this.logger = opts.logger ?? noopLogger;
    this.jsonMode = opts.jsonMode ?? true;
  }

  async decide(input: DecideInput): Promise<Decision> {
    try {
      return await this.decideOrThrow(input);
    } catch (err) {
      const offline = this.toBrainOffline(err);
      reportBrainFailure(this.opts.baseURL);
      this.logger.error(
        { err: offline.message, reason: offline.reason, status: offline.status, requestId: offline.requestId },
        '0G decide failed: brain offline',
      );
      throw offline;
    }
  }

  private async decideOrThrow(input: DecideInput): Promise<Decision> {
    if (!this.opts.apiKey) throw new BrainOfflineError('OG_API_KEY is not set', 'not_configured');
    const news = input.news.slice(0, MAX_NEWS);
    const userPayload = await this.buildUserPayload(input, news);
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(userPayload) },
    ];

    let lastProblem = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      const { data, response, request_id } = await this.complete(messages);

      const trace = (data as unknown as { x_0g_trace?: RouterTrace }).x_0g_trace;
      const ids: ZeroGTrace = {
        completionId: data.id ?? null,
        traceRequestId: trace?.request_id ?? null,
        headerRequestId: request_id ?? response.headers.get('x-request-id'),
        model: data.model ?? this.opts.model,
        provider: trace?.provider ?? null,
        attempts: attempt,
      };
      const requestId =
        ids.traceRequestId ?? routerRequestIdFromHeader(ids.headerRequestId) ?? ids.completionId ?? `0g-unknown-${randomUUID()}`;
      this.logger.info({ ...ids, requestId }, '0G compute response');

      const content = data.choices[0]?.message?.content ?? '';
      const parsed = this.parse(content);
      if (parsed.ok) {
        const { actions, dropped } = toPlannedActions(parsed.value, input.memory, input.maxTradeUsd);
        if (dropped.length > 0) this.logger.warn({ requestId, dropped }, '0G suggested legs dropped (outside venue/watchlist or under the $10 minimum)');
        updateZeroGState({ lastRequestId: requestId, lastDecisionAt: new Date().toISOString() });
        return {
          signal: parsed.value.signal,
          confidence: Math.round(parsed.value.confidence * 100) / 100,
          suggestedActions: actions,
          requestId,
          rationale: parsed.value.rationale,
          newsIds: news.map((n) => n.id),
          zeroG: ids,
        };
      }

      lastProblem = parsed.problem;
      this.logger.warn({ requestId, attempt, problem: parsed.problem }, '0G reply was not valid decision JSON');
      messages.push(
        { role: 'assistant', content },
        {
          role: 'user',
          content: `That reply was invalid (${parsed.problem}). Reply with ONLY the JSON object in the exact schema, nothing else.`,
        },
      );
    }
    throw new BrainOfflineError(`0G returned invalid decision JSON twice: ${lastProblem}`, 'invalid_output');
  }

  /** One chat completion with its own deadline; a timeout or ECONNRESET gets exactly one more try. */
  private async complete(messages: OpenAI.Chat.ChatCompletionMessageParam[]) {
    const once = () =>
      this.client.chat.completions
        .create(
          {
            model: this.opts.model,
            messages,
            // No temperature: several catalog models do not list it in supported_parameters.
            ...(this.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
          },
          { signal: AbortSignal.timeout(this.timeoutMs) },
        )
        .withResponse();
    try {
      return await once();
    } catch (err) {
      if (!isRetryableTransportError(err)) throw err;
      this.logger.warn({ err: errorMessage(err), code: causeCode(err) ?? null }, '0G call timed out or was reset: retrying once');
      return once();
    }
  }

  private parse(content: string): { ok: true; value: LlmDecision } | { ok: false; problem: string } {
    let raw: unknown;
    try {
      raw = extractJson(content);
    } catch (err) {
      return { ok: false, problem: `not JSON: ${errorMessage(err)}` };
    }
    const result = LlmDecisionSchema.safeParse(raw);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      return { ok: false, problem: `schema: ${issues}` };
    }
    return { ok: true, value: result.data };
  }

  private async buildUserPayload(input: DecideInput, news: NewsItem[]) {
    const scorer = this.opts.scorer;
    const scored = await Promise.all(
      news.map(async (n) => {
        let credibility: { score: number | null; level: CredibilityLevel } | null = null;
        if (scorer && n.handle) {
          try {
            const s = await scorer.scoreHandle(n.handle);
            credibility = { score: s.score, level: s.level };
          } catch {
            credibility = null;
          }
        }
        return {
          id: n.id,
          source: n.source,
          title: n.title,
          publishedAt: n.publishedAt,
          handle: n.handle ?? null,
          credibility,
          weight: credibility ? credibilityWeight(credibility.level) : null,
        };
      }),
    );
    const budgetUsd = Math.max(0, input.maxTradeUsd) * RISK_MULTIPLIER[input.memory.riskProfile];
    return {
      transcript: input.transcript,
      news: scored,
      memory: {
        riskProfile: input.memory.riskProfile,
        preferences: input.memory.preferences,
        recentHistory: input.memory.history.slice(-MAX_HISTORY),
      },
      constraints: {
        allowedVenues: ['hyperliquid'],
        allowedMarkets: watchlistOf(input.memory),
        maxTradeUsd: input.maxTradeUsd,
        budgetUsd,
      },
    };
  }

  private toBrainOffline(err: unknown): BrainOfflineError {
    if (err instanceof BrainOfflineError) return err;
    if (err instanceof OpenAI.APIConnectionTimeoutError || err instanceof OpenAI.APIUserAbortError) {
      return new BrainOfflineError(`0G Compute timed out after ${this.timeoutMs} ms`, 'timeout', { cause: err });
    }
    if (err instanceof OpenAI.APIConnectionError) {
      return new BrainOfflineError(`0G Router unreachable: ${err.message}`, 'network_error', { cause: err });
    }
    if (err instanceof OpenAI.APIError) {
      // The SDK keeps only body.error, so the Router's top-level request_id comes from the x-request-id header.
      return new BrainOfflineError(`0G Router error ${err.status ?? ''}: ${err.message}`.trim(), 'http_error', {
        cause: err,
        status: err.status,
        requestId: routerRequestIdFromHeader(err.requestID ?? null),
      });
    }
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      return new BrainOfflineError(`0G Compute timed out after ${this.timeoutMs} ms`, 'timeout', { cause: err });
    }
    return new BrainOfflineError(`0G decide failed: ${errorMessage(err)}`, 'network_error', { cause: err });
  }
}

