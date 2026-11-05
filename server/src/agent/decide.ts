import { randomUUID } from 'node:crypto';
import { credibilityWeight, type CredibilityScorer } from '../credibility/ethos.js';
import { planActions, type PlannedAction, type Signal } from '../execution/playbook.js';
import type { NewsItem } from '../news/types.js';
import type { UserMemory } from './memory.js';

export interface Decision {
  signal: Signal;
  /** 0..1 */
  confidence: number;
  suggestedActions: PlannedAction[];
  /** 0G Compute request id once real; `fake-<uuid>` for the stub. Logged per episode. */
  requestId: string;
  /** One or two sentences Ghosty speaks to the user. */
  rationale: string;
}

export interface DecideInput {
  transcript: string;
  news: NewsItem[];
  memory: UserMemory;
  maxTradeUsd: number;
}

export interface Decider {
  decide(input: DecideInput): Promise<Decision>;
}

const GEOPOLITICAL = /\b(war|strike|missile|invasion)\b/i;
const REGULATORY = /\b(sec|ban|crackdown|lawsuit|sanction(s|ed)?)\b/i;

/** Classify a single headline. Exported for tests and for a pre-filter before the LLM call. */
export function classifyText(text: string): Signal {
  if (GEOPOLITICAL.test(text)) return 'geopolitical_shock';
  if (REGULATORY.test(text)) return 'regulatory_crackdown';
  return 'none';
}

/**
 * Keyword decider: no LLM. Picks the strongest signal across transcript + headlines,
 * weights confidence by the credibility of the sources that triggered it.
 */
export class FakeDecider implements Decider {
  constructor(private readonly scorer?: CredibilityScorer) {}

  async decide(input: DecideInput): Promise<Decision> {
    const texts: Array<{ text: string; handle?: string }> = [
      { text: input.transcript },
      ...input.news.map((n) => ({ text: n.title, handle: n.handle })),
    ];

    const hits: Record<Signal, Array<{ text: string; handle?: string }>> = {
      geopolitical_shock: [],
      regulatory_crackdown: [],
      none: [],
    };
    for (const t of texts) hits[classifyText(t.text)].push(t);

    const signal: Signal =
      hits.geopolitical_shock.length > 0
        ? 'geopolitical_shock'
        : hits.regulatory_crackdown.length > 0
          ? 'regulatory_crackdown'
          : 'none';

    let confidence = 0;
    if (signal !== 'none') {
      const matched = hits[signal];
      const scorer = this.scorer;
      let weight = 0.8;
      if (scorer) {
        const weights = await Promise.all(
          matched.map(async (m) => (m.handle ? credibilityWeight((await scorer.scoreHandle(m.handle)).level) : 0.5)),
        );
        weight = Math.max(...weights);
      }
      // More independent sources → more confidence, weighted by the best source, capped below 1.
      const raw = (0.4 + 0.15 * Math.min(matched.length, 4)) * weight;
      confidence = Math.round(Math.min(0.95, raw) * 100) / 100;
    }

    const suggestedActions = planActions(signal, input.memory, { maxTradeUsd: input.maxTradeUsd });
    const top = hits[signal][0]?.text;
    const rationale =
      signal === 'geopolitical_shock'
        ? `Geopolitical shock detected: "${top}". I suggest going long gold and oil and shorting bitcoin. Press to confirm.`
        : signal === 'regulatory_crackdown'
          ? `Regulatory pressure detected: "${top}". I suggest reducing bitcoin exposure. Press to confirm.`
          : 'Nothing market-moving right now. I will keep watching.';

    return { signal, confidence, suggestedActions, requestId: `fake-${randomUUID()}`, rationale };
  }
}

// TODO(0g): ZeroGDecider. 0G Compute Router is OpenAI-compatible.
// Package: `openai` (not installed yet) with baseURL = OG_ROUTER_URL, apiKey = OG_API_KEY; model from pc.0g.ai/models.
// Prompt: system = playbook + risk profile from memory; user = transcript + top headlines with Ethos levels.
// Ask for JSON { signal, confidence, rationale }; validate with zod; then suggestedActions = planActions(...).
// requestId = response id (or the x-request-id header) so every episode links to a 0G inference.
// Direct (TEE-verified) alternative: @0gfoundation/0g-compute-ts-sdk createZGComputeNetworkBroker → getRequestHeaders.
// On any 0G error: throw, and let safeStop block trading (never fall back to a non-0G model for a trade).
