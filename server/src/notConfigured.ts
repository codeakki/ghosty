/**
 * Live-mode stand-ins for provider slots whose keys are missing. Each one throws ProviderNotConfiguredError
 * (mapped by app.ts to `503 not_configured`) instead of returning fake data. The decider throws
 * BrainOfflineError('not_configured') instead, so a decision without 0G keys is a safe-stop.
 *
 * Every class carries `notConfigured` ({provider, missingEnv}) so routes and tests can detect it.
 */
import { BrainOfflineError, type Decider, type Decision } from './agent/decide.js';
import type { EpisodeInput, EpisodeLog, EpisodeRecord } from './agent/episode.js';
import type { MemoryStore, UserMemory } from './agent/memory.js';
import type { SpeechToText, Transcript } from './audio/stt.js';
import type { TextToSpeech } from './audio/tts.js';
import type { CredibilityScore, CredibilityScorer } from './credibility/ethos.js';
import type { MarketFilter, MarketInfo, MarketOrderRequest, OrderResult, PerpVenue } from './execution/hyperliquid.js';
import { ProviderNotConfiguredError, type NotConfiguredInfo, type NotConfiguredSlot } from './mode.js';
import type { PaidResource, Payer } from './payments/x402Client.js';
import type { SpotLeg, SwapRequest, SwapResult } from './wallet/uniswap.js';

/** Names of the keys in `keys` whose value is missing (undefined or blank). */
export function missingKeys(config: object, keys: string[]): string[] {
  const values = config as Record<string, unknown>;
  return keys.filter((k) => {
    const v = values[k];
    return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
  });
}

abstract class Slot implements NotConfiguredSlot {
  readonly notConfigured: NotConfiguredInfo;

  constructor(provider: string, missingEnv: string[], private readonly hint?: string) {
    this.notConfigured = { provider, missingEnv };
  }

  protected fail(): never {
    const base = `${this.notConfigured.provider} is not configured: set ${this.notConfigured.missingEnv.join(', ')}`;
    throw new ProviderNotConfiguredError(this.notConfigured, this.hint ? `${base} (${this.hint})` : base);
  }
}

export class NotConfiguredStt extends Slot implements SpeechToText {
  constructor(missingEnv = ['GROQ_API_KEY']) {
    super('groq', missingEnv);
  }
  async transcribe(): Promise<Transcript> {
    this.fail();
  }
}

export class NotConfiguredTts extends Slot implements TextToSpeech {
  constructor(missingEnv = ['ELEVENLABS_API_KEY']) {
    super('elevenlabs', missingEnv, 'or OPENAI_API_KEY for the OpenAI TTS fallback');
  }
  async synthesize(): Promise<Buffer> {
    this.fail();
  }
}

/** No OG_API_KEY: every decision is a safe-stop, never a fake decision. */
export class NotConfiguredDecider extends Slot implements Decider {
  constructor(missingEnv = ['OG_API_KEY']) {
    super('0g-router', missingEnv);
  }
  async decide(): Promise<Decision> {
    throw new BrainOfflineError('0G Compute is not configured (OG_API_KEY is not set): safe-stop, no decision', 'not_configured');
  }
}

export class NotConfiguredMemory extends Slot implements MemoryStore {
  constructor(missingEnv = ['OG_PRIVATE_KEY']) {
    super('0g-storage', missingEnv);
  }
  async load(): Promise<UserMemory> {
    this.fail();
  }
  async save(): Promise<void> {
    this.fail();
  }
}

export class NotConfiguredEpisodeLog extends Slot implements EpisodeLog {
  constructor(missingEnv = ['OG_PRIVATE_KEY']) {
    super('0g-storage', missingEnv);
  }
  async append(_entry: EpisodeInput): Promise<EpisodeRecord> {
    this.fail();
  }
  /** Nothing was ever logged, so there is nothing to list. */
  async list(): Promise<EpisodeRecord[]> {
    return [];
  }
}

/**
 * Orders throw. Market listing is real when a keyless read-only venue is passed (HL info API needs no key),
 * so /execution/markets still shows real tickers.
 */
export class NotConfiguredVenue extends Slot implements PerpVenue {
  constructor(
    missingEnv: string[],
    private readonly readOnly?: Pick<PerpVenue, 'listMarkets'>,
  ) {
    super('hyperliquid', missingEnv);
  }
  async placeMarketOrder(_req: MarketOrderRequest): Promise<OrderResult> {
    this.fail();
  }
  async listMarkets(filter?: MarketFilter): Promise<MarketInfo[]> {
    if (this.readOnly) return this.readOnly.listMarkets(filter);
    this.fail();
  }
}

export class NotConfiguredSpotLeg extends Slot implements SpotLeg {
  constructor(missingEnv: string[]) {
    super('uniswap', missingEnv);
  }
  async quoteAndSwap(_req: SwapRequest): Promise<SwapResult> {
    this.fail();
  }
}

/** Ethos switched off in live mode. Callers (weightItems, pod state, decider) treat a throw as "unknown". */
export class NotConfiguredScorer extends Slot implements CredibilityScorer {
  constructor(missingEnv = ['ETHOS_ENABLED']) {
    super('ethos', missingEnv, 'Ethos needs no key, set ETHOS_ENABLED=true');
  }
  async scoreHandle(): Promise<CredibilityScore> {
    this.fail();
  }
}

export class NotConfiguredPayer extends Slot implements Payer {
  readonly mode = 'not_configured' as const;
  constructor(missingEnv: string[]) {
    super('hedera-payer', missingEnv);
  }
  async pay(): Promise<PaidResource> {
    this.fail();
  }
}
