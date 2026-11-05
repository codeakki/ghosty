import type { SpeechToText } from './audio/stt.js';
import type { TextToSpeech } from './audio/tts.js';
import type { WavAudio } from './audio/wav.js';
import type { Decider, Decision } from './agent/decide.js';
import type { EpisodeLog } from './agent/episode.js';
import type { MemoryStore } from './agent/memory.js';
import type { OrderResult, PerpVenue } from './execution/hyperliquid.js';
import type { PlannedAction } from './execution/playbook.js';
import { fetchAll, type NewsProvider } from './news/types.js';

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
    const decision = await this.decide(text);
    const audio = await this.deps.tts.synthesize(decision.rationale);
    return { transcript: text, decision, audio };
  }

  async handleButton(action: 'confirm' | 'cancel'): Promise<ButtonResult> {
    // No voice turn yet (e.g. a button press right after boot): decide from news alone.
    const decision = this.pending ?? (await this.decide(''));
    this.pending = undefined;
    const actions = decision.suggestedActions;

    const orders: OrderResult[] = [];
    if (action === 'confirm') {
      for (const a of actions) {
        orders.push(await this.deps.venue.placeMarketOrder({ coin: a.coin, isBuy: a.side === 'long', sizeUsd: a.sizeUsd }));
      }
    }
    const outcome = action === 'confirm' ? 'executed' : 'cancelled';
    await this.deps.episodes.append({
      decision,
      requestId: decision.requestId,
      actions,
      outcome,
      receipts: orders.map((o) => o.orderId),
    });

    const memory = await this.deps.memory.load(this.userId);
    memory.history.push({ at: new Date().toISOString(), requestId: decision.requestId, signal: decision.signal, outcome });
    await this.deps.memory.save(this.userId, memory);

    return {
      action,
      requestId: decision.requestId,
      signal: decision.signal,
      executed: action === 'confirm' && orders.length > 0,
      actions,
      orders,
    };
  }

  private async decide(transcript: string): Promise<Decision> {
    const [news, memory] = await Promise.all([fetchAll(this.deps.news), this.deps.memory.load(this.userId)]);
    const decision = await this.deps.decider.decide({ transcript, news, memory, maxTradeUsd: this.deps.maxTradeUsd });
    await this.deps.episodes.append({
      decision,
      requestId: decision.requestId,
      actions: decision.suggestedActions,
      outcome: 'proposed',
    });
    this.pending = decision.signal === 'none' ? undefined : decision;
    return decision;
  }
}
