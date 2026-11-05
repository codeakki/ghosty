import { createPublicClient, createWalletClient, defineChain, http, type Chain, type PublicClient, type WalletClient } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { base, baseSepolia, mainnet, sepolia, unichain, unichainSepolia } from 'viem/chains';
import type { Config } from '../config.js';

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

export const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

const KNOWN_CHAINS: Chain[] = [baseSepolia, unichainSepolia, sepolia, base, unichain, mainnet];

export interface AgentAccount {
  address: Address;
  /** True when EVM_PRIVATE_KEY is a valid key and the address was derived from it. */
  canSign: boolean;
  chainId: number;
}

/** Accepts 64 hex chars with or without 0x. Returns undefined for anything else. */
export function normalizePrivateKey(key: string | undefined): Hex | undefined {
  if (!key) return undefined;
  const k = key.trim();
  const withPrefix = k.startsWith('0x') ? k : `0x${k}`;
  return /^0x[0-9a-fA-F]{64}$/.test(withPrefix) ? (withPrefix as Hex) : undefined;
}

export function isAddress(value: string | undefined): value is Address {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

/**
 * Chain for EVM_CHAIN_ID (default Base Sepolia 84532). Unknown ids get a minimal chain that needs EVM_RPC_URL.
 */
export function chainFor(chainId: number, rpcUrl?: string): Chain {
  const known = KNOWN_CHAINS.find((c) => c.id === chainId);
  if (known) return known;
  if (!rpcUrl) throw new Error(`EVM_CHAIN_ID ${chainId} is not built in; set EVM_RPC_URL`);
  return defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

/** Block explorer link for a tx hash, or undefined when the chain has no explorer configured. */
export function explorerTxUrl(chain: Chain, hash: string): string | undefined {
  const explorer = chain.blockExplorers?.default.url;
  return explorer ? `${explorer.replace(/\/$/, '')}/tx/${hash}` : undefined;
}

/** Address + signing ability, without creating clients. Safe to call with no keys. */
export function getAgentAccount(
  config: Pick<Config, 'EVM_ADDRESS' | 'EVM_PRIVATE_KEY' | 'EVM_CHAIN_ID'>,
): AgentAccount {
  const key = normalizePrivateKey(config.EVM_PRIVATE_KEY);
  if (key) return { address: privateKeyToAccount(key).address, canSign: true, chainId: config.EVM_CHAIN_ID };
  const address = isAddress(config.EVM_ADDRESS) ? config.EVM_ADDRESS : ZERO_ADDRESS;
  return { address, canSign: false, chainId: config.EVM_CHAIN_ID };
}

export interface EvmClients {
  account: PrivateKeyAccount;
  chain: Chain;
  walletClient: WalletClient;
  publicClient: PublicClient;
}

/** viem wallet + public client for EVM_PRIVATE_KEY on EVM_CHAIN_ID via EVM_RPC_URL (or the chain's public RPC). */
export function createEvmClients(
  config: Pick<Config, 'EVM_PRIVATE_KEY' | 'EVM_CHAIN_ID' | 'EVM_RPC_URL'>,
): EvmClients | undefined {
  const key = normalizePrivateKey(config.EVM_PRIVATE_KEY);
  if (!key) return undefined;
  const account = privateKeyToAccount(key);
  const chain = chainFor(config.EVM_CHAIN_ID, config.EVM_RPC_URL);
  const transport = http(config.EVM_RPC_URL);
  return {
    account,
    chain,
    walletClient: createWalletClient({ account, chain, transport }),
    publicClient: createPublicClient({ chain, transport }),
  };
}
