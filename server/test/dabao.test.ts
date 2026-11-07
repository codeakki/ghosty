import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { signL1Action } from '@nktkas/hyperliquid/signing';
import { privateKeyToAccount } from 'viem/accounts';
import {
  decodeFrame,
  encodeFrame,
  encodeSignRequest,
  orderAction,
  orderDigest,
  RSP_SIGNATURE,
  toExchangeSignature,
  type HlOrderFields,
} from '../src/execution/dabao.js';

// Throwaway test key (well known, never funded).
const KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const account = privateKeyToAccount(KEY);

const GOLD: HlOrderFields = { asset: 110003, isBuy: true, px: '4106', sz: '0.0025', nonce: 1794003754000, testnet: false };
const BTC_SELL: HlOrderFields = { asset: 0, isBuy: false, px: '66123.5', sz: '0.00016', nonce: 1794003799123, testnet: true };

const HOST = fileURLToPath(new URL('../../firmware/dabao/ghosty_signer/host/host_signer', import.meta.url));

function hostSigner(frame: Buffer): Record<string, string> {
  const out = execFileSync(HOST, [KEY.slice(2), frame.toString('hex')], { encoding: 'utf8' });
  return Object.fromEntries(out.trim().split('\n').map((l) => l.split(' ') as [string, string]));
}

describe('Dabao frames', () => {
  it('round-trips and rejects a bad CRC', () => {
    const f = encodeFrame(0x82, Buffer.from([1, 2, 3]));
    assert.deepEqual(decodeFrame(Buffer.concat([Buffer.from('boot text\r\n'), f])), { type: 0x82, payload: Buffer.from([1, 2, 3]) });
    f[f.length - 1]! ^= 0xff;
    assert.throws(() => decodeFrame(f), /no valid frame/);
  });
});

describe('Dabao order digest', () => {
  it('is the digest the SDK signs for the same order', async () => {
    for (const f of [GOLD, BTC_SELL]) {
      const sdk = await signL1Action({ wallet: account, action: orderAction(f), nonce: f.nonce, isTestnet: f.testnet });
      const ours = await toExchangeSignature(orderDigest(f), Buffer.from(sdk.r.slice(2) + sdk.s.slice(2), 'hex'), account.address);
      assert.deepEqual(ours, { r: sdk.r, s: sdk.s, v: sdk.v });
    }
  });

  it('rejects a signature from another key', async () => {
    const sdk = await signL1Action({ wallet: account, action: orderAction(GOLD), nonce: GOLD.nonce });
    const rs = Buffer.from(sdk.r.slice(2) + sdk.s.slice(2), 'hex');
    await assert.rejects(toExchangeSignature(orderDigest(GOLD), rs, '0x000000000000000000000000000000000000dEaD'), /does not match/);
  });
});

describe('Dabao C signer (host build)', { skip: !existsSync(HOST) && 'build firmware/dabao/ghosty_signer/host first' }, () => {
  it('builds the same digest and a signature the SDK accepts', async () => {
    for (const f of [GOLD, BTC_SELL]) {
      const out = hostSigner(encodeSignRequest(f));
      assert.equal(`0x${out.digest}`, orderDigest(f));
      const reply = decodeFrame(Buffer.from(out.reply!, 'hex'));
      assert.equal(reply.type, RSP_SIGNATURE);
      // Recovers to the key's address (micro-ecc derives its RFC 6979 k differently from viem, so bytes differ).
      const sig = await toExchangeSignature(orderDigest(f), reply.payload, account.address);
      assert.ok(BigInt(sig.s) <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n, 'low-s');
      const again = decodeFrame(Buffer.from(hostSigner(encodeSignRequest(f)).reply!, 'hex'));
      assert.deepEqual(again.payload, reply.payload, 'deterministic: same order, same signature');
    }
  });

  it('enforces its own limits', () => {
    const err = (f: HlOrderFields) => decodeFrame(Buffer.from(hostSigner(encodeSignRequest(f)).reply!, 'hex')).payload[0];
    assert.equal(err({ ...GOLD, asset: 7 }), 4, 'asset not allowed');
    assert.equal(err({ ...GOLD, sz: '0.01' }), 5, '41 USD is above the 15 USD limit');
    assert.equal(err({ ...GOLD, px: '4106.0' }), 3, 'non-canonical decimal');
  });
});
