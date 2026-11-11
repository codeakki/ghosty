import type { OrderResult } from './hyperliquid.js';
import type { SpotLeg } from '../wallet/uniswap.js';

/**
 * Spoken buys on Uniswap (Base), paid in USDC: "buy five dollars of Apple on Uniswap", "buy ten dollars of ETH on Uniswap". Paid in USDC from the swap wallet
 * (the Dabao's address). The Dabao signs the one-time USDC approval to Permit2, Uniswap's 30-day Permit2 permit,
 * and every swap transaction. Buys only for now.
 */

export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

/**
 * Coinbase tokenized stocks on Base (api.coinbase.com/v1/tokenized-stocks, 8 decimals) with a Uniswap route from
 * USDC whose price matched the Chainlink feed within 1% on 2026-11-07.
 */
const stock = (address: string, label: string) => ({ address, label, decimals: 8, unit: `${label} shares` });
export const SPOT_ASSETS = {
  AAPL: stock('0xb200000000000000000000C2e324d24d7eEcd1fb', 'Apple'),
  NVDA: stock('0xb20000000000000000000078ee7ce2fE4908108C', 'Nvidia'),
  TSLA: stock('0xb2000000000000000000001e800a7f5189430cD0', 'Tesla'),
  MSFT: stock('0xB200000000000000000000Ab99cFa739E253872B', 'Microsoft'),
  AMZN: stock('0xb200000000000000000000d9192b6B456483C2E8', 'Amazon'),
  GOOGL: stock('0xb2000000000000000000002D0BA3164cc74f58B7', 'Alphabet'),
  META: stock('0xb2000000000000000000008bC8786B856E61707C', 'Meta'),
  MSTR: stock('0xb2000000000000000000004884b426556b92883d', 'Strategy'),
  SNDK: stock('0xb200000000000000000000397293Cb8cda9a10c5', 'Sandisk'),
  SPCX: stock('0xb2000000000000000000007b9fcbd005511aCBd5', 'SpaceX'),
  /** Native ETH (the router unwraps WETH to the wallet). */
  ETH: { address: '0x0000000000000000000000000000000000000000', label: 'ether', decimals: 18, unit: 'ETH' },
  /** Coinbase Wrapped BTC on Base. */
  BTC: { address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', label: 'bitcoin', decimals: 8, unit: 'bitcoin (cbBTC)' },
} as const;

export type SpotAsset = keyof typeof SPOT_ASSETS;

/** Server-side cap on Uniswap stock buys per UTC day (the owner's limit). */
export const SPOT_DAILY_LIMIT_USD = 100;
export const SPOT_MIN_USD = 1;

export class SpotDailyBudget {
  private day = '';
  private spent = 0;

  constructor(
    readonly limitUsd = SPOT_DAILY_LIMIT_USD,
    private readonly now: () => Date = () => new Date(),
  ) {}

  remaining(): number {
    this.roll();
    return this.limitUsd - this.spent;
  }

  record(usd: number): void {
    this.roll();
    this.spent += usd;
  }

  private roll(): void {
    const today = this.now().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.spent = 0;
    }
  }
}

export interface SpotOrderDeps {
  spot: SpotLeg;
  chainId: number;
  budget: SpotDailyBudget;
}

const fmt = (n: number) => (n >= 1 ? n.toFixed(2) : n.toPrecision(3)).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

/** Buy `usd` dollars of `asset` with USDC. Returns the spoken reply and a journal entry (the swap tx hash is its id). */
export async function executeSpotBuy(asset: SpotAsset, usd: number, deps: SpotOrderDeps): Promise<{ reply: string; result?: OrderResult }> {
  const t = SPOT_ASSETS[asset];
  if (usd < SPOT_MIN_USD) return { reply: `The smallest Uniswap buy is ${SPOT_MIN_USD} dollar.` };
  const left = deps.budget.remaining();
  if (usd > left) return { reply: `That is above today's Uniswap limit. ${Math.max(0, Math.floor(left))} dollars are left of ${deps.budget.limitUsd}.` };
  const base: OrderResult = { orderId: '', coin: `uniswap:${asset}`, isBuy: true, sizeUsd: usd, status: 'rejected' };
  // Count it before the swap: a signed swap can land even if this process does not see the receipt.
  deps.budget.record(usd);
  try {
    const micros = BigInt(Math.round(usd * 1e6));
    const swap = await deps.spot.quoteAndSwap({ tokenIn: USDC_BASE, tokenOut: t.address, amount: micros.toString(), chainId: deps.chainId });
    const shares = swap.amountOut ? Number(swap.amountOut) / 10 ** t.decimals : undefined;
    const result: OrderResult = {
      ...base,
      orderId: swap.txHash,
      status: 'filled',
      txHash: swap.txHash,
      url: swap.explorerUrl,
      ...(shares !== undefined ? { filled: shares, avgPx: Number((usd / shares).toFixed(2)) } : {}),
    };
    const what = shares !== undefined ? `${fmt(shares)} ${t.unit}` : t.unit;
    return { reply: `Done. I bought ${what} for ${fmt(usd)} dollars of USDC on Uniswap.`, result };
  } catch (err) {
    const msg = (err as Error).message;
    return { reply: `The Uniswap buy of ${t.label} failed. ${msg}`, result: { ...base, error: msg } };
  }
}
