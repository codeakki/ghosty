import type { Config } from '../config.js';
import { FakeEthosScorer, type CredibilityScorer } from '../credibility/ethos.js';
import { isBrainOnline } from '../safety/safeStop.js';
import { deriveMemoryKey } from './crypto.js';
import { FakeDecider, ZeroGDecider, type Decider } from './decide.js';
import { InMemoryEpisodeLog, ZeroGEpisodeLog, type EpisodeLog } from './episode.js';
import { consoleLogger, type Logger } from './log.js';
import { InMemoryMemoryStore, ZeroGMemory, type MemoryStore } from './memory.js';
import { updateZeroGState, zeroGState } from './status.js';
import { ZeroGBlobStore, type BlobStore } from './storage.js';

export { BrainOfflineError, ZeroGDecider, FakeDecider } from './decide.js';
export { ZeroGEpisodeLog, InMemoryEpisodeLog } from './episode.js';
export { MemoryUnavailableError, ZeroGMemory, InMemoryMemoryStore } from './memory.js';
export { ZeroGBlobStore, type BlobStore, type StoredBlob } from './storage.js';

export interface CreateAgentOptions {
  logger?: Logger;
  scorer?: CredibilityScorer;
  /** Override the 0G Storage client (tests). */
  blobStore?: BlobStore;
}

export interface Agent {
  decider: Decider;
  memory: MemoryStore;
  episodes: EpisodeLog;
  /** Wait for background 0G Storage uploads (call before shutdown). No-op for in-memory stores. */
  flush(): Promise<void>;
}

let activeConfig: Config | undefined;

/** Real 0G Compute when OG_API_KEY is set, otherwise the keyword FakeDecider. */
export function createDecider(config: Config, opts: CreateAgentOptions = {}): Decider {
  if (config.OG_API_KEY) {
    updateZeroGState({ computeMode: '0g' });
    return new ZeroGDecider({
      baseURL: config.OG_ROUTER_URL,
      apiKey: config.OG_API_KEY,
      model: config.OG_MODEL,
      jsonMode: config.OG_JSON_MODE,
      scorer: opts.scorer,
      logger: opts.logger ?? consoleLogger,
    });
  }
  updateZeroGState({ computeMode: 'fake' });
  return new FakeDecider(opts.scorer ?? new FakeEthosScorer());
}

/** Real 0G Storage when OG_PRIVATE_KEY is set (or a blobStore is injected), otherwise in-memory. */
export function createStorage(
  config: Config,
  opts: CreateAgentOptions = {},
): { memory: MemoryStore; episodes: EpisodeLog; flush(): Promise<void> } {
  const logger = opts.logger ?? consoleLogger;
  const store =
    opts.blobStore ??
    (config.OG_PRIVATE_KEY
      ? new ZeroGBlobStore({
          privateKey: config.OG_PRIVATE_KEY,
          rpcUrl: config.OG_RPC_URL,
          indexerUrl: config.OG_INDEXER_URL,
          logger,
        })
      : undefined);

  if (!store) {
    updateZeroGState({ storageMode: 'memory' });
    return { memory: new InMemoryMemoryStore(), episodes: new InMemoryEpisodeLog(), flush: async () => {} };
  }

  updateZeroGState({ storageMode: '0g' });
  const dataDir = config.OG_DATA_DIR;
  const memory = new ZeroGMemory({
    store,
    key: deriveMemoryKey({ memoryKeyHex: config.OG_MEMORY_KEY, privateKey: config.OG_PRIVATE_KEY }),
    dataDir,
    logger,
  });
  const episodes = new ZeroGEpisodeLog({
    store,
    dataDir,
    logger,
    batchSize: config.OG_EPISODE_BATCH ? config.OG_EPISODE_BATCH_SIZE : 1,
  });
  return {
    memory,
    episodes,
    flush: async () => {
      await Promise.all([memory.flush(), episodes.flush()]);
    },
  };
}

/** Decider + memory + episode log, each picking the 0G implementation when its keys are present. */
export function createAgent(config: Config, opts: CreateAgentOptions = {}): Agent {
  activeConfig = config;
  const decider = createDecider(config, opts);
  const storage = createStorage(config, opts);
  return { decider, memory: storage.memory, episodes: storage.episodes, flush: storage.flush };
}

export interface ZeroGStatus {
  computeOnline: boolean;
  computeMode: '0g' | 'fake';
  storageMode: '0g' | 'memory';
  lastRequestId: string | null;
  memoryRootHash: string | null;
  episodeCount: number;
  lastEpisodeRoot: string | null;
  pendingEpisodes: number;
  lastStorageError: string | null;
}

/**
 * Snapshot for a `GET /zerog/status` route. computeOnline uses the cached safe-stop probe
 * (at most one router ping per 10 s).
 */
export async function zeroGStatus(config: Config | undefined = activeConfig): Promise<ZeroGStatus> {
  const computeOnline = config ? await isBrainOnline(config) : true;
  return {
    computeOnline,
    computeMode: zeroGState.computeMode,
    storageMode: zeroGState.storageMode,
    lastRequestId: zeroGState.lastRequestId,
    memoryRootHash: zeroGState.memoryRootHash,
    episodeCount: zeroGState.episodeCount,
    lastEpisodeRoot: zeroGState.lastEpisodeRoot,
    pendingEpisodes: zeroGState.pendingEpisodes,
    lastStorageError: zeroGState.lastStorageError,
  };
}
