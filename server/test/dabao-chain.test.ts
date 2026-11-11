import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PrivateKey, Transaction } from '@hiero-ledger/sdk';
import { encodeFunctionData, parseTransaction, recoverTransactionAddress, recoverTypedDataAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  decodeFrame,
  encodeEvmTxRequest,
  encodeFrame,
  encodePermitRequest,
  evmTxDigest,
  infoPublicKey,
  MAX_UINT160,
  PERMIT2_ADDRESS,
  permitDigest,
  signedPermit,
  type PermitSingleFields,
  RSP_ERROR,
  signedEvmTx,
  signatureFromReply,
  type EvmTxFields,
} from '../src/execution/dabao.js';
import { DabaoHederaSigner } from '../src/execution/dabaoWallets.js';
import { SignerHub } from '../src/execution/signerHub.js';

// Throwaway test key (well known, never funded).
const KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const account = privateKeyToAccount(KEY);
const HEDERA_PUB = PrivateKey.fromStringECDSA(KEY.slice(2)).publicKey.toStringRaw();

const HOST = fileURLToPath(new URL('../../firmware/dabao/ghosty_signer/host/host_signer', import.meta.url));
const host = (frame: Buffer) => {
  const out = execFileSync(HOST, [KEY.slice(2), frame.toString('hex')], { encoding: 'utf8' });
  return Object.fromEntries(out.trim().split('\n').map((l) => [l.split(' ')[0]!, l.slice(l.indexOf(' ') + 1)]));
};
/** A signer hub whose "pod" is the C signer core on this computer. */
const hostHub = { sign: async (frame: Buffer) => Buffer.from(host(frame).reply!, 'hex') };

const EXECUTE_ABI = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'payable',
    inputs: [
      { name: 'commands', type: 'bytes' },
      { name: 'inputs', type: 'bytes[]' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

const DEADLINE = 1794003754n;
const SWAP: EvmTxFields = {
  chainId: 8453,
  nonce: 7,
  maxPriorityFeePerGas: 1_000_000n,
  maxFeePerGas: 8_500_000n,
  gas: 126_100n,
  to: '0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40',
  value: 0n,
  data: encodeFunctionData({
    abi: EXECUTE_ABI,
    functionName: 'execute',
    args: ['0x0b00', [`0x${'11'.repeat(160)}`, `0x${'22'.repeat(256)}`], DEADLINE],
  }),
};

const errCode = (frame: Buffer) => {
  const r = decodeFrame(Buffer.from(host(frame).reply!, 'hex'));
  return r.type === RSP_ERROR ? r.payload[0] : 0;
};

describe('Dabao Base swap signer (host build)', { skip: !existsSync(HOST) && 'build firmware/dabao: build.sh host' }, () => {
  it('builds the same EIP-1559 digest as viem and a raw tx that recovers to the Dabao', async () => {
    const out = host(encodeEvmTxRequest(SWAP));
    assert.equal(`0x${out.digest}`, evmTxDigest(SWAP));
    assert.equal(out.deadline, String(DEADLINE));
    const raw = await signedEvmTx(SWAP, signatureFromReply(Buffer.from(out.reply!, 'hex')), account.address);
    assert.equal(await recoverTransactionAddress({ serializedTransaction: raw as Parameters<typeof recoverTransactionAddress>[0]['serializedTransaction'] }), account.address);
    const parsed = parseTransaction(raw);
    assert.equal(parsed.to?.toLowerCase(), SWAP.to.toLowerCase());
    assert.equal(parsed.value ?? 0n, SWAP.value);
  });

  it('handles a zero tip and a long calldata header', () => {
    const tx = { ...SWAP, maxPriorityFeePerGas: 0n, nonce: 0, data: encodeFunctionData({ abi: EXECUTE_ABI, functionName: 'execute', args: ['0x00', [`0x${'33'.repeat(900)}`], DEADLINE] }) };
    assert.equal(`0x${host(encodeEvmTxRequest(tx)).digest}`, evmTxDigest(tx));
  });

  it('refuses what is not a small Uniswap swap on Base', () => {
    assert.equal(errCode(encodeEvmTxRequest({ ...SWAP, chainId: 1 })), 13, 'other chain');
    assert.equal(errCode(encodeEvmTxRequest({ ...SWAP, to: '0x000000000000000000000000000000000000dEaD' })), 14, 'other contract');
    assert.equal(errCode(encodeEvmTxRequest({ ...SWAP, value: 1n })), 15, 'swaps pay in USDC: no ETH value');
    assert.equal(errCode(encodeEvmTxRequest({ ...SWAP, maxFeePerGas: 10_000_000_000n })), 15, 'gas above 0.0001 ETH');
    assert.equal(errCode(encodeEvmTxRequest({ ...SWAP, data: `0xa9059cbb${'00'.repeat(96)}` as Hex })), 16, 'transfer(), not execute()');
  });
});

describe('Dabao USDC approval and Permit2 permit (host build)', { skip: !existsSync(HOST) && 'build firmware/dabao: build.sh host' }, () => {
  const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
  const approve = (spender: string): EvmTxFields => ({
    ...SWAP,
    to: USDC,
    gas: 60_000n,
    data: `0x095ea7b3${spender.slice(2).toLowerCase().padStart(64, '0')}${'f'.repeat(64)}` as Hex,
  });
  // Uniswap's standard permit: uint160 max for 30 days.
  const PERMIT: PermitSingleFields = {
    token: USDC,
    amount: MAX_UINT160,
    expiration: 1796621460,
    nonce: 0,
    spender: '0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40',
    sigDeadline: 1794031260,
  };

  it('signs USDC approve(Permit2) and nothing else on USDC', () => {
    const ok = approve(PERMIT2_ADDRESS);
    assert.equal(`0x${host(encodeEvmTxRequest(ok)).digest}`, evmTxDigest(ok));
    assert.equal(errCode(encodeEvmTxRequest(approve('0x000000000000000000000000000000000000dEaD'))), 14, 'approve to anyone else');
    assert.equal(errCode(encodeEvmTxRequest({ ...ok, data: `0xa9059cbb${'00'.repeat(64)}` as Hex })), 16, 'transfer()');
  });

  it('builds the same Permit2 digest as viem and a signature that recovers to the Dabao', async () => {
    for (const p of [PERMIT, { ...PERMIT, amount: 5_000_000n, expiration: PERMIT.sigDeadline + 600 }]) {
      const out = host(encodePermitRequest(p));
      assert.equal(`0x${out.digest}`, permitDigest(p));
      const sig = await signedPermit(p, signatureFromReply(Buffer.from(out.reply!, 'hex')), account.address);
      assert.equal(await recoverTypedDataAddress({
        domain: { name: 'Permit2', chainId: 8453, verifyingContract: PERMIT2_ADDRESS },
        types: {
          PermitSingle: [{ name: 'details', type: 'PermitDetails' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }],
          PermitDetails: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }],
        },
        primaryType: 'PermitSingle',
        message: { details: { token: p.token, amount: p.amount, expiration: p.expiration, nonce: p.nonce }, spender: p.spender, sigDeadline: BigInt(p.sigDeadline) },
        signature: sig,
      }), account.address);
    }
  });

  it('refuses other tokens, other spenders, odd amounts and long lives', () => {
    assert.equal(errCode(encodePermitRequest({ ...PERMIT, token: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf' })), 14);
    assert.equal(errCode(encodePermitRequest({ ...PERMIT, spender: '0x000000000000000000000000000000000000dEaD' })), 14);
    assert.equal(errCode(encodePermitRequest({ ...PERMIT, amount: 200_000_000n })), 15, '200 USDC exact permit');
    assert.equal(errCode(encodePermitRequest({ ...PERMIT, expiration: PERMIT.sigDeadline + 40 * 86400 })), 15, '40 days');
  });
});

describe('Dabao Hedera x402 signer (host build)', { skip: !existsSync(HOST) && 'build firmware/dabao: build.sh host' }, () => {
  const signer = new DabaoHederaSigner({ accountId: '0.0.7001', publicKeyHex: HEDERA_PUB, network: 'testnet', hub: hostHub });
  const req = (over: Partial<{ amount: string; asset: string; payTo: string }> = {}) => ({
    amount: '10000',
    asset: '0.0.429274',
    payTo: '0.0.11342424',
    network: 'hedera:testnet',
    extra: { feePayer: '0.0.7777' },
    ...over,
  });

  it('signs a 0.01 USDC payment to the Signal Desk; the signature verifies with the Dabao key', async () => {
    const tx = Transaction.fromBytes(Buffer.from(await signer.createPartiallySignedTransferTransaction(req()), 'base64'));
    const pub = PrivateKey.fromStringECDSA(KEY.slice(2)).publicKey;
    assert.equal(pub.verifyTransaction(tx), true);
  });

  it('signs an HBAR payment too', async () => {
    const tx = Transaction.fromBytes(Buffer.from(await signer.createPartiallySignedTransferTransaction(req({ asset: '0.0.0', amount: '1000000' })), 'base64'));
    assert.equal(PrivateKey.fromStringECDSA(KEY.slice(2)).publicKey.verifyTransaction(tx), true);
  });

  it('refuses another receiver, another token and amounts above its limit', async () => {
    await assert.rejects(signer.createPartiallySignedTransferTransaction(req({ payTo: '0.0.666' })), /contract or receiver/);
    await assert.rejects(signer.createPartiallySignedTransferTransaction(req({ asset: '0.0.123' })), /contract or receiver/);
    await assert.rejects(signer.createPartiallySignedTransferTransaction(req({ amount: '200000' })), /above the signer limit/);
    await assert.rejects(signer.createPartiallySignedTransferTransaction(req({ asset: '0.0.0', amount: '20000000' })), /above the signer limit/);
  });

  it('GET_INFO v2 carries the compressed public key', () => {
    const info = decodeFrame(Buffer.from(host(encodeFrame(0x01)).reply!, 'hex'));
    assert.equal(infoPublicKey(info.payload)?.toString('hex'), HEDERA_PUB);
  });
});

describe('signer hub queue', () => {
  it('holds a request until the pod asks, and serves requests one at a time', async () => {
    const hub = new SignerHub(1000);
    hub.nextRequest().cancel();  // the pod asked for work a moment ago
    const a = hub.sign(Buffer.from('a'));
    const b = hub.sign(Buffer.from('b'));
    const first = await hub.nextRequest().promise;
    assert.equal(first.frame.toString(), 'a');
    const second = hub.nextRequest();
    let gotSecond = false;
    void second.promise.then(() => (gotSecond = true));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(gotSecond, false, 'b waits until a is answered');
    hub.deliver(first.id, Buffer.from('A'));
    assert.equal((await a).toString(), 'A');
    const req2 = await second.promise;
    hub.deliver(req2.id, Buffer.from('B'));
    assert.equal((await b).toString(), 'B');
  });

  it('times out when no pod picks the request up', async () => {
    const hub = new SignerHub(20);
    await assert.rejects(hub.sign(Buffer.from('x')), /no pod is connected/, 'never seen: fails at once');
    hub.nextRequest().cancel();
    await assert.rejects(hub.sign(Buffer.from('x')), /no pod picked up/);
  });
});
