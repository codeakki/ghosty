import { join } from 'node:path';
import { DEFAULT_STATE_DIR, readJsonFile, writeJsonFile } from './hedera.js';

/**
 * Agent-side spend controls for x402, checked before anything is signed:
 * - SpendCap: a daily budget PER ASSET (tinybars for HBAR, micro-units for USDC), in bigint so nothing rounds.
 *   Persisted in server/.ghosty/spend.json so a restart does not reset the budget.
 * - isHostAllowed: the agent only pays hosts on X402_ALLOWED_HOSTS.
 * The per-payment cap is enforced by @x402/core spendControls (see x402Client.ts).
 */

export class SpendCapExceededError extends Error {
  constructor(
    readonly asset: string,
    readonly amount: bigint,
    readonly spent: bigint,
    readonly cap: bigint,
  ) {
    super(`daily x402 spend cap exceeded for ${asset}: ${spent} + ${amount} > ${cap}`);
    this.name = 'SpendCapExceededError';
  }
}

export class HostNotAllowedError extends Error {
  constructor(readonly host: string) {
    super(`x402 payment to ${host} refused: host not in X402_ALLOWED_HOSTS`);
    this.name = 'HostNotAllowedError';
  }
}

/** On disk amounts are decimal strings (JSON has no bigint). */
interface SpendState {
  v: 2;
  /** UTC day, YYYY-MM-DD */
  day: string;
  spent: Record<string, string>;
  payments: Array<{ ts: string; asset: string; amount: string; ref?: string }>;
}

export interface SpendCapOptions {
  /** Daily cap per asset id, e.g. { '0.0.0': 500_000_000n, '0.0.429274': 2_000_000n }. Unlisted assets: cap 0. */
  maxPerDay: Record<string, bigint>;
  /** JSON file; default server/.ghosty/spend.json. Pass `null` for in-memory only. */
  file?: string | null;
  now?: () => Date;
}

export class SpendCap {
  private readonly caps: Record<string, bigint>;
  private readonly file: string | null;
  private readonly now: () => Date;
  private state: SpendState;

  constructor(opts: SpendCapOptions) {
    for (const [asset, cap] of Object.entries(opts.maxPerDay)) {
      if (typeof cap !== 'bigint' || cap <= 0n) throw new RangeError(`daily cap for ${asset} must be a positive bigint`);
    }
    this.caps = { ...opts.maxPerDay };
    this.file = opts.file === undefined ? join(DEFAULT_STATE_DIR, 'spend.json') : opts.file;
    this.now = opts.now ?? (() => new Date());
    const loaded = this.file ? readJsonFile<SpendState>(this.file) : undefined;
    this.state = isSpendState(loaded) ? loaded : this.emptyDay();
  }

  maxPerDay(asset: string): bigint {
    return this.caps[asset] ?? 0n;
  }

  /** Atomic units of `asset` already signed today (UTC). */
  spentToday(asset: string): bigint {
    this.rollover();
    return BigInt(this.state.spent[asset] ?? '0');
  }

  remainingToday(asset: string): bigint {
    const left = this.maxPerDay(asset) - this.spentToday(asset);
    return left > 0n ? left : 0n;
  }

  canSpend(asset: string, amount: bigint): boolean {
    return amount > 0n && this.spentToday(asset) + amount <= this.maxPerDay(asset);
  }

  assertCanSpend(asset: string, amount: bigint): void {
    if (!this.canSpend(asset, amount)) throw new SpendCapExceededError(asset, amount, this.spentToday(asset), this.maxPerDay(asset));
  }

  /** Count a payment against today's budget and persist. Throws (and records nothing) when it would exceed the cap. */
  record(asset: string, amount: bigint, ref?: string): void {
    this.assertCanSpend(asset, amount);
    this.state.spent[asset] = (this.spentToday(asset) + amount).toString();
    this.state.payments.push({ ts: this.now().toISOString(), asset, amount: amount.toString(), ...(ref ? { ref } : {}) });
    this.persist();
  }

  private emptyDay(): SpendState {
    return { v: 2, day: this.today(), spent: {}, payments: [] };
  }

  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private rollover(): void {
    if (this.state.day !== this.today()) {
      this.state = this.emptyDay();
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
  return s.v === 2 && typeof s.day === 'string' && typeof s.spent === 'object' && s.spent !== null && Array.isArray(s.payments);
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
