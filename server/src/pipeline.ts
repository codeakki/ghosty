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

/** Receipt of one autonomous /signal payment. */
export interface SignalPaymentReceipt {
  txId: string;
  hashscanUrl?: string;
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
   * Pay for the premium /signal (x402 on Hedera) once per decision, with no human approval. Runs alongside the
   * 0G call; a failed payment never blocks or fakes a decision. Undefined = no autonomous payments.
   */
  paySignal?: () => Promise<SignalPaymentReceipt>;
  /** Max wait for that payment after the decision is ready (default 4000 ms). It still settles and is logged later. */
  paySignalWaitMs?: number;
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

  private async decide(transcript: string, trigger: DecisionTrigger, headline?: NewsItem): Promise<Decision> {
    const payment = this.startSignalPayment();
    const [fetched, memory] = await Promise.all([fetchAll(this.deps.news), this.deps.memory.load(this.userId)]);
    await this.deps.observer?.onNews?.(fetched);
    // Put the headline being asked about first so the rationale quotes it.
    const news = headline ? [headline, ...fetched.filter((n) => n.id !== headline.id)] : fetched;
    const decision = await this.deps.decider.decide({ transcript, news, memory, maxTradeUsd: this.deps.maxTradeUsd });
    this.deps.observer?.onDecision?.(decision, { trigger, transcript, headline });
    const paid = await this.awaitSignalPayment(payment);
    await this.logEpisode({
      decision,
      requestId: decision.requestId,
      actions: decision.suggestedActions,
      outcome: 'proposed',
      ...(paid ? { receipts: [paid.txId] } : {}),
    });
    this.pending = decision.signal === 'none' ? undefined : decision;
    return decision;
  }

  /**
   * Start this decision's /signal payment. Resolves to the receipt, or undefined when it failed or was refused:
   * paySignal reports its own errors, and a payment problem never blocks the decision.
   */
  private startSignalPayment(): Promise<SignalPaymentReceipt | undefined> | undefined {
    return this.deps.paySignal?.().catch(() => undefined);
  }

  /** Wait a bounded time for the payment so a slow settlement does not hold up the spoken answer. */
  private async awaitSignalPayment(
    payment: Promise<SignalPaymentReceipt | undefined> | undefined,
  ): Promise<SignalPaymentReceipt | undefined> {
    if (!payment) return undefined;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), this.deps.paySignalWaitMs ?? 4000);
    });
    try {
      return await Promise.race([payment, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async logEpisode(entry: EpisodeInput): Promise<void> {
    const record = await this.deps.episodes.append(entry);
    this.deps.observer?.onEpisode?.(record);
  }
}
