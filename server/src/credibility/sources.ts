/**
 * Static credibility of publisher domains, on the same 0.2..1.0 scale as Ethos weights.
 * Hand-picked: wire services and established crypto desks high, aggregators and social medium.
 */
export const SOURCE_WEIGHTS: Record<string, number> = {
  'reuters.com': 1.0,
  'apnews.com': 1.0,
  'bloomberg.com': 1.0,
  'ft.com': 0.95,
  'wsj.com': 0.95,
  'cnbc.com': 0.9,
  'coindesk.com': 0.9,
  'theblock.co': 0.9,
  'polymarket.com': 0.8, // real-money odds: a different kind of evidence, but hard to fake
  'decrypt.co': 0.75,
  'cointelegraph.com': 0.75,
  'blockworks.co': 0.8,
  'cryptopanic.com': 0.6, // aggregator link without an original source
  'x.com': 0.5, // the poster's Ethos score decides
  'twitter.com': 0.5,
};

/** Unknown publishers land in the middle. */
export const UNKNOWN_SOURCE_WEIGHT = 0.6;

/** Weight for a domain, matching parent domains too (markets.reuters.com → reuters.com). */
export function sourceWeight(domain: string | undefined): { weight: number; known: boolean } {
  if (!domain) return { weight: UNKNOWN_SOURCE_WEIGHT, known: false };
  let d = domain.toLowerCase().replace(/^www\./, '');
  while (d.includes('.')) {
    const w = SOURCE_WEIGHTS[d];
    if (w !== undefined) return { weight: w, known: true };
    d = d.slice(d.indexOf('.') + 1);
  }
  return { weight: UNKNOWN_SOURCE_WEIGHT, known: false };
}
