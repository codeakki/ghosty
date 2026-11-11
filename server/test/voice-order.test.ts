import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { buildApp } from '../src/app.js';
import { FakeStt } from '../src/audio/stt.js';
import { encodeWav } from '../src/audio/wav.js';
import { hasWakeWord, isBareWakeWord, isVenueOrder } from '../src/claude/intent.js';
import { CLOSE_POSITIONS_TOOL, ClaudeOrderAgent, GET_POSITIONS_TOOL, ORDER_AGENT_SYSTEM_PROMPT, PLACE_ORDER_TOOL } from '../src/claude/orderAgent.js';
import type { VoiceContext } from '../src/claude/voice.js';
import { loadConfig } from '../src/config.js';
import type { MarketOrderRequest, OrderResult, PerpVenue } from '../src/execution/hyperliquid.js';
import { describeVoiceOrder, executeVoiceOrder, voiceOrder } from '../src/execution/voiceOrder.js';

const CONTEXT: VoiceContext = {
  mode: 'live',
  simRunActive: false,
  safeStop: false,
  market: [{ coin: 'xyz:GOLD', label: 'Gold', mid: 4063, change24hPct: 0.4 }],
  headlines: [],
  lastDecision: null,
  pendingAlert: null,
  pendingTrade: [],
  recentOrders: [],
};

class RecordingVenue implements PerpVenue {
  readonly orders: MarketOrderRequest[] = [];
  constructor(private readonly result: Partial<OrderResult> = { filled: 0.0025, avgPx: 4012.3 }) {}
  async placeMarketOrder(req: MarketOrderRequest): Promise<OrderResult> {
    this.orders.push(req);
    return { coin: 'xyz:GOLD', isBuy: req.isBuy, sizeUsd: req.sizeUsd, orderId: `oid-${this.orders.length}`, status: 'filled', ...this.result };
  }
  async listMarkets() {
    return [];
  }
}

type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown };

/** Fake Anthropic client: returns the scripted responses in order and records every request. */
function fakeClient(...responses: Array<{ content: Block[]; stop_reason: string }>) {
  const requests: Anthropic.Beta.MessageCreateParamsNonStreaming[] = [];
  const client = {
    beta: {
      messages: {
        create: async (params: Anthropic.Beta.MessageCreateParamsNonStreaming) => {
          requests.push(structuredClone(params));
          const next = responses.shift();
          if (!next) throw new Error('no scripted response left');
          return { id: `msg_${requests.length}`, ...next };
        },
      },
    },
  } as unknown as Pick<Anthropic, 'beta'>;
  return { client, requests };
}

const call = (input: unknown, id = 'tu_1'): Block => ({ type: 'tool_use', id, name: 'place_order', input });

function agent(client: Pick<Anthropic, 'beta'>, venue: PerpVenue, maxTradeUsd = 10) {
  return new ClaudeOrderAgent({ client, model: 'claude-sonnet-5-5', context: async () => CONTEXT, venue, maxTradeUsd });
}

describe('executeVoiceOrder', () => {
  const gold = voiceOrder('buy', 'GOLD', 10);

  it('places the order and reports the fill', async () => {
    const venue = new RecordingVenue();
    const { reply, result } = await executeVoiceOrder(gold, { venue, maxTradeUsd: 10 });
    assert.deepEqual(venue.orders, [{ coin: 'GOLD', isBuy: true, sizeUsd: 10 }]);
    assert.equal(result?.status, 'filled');
    assert.equal(reply, 'Done. I bought 10.03 dollars of gold on Hyperliquid, at 4012 dollars.');
  });

  it('refuses below the Hyperliquid minimum and above the cap without calling the venue', async () => {
    const venue = new RecordingVenue();
    assert.match((await executeVoiceOrder(voiceOrder('buy', 'GOLD', 1), { venue, maxTradeUsd: 10 })).reply, /at least 10 dollars/);
    assert.match((await executeVoiceOrder(voiceOrder('buy', 'GOLD', 50), { venue, maxTradeUsd: 10 })).reply, /limit is 10 dollars/);
    assert.equal(venue.orders.length, 0);
  });

  it('says a rejected order failed', () => {
    const reply = describeVoiceOrder(gold, { coin: 'xyz:GOLD', isBuy: true, sizeUsd: 10, orderId: '', status: 'rejected', error: 'Insufficient margin.' });
    assert.equal(reply, 'The gold order failed. Insufficient margin. Nothing was bought.');
  });
});

describe('ClaudeOrderAgent', () => {
  it('sends the exact words with a strict place_order tool and no forced tool choice', async () => {
    const { client, requests } = fakeClient({ content: [{ type: 'text', text: 'Gold is about four thousand dollars.' }], stop_reason: 'end_turn' });
    const reply = await agent(client, new RecordingVenue()).handle('how much is gold?');
    assert.equal(reply.text, 'Gold is about four thousand dollars.');
    assert.deepEqual(reply.orders, []);
    const req = requests[0]!;
    assert.equal(req.model, 'claude-sonnet-5-5');
    assert.equal(req.system, ORDER_AGENT_SYSTEM_PROMPT);
    assert.deepEqual(req.tools, [PLACE_ORDER_TOOL, GET_POSITIONS_TOOL, CLOSE_POSITIONS_TOOL]);
    assert.deepEqual(req.tool_choice, { type: 'auto' });
    assert.match(String(req.messages[0]!.content), /The wearer says: how much is gold\?$/);
  });

  it('executes the tool call and speaks the venue result, without a second request', async () => {
    const venue = new RecordingVenue();
    const { client, requests } = fakeClient({ content: [call({ side: 'buy', asset: 'GOLD', usd: 10 })], stop_reason: 'tool_use' });
    const reply = await agent(client, venue).handle('put ten bucks into gold');
    assert.deepEqual(venue.orders, [{ coin: 'GOLD', isBuy: true, sizeUsd: 10 }]);
    assert.equal(reply.text, 'Done. I bought 10.03 dollars of gold on Hyperliquid, at 4012 dollars.');
    assert.equal(reply.orders.length, 1);
    assert.equal(requests.length, 1);
  });

  it('caps the total of several orders in one turn', async () => {
    const venue = new RecordingVenue();
    const { client } = fakeClient({
      content: [call({ side: 'buy', asset: 'GOLD', usd: 10 }, 'tu_1'), call({ side: 'buy', asset: 'OIL', usd: 10 }, 'tu_2')],
      stop_reason: 'tool_use',
    });
    const reply = await agent(client, venue, 15).handle('buy ten dollars of gold and ten of oil');
    assert.deepEqual(venue.orders, [{ coin: 'GOLD', isBuy: true, sizeUsd: 10 }]);
    assert.match(reply.text, /limit is 5 dollars per trade\. Nothing was bought\.$/);
  });

  it('retries once after a malformed call and never places it', async () => {
    const venue = new RecordingVenue();
    const { client, requests } = fakeClient(
      { content: [call({ side: 'buy', asset: 'DOGE', usd: 10 })], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'I can not trade dogecoin.' }], stop_reason: 'end_turn' },
    );
    const reply = await agent(client, venue).handle('buy ten dollars of doge');
    assert.equal(venue.orders.length, 0);
    assert.equal(reply.text, 'I can not trade dogecoin.');
    assert.equal(requests.length, 2);
  });

  it('answers PnL questions from get_positions with a second model turn', async () => {
    const venue = Object.assign(new RecordingVenue(), {
      async account() {
        return {
          accountValueUsd: 9.71,
          unrealizedPnlUsd: 0.05,
          positions: [{ coin: 'xyz:GOLD', side: 'long' as const, size: 0.005, entryPx: 4071.95, valueUsd: 20.4, unrealizedPnlUsd: 0.05 }],
        };
      },
    });
    const { client, requests } = fakeClient(
      { content: [{ type: 'tool_use', id: 'tu_p', name: 'get_positions', input: {} }], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'You are long gold, up five cents.' }], stop_reason: 'end_turn' },
    );
    const reply = await agent(client, venue).handle('what is my pnl?');
    assert.equal(reply.text, 'You are long gold, up five cents.');
    const toolResult = (requests[1]!.messages[2]!.content as Array<{ content: string }>)[0]!.content;
    assert.match(toolResult, /"asset":"gold","side":"long".*"unrealizedPnlUsd":0.05/);
    assert.equal(venue.orders.length, 0);
  });

  it('closes every position on close_positions ALL and speaks the venue results', async () => {
    const closed: string[] = [];
    let open = [
      { coin: 'xyz:GOLD', side: 'long' as const, size: 0.005, entryPx: 4071.95, valueUsd: 20.4, unrealizedPnlUsd: 0.05 },
      { coin: 'BTC', side: 'short' as const, size: 0.00028, entryPx: 75853, valueUsd: 21.2, unrealizedPnlUsd: -0.01 },
    ];
    const venue = Object.assign(new RecordingVenue(), {
      async account() {
        return { accountValueUsd: 9.7, unrealizedPnlUsd: 0, positions: open };
      },
      async closePosition(coin: string) {
        closed.push(coin);
        open = open.filter((p) => p.coin !== coin);
        return { coin, isBuy: coin === 'BTC', sizeUsd: 20, orderId: '9', status: 'filled' as const, avgPx: coin === 'BTC' ? 75900 : 4080.2 };
      },
    });
    const { client, requests } = fakeClient({ content: [{ type: 'tool_use', id: 'tu_c', name: 'close_positions', input: { asset: 'ALL' } }], stop_reason: 'tool_use' });
    const reply = await agent(client, venue).handle('close all my positions');
    assert.deepEqual(closed, ['xyz:GOLD', 'BTC']);
    assert.equal(reply.text, 'Closed gold at 4080 dollars. Closed bitcoin at 75900 dollars. No positions left. Account value 9.70 dollars.');
    assert.equal(reply.orders.length, 2);
    assert.equal(requests.length, 1, 'closing needs no second model turn');
  });

  it('throws on a refusal so the pipeline speaks the fallback line', async () => {
    const { client } = fakeClient({ content: [], stop_reason: 'refusal' });
    await assert.rejects(agent(client, new RecordingVenue()).handle('hello'), /declined/);
  });
});

describe('POST /voice/text with an order agent', () => {
  it('routes every turn to the agent and reports its orders', async () => {
    const seen: string[] = [];
    const orderAgent = {
      async handle(utterance: string) {
        seen.push(utterance);
        return { text: 'Done.', id: 'msg_fake', orders: [{ coin: 'xyz:GOLD', isBuy: true, sizeUsd: 10, orderId: '7', status: 'filled' as const }] };
      },
    };
    const app = buildApp({ config: loadConfig({}), assistant: null, orderAgent });
    const body = (await app.inject({ method: 'POST', url: '/voice/text', payload: { text: 'Buy 10 dollars of gold.' } })).json();
    assert.deepEqual(seen, ['Buy 10 dollars of gold.']);
    assert.equal(body.answeredBy, 'order');
    assert.equal(body.reply, 'Done.');
    await app.close();
  });

  it('is off by default: the same words go to the 0G path', async () => {
    const app = buildApp({ config: loadConfig({}), assistant: null });
    const body = (await app.inject({ method: 'POST', url: '/voice/text', payload: { text: 'buy 10 dollars of gold' } })).json();
    assert.equal(body.answeredBy, '0g');
    await app.close();
  });
});

describe('always-listening /voice (X-Listen: always)', () => {
  it('knows the wake word as Whisper writes it', () => {
    for (const t of ['Ghosty, buy ten dollars of gold.', 'Hey ghostie what is gold at?', 'Ghost E, put ten bucks into gold', 'ok gosty sell bitcoin', 'Goshty brother are you up?', 'गोश्टी, हाव आर यू?', 'गोस्टी माई दोस्त']) {
      assert.equal(hasWakeWord(t), true, t);
    }
    for (const t of ['Thank you.', 'buy ten dollars of gold', 'I saw a ghost yesterday', 'the ghosts are back', 'Mm-hmm.', 'गोस्त खाना है']) {
      assert.equal(hasWakeWord(t), false, t);
    }
  });

  async function post(text: string) {
    const seen: string[] = [];
    const orderAgent = {
      async handle(utterance: string) {
        seen.push(utterance);
        return { text: 'Done.', id: 'msg_fake', orders: [] };
      },
    };
    const app = buildApp({ config: loadConfig({}), assistant: null, orderAgent, deps: { stt: new FakeStt(text) } });
    const res = await app.inject({
      method: 'POST',
      url: '/voice',
      headers: { 'content-type': 'audio/wav', 'x-listen': 'always' },
      payload: encodeWav(Buffer.alloc(16000), { sampleRate: 16000 }),
    });
    await app.close();
    return { res, seen };
  }

  it('ignores speech without the wake word: 204, Claude never called', async () => {
    const { res, seen } = await post('buy ten dollars of gold');
    assert.equal(res.statusCode, 204);
    assert.deepEqual(seen, []);
  });

  it('answers speech with the wake word', async () => {
    const { res, seen } = await post('Ghosty, buy ten dollars of gold');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(seen, ['Ghosty, buy ten dollars of gold']);
    assert.ok(res.rawPayload.length > 0);
  });
});

describe('wake word then a pause', () => {
  it('knows a clip that is only the wake word', () => {
    for (const t of ['Ghosty.', 'Hey Ghosty!', 'ok ghostie', 'गोस्टी']) assert.equal(isBareWakeWord(t), true, t);
    for (const t of ['Ghosty, buy Apple', 'Buy Apple', 'hey there']) assert.equal(isBareWakeWord(t), false, t);
  });

  it('answers the next clip without the wake word, once, inside the window', async () => {
    const clips = ['Ghosty.', 'Buy $5 of Apple stock on Uniswap', 'and also some gold'];
    const seen: string[] = [];
    const app = buildApp({
      config: loadConfig({}),
      assistant: null,
      orderAgent: { async handle(u: string) { seen.push(u); return { text: 'Done.', id: 'msg_fake', orders: [] }; } },
      deps: { stt: { async transcribe() { return { text: clips.shift()! }; } } as never },
    });
    const post = () => app.inject({ method: 'POST', url: '/voice', headers: { 'content-type': 'audio/wav', 'x-listen': 'always' }, payload: encodeWav(Buffer.alloc(16000), { sampleRate: 16000 }) });
    assert.equal((await post()).statusCode, 204, 'bare wake word: quiet');
    assert.equal((await post()).statusCode, 200, 'the order right after it');
    assert.equal((await post()).statusCode, 204, 'the window closes after one answer');
    assert.deepEqual(seen, ['Buy $5 of Apple stock on Uniswap']);
    await app.close();
  });
});

describe('venue orders without the wake word', () => {
  it('counts a clear order that names Uniswap or Hyperliquid', () => {
    for (const t of ['Buy $5 of Apple stock on Uniswap', 'sell ten dollars of gold on Hyperliquid', 'buy ETH on uni swap']) assert.equal(isVenueOrder(t), true, t);
    for (const t of ['Uniswap is down today', 'buy me a coffee', 'How are you?']) assert.equal(isVenueOrder(t), false, t);
  });
});

describe('midterms simulation', () => {
  function rig(clips: string[]) {
    const buys: Array<[string, number]> = [];
    const agentSaw: string[] = [];
    const app = buildApp({
      config: loadConfig({}),
      assistant: null,
      orderAgent: { async handle(u: string) { agentSaw.push(u); return { text: 'ok', id: 'm', orders: [] }; } },
      deps: {
        stt: { async transcribe() { return { text: clips.shift()! }; } } as never,
        simulationBuy: async (asset: 'ETH', usd: number) => {
          buys.push([asset, usd]);
          return { reply: 'Done. I bought 0.00223 ETH for 5 dollars of USDC on Uniswap.', result: { orderId: '0xabc', coin: 'uniswap:ETH', isBuy: true, sizeUsd: usd, status: 'filled' as const, txHash: '0xabc' } };
        },
      } as never,
    });
    const post = async () => {
      const res = await app.inject({ method: 'POST', url: '/voice', headers: { 'content-type': 'audio/wav', 'x-listen': 'always' }, payload: encodeWav(Buffer.alloc(16000), { sampleRate: 16000 }) });
      return res.statusCode;
    };
    return { app, post, buys, agentSaw };
  }

  it('speaks the news, and a yes without the wake word runs one real buy', async () => {
    const { app, post, buys, agentSaw } = rig(['Ghosty, run the midterms simulation', 'Yes.', 'yes']);
    assert.equal(await post(), 200);
    assert.equal(await post(), 200);
    assert.deepEqual(buys, [['ETH', 5]]);
    assert.equal(await post(), 204, 'a second yes is not for Ghosty any more');
    assert.deepEqual(buys, [['ETH', 5]]);
    assert.deepEqual(agentSaw, []);
    await app.close();
  });

  it('no cancels, and nothing runs without the simulation', async () => {
    const { app, post, buys } = rig(['Ghosty yes', 'Ghosty, start the simulation', 'no thanks']);
    assert.equal(await post(), 200);
    assert.equal(await post(), 200);
    assert.equal(await post(), 200);
    assert.deepEqual(buys, []);
    await app.close();
  });
});

describe('midterms simulation choices', () => {
  it('Hyperliquid runs the long, Uniswap the USDC buy', async () => {
    for (const [answer, want] of [['Hyperliquid please', 'long'], ['on Uniswap', 'buy']] as const) {
      const clips = ['Ghosty, run the midterms simulation', answer];
      const ran: string[] = [];
      const app = buildApp({
        config: loadConfig({}),
        assistant: null,
        orderAgent: { async handle() { return { text: 'ok', id: 'm', orders: [] }; } },
        deps: {
          stt: { async transcribe() { return { text: clips.shift()! }; } },
          simulationBuy: async () => (ran.push('buy'), { reply: 'bought' }),
          simulationLong: async () => (ran.push('long'), { reply: 'longed' }),
          simulationEvaluation: async () => 'ETH is flat.',
        } as never,
      });
      for (let i = 0; i < 2; i++) await app.inject({ method: 'POST', url: '/voice', headers: { 'content-type': 'audio/wav', 'x-listen': 'always' }, payload: encodeWav(Buffer.alloc(16000), { sampleRate: 16000 }) });
      assert.deepEqual(ran, [want], answer);
      await app.close();
    }
  });
});

describe('simulation window and other orders', () => {
  it('a full Apple order during the window goes to the order agent, not the ETH buy', async () => {
    const clips = ['Ghosty, run the midterms simulation', 'buy 5 dollars of Apple on Uniswap'];
    const ran: string[] = [];
    const agentSaw: string[] = [];
    const app = buildApp({
      config: loadConfig({}),
      assistant: null,
      orderAgent: { async handle(u: string) { agentSaw.push(u); return { text: 'ok', id: 'm', orders: [] }; } },
      deps: {
        stt: { async transcribe() { return { text: clips.shift()! }; } },
        simulationBuy: async () => (ran.push('buy'), { reply: 'bought' }),
        simulationLong: async () => (ran.push('long'), { reply: 'longed' }),
        simulationEvaluation: async () => '',
      } as never,
    });
    for (let i = 0; i < 2; i++) await app.inject({ method: 'POST', url: '/voice', headers: { 'content-type': 'audio/wav', 'x-listen': 'always' }, payload: encodeWav(Buffer.alloc(16000), { sampleRate: 16000 }) });
    assert.deepEqual(ran, []);
    assert.deepEqual(agentSaw, ['buy 5 dollars of Apple on Uniswap']);
    await app.close();
  });
});
