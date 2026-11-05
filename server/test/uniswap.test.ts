import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { baseSepolia } from 'viem/chains';
import { loadConfig } from '../src/config.js';
import { chainFor, explorerTxUrl, getAgentAccount, normalizePrivateKey, ZERO_ADDRESS } from '../src/wallet/account.js';
import {
  createSpotLeg,
  FakeSpotLeg,
  primaryTypeOf,
  UniswapApiError,
  UniswapSpotLeg,
  type SendTxArgs,
  type SignTypedDataArgs,
} from '../src/wallet/uniswap.js';

// Hardhat / anvil account #0. Public test key, never funded on a real network.
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const ROUTER = '0x8702463e73f74d0b6765aBceb314Ef07aCb92650';

const approvalTx = { to: WETH, from: TEST_ADDRESS, data: '0x095ea7b3' + '00'.repeat(64), value: '0', chainId: 84532 };
const swapTx = { to: ROUTER, from: TEST_ADDRESS, data: '0x3593564c' + '11'.repeat(32), value: '0x0', chainId: 84532, gasLimit: '210000' };
const permitData = {
  domain: { name: 'Permit2', chainId: 84532, verifyingContract: PERMIT2 },
  types: {
    PermitSingle: [
      { name: 'details', type: 'PermitDetails' },
      { name: 'spender', type: 'address' },
      { name: 'sigDeadline', type: 'uint256' },
    ],
    PermitDetails: [
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
      { name: 'nonce', type: 'uint48' },
    ],
  },
  values: {
    details: { token: WETH, amount: '1000', expiration: '1762500000', nonce: '0' },
    spender: ROUTER,
    sigDeadline: '1762400000',
  },
};
const classicQuote = { quoteId: 'q-123', routeString: '[V3] 100.00% = WETH -- 0.05% [0xpool] --> USDC', output: { amount: '263000' } };

interface Call {
  path: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function mockApi(responses: Record<string, unknown | { status: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname.replace('/v1', '');
    calls.push({ path, body: JSON.parse(String(init?.body)), headers: init?.headers as Record<string, string> });
    const r = responses[path];
    const { status, body } =
      r && typeof r === 'object' && 'status' in r ? (r as { status: number; body: unknown }) : { status: 200, body: r };
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetchFn, calls };
}

function mockWallet(receiptStatus: 'success' | 'reverted' = 'success') {
  const sent: SendTxArgs[] = [];
  const signed: SignTypedDataArgs[] = [];
  const waited: string[] = [];
  let n = 0;
  return {
    sent,
    signed,
    waited,
    walletClient: {
      async sendTransaction(args: SendTxArgs) {
        sent.push(args);
        return `0x${String(++n).padStart(64, '0')}` as const;
      },
      async signTypedData(args: SignTypedDataArgs) {
        signed.push(args);
        return `0x${'5'.repeat(130)}` as const;
      },
    },
    publicClient: {
      async waitForTransactionReceipt({ hash }: { hash: `0x${string}` }) {
        waited.push(hash);
        return { status: receiptStatus };
      },
    },
  };
}

function leg(api: ReturnType<typeof mockApi>, wallet: ReturnType<typeof mockWallet>) {
  return new UniswapSpotLeg({
    apiKey: 'test-key',
    swapper: TEST_ADDRESS,
    chainId: 84532,
    walletClient: wallet.walletClient,
    publicClient: wallet.publicClient,
    explorerTxUrl: (h) => explorerTxUrl(baseSepolia, h),
    fetch: api.fetchFn,
  });
}

const req = { tokenIn: WETH, tokenOut: USDC, amount: '100000000000000', chainId: 84532 };

describe('UniswapSpotLeg', () => {
  it('approval path: approve → quote → sign permit → swap → send, in that order', async () => {
    const api = mockApi({
      '/check_approval': { requestId: 'a', approval: approvalTx, cancel: null },
      '/quote': { requestId: 'r', routing: 'CLASSIC', quote: classicQuote, permitData },
      '/swap': { requestId: 's', swap: swapTx },
    });
    const wallet = mockWallet();
    const res = await leg(api, wallet).quoteAndSwap(req);

    assert.deepEqual(
      api.calls.map((c) => c.path),
      ['/check_approval', '/quote', '/swap'],
    );
    assert.ok(api.calls.every((c) => c.headers['x-api-key'] === 'test-key'));
    assert.deepEqual(api.calls[0]?.body, {
      walletAddress: TEST_ADDRESS,
      token: WETH,
      amount: req.amount,
      chainId: 84532,
      tokenOut: USDC,
      tokenOutChainId: 84532,
    });
    assert.deepEqual(api.calls[1]?.body, {
      type: 'EXACT_INPUT',
      amount: req.amount,
      tokenIn: WETH,
      tokenOut: USDC,
      tokenInChainId: 84532,
      tokenOutChainId: 84532,
      swapper: TEST_ADDRESS,
      slippageTolerance: 0.5,
      routingPreference: 'BEST_PRICE',
      protocols: ['V2', 'V3', 'V4'],
    });

    // Approval tx sent and mined before the quote; swap tx last.
    assert.equal(wallet.sent.length, 2);
    assert.deepEqual(wallet.sent[0], { to: WETH, data: approvalTx.data, value: 0n });
    assert.deepEqual(wallet.sent[1], { to: ROUTER, data: swapTx.data, value: 0n, gas: 210000n });
    assert.equal(wallet.waited.length, 2);

    // Permit2 signature goes to /swap together with permitData.
    assert.equal(wallet.signed[0]?.primaryType, 'PermitSingle');
    assert.deepEqual(wallet.signed[0]?.message, permitData.values);
    assert.deepEqual(api.calls[2]?.body, { quote: classicQuote, signature: `0x${'5'.repeat(130)}`, permitData });

    assert.equal(res.status, 'confirmed');
    assert.equal(res.txHash, `0x${'2'.padStart(64, '0')}`);
    assert.deepEqual(res.approvalTxHashes, [`0x${'1'.padStart(64, '0')}`]);
    assert.equal(res.explorerUrl, `https://sepolia.basescan.org/tx/${res.txHash}`);
    assert.equal(res.route, classicQuote.routeString);
    assert.equal(res.quoteId, 'q-123');
    assert.equal(res.amountOut, '263000');
  });

  it('no-approval path: no approval tx, no permit, /swap gets only the quote', async () => {
    const api = mockApi({
      '/check_approval': { requestId: 'a', approval: null, cancel: null },
      '/quote': { requestId: 'r', routing: 'CLASSIC', quote: classicQuote, permitData: null },
      '/swap': { requestId: 's', swap: swapTx },
    });
    const wallet = mockWallet();
    const res = await leg(api, wallet).quoteAndSwap(req);
    assert.equal(wallet.sent.length, 1);
    assert.equal(wallet.signed.length, 0);
    assert.deepEqual(api.calls[2]?.body, { quote: classicQuote });
    assert.deepEqual(res.approvalTxHashes, []);
    assert.equal(res.txHash, `0x${'1'.padStart(64, '0')}`);
  });

  it('sends the revoke (cancel) tx before the approval when the API asks for both', async () => {
    const cancelTx = { ...approvalTx, data: '0x095ea7b3' + 'ff'.repeat(64) };
    const api = mockApi({
      '/check_approval': { approval: approvalTx, cancel: cancelTx },
      '/quote': { routing: 'CLASSIC', quote: classicQuote, permitData: null },
      '/swap': { swap: swapTx },
    });
    const wallet = mockWallet();
    await leg(api, wallet).quoteAndSwap(req);
    assert.deepEqual(
      wallet.sent.map((t) => t.data),
      [cancelTx.data, approvalTx.data, swapTx.data],
    );
  });

  it('surfaces API errors with path and status', async () => {
    const api = mockApi({
      '/check_approval': { approval: null, cancel: null },
      '/quote': { status: 404, body: { errorCode: 'NoRouteFoundError', detail: 'No quotes available' } },
    });
    const err = await leg(api, mockWallet())
      .quoteAndSwap(req)
      .catch((e: unknown) => e);
    assert.ok(err instanceof UniswapApiError);
    assert.equal(err.path, '/quote');
    assert.equal(err.status, 404);
    assert.match(err.message, /NoRouteFoundError/);
  });

  it('rejects UniswapX routings, empty calldata, wrong chain and reverted swaps', async () => {
    const base = { '/check_approval': { approval: null, cancel: null } };
    const dutch = mockApi({ ...base, '/quote': { routing: 'DUTCH_V2', quote: {}, permitData: null } });
    await assert.rejects(leg(dutch, mockWallet()).quoteAndSwap(req), /unsupported routing DUTCH_V2/);

    const ok = { '/quote': { routing: 'CLASSIC', quote: classicQuote, permitData: null } };
    const empty = mockApi({ ...base, ...ok, '/swap': { swap: { ...swapTx, data: '0x' } } });
    await assert.rejects(leg(empty, mockWallet()).quoteAndSwap(req), /empty calldata/);

    const wrongChain = mockApi({ ...base, ...ok, '/swap': { swap: { ...swapTx, chainId: 1 } } });
    await assert.rejects(leg(wrongChain, mockWallet()).quoteAndSwap(req), /chain 1/);

    const reverted = mockApi({ ...base, ...ok, '/swap': { swap: swapTx } });
    await assert.rejects(leg(reverted, mockWallet('reverted')).quoteAndSwap(req), /reverted/);

    await assert.rejects(leg(reverted, mockWallet()).quoteAndSwap({ ...req, chainId: 1 }), /wallet is on 84532/);
  });

  it('infers the EIP-712 primary type', () => {
    assert.equal(primaryTypeOf(permitData.types), 'PermitSingle');
    assert.equal(
      primaryTypeOf({
        EIP712Domain: [{ type: 'string' }],
        PermitBatch: [{ type: 'PermitDetails[]' }],
        PermitDetails: [{ type: 'address' }],
      }),
      'PermitBatch',
    );
  });
});

describe('createSpotLeg', () => {
  it('fake without keys, real with UNISWAP_API_KEY + EVM_PRIVATE_KEY', () => {
    assert.ok(createSpotLeg(loadConfig({})) instanceof FakeSpotLeg);
    assert.ok(createSpotLeg(loadConfig({ UNISWAP_API_KEY: 'k' })) instanceof FakeSpotLeg);
    assert.ok(createSpotLeg(loadConfig({ UNISWAP_API_KEY: 'k', EVM_PRIVATE_KEY: TEST_KEY })) instanceof UniswapSpotLeg);
  });
});

describe('agent account', () => {
  it('derives the address from EVM_PRIVATE_KEY', () => {
    const acct = getAgentAccount(loadConfig({ EVM_PRIVATE_KEY: TEST_KEY.slice(2), EVM_ADDRESS: '0x' + '9'.repeat(40) }));
    assert.equal(acct.address, TEST_ADDRESS);
    assert.equal(acct.canSign, true);
    assert.equal(acct.chainId, 84532);
  });

  it('falls back to EVM_ADDRESS (watch-only) or the zero address', () => {
    assert.deepEqual(getAgentAccount(loadConfig({ EVM_ADDRESS: '0x' + '9'.repeat(40) })), {
      address: '0x' + '9'.repeat(40),
      canSign: false,
      chainId: 84532,
    });
    assert.equal(getAgentAccount(loadConfig({ EVM_PRIVATE_KEY: 'nope' })).address, ZERO_ADDRESS);
    assert.equal(normalizePrivateKey('0x1234'), undefined);
  });

  it('resolves chains and explorer links', () => {
    assert.equal(chainFor(84532).id, 84532);
    assert.equal(loadConfig({ EVM_CHAIN_ID: '1301' }).EVM_CHAIN_ID, 1301);
    assert.throws(() => chainFor(999999), /EVM_RPC_URL/);
    assert.equal(chainFor(999999, 'http://localhost:8545').id, 999999);
    assert.equal(explorerTxUrl(chainFor(999999, 'http://localhost:8545'), '0xabc'), undefined);
  });
});
