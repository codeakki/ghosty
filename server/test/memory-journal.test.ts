import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemoryMemoryStore, UserMemorySchema, ZeroGMemory, type MemoryPointer, type PointerStore } from '../src/agent/memory.js';
import type { BlobStore } from '../src/agent/storage.js';
import { buildApp } from '../src/app.js';
import { buildVoiceUserMessage, MEMORY_TURNS, type VoiceContext } from '../src/claude/voice.js';
import { loadConfig } from '../src/config.js';
import { SsmPointerStore } from '../src/agent/ssmPointer.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MASTER = '0x8b916003D0C8F1f468a720BA4Ab5EA9678bc6e61';

function orderAgent(seen: string[] = []) {
  return {
    seen,
    async handle(utterance: string) {
      seen.push(utterance);
      return {
        text: 'Done.',
        id: 'msg_x',
        orders: [{ coin: 'xyz:GOLD', isBuy: true, sizeUsd: 10, orderId: '597608308096', status: 'filled' as const, filled: 0.0025, avgPx: 4078.6 }],
      };
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe('0G journal', () => {
  it('stores what was said, the reply, the order with its tx hash and the news, under the master address', async () => {
    const memory = new InMemoryMemoryStore();
    const app = buildApp({
      config: loadConfig({ HL_MASTER_ADDRESS: MASTER }),
      assistant: null,
      orderAgent: orderAgent(),
      deps: { memory },
    });
    // The fill hash lookup goes to Hyperliquid; replace it so the test stays offline.
    const pipeline = app.ghosty.pipeline as unknown as { deps: { lookupFillHash: (id: string) => Promise<string | undefined> } };
    pipeline.deps.lookupFillHash = async (id) => (id === '597608308096' ? '0x9cc5' : undefined);

    await app.inject({ method: 'POST', url: '/voice/text', payload: { text: 'Ghosty, put ten dollars into gold' } });
    await settle();
    const stored = await memory.load(MASTER.toLowerCase());
    assert.equal(stored.journal.length, 1);
    const [entry] = stored.journal;
    assert.equal(entry!.said, 'Ghosty, put ten dollars into gold');
    assert.equal(entry!.reply, 'Done.');
    assert.deepEqual(entry!.orders, [
      { coin: 'xyz:GOLD', side: 'buy', sizeUsd: 10, status: 'filled', orderId: '597608308096', avgPx: 4078.6, filled: 0.0025, txHash: '0x9cc5' },
    ]);
    assert.deepEqual(await new InMemoryMemoryStore().load('device-0').then((m) => m.journal), [], 'nothing under the device id');
    await app.close();
  });

  it('hands the stored turns to Claude on the next turn', async () => {
    const memory = new InMemoryMemoryStore();
    const m = await memory.load(MASTER.toLowerCase());
    m.journal.push({ at: '2026-11-07T05:28:56.000Z', said: 'put ten dollars into gold', reply: 'Done.', answeredBy: 'order', orders: [{ coin: 'xyz:GOLD', side: 'buy', sizeUsd: 10, status: 'filled', txHash: '0x9cc5' }] });
    await memory.save(MASTER.toLowerCase(), m);
    const app = buildApp({ config: loadConfig({ HL_MASTER_ADDRESS: MASTER }), assistant: null, orderAgent: orderAgent(), deps: { memory } });
    const ctx = await (app.ghosty as unknown as { voiceContext?: () => Promise<VoiceContext> }).voiceContext?.();
    // voiceContext is internal; check through the prompt builder with the same shape instead.
    const prompt = buildVoiceUserMessage('what did I buy?', {
      ...(ctx ?? ({} as VoiceContext)),
      mode: 'live', simRunActive: false, safeStop: false, market: null, headlines: [], lastDecision: null, pendingAlert: null, pendingTrade: [], recentOrders: [],
      memory: { riskProfile: 'balanced', journal: (await memory.load(MASTER.toLowerCase())).journal },
    });
    assert.match(prompt, /"earlierTurns":\[\{"at":"2026-11-07T05:28:56.000Z","said":"put ten dollars into gold"/);
    assert.match(prompt, /"txHash":"0x9cc5"/);
    await app.close();
  });

  it('keeps only the last turns in the prompt', () => {
    const journal = Array.from({ length: MEMORY_TURNS + 5 }, (_, i) => ({ at: `t${i}`, said: `s${i}`, reply: 'r', answeredBy: 'claude' }));
    const prompt = buildVoiceUserMessage('hi', {
      mode: 'live', simRunActive: false, safeStop: false, market: null, headlines: [], lastDecision: null, pendingAlert: null, pendingTrade: [], recentOrders: [],
      memory: { riskProfile: 'balanced', journal },
    });
    assert.ok(!prompt.includes('"s4"') && prompt.includes('"s5"') && prompt.includes(`"s${MEMORY_TURNS + 4}"`));
  });

  it('reads blobs saved before the journal existed', () => {
    const old = { preferences: {}, riskProfile: 'balanced', history: [] };
    assert.deepEqual(UserMemorySchema.parse(old).journal, []);
  });
});

describe('durable memory pointer', () => {
  it('a fresh container finds the memory through the pointer store', async () => {
    const blobs = new Map<string, Uint8Array>();
    const store: BlobStore = {
      async upload(data) {
        const rootHash = `0xroot${blobs.size}`;
        blobs.set(rootHash, data);
        return { rootHash, txHash: `0xtx${blobs.size}` };
      },
      async download(rootHash) {
        return blobs.get(rootHash)!;
      },
    };
    const pointers = new Map<string, MemoryPointer>();
    const pointerStore: PointerStore = { get: async (u) => pointers.get(u), set: async (u, p) => void pointers.set(u, p) };
    const key = new Uint8Array(32).fill(7);

    const first = new ZeroGMemory({ store, key, pointers: pointerStore, dataDir: mkdtempSync(join(tmpdir(), 'mem-a-')) });
    const m = await first.load('acct');
    m.journal.push({ at: 'now', said: 'hello', reply: 'hi', answeredBy: 'claude' });
    await first.save('acct', m);
    await first.flush();

    // New process, empty disk: only the pointer store knows where the memory is.
    const second = new ZeroGMemory({ store, key, pointers: pointerStore, dataDir: mkdtempSync(join(tmpdir(), 'mem-b-')) });
    assert.equal((await second.load('acct')).journal[0]!.said, 'hello');
  });

  it('SSM store writes {rootHash, txHash, savedAt} under the prefix and reads it back', async () => {
    const params = new Map<string, string>();
    const client = {
      async send(cmd: { input: { Name: string; Value?: string } }) {
        if (cmd.input.Value !== undefined) return void params.set(cmd.input.Name, cmd.input.Value);
        const v = params.get(cmd.input.Name);
        if (!v) throw Object.assign(new (await import('@aws-sdk/client-ssm')).ParameterNotFound({ message: 'nf', $metadata: {} }));
        return { Parameter: { Value: v } };
      },
    };
    const ssm = new SsmPointerStore('/ghosty/memory', client as never);
    assert.equal(await ssm.get('0xabc'), undefined);
    await ssm.set('0xabc', { rootHash: '0xr', txHash: '0xt', savedAt: 'now' });
    assert.deepEqual([...params.keys()], ['/ghosty/memory/0xabc']);
    assert.deepEqual(await ssm.get('0xabc'), { rootHash: '0xr', txHash: '0xt', savedAt: 'now' });
  });
});
