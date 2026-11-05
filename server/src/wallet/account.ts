import type { Config } from '../config.js';

export type Address = `0x${string}`;

export const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

export interface AgentAccount {
  address: Address;
  /** True once a private key is configured. The stub never signs. */
  canSign: boolean;
}

/** Stub: address from EVM_ADDRESS (or zero address); no key derivation yet. */
export function getAgentAccount(config: Pick<Config, 'EVM_ADDRESS' | 'EVM_PRIVATE_KEY'>): AgentAccount {
  const address = config.EVM_ADDRESS && /^0x[0-9a-fA-F]{40}$/.test(config.EVM_ADDRESS) ? (config.EVM_ADDRESS as Address) : ZERO_ADDRESS;
  return { address, canSign: Boolean(config.EVM_PRIVATE_KEY) };
}

// TODO(wallet): real account via viem (not installed yet).
// import { privateKeyToAccount } from 'viem/accounts';
// import { createWalletClient, http } from 'viem';
// import { baseSepolia } from 'viem/chains';
// const account = privateKeyToAccount(EVM_PRIVATE_KEY as Address);
// const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(EVM_RPC_URL) });
// Then drop EVM_ADDRESS from .env: the address comes from the key.
