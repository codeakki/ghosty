import type { Signal } from '../execution/playbook.js';
import type { NewsItem } from './types.js';

/**
 * Keyword pre-filter for "something big just happened". It only narrows what the agent looks at;
 * the decision (and whether to trade) stays with the 0G agent.
 */
export type ShockCategory = 'geopolitical_shock' | 'regulatory_crackdown' | 'crypto_incident';

const RULES: Array<{ category: ShockCategory; re: RegExp }> = [
  { category: 'geopolitical_shock', re: /\b(war|missiles?|strikes?|airstrikes?|invasion|invades?|invaded|nuclear)\b/gi },
  { category: 'regulatory_crackdown', re: /\b(sanctions?|sanctioned|bans?|banned|banning)\b/gi },
  { category: 'crypto_incident', re: /\b(hacks?|hacked|exploits?|exploited|depegs?|depegged|de-peg(?:ged)?)\b/gi },
];

/** Strongest first: a war headline outranks a ban, which outranks a protocol hack. */
const PRIORITY: ShockCategory[] = ['geopolitical_shock', 'regulatory_crackdown', 'crypto_incident'];

export interface ShockMatch {
  item: NewsItem;
  category: ShockCategory;
  keywords: string[];
}

export interface ShockResult {
  /** Highest-priority category with at least one match, or 'none'. */
  candidate: ShockCategory | 'none';
  /** The candidate mapped onto the trade playbook. crypto_incident has no playbook yet → 'none'. */
  signal: Signal;
  /** Items that matched the candidate, most credible first, then newest. */
  matched: ShockMatch[];
  /** Every matching item across all categories. */
  all: ShockMatch[];
}

function classify(item: NewsItem): ShockMatch | undefined {
  const text = `${item.title} ${item.summary ?? ''}`;
  for (const category of PRIORITY) {
    const rule = RULES.find((r) => r.category === category);
    if (!rule) continue;
    const hits = [...text.matchAll(rule.re)].map((m) => m[0].toLowerCase());
    if (hits.length > 0) return { item, category, keywords: [...new Set(hits)] };
  }
  return undefined;
}

/** Pure: same items in → same result out. */
export function shockDetector(items: NewsItem[]): ShockResult {
  const all = items.map(classify).filter((m): m is ShockMatch => m !== undefined);
  const candidate = PRIORITY.find((c) => all.some((m) => m.category === c)) ?? 'none';
  const matched = all
    .filter((m) => m.category === candidate)
    .sort(
      (a, b) => (b.item.credibility ?? 0.5) - (a.item.credibility ?? 0.5) || b.item.publishedAt.localeCompare(a.item.publishedAt),
    );
  const signal: Signal = candidate === 'geopolitical_shock' || candidate === 'regulatory_crackdown' ? candidate : 'none';
  return { candidate, signal, matched, all };
}
