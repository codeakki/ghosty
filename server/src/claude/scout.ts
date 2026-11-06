import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { normalizeUrl } from '../news/aggregator.js';
import type { NewsItem, NewsProvider } from '../news/types.js';

/**
 * Claude news scout: every CLAUDE_SCOUT_MINUTES, one Messages API call with the server-side web_search tool finds
 * up to 6 market-moving headlines from the last 2 hours. They feed the NewsAggregator like any other provider
 * (dedupe, rolling window, shock detector); the decision about any of them stays with 0G.
 *
 * fetchLatest() never calls the API: it returns the last cycle's items. Cycles run from start() (index.ts only)
 * or runCycle(). Cost guards: a cycle is skipped while the previous one is still running, and at most
 * CLAUDE_SCOUT_MAX_PER_DAY cycles run per UTC day (in-memory counter, reset on restart).
 */

export const SCOUT_SOURCE = 'claude-scout';
export const SCOUT_MAX_HEADLINES = 6;
export const SCOUT_MAX_AGE_MS = 2 * 3600_000;
export const SCOUT_TIMEOUT_MS = 120_000;
/** web_search rounds per cycle. */
export const SCOUT_MAX_SEARCHES = 3;
/** pause_turn resumes per cycle (server-side tool loop hit its iteration limit). */
const MAX_CONTINUATIONS = 2;

export const ScoutHeadlineSchema = z.object({
  title: z.string().trim().min(1).max(400),
  url: z.string().trim().url(),
  source: z.string().trim().min(1).max(120),
  publishedAt: z.string().trim().min(1),
  why: z.string().trim().max(400).default(''),
});
export type ScoutHeadline = z.infer<typeof ScoutHeadlineSchema>;

export const SCOUT_SYSTEM_PROMPT = `You are a newswire scout for a trading copilot. Use web search to find real, verifiable news.
Search for today's breaking news (wire services, live blogs and markets pages such as Reuters, AP, Bloomberg, CNBC, CoinDesk are good places to look).
Only report stories published in the last 2 hours, each with the article URL you actually found. Use the page age or timestamp shown in the search results for publishedAt.
Never invent a headline, URL or time; leave a story out if you cannot tell when it was published.
Reply with ONLY one JSON object, no prose before or after, no code fences:
{"headlines":[{"title":"<headline as published>","url":"https://...","source":"<outlet, e.g. Reuters>","publishedAt":"<ISO 8601 UTC>","why":"<one short sentence: which market it could move and why>"}]}
At most ${SCOUT_MAX_HEADLINES} headlines, most market-moving first. Use {"headlines":[]} when nothing qualifies.`;

/** Pull the scout JSON out of the final text. Tolerates prose or fences around it. Returns raw entries. */
export function extractHeadlines(text: string): unknown[] {
  const cleaned = text.replace(/```(?:json)?/gi, '');
  const starts = [cleaned.lastIndexOf('{"headlines"'), cleaned.indexOf('{')].filter((i) => i >= 0);
  for (const start of starts) {
    const end = cleaned.lastIndexOf('}');
    if (end <= start) continue;
    try {
      const parsed = JSON.parse(cleaned.slice(start, end + 1)) as { headlines?: unknown };
      if (Array.isArray(parsed.headlines)) return parsed.headlines;
    } catch {
      /* try the next candidate */
    }
  }
  const arrStart = cleaned.indexOf('[');
  const arrEnd = cleaned.lastIndexOf(']');
  if (arrStart >= 0 && arrEnd > arrStart) {
    try {
      const parsed: unknown = JSON.parse(cleaned.slice(arrStart, arrEnd + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* fall through */
    }
  }
  throw new Error('no headlines JSON in reply');
}

/**
 * Validate entries into NewsItems: zod per entry, drop anything without a valid http(s) URL, older than 2 h,
 * with an unparseable time, or a duplicate URL/title. Future times are clamped to `now`.
 */
export function toScoutItems(raw: unknown[], now: number): { items: NewsItem[]; dropped: number } {
  const items: NewsItem[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const entry of raw) {
    const parsed = ScoutHeadlineSchema.safeParse(entry);
    if (!parsed.success || !/^https?:\/\//i.test(parsed.data.url)) {
      dropped++;
      continue;
    }
    const h = parsed.data;
    const t = Date.parse(h.publishedAt);
    if (Number.isNaN(t) || now - t > SCOUT_MAX_AGE_MS) {
      dropped++;
      continue;
    }
    const urlKey = normalizeUrl(h.url);
    const titleKey = h.title.toLowerCase().replace(/\W+/g, ' ').trim();
    if (seen.has(urlKey) || seen.has(titleKey)) {
      dropped++;
      continue;
    }
    seen.add(urlKey);
    seen.add(titleKey);
    let domain: string | undefined;
    try {
      domain = new URL(h.url).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      domain = undefined;
    }
    items.push({
      id: `${SCOUT_SOURCE}:${createHash('sha1').update(urlKey).digest('hex').slice(0, 16)}`,
      source: SCOUT_SOURCE,
      title: h.title.replace(/\s+/g, ' '),
      url: h.url,
      publishedAt: new Date(Math.min(t, now)).toISOString(),
      ...(domain ? { domain } : {}),
      // The outlet only: the scout's own "why" stays out of `summary` so the shock detector reads news, not Claude.
      summary: h.source,
      ...(h.why ? { why: h.why } : {}),
    });
    if (items.length >= SCOUT_MAX_HEADLINES) break;
  }
  return { items, dropped };
}

export type ScoutSkipReason = 'overlap' | 'daily_cap';

export interface ScoutCycleResult {
  /** Set when no API call was made. */
  skipped?: ScoutSkipReason;
  items: NewsItem[];
  /** Entries Claude returned that failed validation (no URL, too old, duplicate). */
  dropped: number;
  /** web_search calls Claude made this cycle. */
  searches: number;
  error?: string;
  /** Anthropic message id. */
  messageId?: string;
}

export interface ClaudeScoutOptions {
  client?: Pick<Anthropic, 'messages'>;
  apiKey?: string;
  model: string;
  query: string;
  maxPerDay: number;
  timeoutMs?: number;
  now?: () => number;
}

export class ClaudeScoutProvider implements NewsProvider {
  readonly name = SCOUT_SOURCE;
  private readonly client: Pick<Anthropic, 'messages'>;
  private readonly now: () => number;
  private items: NewsItem[] = [];
  private running: Promise<ScoutCycleResult> | undefined;
  private day = '';
  private cyclesToday = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly opts: ClaudeScoutOptions) {
    this.now = opts.now ?? Date.now;
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, maxRetries: 1, timeout: opts.timeoutMs ?? SCOUT_TIMEOUT_MS });
  }

  /** The last cycle's headlines still inside the 2 h window. Never calls the API. */
  async fetchLatest(limit = SCOUT_MAX_HEADLINES): Promise<NewsItem[]> {
    const cutoff = this.now() - SCOUT_MAX_AGE_MS;
    return this.items.filter((i) => Date.parse(i.publishedAt) >= cutoff).slice(0, limit);
  }

  /** Cycles used today (UTC) and the cap. */
  usage(): { day: string; cycles: number; max: number } {
    this.rollDay();
    return { day: this.day, cycles: this.cyclesToday, max: this.opts.maxPerDay };
  }

  get busy(): boolean {
    return this.running !== undefined;
  }

  /** One scout cycle. Skipped (no API call) while one is running or once the daily cap is used up. */
  async runCycle(): Promise<ScoutCycleResult> {
    if (this.running) return { skipped: 'overlap', items: [], dropped: 0, searches: 0 };
    this.rollDay();
    if (this.cyclesToday >= this.opts.maxPerDay) return { skipped: 'daily_cap', items: [], dropped: 0, searches: 0 };
    this.cyclesToday++;
    this.running = this.search().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** Run a cycle now and every `intervalMs` (index.ts only; never from buildApp). */
  start(intervalMs: number, onCycle: (result: ScoutCycleResult) => void | Promise<void>): void {
    if (this.timer) return;
    const tick = () =>
      void this.runCycle()
        .then(onCycle)
        .catch(() => undefined);
    tick();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private rollDay(): void {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.cyclesToday = 0;
    }
  }

  private async search(): Promise<ScoutCycleResult> {
    const nowIso = new Date(this.now()).toISOString();
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: `Current time: ${nowIso}. Find: ${this.opts.query}. Only stories published after ${new Date(this.now() - SCOUT_MAX_AGE_MS).toISOString()}.`,
      },
    ];
    let searches = 0;
    let messageId: string | undefined;
    try {
      let response: Anthropic.Message | undefined;
      for (let turn = 0; turn <= MAX_CONTINUATIONS; turn++) {
        response = await this.client.messages.create({
          model: this.opts.model,
          max_tokens: 8000,
          system: SCOUT_SYSTEM_PROMPT,
          output_config: { effort: 'low' },
          tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: SCOUT_MAX_SEARCHES }],
          messages,
        });
        messageId = response.id;
        searches += response.content.filter((b) => b.type === 'server_tool_use').length;
        // The server-side tool loop paused: resend the turn as-is and it resumes (no extra user message).
        if (response.stop_reason !== 'pause_turn') break;
        messages.push({ role: 'assistant', content: response.content });
      }
      if (!response) throw new Error('no response');
      if (response.stop_reason === 'refusal') throw new Error('Claude declined the scout request');
      // Text after the last tool result is the answer; earlier text is commentary between searches.
      let lastTool = -1;
      response.content.forEach((b, i) => {
        if (b.type === 'web_search_tool_result') lastTool = i;
      });
      const text = response.content
        .slice(lastTool + 1)
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const { items, dropped } = toScoutItems(extractHeadlines(text), this.now());
      this.items = items;
      return { items, dropped, searches, messageId };
    } catch (err) {
      // Keep the previous items: a failed cycle never wipes headlines that are still in their window.
      return { items: [], dropped: 0, searches, error: describeScoutError(err), messageId };
    }
  }
}

/** Error text without secrets: SDK status/class, or the message of our own parse errors. */
function describeScoutError(err: unknown): string {
  if (err instanceof Anthropic.APIError) return `Anthropic ${err.status ?? 'connection'} ${err.name}`;
  if (err instanceof Error) return err.message;
  return 'unknown error';
}
