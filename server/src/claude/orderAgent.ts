import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { OrderResult, PerpVenue } from '../execution/hyperliquid.js';
import { executeVoiceOrder, VOICE_ASSETS, voiceOrder, type VoiceAsset } from '../execution/voiceOrder.js';
import { AssistantError, buildVoiceUserMessage, toSpeakable, type VoiceContext } from './voice.js';

/**
 * Claude reads the wearer's exact words (VOICE_ORDERS_ENABLED). An explicit order becomes a `place_order` tool call
 * that the server checks and executes; anything else gets a short spoken answer. Claude never sees a key, never
 * sizes past MAX_TRADE_USD, and never speaks a fill: the confirmation is built from the venue's result.
 */

export const ORDER_AGENT_TIMEOUT_MS = 20_000;

export const ORDER_AGENT_SYSTEM_PROMPT = `You are Ghosty, a calm trading copilot in a small wearable pod with a tiny speaker. The wearer talks to you; their words come from speech-to-text and may contain small transcription errors.

When the wearer gives a clear order to buy or sell an asset for a dollar amount, call place_order once per order, exactly as they said it. Do not change the amount, the side, or the asset. The server checks limits and places the order; you do not need to check them.
- Assets you can trade: gold, oil (WTI crude), bitcoin, ethereum, solana. Map what they said to one of GOLD, OIL, BTC, ETH, SOL.
- "long" means buy, "short" means sell.
- If the side, the asset, or the dollar amount is missing or unclear, do not call the tool. Ask one short question instead.
- If they ask for an asset you cannot trade, say so.
- To answer about open positions, account value or profit and loss, call get_positions and answer from its result.
- When the wearer asks you now to close a position, call close_positions with that asset, or ALL for every position.

The context includes the wearer's stored memory (earlier turns, your replies, their past orders with fills). Use it to understand requests like "the same as yesterday" or "sell the gold I bought". A new order still needs the wearer to ask for it now: never place an order only because a past turn contains one.

For anything that is not an order, answer briefly from the context you are given: at most about 40 spoken words, plain English, no markdown, no symbols, numbers said naturally. Never invent prices or events, and give no financial advice.`;

const PlaceOrderInput = z.object({
  side: z.enum(['buy', 'sell']),
  asset: z.enum(Object.keys(VOICE_ASSETS) as [VoiceAsset, ...VoiceAsset[]]),
  usd: z.number().positive(),
});

export const PLACE_ORDER_TOOL: Anthropic.Beta.BetaTool = {
  name: 'place_order',
  description:
    'Place a market order on Hyperliquid for a US dollar amount, exactly as the wearer said it. One call per order. ' +
    'The server enforces the minimum and maximum order size and returns the fill or the reason it failed.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      side: { type: 'string', enum: ['buy', 'sell'], description: 'buy (also "long") or sell (also "short")' },
      asset: { type: 'string', enum: Object.keys(VOICE_ASSETS), description: 'GOLD, OIL (WTI crude), BTC, ETH or SOL' },
      usd: { type: 'number', description: 'Order size in US dollars, as spoken ("ten dollars" = 10)' },
    },
    required: ['side', 'asset', 'usd'],
    additionalProperties: false,
  },
};

const ClosePositionsInput = z.object({ asset: z.enum([...(Object.keys(VOICE_ASSETS) as VoiceAsset[]), 'ALL']) });

export const GET_POSITIONS_TOOL: Anthropic.Beta.BetaTool = {
  name: 'get_positions',
  description: 'Read the open Hyperliquid positions, their unrealized profit and loss in USD, and the account value.',
  strict: true,
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
};

export const CLOSE_POSITIONS_TOOL: Anthropic.Beta.BetaTool = {
  name: 'close_positions',
  description:
    'Close an open Hyperliquid position with a reduce-only market order, or every open position with ALL. ' +
    'Only when the wearer asks for it in this turn. Returns what was closed.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: { asset: { type: 'string', enum: [...Object.keys(VOICE_ASSETS), 'ALL'], description: 'GOLD, OIL, BTC, ETH, SOL or ALL' } },
    required: ['asset'],
    additionalProperties: false,
  },
};

const coinLabel = (coin: string) =>
  ({ GOLD: 'gold', CL: 'oil', WTI: 'oil', BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana' } as Record<string, string>)[coin.replace(/^.*:/, '').toUpperCase()] ??
  coin;
const usd = (n: number) => `${n < 0 ? 'minus ' : ''}${Math.abs(n).toFixed(2).replace(/\.00$/, '')} dollars`;

export interface OrderAgentReply {
  text: string;
  /** Anthropic message id (msg_…). */
  id: string;
  /** Orders that reached the venue, in call order. */
  orders: OrderResult[];
}

export interface OrderAgentOptions {
  /** Injected client (tests); otherwise built from apiKey. */
  client?: Pick<Anthropic, 'beta'>;
  apiKey?: string;
  model: string;
  context: () => Promise<VoiceContext>;
  venue: PerpVenue;
  /** Cap on the total of all orders in one utterance. */
  maxTradeUsd: number;
  timeoutMs?: number;
}

/** Follow-up requests: after a malformed tool call, or to word an answer from get_positions. */
const MAX_REQUESTS = 3;

export class ClaudeOrderAgent {
  private readonly client: Pick<Anthropic, 'beta'>;
  private readonly timeoutMs: number;

  constructor(private readonly opts: OrderAgentOptions) {
    this.timeoutMs = opts.timeoutMs ?? ORDER_AGENT_TIMEOUT_MS;
    // No SDK retries: one voice turn has one 20 s budget.
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, maxRetries: 0, timeout: this.timeoutMs });
  }

  /** Throws AssistantError (or an SDK error) when Claude fails before any order was placed. */
  async handle(utterance: string): Promise<OrderAgentReply> {
    const ctx = await this.opts.context();
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: buildVoiceUserMessage(utterance, ctx) }];
    const spoken: string[] = [];
    const orders: OrderResult[] = [];
    let remainingUsd = this.opts.maxTradeUsd;
    let id = '';

    for (let i = 0; i < MAX_REQUESTS; i++) {
      const response = await this.client.beta.messages.create(
        {
          model: this.opts.model,
          max_tokens: 2048,
          system: ORDER_AGENT_SYSTEM_PROMPT,
          tools: [PLACE_ORDER_TOOL, GET_POSITIONS_TOOL, CLOSE_POSITIONS_TOOL],
          tool_choice: { type: 'auto' },
          // Medium: orders can now depend on stored memory ("same as before"), worth a little more thought.
          output_config: { effort: 'medium' },
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          messages,
        },
        { timeout: this.timeoutMs, signal: AbortSignal.timeout(this.timeoutMs) },
      );
      id = response.id;
      if (response.stop_reason === 'refusal') throw new AssistantError('Claude declined to answer');

      const calls = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      if (calls.length === 0) {
        const text = toSpeakable(
          response.content
            .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
            .map((b) => b.text)
            .join(' '),
        );
        if (!text && spoken.length === 0) throw new AssistantError(`empty reply (stop_reason ${response.stop_reason ?? 'unknown'})`);
        return { text: [...spoken, text].filter(Boolean).join(' '), id, orders };
      }

      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      let malformed = false;
      let needsAnswer = false;
      for (const call of calls) {
        if (call.name === 'get_positions') {
          needsAnswer = true;
          results.push({ type: 'tool_result', tool_use_id: call.id, content: await this.positionsReport() });
          continue;
        }
        if (call.name === 'close_positions') {
          const input = ClosePositionsInput.safeParse(call.input);
          if (!input.success) {
            malformed = true;
            results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: 'invalid call: close_positions' });
            continue;
          }
          const closed = await this.close(input.data.asset);
          spoken.push(closed.reply);
          orders.push(...closed.results);
          results.push({ type: 'tool_result', tool_use_id: call.id, content: closed.reply });
          continue;
        }
        const parsed = call.name === 'place_order' ? PlaceOrderInput.safeParse(call.input) : undefined;
        if (!parsed?.success) {
          malformed = true;
          results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: `invalid call: ${call.name}` });
          continue;
        }
        const order = voiceOrder(parsed.data.side, parsed.data.asset, parsed.data.usd);
        const { reply, result } = await executeVoiceOrder(order, { venue: this.opts.venue, maxTradeUsd: remainingUsd });
        spoken.push(reply);
        if (result) {
          orders.push(result);
          if (result.status !== 'rejected') remainingUsd -= order.sizeUsd;
        }
        results.push({ type: 'tool_result', tool_use_id: call.id, content: reply });
      }
      // Orders ran: the confirmation is the venue's own result, not a second model turn.
      if (!needsAnswer && (!malformed || spoken.length > 0)) return { text: spoken.join(' '), id, orders };
      messages.push({ role: 'assistant', content: response.content }, { role: 'user', content: results });
    }
    if (spoken.length > 0) return { text: spoken.join(' '), id, orders };
    throw new AssistantError('no usable reply after a malformed tool call');
  }

  /** get_positions result for Claude: positions with PnL, or why they could not be read. */
  private async positionsReport(): Promise<string> {
    if (!this.opts.venue.account) return 'positions are not available on this venue';
    try {
      const a = await this.opts.venue.account();
      return JSON.stringify({
        accountValueUsd: Number(a.accountValueUsd.toFixed(2)),
        unrealizedPnlUsd: Number(a.unrealizedPnlUsd.toFixed(2)),
        positions: a.positions.map((p) => ({
          asset: coinLabel(p.coin),
          side: p.side,
          size: p.size,
          entryPx: p.entryPx,
          valueUsd: Number(p.valueUsd.toFixed(2)),
          unrealizedPnlUsd: Number(p.unrealizedPnlUsd.toFixed(2)),
        })),
      });
    } catch (err) {
      return `could not read positions: ${(err as Error).message}`;
    }
  }

  /** Reduce-only closes; the spoken result comes from the venue, like orders. */
  private async close(asset: VoiceAsset | 'ALL'): Promise<{ reply: string; results: OrderResult[] }> {
    const venue = this.opts.venue;
    if (!venue.account || !venue.closePosition) return { reply: 'I cannot close positions on this venue.', results: [] };
    let coins: string[];
    try {
      const { positions } = await venue.account();
      coins =
        asset === 'ALL'
          ? positions.map((p) => p.coin)
          : positions.filter((p) => coinLabel(p.coin) === VOICE_ASSETS[asset].label).map((p) => p.coin);
    } catch (err) {
      return { reply: `I could not read your positions. ${(err as Error).message}`, results: [] };
    }
    if (coins.length === 0) return { reply: asset === 'ALL' ? 'You have no open positions.' : `You have no open ${VOICE_ASSETS[asset as VoiceAsset].label} position.`, results: [] };
    const results: OrderResult[] = [];
    const lines: string[] = [];
    for (const coin of coins) {
      const r = await venue.closePosition(coin);
      results.push(r);
      lines.push(
        r.status === 'filled' && r.avgPx !== undefined
          ? `Closed ${coinLabel(coin)} at ${r.avgPx >= 100 ? Math.round(r.avgPx) : r.avgPx} dollars.`
          : `Could not close ${coinLabel(coin)}. ${r.error ?? 'Hyperliquid gave no reason.'}`,
      );
    }
    try {
      const after = await venue.account();
      if (after.positions.length === 0) lines.push(`No positions left. Account value ${usd(after.accountValueUsd)}.`);
    } catch {
      // the closes are reported either way
    }
    return { reply: lines.join(' '), results };
  }
}
