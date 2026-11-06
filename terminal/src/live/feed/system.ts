import type { ProviderState } from '../../api/types';

/**
 * Plain-English copy for System cards. Raw probe detail ("key set; 0 models, glm-4.7 NOT listed") never leads:
 * it is kept for an expandable details row.
 */

export interface ProviderEntry {
  id: string;
  label: string;
  state: ProviderState;
  /** State before the first change folded into this card. */
  before: ProviderState;
  detail: string;
  missingEnv: string[];
}

const NAMES: Record<string, string> = {
  '0g-router': '0G brain',
  '0g-storage': '0G memory',
  'hedera-payer': 'Hedera wallet',
  'hedera-merchant': 'Hedera merchant',
  'x402-facilitator': 'x402 payments',
  'hcs-audit': 'Hedera audit log',
  hyperliquid: 'Hyperliquid trading',
  uniswap: 'Uniswap swaps',
  rss: 'RSS feeds',
  polymarket: 'Polymarket',
  cryptopanic: 'CryptoPanic',
  ethos: 'Ethos credibility',
  xai: 'X posts',
  groq: 'Voice input',
  elevenlabs: 'Voice output',
  'openai-tts': 'Backup voice output',
};

/** Most important first: the brain, then money, then data, then voice. */
const ORDER = ['0g-router', '0g-storage', 'hyperliquid', 'uniswap', 'hedera-payer', 'x402-facilitator', 'hedera-merchant', 'hcs-audit', 'rss', 'polymarket', 'ethos', 'cryptopanic', 'xai', 'groq', 'elevenlabs', 'openai-tts'];

export function providerName(id: string, label: string): string {
  return NAMES[id] ?? label.replace(/\s*\(.*\)\s*$/, '');
}

/** "4/4" out of "4/4 feeds reachable", when the probe reports a count. */
function countOf(detail: string): string | null {
  const m = /(\d+)\/(\d+)/.exec(detail);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** One provider, one short phrase: "0G brain unreachable — trading paused", "RSS feeds online (4/4)". */
export function providerPhrase(e: ProviderEntry): string {
  const name = providerName(e.id, e.label);
  const count = countOf(e.detail);
  switch (e.state) {
    case 'live':
      return `${name} online${count ? ` (${count})` : ''}`;
    case 'degraded':
      return `${name} partly down${count ? ` (${count})` : ''}`;
    case 'offline':
      return e.id === '0g-router' ? `${name} unreachable — trading paused` : `${name} unreachable`;
    case 'not_configured':
      return `${name} not set up`;
  }
}

export function sortEntries(entries: readonly ProviderEntry[]): ProviderEntry[] {
  const rank = (id: string) => {
    const i = ORDER.indexOf(id);
    return i === -1 ? ORDER.length : i;
  };
  return [...entries].sort((a, b) => rank(a.id) - rank(b.id));
}

export interface SystemText {
  title: string;
  detail: string | null;
  tone: 'ok' | 'warn';
  /** Raw probe lines, for the expandable details row. */
  raw: string[];
}

export function describeProviders(entries: readonly ProviderEntry[], flips: number): SystemText {
  const sorted = sortEntries(entries);
  const down = sorted.filter((e) => e.state !== 'live');
  const up = sorted.filter((e) => e.state === 'live');
  const lead = down[0] ?? up[0];
  const rest = sorted.filter((e) => e !== lead);
  const parts: string[] = [];
  if (rest.length > 0) parts.push(`Also: ${rest.map(providerPhrase).join(', ')}.`);
  if (flips > 1) parts.push(`Changed ${flips} times in the last minute.`);
  return {
    title: lead ? providerPhrase(lead) : 'Services changed',
    detail: parts.length > 0 ? parts.join(' ') : null,
    tone: down.length > 0 ? 'warn' : 'ok',
    raw: sorted.map((e) => `${e.label}: ${e.state.replace('_', ' ')}${e.detail ? ` — ${e.detail}` : ''}`),
  };
}

export function describeSafeStop(on: boolean, flips: number): SystemText {
  return {
    title: on ? 'Safe-stop on — trading paused' : 'Safe-stop off — trading allowed',
    detail:
      (on ? 'The 0G brain is unreachable, so Ghosty will not place trades.' : 'The 0G brain is back; Ghosty can propose trades again.') +
      (flips > 1 ? ` Changed ${flips} times in the last minute.` : ''),
    tone: on ? 'warn' : 'ok',
    raw: [],
  };
}
