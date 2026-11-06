/**
 * Provider registry behind GET /providers/status and `npm run doctor`: runs every probe in parallel, each with a
 * 5 s budget, and caches the result for 30 s. index.ts polls it and emits an SSE `providers` event on any change.
 * Probes never log; their details carry no secrets (see probes.ts).
 */
import type { Config } from '../config.js';
import { describeError, PROBES, type ProbeResult, type ProviderProbe, type ProviderState, type ProviderTrack } from './probes.js';

export type { ProviderState, ProviderTrack } from './probes.js';

export const PROBE_TIMEOUT_MS = 5_000;
export const STATUS_CACHE_MS = 30_000;

export interface ProviderStatus {
  id: string;
  label: string;
  track: ProviderTrack;
  state: ProviderState;
  detail: string;
  missingEnv: string[];
  /** Last time this provider was live or degraded (ISO), this process. */
  lastOkAt?: string;
  latencyMs?: number;
  /** Next step with the exact URL (doctor prints it). */
  nextAction?: string;
}

export interface ProvidersStatus {
  checkedAt: string;
  mode: Config['GHOSTY_MODE'];
  providers: ProviderStatus[];
}

export interface ProviderRegistryOptions {
  config: Config;
  fetch?: typeof fetch;
  probes?: ProviderProbe[];
  timeoutMs?: number;
  cacheMs?: number;
  now?: () => number;
}

export type ProvidersListener = (status: ProvidersStatus, changed: ProviderStatus[]) => void;

export class ProviderRegistry {
  private readonly probes: ProviderProbe[];
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly cacheMs: number;
  private readonly now: () => number;
  private cache: { at: number; status: ProvidersStatus } | undefined;
  private inFlight: Promise<ProvidersStatus> | undefined;
  private readonly lastOk = new Map<string, string>();
  private readonly listeners = new Set<ProvidersListener>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly opts: ProviderRegistryOptions) {
    this.probes = opts.probes ?? PROBES;
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
    this.cacheMs = opts.cacheMs ?? STATUS_CACHE_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Cached status (≤ 30 s old), probing when the cache is cold. Concurrent callers share one probe run. */
  async status(): Promise<ProvidersStatus> {
    if (this.cache && this.now() - this.cache.at < this.cacheMs) return this.cache.status;
    return this.refresh();
  }

  /** Probe everything now, update the cache, notify listeners about state changes. */
  async refresh(): Promise<ProvidersStatus> {
    this.inFlight ??= this.runAll().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  /** Called with the full status and the providers whose state changed (all of them on the first run). */
  onChange(listener: ProvidersListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Poll every `intervalMs` (index.ts only; buildApp never starts timers). */
  startPolling(intervalMs = STATUS_CACHE_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh().catch(() => undefined), intervalMs);
    this.timer.unref?.();
  }

  stopPolling(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async runAll(): Promise<ProvidersStatus> {
    const previous = new Map((this.cache?.status.providers ?? []).map((p) => [p.id, p.state]));
    const providers = await Promise.all(this.probes.map((probe) => this.runOne(probe)));
    const status: ProvidersStatus = { checkedAt: new Date(this.now()).toISOString(), mode: this.opts.config.GHOSTY_MODE, providers };
    this.cache = { at: this.now(), status };
    const changed = providers.filter((p) => previous.get(p.id) !== p.state);
    if (changed.length > 0) for (const l of this.listeners) l(status, changed);
    return status;
  }

  private async runOne(probe: ProviderProbe): Promise<ProviderStatus> {
    const started = this.now();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
      }, this.timeoutMs);
    });
    let result: ProbeResult;
    try {
      result = await Promise.race([probe.run({ config: this.opts.config, fetch: this.fetchImpl, signal: controller.signal }), timeout]);
    } catch (err) {
      result = { state: 'offline', detail: describeError(err) };
    } finally {
      clearTimeout(timer);
    }
    const latencyMs = this.now() - started;
    if (result.state === 'live' || result.state === 'degraded') this.lastOk.set(probe.id, new Date(this.now()).toISOString());
    const lastOkAt = this.lastOk.get(probe.id);
    return {
      id: probe.id,
      label: probe.label,
      track: probe.track,
      state: result.state,
      detail: result.detail,
      missingEnv: result.missingEnv ?? [],
      ...(lastOkAt ? { lastOkAt } : {}),
      latencyMs,
      ...(result.nextAction ? { nextAction: result.nextAction } : {}),
    };
  }
}
