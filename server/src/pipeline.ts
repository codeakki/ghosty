import { randomUUID } from 'node:crypto';
import type { SpeechToText } from './audio/stt.js';
import type { TextToSpeech } from './audio/tts.js';
import type { WavAudio } from './audio/wav.js';
import { isActionable, spokenRationale, type Decider, type Decision } from './agent/decide.js';
import type { EpisodeInput, EpisodeLog, EpisodeRecord } from './agent/episode.js';
import type { MemoryStore } from './agent/memory.js';
import { executePlan, type SpotOutcome } from './execution/executor.js';
import type { OrderResult, PerpVenue } from './execution/hyperliquid.js';
import { planSteps, type PlannedAction, type PlanStep, type SpotLegSpec } from './execution/playbook.js';
import { FakeSpotLeg, type SpotLeg } from './wallet/uniswap.js';
import { fetchAll, type NewsItem, type NewsProvider } from './news/types.js';
import { ProviderNotConfiguredError, type NotConfiguredInfo } from './mode.js';
import { classifyIntent, type VoiceIntent } from './claude/intent.js';
import { ASSISTANT_FALLBACK_REPLY, type VoiceAssistant } from './claude/voice.js';

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
  /** Every voice/text turn: what was said, what Ghosty answered and who answered (SSE `voice`). */
  onVoice?(turn: VoiceTurn): void;
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
  /**
   * Claude voice answers (CLAUDE_VOICE_ENABLED). When set, questions go to Claude and only trade requests reach the
   * 0G decider; without it every turn is a 0G decision, as before.
   */
  assistant?: VoiceAssistant;
  /** Safe-stop check for the 0G path when the assistant is on (the route's preHandler no longer does it). */
  brainOnline?: () => Promise<boolean>;
  /** How long a presented decision can still be confirmed (PENDING_DECISION_TTL_SEC). Default 120 000 ms. */
  pendingTtlMs?: number;
  /** Clock for the pending-decision TTL (tests). Default Date.now. */
  now?: () => number;
}

/** Default PENDING_DECISION_TTL_SEC, in ms. */
export const DEFAULT_PENDING_TTL_MS = 120_000;

/** A decision the wearer was told about (spoken reply or alert) and can still confirm or cancel. */
export interface PendingDecision {
  decision: Decision;
  /** Epoch ms when it was presented. */
  presentedAt: number;
  /** Epoch ms after which a press answers 409 alert_expired. */
  expiresAt: number;
}

export const NOTHING_PENDING_MESSAGE = "Nothing to confirm. Ghosty only trades on an alert you've heard.";

/**
 * A button press with no presented decision to act on: nothing pending, or the alert expired. Mapped to 409.
 * The press never triggers a fresh decision and never executes anything.
 */
export class NothingPendingError extends Error {
  override readonly name = 'NothingPendingError';
  constructor(
    readonly code: 'nothing_pending' | 'alert_expired',
    readonly requestId?: string,
  ) {
    super(
      code === 'alert_expired'
        ? 'Alert expired. Nothing was traded; wait for the next alert.'
        : NOTHING_PENDING_MESSAGE,
    );
  }

  body(): { error: string; message: string; requestId?: string } {
    return { error: this.code, message: this.message, ...(this.requestId ? { requestId: this.requestId } : {}) };
  }
}

/** Who produced the spoken reply: Claude (research, chit-chat) or the 0G trade path. */
export type AnsweredBy = 'claude' | '0g';

/** One voice/text turn as shown in the Live feed (SSE `voice`). */
export interface VoiceTurn {
  transcript: string;
  reply: string;
  answeredBy: AnsweredBy;
  intent: VoiceIntent;
  /** 0G decision id, Anthropic message id, or the pending decision's id for a confirm hint. */
  requestId?: string;
  trigger: DecisionTrigger;
  at: string;
}

/** The trade path was asked for while safe-stop is engaged (0G unreachable). Mapped to 503 brain_offline. */
export class SafeStopEngagedError extends Error {
  override readonly name = 'SafeStopEngagedError';
  constructor() {
    super('safe-stop engaged: 0G brain unreachable');
  }
}

export interface VoiceResult {
  transcript: string;
  answeredBy: AnsweredBy;
  intent: VoiceIntent;
  /** What Ghosty said (the 0G rationale, Claude's answer, or the confirm hint). */
  reply: string;
  /** 0G decision id, `msg_…` for Claude, or the pending decision's id for a confirm hint. */
  requestId: string;
  /** Present on 0G decision turns only. Claude never produces a decision. */
  decision?: Decision;
  /** Claude failed or timed out; `reply` is the honest fallback line. */
  assistantError?: string;
  /** PCM s16le mono 16 kHz. Empty when TTS is not configured (live mode, text turns only). */
  audio: Buffer;
  /** Set when the decision was made but TTS is not configured; /voice refuses earlier, /voice/text reports it. */
  ttsNotConfigured?: NotConfiguredInfo;
  /** Text turns only: TTS failed (timeout, HTTP error). The reply is real; the audio is empty. */
  ttsFailed?: string;
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
 * Voice loop: STT → news → decide → TTS. The last actionable decision waits for a button press, for at most
 * pendingTtlMs. Button: confirm → execute the planned actions of THAT decision; cancel → drop them. A press with
 * nothing pending (or an expired alert) throws NothingPendingError: it never decides or executes anything.
 * Every step is an episode.
 */
export class Pipeline {
  private pending: PendingDecision | undefined;
  private readonly userId: string;
  private readonly pendingTtlMs: number;
  private readonly now: () => number;

  constructor(private readonly deps: PipelineDeps) {
    this.userId = deps.userId ?? 'device-0';
    this.pendingTtlMs = deps.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
    this.now = deps.now ?? Date.now;
  }

  /** The decision a press would act on right now, or undefined (none presented, or expired). */
  pendingDecision(): PendingDecision | undefined {
    const p = this.pending;
    return p && this.now() <= p.expiresAt ? p : undefined;
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
    // Take the pending decision synchronously (no await before this) so two presses can never both execute it.
    const pending = this.pending;
    this.pending = undefined;
    // Only an alert the wearer has heard can trade. No pending decision → no new 0G decision, no execution.
    if (!pending) throw new NothingPendingError('nothing_pending');
    if (this.now() > pending.expiresAt) throw new NothingPendingError('alert_expired', pending.decision.requestId);
    const { decision } = pending;
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
    const intent = classifyIntent(transcript);
    const { assistant } = this.deps;
    let turn: Omit<VoiceResult, 'audio' | 'ttsNotConfigured'>;
    if (assistant && intent === 'question') {
      turn = await this.ask(assistant, transcript, intent);
    } else if (assistant && intent === 'confirm') {
      turn = this.confirmHint(transcript, intent);
    } else {
      // Trade requests (and every turn when Claude is off) stay on the 0G decision path.
      if (assistant && this.deps.brainOnline && !(await this.deps.brainOnline())) throw new SafeStopEngagedError();
      const decision = await this.decide(transcript, trigger);
      turn = { transcript, answeredBy: '0g', intent, reply: decision.rationale, requestId: decision.requestId, decision };
    }
    this.deps.observer?.onVoice?.({
      transcript,
      reply: turn.reply,
      answeredBy: turn.answeredBy,
      intent,
      requestId: turn.requestId,
      trigger,
      at: new Date().toISOString(),
    });
    try {
      const audio = await this.deps.tts.synthesize(turn.reply);
      return { ...turn, audio };
    } catch (err) {
      // A text turn still returns its (real) reply without audio; never a placeholder sound.
      if (err instanceof ProviderNotConfiguredError && trigger === 'text') {
        return { ...turn, audio: Buffer.alloc(0), ttsNotConfigured: { provider: err.provider, missingEnv: err.missingEnv } };
      }
      // A slow or failing TTS must not turn a real text reply into a 500. /voice still fails (the pod needs audio).
      if (trigger === 'text') return { ...turn, audio: Buffer.alloc(0), ttsFailed: err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error' };
      throw err;
    }
  }

  /** Claude answers a question. Any failure becomes the honest fallback line, never a made-up answer. */
  private async ask(assistant: VoiceAssistant, transcript: string, intent: VoiceIntent): Promise<Omit<VoiceResult, 'audio'>> {
    try {
      const reply = await assistant.answer(transcript);
      return { transcript, answeredBy: 'claude', intent, reply: reply.text, requestId: reply.id };
    } catch (err) {
      return {
        transcript,
        answeredBy: 'claude',
        intent,
        reply: ASSISTANT_FALLBACK_REPLY,
        requestId: `claude-error-${randomUUID()}`,
        assistantError: err instanceof Error ? err.name : 'unknown error',
      };
    }
  }

  /** "yes" / "confirm" / "cancel" by voice: the button is the only way to act on a pending 0G decision. */
  private confirmHint(transcript: string, intent: VoiceIntent): Omit<VoiceResult, 'audio'> {
    const pending = this.pendingDecision()?.decision;
    const reply = pending
      ? 'Use the button to confirm or cancel the pending trade. I never trade on voice alone.'
      : 'There is nothing waiting for confirmation right now.';
    return { transcript, answeredBy: '0g', intent, reply, requestId: pending?.requestId ?? `no-pending-${randomUUID()}` };
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
    // Nothing to confirm → never say "Press to confirm" (spoken reply, alert text, episode, terminal).
    decision.rationale = spokenRationale(decision);
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
    // Only an actionable decision is presented as something to confirm. A newer non-actionable decision replaces
    // (clears) an older pending one: the last thing the wearer heard was not a trade, so a press must not trade.
    const at = this.now();
    this.pending = isActionable(decision) ? { decision, presentedAt: at, expiresAt: at + this.pendingTtlMs } : undefined;
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
