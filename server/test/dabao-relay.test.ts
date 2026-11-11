import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { recoverAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { buildApp } from '../src/app.js';
import { FakeStt } from '../src/audio/stt.js';
import { encodeWav } from '../src/audio/wav.js';
import { loadConfig } from '../src/config.js';
import { orderDigest, type HlOrderFields, type HlSignature } from '../src/execution/dabao.js';
import { HyperliquidVenue, type HlInfoApi } from '../src/execution/hyperliquid.js';
import { signerHub, SignerHub } from '../src/execution/signerHub.js';
import { executeVoiceOrder, voiceOrder } from '../src/execution/voiceOrder.js';

// Throwaway test key (well known, never funded) standing in for the Dabao's key.
const KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const DABAO = privateKeyToAccount(KEY).address;
const HOST = fileURLToPath(new URL('../../firmware/dabao/ghosty_signer/host/host_signer', import.meta.url));

/** Mainnet-shaped markets: xyz is perp dex 1 and GOLD its 4th market, so GOLD = asset 110003 as on the Dabao allowlist. */
const info: HlInfoApi = {
  async perpDexs() {
    return [null, { name: 'xyz' }];
  },
  async meta({ dex }) {
    const universe = dex === 'xyz' ? ['xyz:XYZ100', 'xyz:TSLA', 'xyz:NVDA', 'xyz:GOLD'] : ['BTC', 'ETH'];
    return { universe: universe.map((name) => ({ name, szDecimals: 4 })) };
  },
  async allMids({ dex }) {
    const mids: Record<string, string> = dex === 'xyz' ? { 'xyz:GOLD': '4065.3' } : { BTC: '76520' };
    return mids;
  },
};

/** The pod: runs the C signer (host build) on a sign request frame, as the Dabao would after a button press. */
function dabao(frame: Buffer): Buffer {
  const out = execFileSync(HOST, [KEY.slice(2), frame.toString('hex')], { encoding: 'utf8' });
  return Buffer.from(/^reply (\w+)$/m.exec(out)![1]!, 'hex');
}

describe('voice order signed on the Dabao', { skip: !existsSync(HOST) && 'run firmware/dabao/build.sh host first' }, () => {
  it('/voice asks the pod to sign, /sign submits the signed order and speaks the fill', async () => {
    const submitted: Array<{ action: unknown; signature: HlSignature; nonce: number }> = [];
    let now = 1794003754000;
    const venue = new HyperliquidVenue({
      info,
      testnet: false,
      now: () => now++,
      signer: {
        address: DABAO,
        sign: (frame) => signerHub.sign(frame),
        async submit(payload) {
          submitted.push(payload);
          return { status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { oid: 77, totalSz: '0.0025', avgPx: '4065.3' } }] } } };
        },
      },
    });
    const orderAgent = {
      async handle() {
        const { reply, result } = await executeVoiceOrder(voiceOrder('buy', 'GOLD', 10), { venue, maxTradeUsd: 10 });
        return { text: reply, id: 'msg_test', orders: result ? [result] : [] };
      },
    };
    const app = buildApp({
      config: loadConfig({}),
      assistant: null,
      orderAgent,
      deps: { stt: new FakeStt('Ghosty, put ten dollars into gold'), venue },
    });

    const voice = await app.inject({
      method: 'POST',
      url: '/voice',
      headers: { 'content-type': 'audio/wav', 'x-listen': 'always' },
      payload: encodeWav(Buffer.alloc(16000), { sampleRate: 16000 }),
    });
    assert.equal(voice.statusCode, 202);
    const signId = voice.headers['x-sign-id'] as string;
    assert.ok(signId);
    assert.equal(submitted.length, 0, 'nothing reaches Hyperliquid before the Dabao signs');

    const done = await app.inject({
      method: 'POST',
      url: '/sign',
      headers: { 'content-type': 'application/octet-stream', 'x-sign-id': signId },
      payload: dabao(voice.rawPayload),
    });
    assert.equal(done.statusCode, 200);
    assert.equal(done.headers['x-answered-by'], 'order');
    assert.ok(done.rawPayload.length > 0, 'confirmation audio');

    assert.equal(submitted.length, 1);
    const { action, signature, nonce } = submitted[0]!;
    const fields: HlOrderFields = { asset: 110003, isBuy: true, px: '4105.9', sz: '0.0025', nonce, testnet: false };
    assert.deepEqual(action, {
      type: 'order',
      orders: [{ a: 110003, b: true, p: '4105.9', s: '0.0025', r: false, t: { limit: { tif: 'Ioc' } } }],
      grouping: 'na',
    });
    const signer = await recoverAddress({ hash: orderDigest(fields), signature: { ...signature, v: BigInt(signature.v) } as { r: Hex; s: Hex; v: bigint } });
    assert.equal(signer, DABAO);
    await app.close();
  });

  it('speaks the Dabao refusal and submits nothing', async () => {
    const submitted: unknown[] = [];
    const noPodHub = new SignerHub();  // no pod has ever asked this hub for work
    const venue = new HyperliquidVenue({
      info,
      testnet: true,  // the Dabao is a mainnet signer: it refuses testnet orders
      signer: { address: DABAO, sign: (frame) => noPodHub.sign(frame), submit: async (p) => submitted.push(p) },
    });
    const orderAgent = {
      async handle() {
        const { reply, result } = await executeVoiceOrder(voiceOrder('buy', 'GOLD', 10), { venue, maxTradeUsd: 10 });
        return { text: reply, id: 'msg_test', orders: result ? [result] : [] };
      },
    };
    const app = buildApp({ config: loadConfig({}), assistant: null, orderAgent, deps: { venue } });
    const voice = await app.inject({ method: 'POST', url: '/voice/text', payload: { text: 'Ghosty, buy ten dollars of gold' } });
    // /voice/text has no pod to relay through: the order fails cleanly instead of waiting.
    assert.equal(voice.statusCode, 200);
    assert.match(voice.json().reply, /failed\. no pod is connected/);
    assert.equal(submitted.length, 0);
    await app.close();
  });
});
