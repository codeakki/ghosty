import type { SpeechToText } from './audio/stt.js';
import type { TextToSpeech } from './audio/tts.js';
import type { WavAudio } from './audio/wav.js';
import type { Decider, Decision } from './agent/decide.js';
import type { EpisodeInput, EpisodeLog, EpisodeRecord } from './agent/episode.js';
import type { MemoryStore } from './agent/memory.js';
import type { OrderResult, PerpVenue } from './execution/hyperliquid.js';
import type { PlannedAction } from './execution/playbook.js';
import { fetchAll, type NewsItem, type NewsProvider } from './news/types.js';

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

export interface PipelineDeps {
  stt: SpeechToText;
  tts: TextToSpeech;
  news: NewsProvider[];
  decider: Decider;
  memory: MemoryStore;
  episodes: EpisodeLog;
  venue: PerpVenue;
  maxTradeUsd: number;
  /** Single-user device for now. */
  userId?: string;
  observer?: PipelineObserver;
}

export interface VoiceResult {
  transcript: string;
  decision: Decision;
  /** PCM s16le mono 16 kHz */
  audio: Buffer;
}

export interface ButtonResult {
  action: 'confirm' | 'cancel';
  requestId: string;
  signal: Decision['signal'];
  executed: boolean;
  actions: PlannedAction[];
  orders: OrderResult[];
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

    const orders: OrderResult[] = [];
    if (action === 'confirm') {
      for (const a of actions) {
        orders.push(await this.deps.venue.placeMarketOrder({ coin: a.coin, isBuy: a.side === 'long', sizeUsd: a.sizeUsd }));
      }
    }
    const outcome = action === 'confirm' ? 'executed' : 'cancelled';
    await this.logEpisode({
      decision,
      requestId: decision.requestId,
      actions,
      outcome,
      receipts: orders.map((o) => o.orderId),
    });

    const memory = await this.deps.memory.load(this.userId);
    memory.history.push({ at: new Date().toISOString(), requestId: decision.requestId, signal: decision.signal, outcome });
    await this.deps.memory.save(this.userId, memory);

    const result: ButtonResult = {
      action,
      requestId: decision.requestId,
      signal: decision.signal,
      executed: action === 'confirm' && orders.length > 0,
      actions,
      orders,
    };
    this.deps.observer?.onButton?.(result);
    return result;
  }

  private async answer(transcript: string, trigger: DecisionTrigger): Promise<VoiceResult> {
    const decision = await this.decide(transcript, trigger);
    const audio = await this.deps.tts.synthesize(decision.rationale);
    return { transcript, decision, audio };
  }

  private async decide(transcript: string, trigger: DecisionTrigger, headline?: NewsItem): Promise<Decision> {
    const [fetched, memory] = await Promise.all([fetchAll(this.deps.news), this.deps.memory.load(this.userId)]);
    await this.deps.observer?.onNews?.(fetched);
    // Put the headline being asked about first so the rationale quotes it.
    const news = headline ? [headline, ...fetched.filter((n) => n.id !== headline.id)] : fetched;
    const decision = await this.deps.decider.decide({ transcript, news, memory, maxTradeUsd: this.deps.maxTradeUsd });
    this.deps.observer?.onDecision?.(decision, { trigger, transcript, headline });
    await this.logEpisode({
      decision,
      requestId: decision.requestId,
      actions: decision.suggestedActions,
      outcome: 'proposed',
    });
    this.pending = decision.signal === 'none' ? undefined : decision;
    return decision;
  }

  private async logEpisode(entry: EpisodeInput): Promise<void> {
    const record = await this.deps.episodes.append(entry);
    this.deps.observer?.onEpisode?.(record);
  }
}
