import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CredibilityScorer } from '../credibility/ethos.js';
import { weightItems } from '../credibility/ethos.js';
import { withTimeout } from './http.js';
import type { NewsItem, NewsProvider } from './types.js';

/** Lowercased title with punctuation and extra whitespace removed, for cross-source dedupe. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** host+path without www, query, hash or trailing slash, for cross-source dedupe. */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

/** Keys that identify the same story: provider id, normalized url, normalized title. */
export function dedupeKeys(item: NewsItem): string[] {
  const keys = [`id:${item.id}`];
  if (item.url) keys.push(`url:${normalizeUrl(item.url)}`);
  const title = normalizeTitle(item.title);
  if (title.length >= 12) keys.push(`title:${title}`); // very short titles collide too easily
  return keys;
}

export interface ProviderError {
  provider: string;
  message: string;
}

export interface PollResult {
  /** Items never seen before (across restarts, via the seen file). */
  fresh: NewsItem[];
  /** Everything in the rolling window, newest first. */
  window: NewsItem[];
  errors: ProviderError[];
}

export interface NewsAggregatorOptions {
  providers: NewsProvider[];
  /** Per-provider deadline (default 8 s). */
  timeoutMs?: number;
  /** Per-provider overrides by provider name, e.g. { grok: 45_000 }. */
  timeouts?: Record<string, number>;
  /** Rolling window length (default 120 min). */
  windowMinutes?: number;
  /** Items requested from each provider per poll. */
  limitPerProvider?: number;
  /** JSON file for last-seen keys; omit to keep them in memory only. */
  seenPath?: string;
  /** Max keys kept in the seen file. */
  maxSeen?: number;
  /** When set, `credibility` is attached to new items. */
  scorer?: CredibilityScorer;
  now?: () => number;
}

/**
 * Fans out to every provider (each with its own deadline), dedupes by id / url / title,
 * keeps a rolling time window, and remembers what it has already announced.
 * Also a NewsProvider itself: `fetchLatest` returns the window, so the pipeline can take it as-is.
 */
export class NewsAggregator implements NewsProvider {
  readonly name = 'aggregator';
  private readonly windowItems = new Map<string, NewsItem>();
  private readonly windowKeys = new Map<string, string>(); // dedupe key → window item id
  private seen: Set<string> | undefined;
  private polled = false;
  private readonly now: () => number;

  constructor(private readonly opts: NewsAggregatorOptions) {
    this.now = opts.now ?? Date.now;
  }

  get providers(): readonly NewsProvider[] {
    return this.opts.providers;
  }

  private windowMs(): number {
    return (this.opts.windowMinutes ?? 120) * 60_000;
  }

  private async loadSeen(): Promise<Set<string>> {
    if (this.seen) return this.seen;
    this.seen = new Set();
    if (this.opts.seenPath) {
      try {
        const data = JSON.parse(await readFile(this.opts.seenPath, 'utf8')) as { keys?: unknown };
        if (Array.isArray(data.keys)) for (const k of data.keys) if (typeof k === 'string') this.seen.add(k);
      } catch {
        // missing or corrupt file: start fresh
      }
    }
    return this.seen;
  }

  private async saveSeen(): Promise<void> {
    if (!this.opts.seenPath || !this.seen) return;
    const max = this.opts.maxSeen ?? 5000;
    const keys = [...this.seen].slice(-max); // Set keeps insertion order: drop the oldest
    this.seen = new Set(keys);
    const tmp = `${this.opts.seenPath}.tmp`;
    try {
      await mkdir(dirname(this.opts.seenPath), { recursive: true });
      await writeFile(tmp, JSON.stringify({ updatedAt: new Date(this.now()).toISOString(), keys }));
      await rename(tmp, this.opts.seenPath);
    } catch {
      // persistence is best effort; never fail a poll over it
    }
  }

  private prune(): void {
    const cutoff = this.now() - this.windowMs();
    for (const [id, item] of this.windowItems) {
      if (Date.parse(item.publishedAt) < cutoff) this.removeFromWindow(id);
    }
  }

  private removeFromWindow(id: string): void {
    const item = this.windowItems.get(id);
    if (!item) return;
    this.windowItems.delete(id);
    for (const k of dedupeKeys(item)) if (this.windowKeys.get(k) === id) this.windowKeys.delete(k);
  }

  private addToWindow(item: NewsItem): void {
    this.windowItems.set(item.id, item);
    for (const k of dedupeKeys(item)) if (!this.windowKeys.has(k)) this.windowKeys.set(k, item.id);
  }

  async poll(): Promise<PollResult> {
    const seen = await this.loadSeen();
    const limit = this.opts.limitPerProvider ?? 40;
    const errors: ProviderError[] = [];
    const settled = await Promise.allSettled(
      this.opts.providers.map((p) =>
        withTimeout(p.fetchLatest(limit), this.opts.timeouts?.[p.name] ?? this.opts.timeoutMs ?? 8_000, p.name),
      ),
    );
    const fetched: NewsItem[] = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') fetched.push(...r.value);
      else errors.push({ provider: this.opts.providers[i]?.name ?? '?', message: String((r.reason as Error)?.message ?? r.reason) });
    });

    const nowMs = this.now();
    const cutoff = nowMs - this.windowMs();
    let fresh: NewsItem[] = [];
    for (const raw of fetched) {
      // Unparseable or future timestamps are clamped to "now" so they neither vanish nor pin the top.
      const t = Date.parse(raw.publishedAt);
      const item = Number.isNaN(t) || t > nowMs ? { ...raw, publishedAt: new Date(nowMs).toISOString() } : raw;
      if (Date.parse(item.publishedAt) < cutoff) continue;

      const keys = dedupeKeys(item);
      const existingId = keys.map((k) => this.windowKeys.get(k)).find((id) => id !== undefined);
      if (existingId !== undefined) {
        // Same provider id again: keep the latest copy (Polymarket odds move). Other dupes are dropped.
        if (existingId === item.id) this.windowItems.set(item.id, { ...this.windowItems.get(item.id), ...item });
        continue;
      }
      this.addToWindow(item);
      const isFresh = !keys.some((k) => seen.has(k));
      for (const k of keys) seen.add(k);
      if (isFresh) fresh.push(item);
    }
    this.prune();
    this.polled = true;

    if (this.opts.scorer && fresh.length > 0) {
      fresh = await weightItems(fresh, this.opts.scorer);
      for (const item of fresh) if (this.windowItems.has(item.id)) this.windowItems.set(item.id, item);
    }
    await this.saveSeen();
    return { fresh: newestFirst(fresh), window: this.window(), errors };
  }

  /** Current rolling window, newest first. */
  window(): NewsItem[] {
    this.prune();
    return newestFirst([...this.windowItems.values()]);
  }

  /** NewsProvider: the window (polling once first if the poller has not run yet). */
  async fetchLatest(limit = 50): Promise<NewsItem[]> {
    if (!this.polled) await this.poll();
    return this.window().slice(0, limit);
  }
}

function newestFirst(items: NewsItem[]): NewsItem[] {
  return items.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

export type NewItemsListener = (items: NewsItem[]) => void | Promise<void>;

export interface NewsPollerOptions {
  /** Poll interval (default 60 s). */
  intervalMs?: number;
  onError?: (err: unknown) => void;
  /** Provider failures (timeouts, 4xx/5xx) from a poll that otherwise succeeded. */
  onProviderErrors?: (errors: ProviderError[]) => void;
}

/**
 * Polls a NewsAggregator on an interval and calls every `onNew` listener once per batch of
 * never-seen items. Ticks never overlap; the timer is unref'd so it does not keep the process alive.
 */
export class NewsPoller {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private readonly listeners: NewItemsListener[] = [];

  constructor(
    private readonly aggregator: Pick<NewsAggregator, 'poll'>,
    private readonly opts: NewsPollerOptions = {},
  ) {}

  onNew(listener: NewItemsListener): this {
    this.listeners.push(listener);
    return this;
  }

  /** One poll; resolves when listeners have run. Concurrent calls share the in-flight tick. */
  tick(): Promise<void> {
    this.running ??= this.runOnce().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async runOnce(): Promise<void> {
    try {
      const { fresh, errors } = await this.aggregator.poll();
      if (errors.length > 0) this.opts.onProviderErrors?.(errors);
      if (fresh.length === 0) return;
      for (const listener of this.listeners) {
        try {
          await listener(fresh);
        } catch (err) {
          this.opts.onError?.(err);
        }
      }
    } catch (err) {
      this.opts.onError?.(err);
    }
  }

  start(): this {
    if (this.timer) return this;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs ?? 60_000);
    this.timer.unref();
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  get started(): boolean {
    return this.timer !== undefined;
  }
}
