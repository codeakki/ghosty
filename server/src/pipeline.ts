import type { SpeechToText } from './audio/stt.js';
import type { TextToSpeech } from './audio/tts.js';
import type { WavAudio } from './audio/wav.js';
import type { Decider, Decision } from './agent/decide.js';
import type { EpisodeInput, EpisodeLog, EpisodeRecord } from './agent/episode.js';
import type { MemoryStore } from './agent/memory.js';
import { executePlan, type SpotOutcome } from './execution/executor.js';
import type { OrderResult, PerpVenue } from './execution/hyperliquid.js';
import { planSteps, type PlannedAction, type PlanStep, type SpotLegSpec } from './execution/playbook.js';
import { FakeSpotLeg, type SpotLeg } from './wallet/uniswap.js';
import { fetchAll, type NewsItem, type NewsProvider } from './news/types.js';
import { ProviderNotConfiguredError, type NotConfiguredInfo } from './mode.js';

/** What started a decision. `text` and `inject` come from the virtual pod, never from the firmware. */
export type DecisionTrigger = 'voice' | 'text' | 'button' | 'inject';

export interface DecisionContext {
  trigger: DecisionTrigger;
  transcript: string;
  /** The injected headline the decision was asked about, for `inject`. */
  headline?: NewsItem;
}

/**
 * Optional listener for every pipeline step (news fetched, decision made, button handled, episode logged).
 * The virtual pod's state store implements it; the pipeline works the same without one.
 */
export interface PipelineObserver {
  onNews?(items: NewsItem[]): void | Promise<void>;
  onDecision?(decision: Decision, ctx: DecisionContext): void;
  onButton?(result: ButtonResult): void;
  onEpisode?(record: EpisodeRecord): void;
}

/** Intel the agent bought for a headline (x402 on Hedera), as the pipeline needs it. See payments/intelBuyer.ts. */
export interface BoughtIntel {
  bundle: object;
  txId: string;
  provider: string;
  hashscanUrl: string;
  asset: string;
  amount: string;
  verification: Promise<{ verified: boolean }>;
}

/** One HCS audit line (payments/hcsAudit.ts). Fire-and-forget: the pipeline never waits on it. */
export interface PipelineAuditEntry {
  kind: 'decision' | 'trade';
  requestId: string;
  signal: string;
  txId?: string;
}

export interface PipelineDeps {
  stt: SpeechToText;
  tts: TextToSpeech;
  news: NewsProvider[];
  decider: Decider;
  memory: MemoryStore;
  episodes: EpisodeLog;
  venue: PerpVenue;
  /** Uniswap Trading API leg (createSpotLeg). Defaults to the fake. */
  spot?: SpotLeg;
  /** Spot leg to run before the perp legs (UNISWAP_SPOT_LEG=true), or undefined for perps only. */
  spotLeg?: SpotLegSpec;
  maxTradeUsd: number;
  /** Single-user device for now. */
  userId?: string;
  observer?: PipelineObserver;
  /**
   * Buy the Signal Desk intel bundle for a headline (x402 on Hedera), with no human approval, BEFORE the 0G
   * decision. Resolves undefined when it chose not to pay (brain offline, not a shock, ...). A failed payment
   * never blocks or fakes a decision. Undefined = no autonomous payments.
   */
  buyIntel?: (headline: NewsItem) => Promise<BoughtIntel | undefined>;
  /** Max wait for the purchase before deciding without it (default 8000 ms). A late purchase is still recorded. */
  intelWaitMs?: number;
  /** Max wait, after the decision, for the mirror-node verification so the episode can say verified (default 3000 ms). */
  verifyWaitMs?: number;
  /** HCS audit hook for decisions and trades. */
  audit?: (entry: PipelineAuditEntry) => void;
}

export interface VoiceResult {
  transcript: string;
  decision: Decision;
  /** PCM s16le mono 16 kHz. Empty when TTS is not configured (live mode, text turns only). */
  audio: Buffer;
  /** Set when the decision was made but TTS is not configured; /voice refuses earlier, /voice/text reports it. */
  ttsNotConfigured?: NotConfiguredInfo;
}

export interface ButtonResult {
  action: 'confirm' | 'cancel';
  requestId: string;
  signal: Decision['signal'];
  executed: boolean;
  actions: PlannedAction[];
  orders: OrderResult[];
  /** Uniswap spot leg results (empty unless UNISWAP_SPOT_LEG=true). */
  swaps: SpotOutcome[];
}

/**
 * Voice loop: STT → news → decide → TTS. The last decision waits for a button press.
 * Button: confirm → execute the planned actions; cancel → drop them. Every step is an episode.
 */
export class Pipeline {
  private pending: Decision | undefined;
  private readonly userId: string;

  constructor(private readonly deps: PipelineDeps) {
    this.userId = deps.userId ?? 'device-0';
  }

  async handleVoice(wav: WavAudio): Promise<VoiceResult> {
    const { text } = await this.deps.stt.transcribe(wav);
    return this.answer(text, 'voice');
  }

  /** Same as handleVoice without STT: the text is the transcript. Used by the virtual pod. */
  async handleText(text: string): Promise<VoiceResult> {
    return this.answer(text, 'text');
  }

  /**
   * Run the decision loop about one headline that just arrived (the injected item must already be
   * visible to a news provider). The decision becomes the pending one, like after a voice turn.
   */
  async decideOnHeadline(headline: NewsItem): Promise<Decision> {
    return this.decide('', 'inject', headline);
  }

  /** Fetch news and tell the observer, without deciding. */
  async refreshNews(): Promise<NewsItem[]> {
    const news = await fetchAll(this.deps.news);
    await this.deps.observer?.onNews?.(news);
    return news;
  }

  async handleButton(action: 'confirm' | 'cancel'): Promise<ButtonResult> {
    // No voice turn yet (e.g. a button press right after boot): decide from news alone.
    const decision = this.pending ?? (await this.decide('', 'button'));
    this.pending = undefined;
    const actions = decision.suggestedActions;
    const memory = await this.deps.memory.load(this.userId);

    let orders: OrderResult[] = [];
    let swaps: SpotOutcome[] = [];
    if (action === 'confirm') {
      // Perp legs are the ones the wearer heard and confirmed; planSteps only contributes the Uniswap spot step.
      const spotSteps = planSteps(decision.signal, memory, {
        maxTradeUsd: this.deps.maxTradeUsd,
        spotLeg: this.deps.spotLeg,
      }).filter((s) => s.kind === 'spot');
      const steps: PlanStep[] = [...spotSteps, ...actions];
      const report = await executePlan(steps, { venue: this.deps.venue, spot: this.deps.spot ?? new FakeSpotLeg() });
      orders = report.orders;
      swaps = report.spot;
    }
    const outcome = action === 'confirm' ? 'executed' : 'cancelled';
    await this.logEpisode({
      decision,
      requestId: decision.requestId,
      actions,
      outcome,
      receipts: [
        ...swaps.flatMap((s) => (s.result ? [s.result.txHash] : [])),
        ...orders.map((o) => o.orderId).filter((id) => id !== ''),
      ],
    });

    if (action === 'confirm' && orders.length + swaps.length > 0) {
      const receipt = swaps.find((s) => s.result)?.result?.txHash ?? orders.find((o) => o.orderId)?.orderId;
      this.deps.audit?.({ kind: 'trade', requestId: decision.requestId, signal: decision.signal, ...(receipt ? { txId: String(receipt) } : {}) });
    }
    memory.history.push({ at: new Date().toISOString(), requestId: decision.requestId, signal: decision.signal, outcome });
    await this.deps.memory.save(this.userId, memory);

    const result: ButtonResult = {
      action,
      requestId: decision.requestId,
      signal: decision.signal,
      executed: action === 'confirm' && orders.length + swaps.length > 0,
      actions,
      orders,
      swaps,
    };
    this.deps.observer?.onButton?.(result);
    return result;
  }

  private async answer(transcript: string, trigger: DecisionTrigger): Promise<VoiceResult> {
    const decision = await this.decide(transcript, trigger);
    try {
      const audio = await this.deps.tts.synthesize(decision.rationale);
      return { transcript, decision, audio };
    } catch (err) {
      // A text turn still returns its (real) decision without audio; never a placeholder sound.
      if (err instanceof ProviderNotConfiguredError && trigger === 'text') {
        return { transcript, decision, audio: Buffer.alloc(0), ttsNotConfigured: { provider: err.provider, missingEnv: err.missingEnv } };
      }
      throw err;
    }
  }

  /**
   * One decision. For a headline, step 1 is buying the Signal Desk intel (x402) so 0G decides WITH it:
   *   buy intel (bounded wait) → 0G decide (intel in the prompt) → wait briefly for mirror verification →
   *   episode (with paidIntel) → HCS "decision" message.
   */
  private async decide(transcript: string, trigger: DecisionTrigger, headline?: NewsItem): Promise<Decision> {
    const purchase = headline && this.deps.buyIntel ? this.deps.buyIntel(headline).catch(() => undefined) : undefined;
    const [fetched, memory, intel] = await Promise.all([
      fetchAll(this.deps.news),
      this.deps.memory.load(this.userId),
      withTimeout(purchase, this.deps.intelWaitMs ?? 8000),
    ]);
    await this.deps.observer?.onNews?.(fetched);
    // Put the headline being asked about first so the rationale quotes it.
    const news = headline ? [headline, ...fetched.filter((n) => n.id !== headline.id)] : fetched;
    const decision = await this.deps.decider.decide({
      transcript,
      news,
      memory,
      maxTradeUsd: this.deps.maxTradeUsd,
      ...(intel ? { paidIntel: { provider: intel.provider, txId: intel.txId, bundle: intel.bundle } } : {}),
    });
    if (intel) {
      const check = await withTimeout(intel.verification, this.deps.verifyWaitMs ?? 3000);
      decision.paidIntel = {
        txId: intel.txId,
        provider: intel.provider,
        hashscanUrl: intel.hashscanUrl,
        asset: intel.asset,
        amount: intel.amount,
        // null = the mirror-node check had not finished yet; GET /x402/status shows the final answer.
        verified: check ? check.verified : null,
      };
    }
    this.deps.observer?.onDecision?.(decision, { trigger, transcript, headline });
    await this.logEpisode({
      decision,
      requestId: decision.requestId,
      actions: decision.suggestedActions,
      outcome: 'proposed',
      ...(intel ? { receipts: [intel.txId] } : {}),
    });
    this.deps.audit?.({ kind: 'decision', requestId: decision.requestId, signal: decision.signal, txId: intel?.txId });
    this.pending = decision.signal === 'none' ? undefined : decision;
    return decision;
  }

  private async logEpisode(entry: EpisodeInput): Promise<void> {
    const record = await this.deps.episodes.append(entry);
    this.deps.observer?.onEpisode?.(record);
  }
}

/** Resolve with the promise's value, or undefined after `ms` (the promise keeps running in the background). */
async function withTimeout<T>(promise: Promise<T> | undefined, ms: number): Promise<T | undefined> {
  if (!promise) return undefined;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
