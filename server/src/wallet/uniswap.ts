import { createHash } from 'node:crypto';
import type { Config } from '../config.js';
import { isTestMode } from '../mode.js';
import { missingKeys, NotConfiguredSpotLeg } from '../notConfigured.js';
import { createEvmClients, explorerTxUrl, isAddress, type Address, type Hex } from './account.js';

/**
 * Uniswap Trading API spot leg (track: "Build with Uniswap").
 * Flow: POST /check_approval → (approve tx) → POST /quote → (sign permit2) → POST /swap → sign + send with viem.
 * Docs: https://developers.uniswap.org/docs/trading/swapping-api/start-building/integration-guide
 * OpenAPI: https://trade-api.gateway.uniswap.org/v1/api.json
 * Testnets reachable through the API: Base Sepolia 84532, Unichain Sepolia 1301, Ethereum Sepolia 11155111.
 */

export const UNISWAP_TRADING_API = 'https://trade-api.gateway.uniswap.org/v1';

export interface SwapRequest {
  tokenIn: string;
  tokenOut: string;
  /** Amount of tokenIn in base units (wei-style string). */
  amount: string;
  chainId: number;
}

export interface SwapResult {
  /** Trading API quote id (or a fake id for the stub). */
  quoteId: string;
  txHash: Hex;
  status: 'simulated' | 'confirmed';
  explorerUrl?: string;
  /** Route summary, e.g. the quote's routeString, or the routing type. */
  route?: string;
  /** Approval (and optional revoke) tx hashes sent before the swap. */
  approvalTxHashes?: Hex[];
  amountOut?: string;
}

export interface SpotLeg {
  quoteAndSwap(req: SwapRequest): Promise<SwapResult>;
}

/** Stub: deterministic fake tx hash derived from the request; no network calls. */
export class FakeSpotLeg implements SpotLeg {
  async quoteAndSwap(req: SwapRequest): Promise<SwapResult> {
    const digest = createHash('sha256').update(JSON.stringify(req)).digest('hex');
    return { quoteId: `fake-quote-${digest.slice(0, 12)}`, txHash: `0x${digest}`, status: 'simulated', route: 'fake' };
  }
}

// ---------------------------------------------------------------------------
// Trading API shapes (only the fields we read). Source: v1/api.json, fetched 2026-11-06.

/** TransactionRequest from /check_approval and /swap. Numbers are decimal or hex strings. */
export interface ApiTransaction {
  to: string;
  from?: string;
  data: string;
  value?: string;
  chainId?: number;
  gasLimit?: string;
}

interface ApprovalResponse {
  requestId?: string;
  approval: ApiTransaction | null;
  /** Some tokens need the old allowance revoked first; the API returns both. */
  cancel: ApiTransaction | null;
}

interface PermitData {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  values: Record<string, unknown>;
}

interface QuoteResponse {
  requestId?: string;
  routing: string;
  quote: { quoteId?: string; routeString?: string; output?: { amount?: string } } & Record<string, unknown>;
  permitData: PermitData | null;
}

interface SwapResponse {
  requestId?: string;
  swap: ApiTransaction;
}

/** Routings we can execute with /swap (gasful). UniswapX routings (/order) are excluded by `protocols`. */
const SWAP_ROUTINGS = new Set(['CLASSIC', 'WRAP', 'UNWRAP']);

// ---------------------------------------------------------------------------
// Minimal structural views of viem clients, so tests can pass mocks.

export interface SendTxArgs {
  to: Address;
  data: Hex;
  value: bigint;
  gas?: bigint;
}

export interface SignTypedDataArgs {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface SpotWalletClient {
  sendTransaction(args: SendTxArgs): Promise<Hex>;
  signTypedData(args: SignTypedDataArgs): Promise<Hex>;
}

export interface SpotPublicClient {
  waitForTransactionReceipt(args: { hash: Hex }): Promise<{ status: 'success' | 'reverted' }>;
}

export interface UniswapSpotLegOptions {
  apiKey: string;
  baseUrl?: string;
  swapper: Address;
  chainId: number;
  walletClient: SpotWalletClient;
  publicClient: SpotPublicClient;
  /** Slippage in percent (0.5 = 0.5%). */
  slippagePct?: number;
  explorerTxUrl?: (hash: Hex) => string | undefined;
  fetch?: typeof fetch;
}

export class UniswapApiError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`Uniswap Trading API ${path} → ${status}: ${body.slice(0, 500)}`);
    this.name = 'UniswapApiError';
  }
}

/** The struct the permit is about: the one type no other type references. Permit2 uses PermitSingle / PermitBatch. */
export function primaryTypeOf(types: Record<string, Array<{ type: string }>>): string {
  const names = Object.keys(types).filter((n) => n !== 'EIP712Domain');
  const referenced = new Set(names.flatMap((n) => (types[n] ?? []).map((f) => f.type.replace(/\[\]$/, ''))));
  const roots = names.filter((n) => !referenced.has(n));
  if (roots.length !== 1) throw new Error(`cannot infer EIP-712 primaryType from ${names.join(', ')}`);
  return roots[0] as string;
}

function toSendArgs(tx: ApiTransaction, expectChainId: number): SendTxArgs {
  if (!isAddress(tx.to)) throw new Error(`Trading API returned an invalid 'to': ${tx.to}`);
  // Docs: never broadcast a tx with empty calldata.
  if (!tx.data || tx.data === '0x' || !/^0x[0-9a-fA-F]+$/.test(tx.data)) throw new Error('Trading API returned empty calldata');
  if (tx.chainId !== undefined && tx.chainId !== expectChainId) {
    throw new Error(`Trading API tx is for chain ${tx.chainId}, wallet is on ${expectChainId}`);
  }
  return {
    to: tx.to,
    data: tx.data as Hex,
    value: tx.value ? BigInt(tx.value) : 0n,
    ...(tx.gasLimit ? { gas: BigInt(tx.gasLimit) } : {}),
  };
}

/**
 * Real spot leg through the Uniswap Trading API, signed with a viem wallet.
 * Restricts routing to AMM pools (V2/V3/V4) so the result is always a gasful /swap tx with a hash we can show.
 */
export class UniswapSpotLeg implements SpotLeg {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: UniswapSpotLegOptions) {
    this.baseUrl = (opts.baseUrl ?? UNISWAP_TRADING_API).replace(/\/$/, '');
    this.fetchFn = opts.fetch ?? fetch;
  }

  async quoteAndSwap(req: SwapRequest): Promise<SwapResult> {
    if (req.chainId !== this.opts.chainId) {
      throw new Error(`swap requested on chain ${req.chainId} but the wallet is on ${this.opts.chainId}`);
    }
    const { swapper } = this.opts;

    // 1. Approval (token → Permit2). Only returned when needed.
    const approval = await this.post<ApprovalResponse>('/check_approval', {
      walletAddress: swapper,
      token: req.tokenIn,
      amount: req.amount,
      chainId: req.chainId,
      tokenOut: req.tokenOut,
      tokenOutChainId: req.chainId,
    });
    const approvalTxHashes: Hex[] = [];
    for (const tx of [approval.cancel, approval.approval]) {
      if (tx) approvalTxHashes.push(await this.sendAndWait(tx, req.chainId));
    }

    // 2. Quote. AMM only: UniswapX is not on testnets and would need /order instead of /swap.
    const quote = await this.post<QuoteResponse>('/quote', {
      type: 'EXACT_INPUT',
      amount: req.amount,
      tokenIn: req.tokenIn,
      tokenOut: req.tokenOut,
      tokenInChainId: req.chainId,
      tokenOutChainId: req.chainId,
      swapper,
      slippageTolerance: this.opts.slippagePct ?? 0.5,
      routingPreference: 'BEST_PRICE',
      protocols: ['V2', 'V3', 'V4'],
    });
    if (!SWAP_ROUTINGS.has(quote.routing)) {
      throw new Error(`unsupported routing ${quote.routing} (expected CLASSIC/WRAP/UNWRAP)`);
    }

    // 3. Permit2 signature when the quote asks for one. /swap needs both signature and permitData, or neither.
    let permit: { signature: Hex; permitData: PermitData } | undefined;
    if (quote.permitData) {
      const { domain, types, values } = quote.permitData;
      const signature = await this.opts.walletClient.signTypedData({
        domain,
        types,
        primaryType: primaryTypeOf(types),
        message: values,
      });
      permit = { signature, permitData: quote.permitData };
    }

    // 4. Unsigned swap tx → sign + send → wait.
    const { swap } = await this.post<SwapResponse>('/swap', { quote: quote.quote, ...permit });
    const txHash = await this.sendAndWait(swap, req.chainId);

    return {
      quoteId: quote.quote.quoteId ?? quote.requestId ?? 'unknown',
      txHash,
      status: 'confirmed',
      explorerUrl: this.opts.explorerTxUrl?.(txHash),
      route: quote.quote.routeString ?? quote.routing,
      approvalTxHashes,
      amountOut: quote.quote.output?.amount,
    };
  }

  private async sendAndWait(tx: ApiTransaction, chainId: number): Promise<Hex> {
    const hash = await this.opts.walletClient.sendTransaction(toSendArgs(tx, chainId));
    const receipt = await this.opts.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`transaction ${hash} reverted`);
    return hash;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'x-api-key': this.opts.apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new UniswapApiError(path, res.status, text);
    return JSON.parse(text) as T;
  }
}

/** Real leg when UNISWAP_API_KEY and EVM_PRIVATE_KEY are set, else the fake (test mode) or NotConfiguredSpotLeg (live). */
export function createSpotLeg(
  config: Pick<
    Config,
    'UNISWAP_API_KEY' | 'UNISWAP_API_URL' | 'UNISWAP_SLIPPAGE_PCT' | 'EVM_PRIVATE_KEY' | 'EVM_CHAIN_ID' | 'EVM_RPC_URL'
  > &
    Partial<Pick<Config, 'GHOSTY_MODE'>>,
): SpotLeg {
  const clients = config.UNISWAP_API_KEY ? createEvmClients(config) : undefined;
  if (!config.UNISWAP_API_KEY || !clients) {
    if (isTestMode(config)) return new FakeSpotLeg();
    const missing = missingKeys(config, ['UNISWAP_API_KEY', 'EVM_PRIVATE_KEY']);
    return new NotConfiguredSpotLeg(missing.length > 0 ? missing : ['EVM_PRIVATE_KEY']);
  }
  const { account, chain, walletClient, publicClient } = clients;
  return new UniswapSpotLeg({
    apiKey: config.UNISWAP_API_KEY,
    baseUrl: config.UNISWAP_API_URL,
    swapper: account.address,
    chainId: chain.id,
    slippagePct: config.UNISWAP_SLIPPAGE_PCT,
    explorerTxUrl: (hash) => explorerTxUrl(chain, hash),
    walletClient: {
      sendTransaction: (args) => walletClient.sendTransaction({ ...args, account, chain }),
      signTypedData: (args) => walletClient.signTypedData({ ...args, account } as Parameters<typeof walletClient.signTypedData>[0]),
    },
    publicClient: { waitForTransactionReceipt: (args) => publicClient.waitForTransactionReceipt(args) },
  });
}
