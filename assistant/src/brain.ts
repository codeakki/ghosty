import Anthropic from '@anthropic-ai/sdk';

/**
 * Ghosty's brain: Claude with web search and web fetch, plus a short spoken conversation.
 * The conversation is append-only (full response content goes back each turn). It starts fresh
 * after a quiet spell or a number of turns, instead of trimming old turns.
 */

export const SYSTEM_PROMPT = `You are Ghosty, a friendly personal assistant that lives in a small pod on the user's desk and talks through a tiny speaker.
You help with anything the user asks: questions, explanations, advice, planning, maths, writing ideas, recipes, news, weather, facts you look up.

Your tools let you act, not just talk: play songs from the user's music files (play_music, list_music, stop_music), set, list and cancel reminders and timers (set_reminder, list_reminders, cancel_reminder), remember and forget notes (remember, forget), and change the volume (set_volume). When the user asks for one of these, use the tool, then confirm in a few words what you did ("Playing Amplifier by Imran Khan." "Okay, I'll remind you to call mom at seven."). Only say you did something after the tool says it worked. Each message tells you the current time, volume, notes and what is playing.

Use web search when the answer depends on current or local information (news, weather, prices, opening hours, scores, anything after your training). Otherwise answer from what you know.
The user is waiting for a spoken answer, so be quick: one search is almost always enough. Answer from the search results themselves; fetch a page only when the results do not contain the answer.

How you speak:
- Your words are read aloud. Plain sentences only: no markdown, no lists, no emojis, no URLs, no code.
- Short by default: one to three sentences, about forty words. Go longer only when the user asks for detail, a story or step-by-step help, and even then stay under about a hundred and twenty words.
- Say numbers, dates and units the way a person would say them out loud.
- If you looked something up, you can mention the source by name.
- If you cannot do something with your tools (send messages or email, make calls, control lights or other devices, open apps, stream from YouTube or Spotify, buy things), say so plainly and offer what you can do instead. Never pretend you did an action.
- While a song plays the pod cannot hear the user, so they cannot stop it by voice until it ends. Mention this only if they ask how to stop music.
- Never place trades or move money, even if asked.`;

const MAX_TURNS = 12;
const IDLE_RESET_MS = 10 * 60_000;
/** API requests per turn: tool rounds plus pause_turn continuations. */
const MAX_ROUNDS = 6;

export interface ClientTools {
  defs: Anthropic.Beta.BetaTool[];
  run(name: string, input: Record<string, unknown>): Promise<{ content: string; is_error?: boolean }>;
  /** Live state added to each user message (volume, notes, now playing). */
  context(): string;
}

export interface BrainOptions {
  apiKey: string;
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  timeoutMs?: number;
  tools?: ClientTools;
}

export interface Answer {
  text: string;
  model: string;
  searches: number;
  /** Server tools Claude ran, in order (web_search, web_fetch, code_execution...). */
  tools: string[];
  /** API requests this turn took (1 + pause_turn continuations). */
  rounds: number;
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

export class Brain {
  private readonly client: Anthropic;
  private messages: Anthropic.Beta.BetaMessageParam[] = [];
  private turns = 0;
  private lastAt = 0;
  private busy: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: BrainOptions) {
    const timeout = opts.timeoutMs ?? 45_000;
    this.client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 1, timeout });
  }

  reset() {
    this.messages = [];
    this.turns = 0;
  }

  /** One turn at a time, so two quick questions never interleave the history. */
  ask(question: string): Promise<Answer> {
    const run = this.busy.then(() => this.askNow(question));
    this.busy = run.catch(() => undefined);
    return run;
  }

  private async askNow(question: string): Promise<Answer> {
    const now = Date.now();
    if (now - this.lastAt > IDLE_RESET_MS || this.turns >= MAX_TURNS) this.reset();
    this.lastAt = now;

    const when = new Date().toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' });
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const live = this.opts.tools?.context();
    // Keep this turn separate until it succeeds, so a failed turn leaves the history valid.
    const turn: Anthropic.Beta.BetaMessageParam[] = [
      { role: 'user', content: `(It is ${when}, time zone ${tz}.${live ? ` ${live}` : ''}) ${question}` },
    ];

    let response: Anthropic.Beta.BetaMessage | undefined;
    let searches = 0;
    let rounds = 0;
    const tools: string[] = [];
    const spoken: string[] = [];
    for (let i = 0; i < MAX_ROUNDS; i++) {
      response = await this.client.beta.messages.create({
        model: this.opts.model,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        output_config: { effort: this.opts.effort },
        tools: [
          // Plain search/fetch, not the _20260209 versions: those wrap every lookup in code_execution
          // ("dynamic filtering"), which costs several seconds a spoken answer cannot afford.
          // Each lookup still adds time, so cap them.
          { type: 'web_search_20250305', name: 'web_search', max_uses: 2 },
          { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 1 },
          ...(this.opts.tools?.defs ?? []),
        ],
        messages: [...this.messages, ...turn],
      });
      rounds++;
      for (const b of response.content) {
        if (b.type === 'server_tool_use') {
          searches++;
          tools.push(b.name);
        } else if (b.type === 'text' && b.text.trim()) {
          spoken.push(b.text);
        }
      }
      turn.push({ role: 'assistant', content: response.content });

      // A long server-tool turn can pause; send it back so the server continues it.
      if (response.stop_reason === 'pause_turn') continue;
      if (response.stop_reason !== 'tool_use' || !this.opts.tools) break;

      // Our own tools: run every call from this response, return all results in one user message.
      const calls = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      const results = await Promise.all(
        calls.map(async (c): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
          tools.push(c.name);
          try {
            const r = await this.opts.tools!.run(c.name, (c.input ?? {}) as Record<string, unknown>);
            return { type: 'tool_result', tool_use_id: c.id, content: r.content, ...(r.is_error ? { is_error: true } : {}) };
          } catch (err) {
            return { type: 'tool_result', tool_use_id: c.id, content: `Tool failed: ${(err as Error).message}`, is_error: true };
          }
        }),
      );
      turn.push({ role: 'user', content: results });
    }
    if (!response) throw new Error('no response');
    if (response.stop_reason === 'refusal') {
      this.reset();
      return { text: "Sorry, I can't help with that one.", model: response.model, searches, tools, rounds };
    }
    if (response.stop_reason === 'tool_use') {
      // Ran out of rounds mid-task: the history now ends in an unanswered tool call, so start fresh next time.
      this.reset();
      throw new Error(`still calling tools after ${MAX_ROUNDS} rounds (${tools.join(', ')})`);
    }

    // The spoken reply: the text of the final response (earlier text was said before a tool call).
    const finalText = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join(' ');
    const text = toSpeakable(finalText || spoken.join(' '));
    if (!text) throw new Error(`empty reply (stop_reason ${response.stop_reason})`);

    this.messages.push(...turn);
    this.turns++;
    return { text, model: response.model, searches, tools, rounds };
  }
}
