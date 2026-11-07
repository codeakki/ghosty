import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Guest access (GUEST_ACCESS=true): anyone can get a short-lived token that only asks Ghosty questions.
 * Guests never decide, trade, pay, inject or press the button; app.ts enforces that per route and the pipeline
 * answers guest trade requests with GUEST_TRADE_REPLY. This module issues, verifies and meters the tokens.
 *
 * Tokens are 32 hex chars. Only their sha256 is kept (in memory, and in `persistPath` when set) so a leaked
 * guests.json never hands out working tokens.
 */

export const GUEST_TRADE_REPLY = "Guests can ask questions; trading needs the owner's pod.";
export const GUEST_NO_ASSISTANT_REPLY = 'Guest questions are switched off right now. Please try again later.';

export interface GuestLimits {
  ttlSec: number;
  /** Voice/text turns per guest token per rolling hour. */
  maxPerHour: number;
  /** Guest turns per UTC day, all guests together (cost guard). */
  maxPerDay: number;
  /** Tokens one IP may get per rolling hour. */
  issuePerIpPerHour: number;
  /** Unexpired guest tokens at once, all IPs together. */
  maxActive: number;
}

export const DEFAULT_GUEST_LIMITS: GuestLimits = {
  ttlSec: 86_400,
  maxPerHour: 10,
  maxPerDay: 300,
  issuePerIpPerHour: 5,
  maxActive: 500,
};

export interface GuestSession {
  /** sha256 of the token. */
  id: string;
  issuedAt: number;
  expiresAt: number;
  /** Turn timestamps in the last hour. */
  turns: number[];
}

export type IssueResult =
  | { ok: true; token: string; expiresAt: number; ttlSec: number }
  | { ok: false; error: 'guest_issue_limited' | 'guest_capacity'; retryAfterSec: number };

export type TurnResult = { ok: true } | { ok: false; error: 'guest_rate_limited' | 'guest_daily_cap'; retryAfterSec: number };

const HOUR_MS = 3_600_000;
const TOKEN_RE = /^[0-9a-f]{32}$/;

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export class GuestAccess {
  readonly limits: GuestLimits;
  private readonly sessions = new Map<string, GuestSession>();
  private readonly issuedByIp = new Map<string, number[]>();
  private day = '';
  private dayTurns = 0;
  private readonly now: () => number;

  constructor(
    limits: Partial<GuestLimits> = {},
    private readonly opts: { persistPath?: string; now?: () => number; onPersistError?: (err: unknown) => void } = {},
  ) {
    this.limits = { ...DEFAULT_GUEST_LIMITS, ...limits };
    this.now = opts.now ?? Date.now;
    this.load();
  }

  /** A new guest token for `ip`, or why not (per-IP issuance limit, global cap on active tokens). */
  issue(ip: string): IssueResult {
    const now = this.now();
    this.prune(now);
    const recent = (this.issuedByIp.get(ip) ?? []).filter((t) => now - t < HOUR_MS);
    if (recent.length >= this.limits.issuePerIpPerHour) {
      return { ok: false, error: 'guest_issue_limited', retryAfterSec: Math.max(1, Math.ceil((recent[0]! + HOUR_MS - now) / 1000)) };
    }
    if (this.sessions.size >= this.limits.maxActive) {
      const soonest = Math.min(...[...this.sessions.values()].map((s) => s.expiresAt));
      return { ok: false, error: 'guest_capacity', retryAfterSec: Math.max(1, Math.ceil((soonest - now) / 1000)) };
    }
    const token = randomBytes(16).toString('hex');
    const expiresAt = now + this.limits.ttlSec * 1000;
    this.sessions.set(hash(token), { id: hash(token), issuedAt: now, expiresAt, turns: [] });
    recent.push(now);
    this.issuedByIp.set(ip, recent);
    this.persist();
    return { ok: true, token, expiresAt, ttlSec: this.limits.ttlSec };
  }

  /** The live session for a token, or undefined (unknown, malformed or expired). */
  verify(token: string): GuestSession | undefined {
    if (!TOKEN_RE.test(token)) return undefined;
    const session = this.sessions.get(hash(token));
    // Expired sessions are dropped by prune() on the next issue, so wasExpired() can still say "expired" until then.
    if (!session || this.now() >= session.expiresAt) return undefined;
    return session;
  }

  /** True when the token was a guest token that has expired (so the UI can say "expired" instead of "wrong"). */
  wasExpired(token: string): boolean {
    if (!TOKEN_RE.test(token)) return false;
    const s = this.sessions.get(hash(token));
    return s !== undefined && this.now() >= s.expiresAt;
  }

  /** Count one voice/text turn against the guest's hourly limit and the global daily cap. */
  consumeTurn(session: GuestSession): TurnResult {
    const now = this.now();
    session.turns = session.turns.filter((t) => now - t < HOUR_MS);
    if (session.turns.length >= this.limits.maxPerHour) {
      return { ok: false, error: 'guest_rate_limited', retryAfterSec: Math.max(1, Math.ceil((session.turns[0]! + HOUR_MS - now) / 1000)) };
    }
    const today = new Date(now).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.dayTurns = 0;
    }
    if (this.dayTurns >= this.limits.maxPerDay) {
      const midnight = Date.parse(`${today}T00:00:00.000Z`) + 24 * HOUR_MS;
      return { ok: false, error: 'guest_daily_cap', retryAfterSec: Math.max(1, Math.ceil((midnight - now) / 1000)) };
    }
    session.turns.push(now);
    this.dayTurns += 1;
    return { ok: true };
  }

  activeCount(): number {
    this.prune(this.now());
    return this.sessions.size;
  }

  private prune(now: number): void {
    for (const [id, s] of this.sessions) if (now >= s.expiresAt) this.sessions.delete(id);
    for (const [ip, times] of this.issuedByIp) {
      const fresh = times.filter((t) => now - t < HOUR_MS);
      if (fresh.length === 0) this.issuedByIp.delete(ip);
      else this.issuedByIp.set(ip, fresh);
    }
  }

  private load(): void {
    const path = this.opts.persistPath;
    if (!path || !existsSync(path)) return;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { guests?: Array<{ id: string; issuedAt: number; expiresAt: number }> };
      const now = this.now();
      for (const g of raw.guests ?? []) {
        if (typeof g.id === 'string' && /^[0-9a-f]{64}$/.test(g.id) && typeof g.expiresAt === 'number' && g.expiresAt > now) {
          this.sessions.set(g.id, { id: g.id, issuedAt: Number(g.issuedAt) || now, expiresAt: g.expiresAt, turns: [] });
        }
      }
    } catch (err) {
      this.opts.onPersistError?.(err);
    }
  }

  private persist(): void {
    const path = this.opts.persistPath;
    if (!path) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const guests = [...this.sessions.values()].map(({ id, issuedAt, expiresAt }) => ({ id, issuedAt, expiresAt }));
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ guests }), { mode: 0o600 });
      renameSync(tmp, path);
    } catch (err) {
      this.opts.onPersistError?.(err);
    }
  }
}
