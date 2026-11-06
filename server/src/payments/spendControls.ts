import { join } from 'node:path';
import { DEFAULT_STATE_DIR, readJsonFile, writeJsonFile } from './hedera.js';

/**
 * Agent-side spend controls for x402 (Hedera track extra credit):
 * - SpendCap: total tinybars the agent may sign per UTC day, persisted in server/.ghosty/spend.json.
 * - isHostAllowed: the agent only pays hosts on X402_ALLOWED_HOSTS.
 * The per-payment cap is enforced by @x402/core spendControls (see x402Client.ts).
 */

export class SpendCapExceededError extends Error {
  constructor(
    readonly amountTinybar: number,
    readonly spentTinybar: number,
    readonly capTinybar: number,
  ) {
    super(`daily x402 spend cap exceeded: ${spentTinybar} + ${amountTinybar} > ${capTinybar} tinybar`);
    this.name = 'SpendCapExceededError';
  }
}

export class HostNotAllowedError extends Error {
  constructor(readonly host: string) {
    super(`x402 payment to ${host} refused: host not in X402_ALLOWED_HOSTS`);
    this.name = 'HostNotAllowedError';
  }
}

interface SpendState {
  /** UTC day, YYYY-MM-DD */
  day: string;
  spentTinybar: number;
  payments: Array<{ ts: string; amountTinybar: number; ref?: string }>;
}

export interface SpendCapOptions {
  maxPerDayTinybar: number;
  /** JSON file; default server/.ghosty/spend.json. Pass `null` for in-memory only. */
  file?: string | null;
  now?: () => Date;
}

export class SpendCap {
  readonly maxPerDayTinybar: number;
  private readonly file: string | null;
  private readonly now: () => Date;
  private state: SpendState;

  constructor(opts: SpendCapOptions) {
    if (!Number.isSafeInteger(opts.maxPerDayTinybar) || opts.maxPerDayTinybar <= 0) {
      throw new RangeError('maxPerDayTinybar must be a positive integer');
    }
    this.maxPerDayTinybar = opts.maxPerDayTinybar;
    this.file = opts.file === undefined ? join(DEFAULT_STATE_DIR, 'spend.json') : opts.file;
    this.now = opts.now ?? (() => new Date());
    const loaded = this.file ? readJsonFile<SpendState>(this.file) : undefined;
    this.state = isSpendState(loaded) ? loaded : { day: this.today(), spentTinybar: 0, payments: [] };
  }

  /** Tinybars already signed today (UTC). */
  spentToday(): number {
    this.rollover();
    return this.state.spentTinybar;
  }

  remainingToday(): number {
    return Math.max(0, this.maxPerDayTinybar - this.spentToday());
  }

  canSpend(amountTinybar: number): boolean {
    return Number.isSafeInteger(amountTinybar) && amountTinybar > 0 && this.spentToday() + amountTinybar <= this.maxPerDayTinybar;
  }

  assertCanSpend(amountTinybar: number): void {
    if (!this.canSpend(amountTinybar)) {
      throw new SpendCapExceededError(amountTinybar, this.spentToday(), this.maxPerDayTinybar);
    }
  }

  /**
   * Count a payment against today's budget and persist. Throws (and records nothing) when it
   * would exceed the cap, so check-and-record is a single step for callers that want that.
   */
  record(amountTinybar: number, ref?: string): void {
    this.assertCanSpend(amountTinybar);
    this.state.spentTinybar += amountTinybar;
    this.state.payments.push({ ts: this.now().toISOString(), amountTinybar, ...(ref ? { ref } : {}) });
    this.persist();
  }

  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private rollover(): void {
    const today = this.today();
    if (this.state.day !== today) {
      this.state = { day: today, spentTinybar: 0, payments: [] };
      this.persist();
    }
  }

  private persist(): void {
    if (this.file) writeJsonFile(this.file, this.state);
  }
}

function isSpendState(v: unknown): v is SpendState {
  if (!v || typeof v !== 'object') return false;
  const s = v as Partial<SpendState>;
  return typeof s.day === 'string' && typeof s.spentTinybar === 'number' && Number.isFinite(s.spentTinybar) && Array.isArray(s.payments);
}

/**
 * True when the URL's host is on the allowlist. Entries match the hostname (any port) or an
 * exact `host:port`. A leading `*.` matches subdomains. Comparison is case-insensitive.
 */
export function isHostAllowed(url: string | URL, allowedHosts: readonly string[]): boolean {
  let u: URL;
  try {
    u = typeof url === 'string' ? new URL(url) : url;
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const hostname = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const hostPort = u.port ? `${hostname}:${u.port}` : hostname;
  return allowedHosts.some((raw) => {
    const entry = raw.trim().toLowerCase();
    if (!entry) return false;
    if (entry.startsWith('*.')) return hostname.endsWith(entry.slice(1));
    return entry === hostname || entry === hostPort;
  });
}

export function assertHostAllowed(url: string | URL, allowedHosts: readonly string[]): void {
  if (!isHostAllowed(url, allowedHosts)) {
    let host = String(url);
    try {
      host = new URL(String(url)).host;
    } catch {
      // keep the raw string
    }
    throw new HostNotAllowedError(host);
  }
}
