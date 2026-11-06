import Anthropic from '@anthropic-ai/sdk';
import type { PlannedAction, Signal } from '../execution/playbook.js';

/**
 * Claude voice answers: questions and chit-chat only ("what's moving gold?", "are you online?").
 * Claude never decides or proposes trades; trade requests stay on the 0G path (see intent.ts).
 */

export const VOICE_TIMEOUT_MS = 20_000;

/** Spoken when Claude fails or times out. Honest, never a made-up answer. */
export const ASSISTANT_FALLBACK_REPLY = "I couldn't reach my research assistant. Please try again in a moment.";

/** What Ghosty knows right now, handed to Claude with every question. Built by app.ts from live state. */
export interface VoiceContext {
  /** live = real providers; test = offline fakes. */
  mode: 'live' | 'test';
  /** A historical simulation run is in progress (paper trades only). */
  simRunActive: boolean;
  /** true = 0G unreachable, trading blocked. */
  safeStop: boolean;
  /** Watchlist mids and 24 h change, or null when market data is unavailable. */
  market: Array<{ coin: string; label: string; mid: number | null; change24hPct: number | null }> | null;
  /** Up to ~10 latest headlines, newest first. */
  headlines: Array<{
    title: string;
    source: string;
    publishedAt: string;
    /** 0.2..1.0 credibility weight when known. */
    weight?: number;
    credibility?: string | null;
  }>;
  lastDecision: { signal: Signal; confidence: number; rationale: string; at: string; trigger: string } | null;
  /** Newest alert that has not been acknowledged. */
  pendingAlert: { text: string; signal: Signal; headline?: string; createdAt: string } | null;
  /** Actions waiting for a button press. */
  pendingTrade: PlannedAction[];
  /** Recent orders (newest first); stands in for positions. */
  recentOrders: Array<{ coin: string; isBuy: boolean; sizeUsd: number; status: string; at: string }>;
}

export interface AssistantReply {
  text: string;
  /** Anthropic message id (msg_…). */
  id: string;
}

/** Answers one question. Throws on any failure; the pipeline turns that into ASSISTANT_FALLBACK_REPLY. */
export interface VoiceAssistant {
  answer(question: string): Promise<AssistantReply>;
}

export class AssistantError extends Error {
  override readonly name = 'AssistantError';
}

export const VOICE_SYSTEM_PROMPT = `You are Ghosty, a calm, private trading copilot that lives in a small wearable pod and talks through a tiny speaker.
You answer the wearer's questions about markets, news and what Ghosty has been doing, using only the context you are given.

How you speak:
- Plain English, brief, calm. At most about 45 spoken words, usually one to three short sentences.
- Your words are read aloud: no markdown, no lists, no emojis, no URLs, no symbols like % or $ written as symbols. Say numbers naturally ("about sixty-eight thousand dollars", "up one point two percent").
- No hype and no financial advice. Do not tell the wearer to buy or sell. If they want a trade, say Ghosty's decision engine on 0G proposes trades and the button confirms them.
- If the context does not contain the answer, say so plainly. Never invent prices, headlines or events.
- Mention a headline's source when it matters, and say when a source has low credibility.
- You never execute anything. Trades are proposed by 0G and confirmed with the physical button.`;

const round = (n: number | null, digits: number) => (n === null ? null : Number(n.toFixed(digits)));

/** The user turn: the question plus the context as compact JSON. Exported for tests. */
export function buildVoiceUserMessage(question: string, ctx: VoiceContext): string {
  const context = {
    mode: ctx.simRunActive ? `${ctx.mode} (a simulation run is active: paper trades only)` : ctx.mode,
    safeStop: ctx.safeStop ? 'engaged: 0G brain unreachable, no trades possible' : 'off',
    market: ctx.market
      ? ctx.market.map((m) => ({
          asset: m.label,
          coin: m.coin,
          price: m.mid === null ? null : round(m.mid, m.mid >= 100 ? 0 : 2),
          change24hPct: round(m.change24hPct, 2),
        }))
      : 'market data unavailable',
    headlines: ctx.headlines.map((h) => ({
      title: h.title,
      source: h.source,
      publishedAt: h.publishedAt,
      credibility: h.credibility ?? (h.weight === undefined ? 'unknown' : h.weight >= 0.8 ? 'high' : h.weight >= 0.5 ? 'medium' : 'low'),
    })),
    lastDecision: ctx.lastDecision,
    pendingAlert: ctx.pendingAlert,
    pendingTrade: ctx.pendingTrade.map((a) => ({ coin: a.coin, side: a.side, sizeUsd: a.sizeUsd })),
    recentOrders: ctx.recentOrders,
  };
  return `Context (live state, JSON):\n${JSON.stringify(context)}\n\nThe wearer says: ${question}`;
}

/** Make a reply safe for TTS: drop markdown marks, emojis and URLs, collapse whitespace. */
export function toSpeakable(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_#`>|~]+/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ClaudeVoiceOptions {
  /** Injected client (tests); otherwise built from apiKey. */
  client?: Pick<Anthropic, 'messages'>;
  apiKey?: string;
  model: string;
  /** Live state for the prompt. */
  context: () => Promise<VoiceContext>;
  timeoutMs?: number;
}

export class ClaudeVoiceAssistant implements VoiceAssistant {
  private readonly client: Pick<Anthropic, 'messages'>;
  private readonly timeoutMs: number;

  constructor(private readonly opts: ClaudeVoiceOptions) {
    this.timeoutMs = opts.timeoutMs ?? VOICE_TIMEOUT_MS;
    // No SDK retries: a voice turn has one 20 s budget, then the honest fallback.
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, maxRetries: 0, timeout: this.timeoutMs });
  }

  async answer(question: string): Promise<AssistantReply> {
    const ctx = await this.opts.context();
    const response = await this.client.messages.create(
      {
        model: this.opts.model,
        max_tokens: 1024,
        system: VOICE_SYSTEM_PROMPT,
        // Short spoken answers over a small context: low effort keeps latency down.
        output_config: { effort: 'low' },
        messages: [{ role: 'user', content: buildVoiceUserMessage(question, ctx) }],
      },
      { timeout: this.timeoutMs, signal: AbortSignal.timeout(this.timeoutMs) },
    );
    if (response.stop_reason === 'refusal') throw new AssistantError('Claude declined to answer');
    const text = toSpeakable(
      response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join(' '),
    );
    if (!text) throw new AssistantError(`empty reply (stop_reason ${response.stop_reason ?? 'unknown'})`);
    return { text, id: response.id };
  }
}
