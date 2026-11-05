/**
 * Private, user-owned memory. Target: an AES-256 encrypted blob on 0G Storage (0G Physical AI track).
 */

export type RiskProfile = 'conservative' | 'balanced' | 'aggressive';

export interface HistoryEntry {
  at: string;
  requestId: string;
  signal: string;
  outcome: string;
}

export interface UserMemory {
  /** Free-form preferences: watchlist, voice, quiet hours, etc. */
  preferences: Record<string, string | string[]>;
  riskProfile: RiskProfile;
  /** Most recent last. */
  history: HistoryEntry[];
}

export interface MemoryStore {
  load(userId: string): Promise<UserMemory>;
  save(userId: string, memory: UserMemory): Promise<void>;
}

export function defaultMemory(): UserMemory {
  return {
    preferences: { watchlist: ['BTC', 'ETH', 'xyz:GOLD', 'xyz:WTI'], voice: 'calm' },
    riskProfile: 'balanced',
    history: [],
  };
}

const MAX_HISTORY = 200;

export class InMemoryMemoryStore implements MemoryStore {
  private readonly data = new Map<string, UserMemory>();

  async load(userId: string): Promise<UserMemory> {
    const existing = this.data.get(userId);
    return structuredClone(existing ?? defaultMemory());
  }

  async save(userId: string, memory: UserMemory): Promise<void> {
    const trimmed = { ...memory, history: memory.history.slice(-MAX_HISTORY) };
    this.data.set(userId, structuredClone(trimmed));
  }
}

// TODO(0g): ZeroGMemoryStore backed by 0G Storage with built-in encryption.
// Package: @0gfoundation/0g-storage-ts-sdk (peer: ethers). NOT @0glabs/0g-ts-sdk. Not installed yet.
// Indexer: OG_INDEXER_URL (https://indexer-storage-testnet-turbo.0g.ai), RPC https://evmrpc-testnet.0g.ai (chain 16602).
// Signer: new ethers.Wallet(OG_PRIVATE_KEY, new ethers.JsonRpcProvider(RPC)).
// save(): serialize JSON → ZgFile → file.merkleTree() → indexer.upload(file, RPC, signer, { encryption: { type: 'aes256', key } })
//         keep the returned rootHash as the pointer (locally, or later in the agent's iNFT / ERC-7857 metadata).
// load(): indexer.downloadToBlob(rootHash, { decryption key }) → JSON. Wrong key silently returns ciphertext,
//         so validate the JSON shape and fall back to defaultMemory() on failure.
