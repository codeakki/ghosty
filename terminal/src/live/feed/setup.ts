import type { ProviderStatus } from '../../api/types';

/**
 * One calm Setup notice instead of error-looking cards. Primary text is plain English; env var names only appear
 * in the expandable details.
 */

export interface SetupIssue {
  id: string;
  /** Plain name of the missing piece. */
  label: string;
  /** What it blocks, in a few words. */
  effect: string;
  env: string[];
  blocking: boolean;
}

export interface SetupNotice {
  headline: string;
  issues: SetupIssue[];
}

interface Rule {
  id: string;
  label: string;
  effect: string;
  headline: string;
  blocking: boolean;
}

/** Most important first. `headline` is used when this is the top issue. */
const RULES: Rule[] = [
  { id: '0g-router', label: '0G brain key', effect: 'decisions', headline: 'Ghosty can’t decide yet — the 0G brain key isn’t set up.', blocking: true },
  { id: '0g-storage', label: 'Storage wallet', effect: 'decisions and memory', headline: 'Ghosty can’t decide yet — the storage wallet isn’t set up.', blocking: true },
  { id: 'hyperliquid', label: 'Trading wallet', effect: 'placing trades', headline: 'Ghosty can’t place trades yet — the trading wallet isn’t set up.', blocking: true },
  { id: 'groq', label: 'Voice input', effect: 'talking to the pod', headline: 'Voice isn’t set up yet — you can type instead.', blocking: false },
  { id: 'elevenlabs', label: 'Voice output', effect: 'spoken replies', headline: 'Spoken replies aren’t set up yet.', blocking: false },
  { id: 'hedera-payer', label: 'Hedera wallet', effect: 'paying for signals', headline: 'Paying for signals isn’t set up yet.', blocking: false },
  { id: 'hedera-merchant', label: 'Hedera merchant account', effect: 'selling signals', headline: 'Selling signals isn’t set up yet.', blocking: false },
  { id: 'uniswap', label: 'Uniswap key', effect: 'the spot leg (optional)', headline: 'The Uniswap leg isn’t set up yet.', blocking: false },
  { id: 'cryptopanic', label: 'CryptoPanic token', effect: 'one extra news source (optional)', headline: 'An optional news source isn’t set up.', blocking: false },
  { id: 'xai', label: 'X posts key', effect: 'X posts in the news (optional)', headline: 'An optional news source isn’t set up.', blocking: false },
];

export function setupNotice(providers: readonly ProviderStatus[] | null | undefined): SetupNotice | null {
  if (!providers) return null;
  const byId = new Map(providers.map((p) => [p.id, p]));
  const issues: SetupIssue[] = [];
  for (const r of RULES) {
    const p = byId.get(r.id);
    if (!p || p.state !== 'not_configured') continue;
    // Voice output has a fallback: only an issue when the fallback is missing too.
    if (r.id === 'elevenlabs' && byId.get('openai-tts')?.state === 'live') continue;
    issues.push({ id: r.id, label: r.label, effect: r.effect, env: p.missingEnv, blocking: r.blocking });
  }
  if (issues.length === 0) return null;
  const top = RULES.find((r) => r.id === issues[0]!.id)!;
  return { headline: top.headline, issues };
}

export interface Watching {
  wires: number | null;
  polymarket: boolean;
  markets: number | null;
}

/** Real counts for the "What Ghosty is watching" intro (null when the server has not said). */
export function watching(providers: readonly ProviderStatus[] | null | undefined, marketCount: number | null): Watching {
  const rss = providers?.find((p) => p.id === 'rss');
  const m = rss ? /(\d+)\/(\d+)/.exec(rss.detail) : null;
  return {
    wires: m ? Number(m[2]) : null,
    polymarket: providers?.some((p) => p.id === 'polymarket' && p.state !== 'not_configured') ?? false,
    markets: marketCount,
  };
}

/** "4 news wires, Polymarket and 8 markets". */
export function watchingText(w: Watching): string {
  const parts: string[] = [];
  if (w.wires !== null) parts.push(`${w.wires} news ${w.wires === 1 ? 'wire' : 'wires'}`);
  if (w.polymarket) parts.push('Polymarket');
  if (w.markets !== null) parts.push(`${w.markets} markets`);
  if (parts.length === 0) return 'the news and the markets';
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}
