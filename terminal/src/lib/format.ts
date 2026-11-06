import type { Signal } from '../api/types';

/** Formatters shared by every panel. All pure, all tested. A missing value renders as an em dash, never as 0. */

export const DASH = '—';

const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });

export function formatUsd(v: number | null | undefined, opts: { cents?: boolean } = {}): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return (opts.cents ? usd2 : usd0).format(v);
}

/** Price with decimals that suit its magnitude: 104,230 · 3,412.5 · 72.48 · 0.4821 · 0.00001234. */
export function formatPrice(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  const abs = Math.abs(v);
  const digits = abs >= 10_000 ? 0 : abs >= 1_000 ? 1 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 8;
  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Signed percent: +1.24% / −0.50%. Uses a real minus sign so columns line up. */
export function formatPct(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  const s = Math.abs(v).toFixed(digits);
  if (Number(s) === 0) return `${(0).toFixed(digits)}%`;
  return `${v > 0 ? '+' : '−'}${s}%`;
}

/** Hyperliquid funding is a per-hour rate as a fraction (0.0000125 → +0.0013%/h). */
export function formatFunding(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return `${formatPct(v * 100, 4)}/h`;
}

export function formatCompact(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return compact.format(v);
}

/** 1 HBAR = 100,000,000 tinybar. */
export function formatHbar(tinybar: number | null | undefined): string {
  if (tinybar === null || tinybar === undefined || !Number.isFinite(tinybar)) return DASH;
  const hbar = tinybar / 1e8;
  const digits = hbar === 0 ? 2 : hbar < 0.01 ? 4 : 2;
  return `${hbar.toFixed(digits)} ℏ`;
}

/** Age from an ISO timestamp: "now", "42s", "7m", "3h", "2d". Future timestamps read "now". */
export function formatAge(iso: string | undefined, now: number): string {
  if (!iso) return DASH;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return DASH;
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 5) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** HH:MM:SS in a time zone, 24 h. */
export function formatClock(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(date);
}

/** Middle-ellipsis for hashes and ids: 0x3f2c…9a1b. Short values pass through. */
export function shortId(id: string | null | undefined, head = 6, tail = 4): string {
  if (!id) return DASH;
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

export function formatConfidence(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;
}

const SIGNAL_LABEL: Record<Signal, string> = {
  geopolitical_shock: 'Geopolitical shock',
  regulatory_crackdown: 'Regulatory crackdown',
  none: 'No signal',
};

export function formatSignal(s: Signal | string): string {
  return SIGNAL_LABEL[s as Signal] ?? s.replace(/_/g, ' ');
}

export type ShockKind = 'war' | 'sanction' | 'hack';

export interface ShockTag {
  tag: string;
  kind: ShockKind;
}

// Same keyword families as server/src/news/shock.ts, so the tape tags what the brain will look at.
const SHOCK_RULES: Array<{ kind: ShockKind; re: RegExp; tag: (word: string) => string }> = [
  {
    kind: 'war',
    re: /\b(war|missiles?|strikes?|airstrikes?|invasion|invades?|invaded|nuclear)\b/i,
    tag: (w) => (/nuclear/i.test(w) ? 'NUCLEAR' : /missile|strike/i.test(w) ? 'STRIKE' : 'WAR'),
  },
  {
    kind: 'sanction',
    re: /\b(sanctions?|sanctioned|bans?|banned|banning|crackdown|lawsuit|sec)\b/i,
    tag: (w) => (/ban/i.test(w) ? 'BAN' : /sanction/i.test(w) ? 'SANCTION' : 'REG'),
  },
  {
    kind: 'hack',
    re: /\b(hacks?|hacked|exploits?|exploited|depegs?|depegged|de-peg(?:ged)?)\b/i,
    tag: (w) => (/peg/i.test(w) ? 'DEPEG' : /exploit/i.test(w) ? 'EXPLOIT' : 'HACK'),
  },
];

/** Shock tag for a headline, or null. War outranks sanctions, which outrank hacks. */
export function shockTag(text: string): ShockTag | null {
  for (const rule of SHOCK_RULES) {
    const m = rule.re.exec(text);
    if (m) return { kind: rule.kind, tag: rule.tag(m[0]) };
  }
  return null;
}

/** "xyz:GOLD" → { ticker: "GOLD", dex: "xyz" }; "BTC" → { ticker: "BTC", dex: "" }. */
export function splitCoin(coin: string): { ticker: string; dex: string } {
  const i = coin.indexOf(':');
  return i === -1 ? { ticker: coin, dex: '' } : { ticker: coin.slice(i + 1), dex: coin.slice(0, i) };
}

/** Server stub feeds (no NEWS_LIVE / no keys) use ids like "rss:coindesk:fake-1". */
export function isStubNewsId(id: string): boolean {
  return /(^|:)fake-/.test(id);
}

/** Percent change between the first and last point of a series, or null with fewer than 2 points. */
export function seriesChangePct(points: readonly number[]): number | null {
  if (points.length < 2) return null;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (first === 0) return null;
  return ((last - first) / first) * 100;
}
