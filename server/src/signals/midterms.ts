import { runSignalChecks } from './checks.js';

/**
 * Live evaluation for the midterms demo: Polymarket's House and Senate results and the ETH price move on
 * Hyperliquid and Binance. Returns sentences for the speaker. Never throws.
 */
const GAMMA = 'https://gamma-api.polymarket.com';

async function democratsWon(slug: string, fetchImpl: typeof fetch): Promise<'yes' | 'no' | 'open' | undefined> {
  try {
    const res = await fetchImpl(`${GAMMA}/events?slug=${slug}`, { signal: AbortSignal.timeout(15000) });
    const [event] = (await res.json()) as Array<{ markets?: Array<{ question?: string; outcomePrices?: string; closed?: boolean }> }>;
    const dem = event?.markets?.find((m) => /democratic/i.test(m.question ?? ''));
    if (!dem) return undefined;
    const yes = Number((JSON.parse(dem.outcomePrices ?? '[]') as string[])[0]);
    if (!dem.closed) return 'open';
    return yes >= 0.99 ? 'yes' : 'no';
  } catch {
    return undefined;
  }
}

export async function evaluateMidterms(fetchImpl: typeof fetch = fetch): Promise<string> {
  const [house, senate, checks] = await Promise.all([
    democratsWon('which-party-will-win-the-house-in-2026', fetchImpl),
    democratsWon('which-party-will-win-the-senate-in-2026', fetchImpl),
    runSignalChecks(
      { headline: 'Democrats win the midterms', actions: [{ venue: 'hyperliquid', kind: 'perp', coin: 'ETH', side: 'long', sizeUsd: 10, reason: 'midterms' }] },
      { fetch: fetchImpl, testnet: false },
    ),
  ]);
  const parts: string[] = [];
  if (house === 'yes' && senate === 'yes') parts.push('Polymarket has settled both: Democrats control the House and the Senate.');
  else if (house === 'yes' || senate === 'yes') parts.push(`Polymarket has settled the ${house === 'yes' ? 'House' : 'Senate'} for the Democrats.`);
  else parts.push('I could not read the Polymarket result right now.');
  const hl = checks.prices.find((p) => p.venue === 'hyperliquid');
  if (hl) {
    const move = (n: number) => `${n >= 0 ? 'up' : 'down'} ${Math.abs(n).toFixed(2)} percent`;
    parts.push(`ETH is at ${Math.round(hl.price)} dollars, ${move(hl.change5mPct)} in five minutes${hl.significant ? ', a significant move' : ', no big move yet'}.`);
  }
  return parts.join(' ');
}
