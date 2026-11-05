import { createHash } from 'node:crypto';

/**
 * Uniswap Trading API spot leg (track: "Build with Uniswap").
 * Use: wallet tokens → USDC before funding the perp account, or USDC → PAXG as a safe-haven spot leg.
 * Base URL: https://trade-api.gateway.uniswap.org/v1   Header: x-api-key: UNISWAP_API_KEY
 * Flow: POST /check_approval → POST /quote → POST /swap → sign + send the returned tx with viem.
 * Testnets: Base Sepolia 84532 (Universal Router 0x8702463e73f74d0b6765aBceb314Ef07aCb92650),
 *           Unichain Sepolia 1301, Ethereum Sepolia 11155111. Liquidity is thin: pre-test the pair.
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
  quoteId: string;
  txHash: `0x${string}`;
  status: 'simulated' | 'submitted';
}

/** Stub: deterministic fake tx hash derived from the request; no network calls. */
export async function quoteAndSwap(req: SwapRequest): Promise<SwapResult> {
  const digest = createHash('sha256').update(JSON.stringify(req)).digest('hex');
  return { quoteId: `fake-quote-${digest.slice(0, 12)}`, txHash: `0x${digest}`, status: 'simulated' };
}

// TODO(uniswap): real implementation. Keep it in this file so FEEDBACK.md / README can point at exact lines.
// const headers = { 'x-api-key': UNISWAP_API_KEY, 'content-type': 'application/json' };
// 1. POST `${UNISWAP_TRADING_API}/check_approval` { walletAddress, token: tokenIn, amount, chainId }
//      → if approval tx returned, sign + send it with viem and wait for receipt.
// 2. POST `${UNISWAP_TRADING_API}/quote` { type: 'EXACT_INPUT', amount, tokenIn, tokenOut,
//      tokenInChainId: chainId, tokenOutChainId: chainId, swapper: walletAddress }
// 3. POST `${UNISWAP_TRADING_API}/swap` { quote: quoteResponse.quote }  → { swap: { to, data, value, ... } }
// 4. walletClient.sendTransaction(swap) → txHash; wait for receipt.
