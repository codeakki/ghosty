import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { decryptJson, encryptJson } from './crypto.js';
import { errorMessage, noopLogger, type Logger } from './log.js';
import { updateZeroGState } from './status.js';
import { DEFAULT_DATA_DIR, ensureDataDir, SerialQueue, type BlobStore, type StoredBlob } from './storage.js';

/**
 * Private, user-owned memory: an AES-256-GCM encrypted blob on 0G Storage (0G Physical AI track).
 */

export type RiskProfile = 'conservative' | 'balanced' | 'aggressive';

export interface HistoryEntry {
  at: string;
  requestId: string;
  signal: string;
  outcome: string;
}

/** One order a voice turn sent to the venue, as remembered. */
export interface JournalOrder {
  coin: string;
  side: 'buy' | 'sell';
  sizeUsd: number;
  status: string;
  orderId?: string;
  avgPx?: number;
  filled?: number;
  /** Hyperliquid transaction hash of the fill, when it could be looked up. */
  txHash?: string;
  error?: string;
}

/** One thing the wearer said, what Ghosty answered, any orders, and the news at that moment. Most recent last. */
export interface JournalEntry {
  at: string;
  said: string;
  reply: string;
  answeredBy: string;
  orders?: JournalOrder[];
  /** Top headlines in the context when the wearer spoke. */
  news?: Array<{ title: string; source: string }>;
  /** News-driven signal: the 0G decision and both checks (prediction-market odds, price move). */
  signal?: Record<string, unknown>;
}

export interface UserMemory {
  /** Free-form preferences: watchlist, voice, quiet hours, etc. */
  preferences: Record<string, string | string[]>;
  riskProfile: RiskProfile;
  /** Most recent last. */
  history: HistoryEntry[];
  /** Voice turns, trades and news, most recent last (stored on 0G with the rest). */
  journal: JournalEntry[];
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
    journal: [],
  };
}

const MAX_HISTORY = 200;
const MAX_JOURNAL = 200;

function trim(memory: UserMemory): UserMemory {
  return { ...memory, history: memory.history.slice(-MAX_HISTORY), journal: (memory.journal ?? []).slice(-MAX_JOURNAL) };
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly data = new Map<string, UserMemory>();

  async load(userId: string): Promise<UserMemory> {
    const existing = this.data.get(userId);
    return structuredClone(existing ?? defaultMemory());
  }

  async save(userId: string, memory: UserMemory): Promise<void> {
    this.data.set(userId, structuredClone(trim(memory)));
  }
}

// ---------------------------------------------------------------------------
// 0G Storage memory
// ---------------------------------------------------------------------------

export const UserMemorySchema = z.object({
  preferences: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  riskProfile: z.enum(['conservative', 'balanced', 'aggressive']),
  history: z.array(z.object({ at: z.string(), requestId: z.string(), signal: z.string(), outcome: z.string() })),
  // Older blobs predate the journal.
  journal: z
    .array(
      z.object({
        at: z.string(),
        said: z.string(),
        reply: z.string(),
        answeredBy: z.string(),
        orders: z
          .array(
            z.object({
              coin: z.string(),
              side: z.enum(['buy', 'sell']),
              sizeUsd: z.number(),
              status: z.string(),
              orderId: z.string().optional(),
              avgPx: z.number().optional(),
              filled: z.number().optional(),
              txHash: z.string().optional(),
              error: z.string().optional(),
            }),
          )
          .optional(),
        news: z.array(z.object({ title: z.string(), source: z.string() })).optional(),
        signal: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .default([]),
});

/** Plaintext inside the encrypted blob. */
const MemoryEnvelopeSchema = z.object({
  v: z.literal(1),
  kind: z.literal('ghosty.memory'),
  userId: z.string(),
  savedAt: z.string(),
  memory: UserMemorySchema,
});

export interface MemoryPointer extends StoredBlob {
  savedAt: string;
}

interface MemoryCacheFile {
  v: 1;
  users: Record<string, MemoryPointer>;
}

export class MemoryUnavailableError extends Error {
  override readonly name = 'MemoryUnavailableError';
}

/**
 * Where the newest {rootHash, txHash} per user is kept. The memory itself is on 0G; this is only its address.
 * Default: <dataDir>/memory.json. On a container with a throwaway disk use a durable one (agent/ssmPointer.ts).
 */
export interface PointerStore {
  get(userId: string): Promise<MemoryPointer | undefined>;
  set(userId: string, pointer: MemoryPointer): Promise<void>;
}

export interface ZeroGMemoryOptions {
  store: BlobStore;
  /** Durable pointer store; the local memory.json is still written as a cache. */
  pointers?: PointerStore;
  /** 32-byte AES-256-GCM key (see deriveMemoryKey). */
  key: Uint8Array;
  /** Holds memory.json with the latest root hash per user. Default server/.ghosty */
  dataDir?: string;
  logger?: Logger;
  /** Await the 0G upload inside save(). Default false: upload runs in the background, flush() waits for it. */
  waitForUpload?: boolean;
}

/**
 * User memory on 0G Storage. Every save() encrypts the JSON with AES-256-GCM and uploads it; the newest
 * {rootHash, txHash} per user is kept in <dataDir>/memory.json. load() downloads by root hash and decrypts.
 * Saves are coalesced: if several land while an upload is queued, only the latest state is uploaded.
 */
export class ZeroGMemory implements MemoryStore {
  private readonly cachePath: string;
  private readonly pointers: Record<string, MemoryPointer>;
  /** Latest known plaintext per user in this process; avoids a download per decision. */
  private readonly live = new Map<string, UserMemory>();
  private readonly scheduled = new Set<string>();
  private readonly queue = new SerialQueue();
  private readonly logger: Logger;

  constructor(private readonly opts: ZeroGMemoryOptions) {
    const dir = ensureDataDir(opts.dataDir ?? DEFAULT_DATA_DIR);
    this.cachePath = join(dir, 'memory.json');
    this.pointers = readCache(this.cachePath).users;
    this.logger = opts.logger ?? noopLogger;
    const latest = Object.values(this.pointers).sort((a, b) => b.savedAt.localeCompare(a.savedAt))[0];
    if (latest) updateZeroGState({ memoryRootHash: latest.rootHash, memoryTxHash: latest.txHash });
  }

  pointer(userId: string): MemoryPointer | undefined {
    return this.pointers[userId];
  }

  async load(userId: string): Promise<UserMemory> {
    const cached = this.live.get(userId);
    if (cached) return structuredClone(cached);

    let ptr = this.pointers[userId];
    if (!ptr && this.opts.pointers) {
      try {
        ptr = await this.opts.pointers.get(userId);
      } catch (err) {
        this.logger.error({ userId, err: errorMessage(err) }, 'memory pointer lookup failed');
        throw new MemoryUnavailableError(`memory pointer for ${userId} could not be read: ${errorMessage(err)}`, { cause: err });
      }
      if (ptr) this.pointers[userId] = ptr;
    }
    if (!ptr) return defaultMemory();

    let memory: UserMemory;
    try {
      const blob = await this.opts.store.download(ptr.rootHash);
      const envelope = MemoryEnvelopeSchema.parse(decryptJson(this.opts.key, blob));
      if (envelope.userId !== userId) throw new Error(`blob belongs to ${envelope.userId}`);
      memory = envelope.memory;
    } catch (err) {
      // Loud on purpose: silently resetting to defaults would change the user's risk profile.
      this.logger.error({ userId, rootHash: ptr.rootHash, err: errorMessage(err) }, '0G memory load failed');
      throw new MemoryUnavailableError(`memory ${ptr.rootHash} could not be loaded: ${errorMessage(err)}`, { cause: err });
    }
    this.live.set(userId, memory);
    this.logger.info({ userId, rootHash: ptr.rootHash }, '0G memory loaded');
    return structuredClone(memory);
  }

  async save(userId: string, memory: UserMemory): Promise<void> {
    this.live.set(userId, structuredClone(trim(memory)));
    const job = this.scheduleUpload(userId);
    if (this.opts.waitForUpload) await job;
  }

  /** Wait for queued uploads (shutdown, tests, demo script). */
  async flush(): Promise<void> {
    await this.queue.idle();
  }

  private scheduleUpload(userId: string): Promise<void> {
    if (this.scheduled.has(userId)) return this.queue.idle();
    this.scheduled.add(userId);
    return this.queue
      .run(async () => {
        this.scheduled.delete(userId);
        const memory = this.live.get(userId);
        if (!memory) return;
        const savedAt = new Date().toISOString();
        const blob = encryptJson(this.opts.key, { v: 1, kind: 'ghosty.memory', userId, savedAt, memory });
        const stored = await this.opts.store.upload(blob, `memory-${userId}`);
        this.pointers[userId] = { ...stored, savedAt };
        writeCache(this.cachePath, { v: 1, users: this.pointers });
        await this.opts.pointers?.set(userId, this.pointers[userId]);
        updateZeroGState({ memoryRootHash: stored.rootHash, memoryTxHash: stored.txHash, lastStorageError: null });
        this.logger.info({ userId, ...stored }, '0G memory saved');
      })
      .catch((err: unknown) => {
        updateZeroGState({ lastStorageError: `memory: ${errorMessage(err)}` });
        this.logger.error({ userId, err: errorMessage(err) }, '0G memory upload failed; will retry on next save');
        if (this.opts.waitForUpload) throw err;
      });
  }
}

function readCache(path: string): MemoryCacheFile {
  if (!existsSync(path)) return { v: 1, users: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<MemoryCacheFile>;
    return { v: 1, users: parsed.users ?? {} };
  } catch {
    return { v: 1, users: {} };
  }
}

function writeCache(path: string, data: MemoryCacheFile): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

