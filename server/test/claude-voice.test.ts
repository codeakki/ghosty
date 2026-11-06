import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { buildApp } from '../src/app.js';
import { encodeWav } from '../src/audio/wav.js';
import { classifyIntent } from '../src/claude/intent.js';
import {
  ASSISTANT_FALLBACK_REPLY,
  buildVoiceUserMessage,
  ClaudeVoiceAssistant,
  toSpeakable,
  VOICE_SYSTEM_PROMPT,
  type VoiceAssistant,
  type VoiceContext,
} from '../src/claude/voice.js';
import { loadConfig } from '../src/config.js';
import type { PodEvent } from '../src/sim/state.js';

const CONTEXT: VoiceContext = {
  mode: 'live',
  simRunActive: false,
  safeStop: false,
  market: [
    { coin: 'xyz:GOLD', label: 'Gold', mid: 2731.456, change24hPct: 1.234 },
    { coin: 'BTC', label: 'Bitcoin', mid: 68012.7, change24hPct: -0.5 },
  ],
  headlines: [
    { title: 'Central bank buys record gold tonnage', source: 'rss', publishedAt: '2026-11-06T08:00:00.000Z', weight: 0.9, credibility: 'exemplary' },
    { title: 'Anon says gold to the moon', source: 'grok', publishedAt: '2026-11-06T07:00:00.000Z', weight: 0.2, credibility: 'untrusted' },
  ],
  lastDecision: { signal: 'none', confidence: 0.1, rationale: 'Quiet market.', at: '2026-11-06T08:10:00.000Z', trigger: 'inject' },
  pendingAlert: null,
  pendingTrade: [],
  recentOrders: [],
};

/** Minimal Messages client: records each request, answers with `reply` (or throws it). */
function mockClient(reply: Partial<Anthropic.Message> | Error) {
  const calls: Array<{ body: Anthropic.MessageCreateParamsNonStreaming; options: unknown }> = [];
  const client = {
    messages: {
      create: async (body: Anthropic.MessageCreateParamsNonStreaming, options?: unknown) => {
        calls.push({ body, options });
        if (reply instanceof Error) throw reply;
        return { id: 'msg_test_1', stop_reason: 'end_turn', content: [], ...reply } as Anthropic.Message;
      },
    },
  } as unknown as Pick<Anthropic, 'messages'>;
  return { client, calls };
}

class FakeAssistant implements VoiceAssistant {
  readonly questions: string[] = [];
  constructor(private readonly fail = false) {}
  async answer(question: string) {
    this.questions.push(question);
    if (this.fail) throw Object.assign(new Error('timed out'), { name: 'APIConnectionTimeoutError' });
    return { text: 'Gold is up about one percent on central bank buying.', id: 'msg_fake_1' };
  }
}

describe('voice intent routing', () => {
  for (const q of ["What's moving gold right now?", 'how is BTC doing?', 'are you online?', 'what did you just do?', 'No news today?', 'hi']) {
    it(`question → claude: ${q}`, () => assert.equal(classifyIntent(q), 'question'));
  }
  for (const q of ['Should I buy gold?', 'Should I go long oil?', 'go long oil', 'short BTC now', 'can we hedge my bitcoin', 'what should I do?']) {
    it(`trade → 0g: ${q}`, () => assert.equal(classifyIntent(q), 'trade'));
  }
  for (const q of ['yes', 'confirm', 'Yes, do it', 'cancel', 'no, cancel that']) {
    it(`alert reaction → confirm: ${q}`, () => assert.equal(classifyIntent(q), 'confirm'));
  }
});

describe('ClaudeVoiceAssistant', () => {
  it('sends the Ghosty persona plus live market and headline context', async () => {
    const { client, calls } = mockClient({ content: [{ type: 'text', text: '**Gold** is up about one percent 🚀 https://x.com/a', citations: null }] });
    const assistant = new ClaudeVoiceAssistant({ client, model: 'claude-sonnet-5-5', context: async () => CONTEXT });
    const reply = await assistant.answer("what's moving gold?");

    assert.equal(reply.id, 'msg_test_1');
    assert.equal(reply.text, 'Gold is up about one percent', 'markdown, emoji and URL stripped for TTS');
    const { body, options } = calls[0]!;
    assert.equal(body.model, 'claude-sonnet-5-5');
    assert.equal(body.system, VOICE_SYSTEM_PROMPT);
    assert.match(VOICE_SYSTEM_PROMPT, /45 spoken words/);
    assert.match(VOICE_SYSTEM_PROMPT, /no financial advice/i);
    const user = String(body.messages[0]!.content);
    assert.match(user, /The wearer says: what's moving gold\?/);
    assert.match(user, /"asset":"Gold","coin":"xyz:GOLD","price":2731,"change24hPct":1.23/);
    assert.match(user, /Central bank buys record gold tonnage/);
    assert.match(user, /"credibility":"untrusted"/);
    assert.match(user, /"lastDecision":\{"signal":"none"/);
    assert.match(user, /"mode":"live"/);
    assert.equal((options as { timeout: number }).timeout, 20_000);
  });

  it('throws on refusal or an empty reply (the pipeline turns that into the fallback)', async () => {
    const refused = new ClaudeVoiceAssistant({ client: mockClient({ stop_reason: 'refusal' }).client, model: 'm', context: async () => CONTEXT });
    await assert.rejects(refused.answer('hi'), /declined/);
    const empty = new ClaudeVoiceAssistant({ client: mockClient({ content: [] }).client, model: 'm', context: async () => CONTEXT });
    await assert.rejects(empty.answer('hi'), /empty reply/);
  });

  it('buildVoiceUserMessage says when market data is unavailable and when safe-stop is on', () => {
    const msg = buildVoiceUserMessage('are you online?', { ...CONTEXT, market: null, safeStop: true, simRunActive: true });
    assert.match(msg, /"market":"market data unavailable"/);
    assert.match(msg, /safeStop":"engaged/);
    assert.match(msg, /simulation run is active/);
  });

  it('toSpeakable keeps plain sentences', () => {
    assert.equal(toSpeakable('  Bitcoin is flat.\n\nNothing else. '), 'Bitcoin is flat. Nothing else.');
  });
});

describe('POST /voice/text with Claude on', () => {
  const events = (app: ReturnType<typeof buildApp>) => {
    const seen: PodEvent[] = [];
    app.ghosty.state.subscribe((e) => seen.push(e));
    return seen;
  };

  it('answers a question with Claude: answeredBy claude, audio, header, SSE voice event, no decision', async () => {
    const assistant = new FakeAssistant();
    const app = buildApp({ config: loadConfig({}), assistant });
    const seen = events(app);
    const res = await app.inject({ method: 'POST', url: '/voice/text', payload: { text: "What's moving gold right now?" } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-answered-by'], 'claude');
    const body = res.json();
    assert.equal(body.answeredBy, 'claude');
    assert.equal(body.intent, 'question');
    assert.equal(body.reply, 'Gold is up about one percent on central bank buying.');
    assert.equal(body.requestId, 'msg_fake_1');
    assert.equal(body.signal, 'none');
    assert.deepEqual(body.actions, []);
    assert.ok(body.audioBytes > 0);
    assert.deepEqual(assistant.questions, ["What's moving gold right now?"]);

    const voice = seen.filter((e) => e.type === 'voice');
    assert.equal(voice.length, 1);
    assert.deepEqual(
      { ...(voice[0]!.data as object), at: 'x' },
      { transcript: "What's moving gold right now?", reply: body.reply, answeredBy: 'claude', intent: 'question', requestId: 'msg_fake_1', trigger: 'text', at: 'x' },
    );
    assert.ok(!seen.some((e) => e.type === 'decision'), 'Claude never makes a decision');
    assert.equal((await app.inject({ method: 'GET', url: '/state' })).json().lastDecision, null);
    await app.close();
  });

  it('keeps trade requests on the 0G path', async () => {
    const assistant = new FakeAssistant();
    const app = buildApp({ config: loadConfig({}), assistant });
    const seen = events(app);
    const res = await app.inject({ method: 'POST', url: '/voice/text', payload: { text: 'Should I go long oil?' } });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.answeredBy, '0g');
    assert.equal(body.intent, 'trade');
    assert.match(body.requestId, /^fake-/, 'the (test-mode) 0G decider answered');
    assert.equal(assistant.questions.length, 0);
    assert.ok(seen.some((e) => e.type === 'decision'));
    assert.equal((seen.find((e) => e.type === 'voice')!.data as { answeredBy: string }).answeredBy, '0g');
    await app.close();
  });

  it('answers "yes" with a button hint and never executes', async () => {
    const app = buildApp({ config: loadConfig({}), assistant: new FakeAssistant() });
    await app.inject({ method: 'POST', url: '/news/inject', payload: { title: 'Missile strike reported near the Taiwan Strait' } });
    const res = await app.inject({ method: 'POST', url: '/voice/text', payload: { text: 'yes' } });
    const body = res.json();
    assert.equal(body.answeredBy, '0g');
    assert.equal(body.intent, 'confirm');
    assert.match(body.reply, /button/);
    const state = (await app.inject({ method: 'GET', url: '/state' })).json();
    assert.equal(state.orders.length, 0, 'no order from a voice "yes"');
    assert.ok(state.plannedActions.length > 0, 'pending trade still waits for the button');
    await app.close();
  });

  it('Claude failure → honest spoken fallback, not a fake answer', async () => {
    const app = buildApp({ config: loadConfig({}), assistant: new FakeAssistant(true) });
    const body = (await app.inject({ method: 'POST', url: '/voice/text', payload: { text: 'how is BTC doing?' } })).json();
    assert.equal(body.answeredBy, 'claude');
    assert.equal(body.reply, ASSISTANT_FALLBACK_REPLY);
    assert.equal(body.assistantError, 'APIConnectionTimeoutError');
    assert.match(body.requestId, /^claude-error-/);
    await app.close();
  });

  it('questions still work during safe-stop; trades get 503 brain_offline', async () => {
    const app = buildApp({ config: loadConfig({ SIMULATE_BRAIN_OFFLINE: 'true' }), assistant: new FakeAssistant() });
    const q = await app.inject({ method: 'POST', url: '/voice/text', payload: { text: 'are you online?' } });
    assert.equal(q.statusCode, 200);
    assert.equal(q.json().answeredBy, 'claude');
    const t = await app.inject({ method: 'POST', url: '/voice/text', payload: { text: 'go long gold' } });
    assert.equal(t.statusCode, 503);
    assert.equal(t.json().error, 'brain_offline');
    await app.close();
  });

  it('POST /voice sets x-answered-by', async () => {
    const app = buildApp({ config: loadConfig({}), assistant: new FakeAssistant() });
    // Test-mode fake STT transcribes to a fixed question-or-trade phrase; whichever it is, the header says who answered.
    const res = await app.inject({ method: 'POST', url: '/voice', headers: { 'content-type': 'audio/wav' }, payload: encodeWav(Buffer.alloc(32000)) });
    assert.equal(res.statusCode, 200);
    assert.ok(['claude', '0g'].includes(String(res.headers['x-answered-by'])));
    assert.ok(Number(res.headers['content-length'] ?? res.rawPayload.length) > 0);
    await app.close();
  });

  it('a slow TTS does not turn a real text reply into a 500', async () => {
    const tts = { synthesize: async () => Promise.reject(Object.assign(new Error('aborted due to timeout'), { name: 'TimeoutError' })) };
    const app = buildApp({ config: loadConfig({}), assistant: new FakeAssistant(), deps: { tts } });
    const res = await app.inject({ method: 'POST', url: '/voice/text', payload: { text: 'how is gold?' } });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.answeredBy, 'claude');
    assert.equal(body.audioBytes, 0);
    assert.deepEqual(body.tts, { error: 'tts_failed', message: 'TimeoutError: aborted due to timeout' });
    await app.close();
  });

  it('without Claude every turn is a 0G decision (answeredBy 0g)', async () => {
    const app = buildApp({ config: loadConfig({}), assistant: null });
    const body = (await app.inject({ method: 'POST', url: '/voice/text', payload: { text: 'how is BTC doing?' } })).json();
    assert.equal(body.answeredBy, '0g');
    assert.match(body.requestId, /^fake-/);
    await app.close();
  });
});
