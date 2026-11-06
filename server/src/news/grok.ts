import { DEFAULT_TIMEOUT_MS, fetchJson, type FetchLike } from './http.js';
import { FAKE_NOW, type NewsItem, type NewsProvider } from './types.js';

/** xAI Responses API with the x_search tool (live X posts). Optional, paid per post fetched. */
export const XAI_RESPONSES_URL = 'https://api.x.ai/v1/responses';
export const XAI_DEFAULT_MODEL = 'grok-4.7';

/** Handles we pass as allowed_x_handles (max 20, no @). */
export const DEFAULT_X_HANDLES = ['DeItaone', 'Reuters', 'WatcherGuru', 'tier10k', 'zerohedge'];
export const MAX_X_HANDLES = 20;

export class FakeGrokProvider implements NewsProvider {
  readonly name = 'grok';

  async fetchLatest(limit = 10): Promise<NewsItem[]> {
    const items: NewsItem[] = [
      {
        id: 'grok:fake-1',
        source: 'grok',
        title: 'BREAKING: Air raid sirens reported after missile launch, war fears grow',
        url: 'https://x.com/DeItaone/status/0000000000000000001',
        publishedAt: FAKE_NOW,
        handle: 'DeItaone',
      },
      {
        id: 'grok:fake-2',
        source: 'grok',
        title: 'Rumour: exchange listing announcement coming today',
        url: 'https://x.com/randomtrader123/status/0000000000000000002',
        publishedAt: '2026-11-07T08:40:00.000Z',
        handle: 'randomtrader123',
      },
    ];
    return items.slice(0, limit);
  }
}

const INSTRUCTIONS =
  'You are a newswire filter. Use x_search to find the most recent market-moving posts (war, strikes, ' +
  'sanctions, regulation, hacks, exchange incidents, macro shocks). Reply with ONLY a JSON array, newest first, ' +
  'no prose: [{"handle":"<author without @>","text":"<post text, max 280 chars>","url":"https://x.com/<handle>/status/<id>","posted_at":"<ISO 8601>"}]. ' +
  'Use [] when nothing relevant was posted.';

interface ResponsesOutput {
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string; annotations?: Array<{ type?: string; url?: string; start_index?: number }> }>;
  }>;
  output_text?: string;
}

interface GrokPost {
  handle?: string;
  text?: string;
  url?: string;
  posted_at?: string;
}

const STATUS_URL = /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/i;

function outputText(json: ResponsesOutput): { text: string; citations: string[] } {
  const texts: string[] = [];
  const citations: string[] = [];
  for (const item of json.output ?? []) {
    if (item.type !== 'message') continue;
    for (const block of item.content ?? []) {
      if (block.type !== 'output_text' || typeof block.text !== 'string') continue;
      texts.push(block.text);
      for (const a of block.annotations ?? []) if (a.type === 'url_citation' && a.url) citations.push(a.url);
    }
  }
  if (texts.length === 0 && typeof json.output_text === 'string') texts.push(json.output_text);
  return { text: texts.join('\n'), citations };
}

function extractJsonArray(text: string): GrokPost[] | undefined {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? (parsed as GrokPost[]) : undefined;
  } catch {
    return undefined;
  }
}

/** Parse a Responses API result into NewsItems. Prefers the JSON array we asked for; falls back to cited post URLs. */
export function parseGrokResponse(json: ResponsesOutput, fetchedAt = new Date().toISOString()): NewsItem[] {
  const { text, citations } = outputText(json);
  const posts = extractJsonArray(text);
  const items: NewsItem[] = [];
  const seen = new Set<string>();
  const push = (url: string, title: string, handleHint?: string, postedAt?: string) => {
    const m = STATUS_URL.exec(url);
    if (!m || !title) return;
    const [, handle, statusId] = m;
    if (!statusId || seen.has(statusId)) return;
    seen.add(statusId);
    const t = postedAt ? Date.parse(postedAt) : NaN;
    items.push({
      id: `grok:${statusId}`,
      source: 'grok',
      title: title.replace(/\s+/g, ' ').trim().slice(0, 280),
      url: `https://x.com/${handle}/status/${statusId}`,
      publishedAt: Number.isNaN(t) ? fetchedAt : new Date(t).toISOString(),
      handle: (handleHint ?? handle ?? '').replace(/^@/, '') || handle,
      domain: 'x.com',
    });
  };

  for (const p of posts ?? []) {
    if (p && typeof p.url === 'string' && typeof p.text === 'string') push(p.url, p.text, p.handle, p.posted_at);
  }
  // A bracketed "[[1]](url)" citation can parse as a JSON array too, so decide on results, not on parse success.
  if (items.length === 0) {
    // Fallback: the model answered in prose. Use each cited post with the line that cites it as the title.
    const lines = text.split('\n');
    for (const url of citations) {
      const line = lines.find((l) => l.includes(url)) ?? '';
      const title = line
        .replace(/\[\[?\d+\]?\]\([^)]*\)/g, '')
        .replace(/[*_#>`-]/g, ' ')
        .trim();
      push(url, title || url);
    }
  }
  return items;
}

export interface GrokProviderOptions {
  apiKey: string;
  model?: string;
  handles?: string[];
  /** Minimum ms between paid calls; in between, fetchLatest returns the cached result. */
  minIntervalMs?: number;
  url?: string;
  timeoutMs?: number;
  fetch?: FetchLike;
  now?: () => number;
}

/** Grok x_search over an allowlist of handles, last ~24 h. Cached so the 60 s poller does not burn money. */
export class GrokProvider implements NewsProvider {
  readonly name = 'grok';
  private cache: { at: number; items: NewsItem[] } | undefined;
  private inflight: Promise<NewsItem[]> | undefined;
  private readonly now: () => number;

  constructor(private readonly opts: GrokProviderOptions) {
    this.now = opts.now ?? Date.now;
  }

  requestBody(): Record<string, unknown> {
    const handles = (this.opts.handles?.length ? this.opts.handles : DEFAULT_X_HANDLES)
      .map((h) => h.replace(/^@/, ''))
      .slice(0, MAX_X_HANDLES);
    // from_date is inclusive from 00:00 UTC; use yesterday so posts just after midnight UTC are not lost.
    const fromDate = new Date(this.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
    return {
      model: this.opts.model ?? XAI_DEFAULT_MODEL,
      input: [
        { role: 'system', content: INSTRUCTIONS },
        { role: 'user', content: 'Latest market-moving posts from the allowed accounts.' },
      ],
      tools: [{ type: 'x_search', allowed_x_handles: handles, from_date: fromDate }],
    };
  }

  async fetchLatest(limit = 20): Promise<NewsItem[]> {
    const minInterval = this.opts.minIntervalMs ?? 300_000;
    if (this.cache && this.now() - this.cache.at < minInterval) return this.cache.items.slice(0, limit);
    // A slow x_search call may outlive the aggregator's deadline; share it instead of paying twice.
    this.inflight ??= this.search().finally(() => {
      this.inflight = undefined;
    });
    return (await this.inflight).slice(0, limit);
  }

  private async search(): Promise<NewsItem[]> {
    const json = await fetchJson<ResponsesOutput>(this.opts.url ?? XAI_RESPONSES_URL, {
      fetch: this.opts.fetch,
      // x_search runs several tool rounds server-side; give it more than the aggregator default.
      timeoutMs: this.opts.timeoutMs ?? Math.max(DEFAULT_TIMEOUT_MS, 30_000),
      init: {
        method: 'POST',
        headers: { authorization: `Bearer ${this.opts.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(this.requestBody()),
      },
    });
    const items = parseGrokResponse(json);
    this.cache = { at: this.now(), items };
    return items;
  }
}
