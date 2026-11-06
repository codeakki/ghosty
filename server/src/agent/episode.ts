import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PlannedAction } from '../execution/playbook.js';
import { sha256Hex } from './crypto.js';
import type { Decision } from './decide.js';
import { errorMessage, noopLogger, type Logger } from './log.js';
import { updateZeroGState } from './status.js';
import { DEFAULT_DATA_DIR, ensureDataDir, SerialQueue, type BlobStore } from './storage.js';

/**
 * Per-decision episode log. The 0G Physical AI track asks for one record per decision,
 * tied to the 0G inference request id, stored on 0G Storage.
 */

export type EpisodeOutcome = 'proposed' | 'executed' | 'cancelled' | 'blocked_safe_stop' | 'failed';

export interface EpisodeInput {
  decision: Decision;
  requestId: string;
  actions: PlannedAction[];
  outcome: EpisodeOutcome;
  /** Venue order ids / tx hashes, when something was executed. */
  receipts?: string[];
  /** News item ids the decision used. Defaults to decision.newsIds. */
  newsIds?: string[];
  /** Full venue order results. Defaults to receipts. */
  orders?: unknown[];
}

export interface EpisodeRecord extends EpisodeInput {
  seq: number;
  at: string;
  /** Set once the episode is on 0G Storage (ZeroGEpisodeLog only). */
  rootHash?: string;
  txHash?: string;
}

export interface EpisodeLog {
  append(entry: EpisodeInput): Promise<EpisodeRecord>;
  list(limit?: number): Promise<EpisodeRecord[]>;
}

export class InMemoryEpisodeLog implements EpisodeLog {
  private readonly records: EpisodeRecord[] = [];

  async append(entry: EpisodeInput): Promise<EpisodeRecord> {
    const record: EpisodeRecord = { ...entry, seq: this.records.length + 1, at: new Date().toISOString() };
    this.records.push(record);
    return record;
  }

  async list(limit = 50): Promise<EpisodeRecord[]> {
    return this.records.slice(-limit);
  }
}

// ---------------------------------------------------------------------------
// 0G Storage episode log
// ---------------------------------------------------------------------------

/** One decision as stored on 0G Storage. Plaintext on purpose: judges can open it from storagescan. */
export interface EpisodeBody {
  v: 1;
  kind: 'ghosty.episode';
  seq: number;
  ts: string;
  requestId: string;
  newsIds: string[];
  decision: Pick<Decision, 'signal' | 'confidence' | 'rationale' | 'zeroG'>;
  actions: PlannedAction[];
  orders: unknown[];
  outcome: EpisodeOutcome;
}

/** Root hash of the previous upload, so a reader can walk the whole log back from the newest root. */
type Chained<T> = T & { prevRoot: string | null };

export interface EpisodeBatchBody {
  v: 1;
  kind: 'ghosty.episode-batch';
  prevRoot: string | null;
  episodes: EpisodeBody[];
}

/** One line of <dataDir>/episodes.jsonl. */
export interface EpisodeIndexEntry {
  ts: string;
  seq: number;
  requestId: string;
  outcome: EpisodeOutcome;
  rootHash: string;
  txHash: string;
  /** sha256 of the exact bytes uploaded, checked by verify(). */
  sha256: string;
  /** Episodes in the same blob (1 unless batched). */
  batchSize: number;
}

export interface EpisodeVerification {
  ok: boolean;
  rootHash: string;
  sha256: string;
  expectedSha256: string | null;
  episodes: EpisodeBody[];
  problems: string[];
}

export interface ZeroGEpisodeLogOptions {
  store: BlobStore;
  dataDir?: string;
  logger?: Logger;
  /** Episodes per upload. 1 = one blob per decision (default). OG_EPISODE_BATCH=true → OG_EPISODE_BATCH_SIZE. */
  batchSize?: number;
  /** Await the 0G upload inside append(). Default false: uploads run in the background, flush() waits. */
  waitForUpload?: boolean;
}

const MAX_RECORDS_IN_PROCESS = 500;

/**
 * Episode log on 0G Storage: one JSON per decision (or per batch), uploaded through the BlobStore.
 * <dataDir>/episodes.jsonl is an append-only index of {ts, requestId, rootHash, txHash, ...} that survives restarts.
 * Failed uploads go back into the buffer and are retried with the next upload.
 */
export class ZeroGEpisodeLog implements EpisodeLog {
  private readonly indexPath: string;
  private readonly index: EpisodeIndexEntry[];
  private readonly records: EpisodeRecord[] = [];
  private buffer: Array<{ body: EpisodeBody; record: EpisodeRecord }> = [];
  private readonly queue = new SerialQueue();
  private readonly logger: Logger;
  private readonly batchSize: number;
  private inQueue = 0;
  private nextSeq: number;
  private lastRoot: string | null;

  constructor(private readonly opts: ZeroGEpisodeLogOptions) {
    const dir = ensureDataDir(opts.dataDir ?? DEFAULT_DATA_DIR);
    this.indexPath = join(dir, 'episodes.jsonl');
    this.index = readIndex(this.indexPath);
    this.logger = opts.logger ?? noopLogger;
    this.batchSize = Math.max(1, Math.floor(opts.batchSize ?? 1));
    this.nextSeq = this.index.reduce((max, e) => Math.max(max, e.seq), 0) + 1;
    this.lastRoot = this.index.at(-1)?.rootHash ?? null;
    updateZeroGState({ episodeCount: this.index.length, lastEpisodeRoot: this.lastRoot, pendingEpisodes: 0 });
  }

  async append(entry: EpisodeInput): Promise<EpisodeRecord> {
    const record: EpisodeRecord = { ...entry, seq: this.nextSeq++, at: new Date().toISOString() };
    this.records.push(record);
    if (this.records.length > MAX_RECORDS_IN_PROCESS) this.records.shift();
    this.buffer.push({ body: toBody(record), record });
    this.publishPending();

    if (this.buffer.length >= this.batchSize) {
      const job = this.uploadBuffered();
      if (this.opts.waitForUpload) await job;
    }
    return record;
  }

  /** Episodes appended in this process, newest last (rootHash set once uploaded). */
  async list(limit = 50): Promise<EpisodeRecord[]> {
    return this.records.slice(-limit);
  }

  /** Persisted pointers from episodes.jsonl, newest last. */
  listIndex(limit = 50): EpisodeIndexEntry[] {
    return this.index.slice(-limit);
  }

  get pending(): number {
    return this.buffer.length + this.inQueue;
  }

  /** Upload a partial batch and wait for every queued upload. */
  async flush(): Promise<void> {
    void this.uploadBuffered();
    await this.queue.idle();
  }

  /** Download a blob by root hash (merkle proof checked by the SDK) and compare it with the local index. */
  async verify(rootHash: string): Promise<EpisodeVerification> {
    const entries = this.index.filter((e) => e.rootHash === rootHash);
    const bytes = await this.opts.store.download(rootHash);
    const sha256 = sha256Hex(bytes);
    const expectedSha256 = entries[0]?.sha256 ?? null;
    const problems: string[] = [];

    let episodes: EpisodeBody[] = [];
    try {
      const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as Chained<EpisodeBody> | EpisodeBatchBody;
      episodes = parsed.kind === 'ghosty.episode-batch' ? parsed.episodes : [parsed];
      if (!episodes.every((e) => e?.kind === 'ghosty.episode')) problems.push('blob is not a Ghosty episode');
    } catch (err) {
      problems.push(`blob is not JSON: ${errorMessage(err)}`);
    }

    if (entries.length === 0) problems.push('root hash not in the local index');
    else if (expectedSha256 !== sha256) problems.push('sha256 of downloaded bytes does not match the index');
    const ids = new Set(episodes.map((e) => e.requestId));
    for (const e of entries) if (!ids.has(e.requestId)) problems.push(`requestId ${e.requestId} missing from blob`);

    return { ok: problems.length === 0, rootHash, sha256, expectedSha256, episodes, problems };
  }

  private uploadBuffered(): Promise<void> {
    const items = this.buffer;
    if (items.length === 0) return Promise.resolve();
    this.buffer = [];
    this.inQueue += items.length;

    return this.queue
      .run(async () => {
        const prevRoot = this.lastRoot;
        const first = items[0]!;
        const payload: Chained<EpisodeBody> | EpisodeBatchBody =
          items.length === 1
            ? { ...first.body, prevRoot }
            : { v: 1, kind: 'ghosty.episode-batch', prevRoot, episodes: items.map((i) => i.body) };
        const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
        const label = items.length === 1 ? `episode-${first.record.seq}` : `episodes-${first.record.seq}-${items.at(-1)!.record.seq}`;
        const stored = await this.opts.store.upload(bytes, label);
        const sha256 = sha256Hex(bytes);

        for (const { record } of items) {
          record.rootHash = stored.rootHash;
          record.txHash = stored.txHash;
          const entry: EpisodeIndexEntry = {
            ts: record.at,
            seq: record.seq,
            requestId: record.requestId,
            outcome: record.outcome,
            rootHash: stored.rootHash,
            txHash: stored.txHash,
            sha256,
            batchSize: items.length,
          };
          appendFileSync(this.indexPath, `${JSON.stringify(entry)}\n`);
          this.index.push(entry);
        }
        this.lastRoot = stored.rootHash;
        updateZeroGState({ episodeCount: this.index.length, lastEpisodeRoot: stored.rootHash, lastStorageError: null });
        this.logger.info(
          { ...stored, episodes: items.length, requestIds: items.map((i) => i.record.requestId) },
          '0G episode uploaded',
        );
      })
      .catch((err: unknown) => {
        this.buffer = [...items, ...this.buffer];
        updateZeroGState({ lastStorageError: `episodes: ${errorMessage(err)}` });
        this.logger.error({ err: errorMessage(err), episodes: items.length }, '0G episode upload failed; retrying with the next upload');
        if (this.opts.waitForUpload) throw err;
      })
      .finally(() => {
        this.inQueue -= items.length;
        this.publishPending();
      });
  }

  private publishPending(): void {
    updateZeroGState({ pendingEpisodes: this.pending });
  }
}

function toBody(record: EpisodeRecord): EpisodeBody {
  const { decision } = record;
  return {
    v: 1,
    kind: 'ghosty.episode',
    seq: record.seq,
    ts: record.at,
    requestId: record.requestId,
    newsIds: record.newsIds ?? decision.newsIds ?? [],
    decision: {
      signal: decision.signal,
      confidence: decision.confidence,
      rationale: decision.rationale,
      ...(decision.zeroG ? { zeroG: decision.zeroG } : {}),
    },
    actions: record.actions,
    orders: record.orders ?? record.receipts ?? [],
    outcome: record.outcome,
  };
}

function readIndex(path: string): EpisodeIndexEntry[] {
  if (!existsSync(path)) return [];
  const out: EpisodeIndexEntry[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as EpisodeIndexEntry;
      if (typeof e.rootHash === 'string' && typeof e.requestId === 'string') out.push(e);
    } catch {
      // Skip a torn last line from a crash mid-write.
    }
  }
  return out;
}

