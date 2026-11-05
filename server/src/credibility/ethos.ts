/**
 * Signal credibility via Ethos Network. Not a sponsor; optional weighting layer.
 * Ethos scores run 0–2800. We collapse them into a coarse level the decision loop can use.
 */

export type CredibilityLevel = 'untrusted' | 'questionable' | 'neutral' | 'reputable' | 'exemplary';

export interface CredibilityScore {
  handle: string;
  /** Ethos score 0–2800, or null when unknown. */
  score: number | null;
  level: CredibilityLevel;
}

export interface CredibilityScorer {
  scoreHandle(handle: string): Promise<CredibilityScore>;
}

/** Approximate Ethos thresholds; confirm against the API's own `level` field once wired. */
export function levelFromScore(score: number): CredibilityLevel {
  if (score < 800) return 'untrusted';
  if (score < 1200) return 'questionable';
  if (score < 1600) return 'neutral';
  if (score < 2000) return 'reputable';
  return 'exemplary';
}

/** Multiplier applied to a signal's confidence. */
export function credibilityWeight(level: CredibilityLevel): number {
  switch (level) {
    case 'untrusted':
      return 0.2;
    case 'questionable':
      return 0.5;
    case 'neutral':
      return 0.8;
    case 'reputable':
      return 1.0;
    case 'exemplary':
      return 1.1;
  }
}

const FAKE_SCORES: Record<string, number> = {
  reuters: 2300,
  deitaone: 1900,
  coindesk: 1850,
  cointelegraph: 1500,
  watcherguru: 1300,
  randomtrader123: 600,
};

/** Deterministic fake: known outlets score high, unknown handles are "questionable". */
export class FakeEthosScorer implements CredibilityScorer {
  async scoreHandle(handle: string): Promise<CredibilityScore> {
    const score = FAKE_SCORES[handle.replace(/^@/, '').toLowerCase()];
    if (score === undefined) return { handle, score: null, level: 'questionable' };
    return { handle, score, level: levelFromScore(score) };
  }
}

// TODO(credibility): real Ethos API v2 scorer.
// Base: https://api.ethos.network/api/v2   Header: X-Ethos-Client: <ETHOS_CLIENT> (e.g. ghosty@0.1.0)
// By X handle: GET /score/userkey?userkey=service:x.com:username:<handle>  → { score, level }
// By wallet:   GET /score/address?address=0x...
// Bulk:        POST /score/userkeys, POST /score/addresses
// Cache results for ~1 h; scores move slowly.
//
// export class EthosScorer implements CredibilityScorer {
//   constructor(private readonly client: string, private readonly base = 'https://api.ethos.network/api/v2') {}
//   async scoreHandle(handle: string): Promise<CredibilityScore> {
//     const userkey = encodeURIComponent(`service:x.com:username:${handle}`);
//     const res = await fetch(`${this.base}/score/userkey?userkey=${userkey}`, { headers: { 'X-Ethos-Client': this.client } });
//     if (!res.ok) return { handle, score: null, level: 'questionable' };
//     const { score } = (await res.json()) as { score: number; level: string };
//     return { handle, score, level: levelFromScore(score) };
//   }
// }
