import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from '../agent/crypto.js';
import type { Decision } from '../agent/decide.js';
import type { EpisodeOutcome } from '../agent/episode.js';
import { errorMessage, noopLogger, type Logger } from '../agent/log.js';
import { ensureDataDir, SerialQueue, type BlobStore } from '../agent/storage.js';
import type { PlannedAction } from '../execution/playbook.js';

/**
 * Episode log for simulation runs. Each episode is a chained JSON body ({..., prevRoot}):
 *  - with a BlobStore (OG_PRIVATE_KEY set) it is uploaded to 0G Storage and rootHash is the 0G merkle root;
 *  - otherwise it stays local and rootHash is `local:<sha256 of the body>`, with `storage: "local"`.
 * Either way one line per episode goes to <dataDir>/sim-episodes.jsonl (append-only), body included, so
 * GET /episodes and the replay walk work offline. Sim episodes never join the live episode chain.
 */

export interface SimEpisodeBody {
  v: 1;
  kind: 'ghosty.episode';
  sim: true;
  runId: string;
  scenarioId: string;
  seq: number;
  /** Wall-clock time the episode was written. */
  ts: string;
  /** Scenario time the decision was made at. */
  simTime: string;
  requestId: string;
  newsIds: string[];
  headline?: string;
  decision: Pick<Decision, 'signal' | 'confidence' | 'rationale' | 'zeroG'>;
  actions: PlannedAction[];
  orders: unknown[];
  outcome: EpisodeOutcome;
  /** How the memory snapshot was obtained (e.g. "default: 0G memory not configured"). */
  memory: string;
  prevRoot: string | null;
}

export interface SimEpisodeEntry {
  seq: number;
  ts: string;
  runId: string;
  scenarioId: string;
  requestId: string;
  outcome: EpisodeOutcome;
  storage: 'local' | '0g';
  rootHash: string;
  prevRoot: string | null;
  txHash?: string;
  /** Set when a 0G upload was attempted and failed; the episode then stayed local. */
  storageError?: string;
  body: SimEpisodeBody;
}

export type SimEpisodeInput = Omit<SimEpisodeBody, 'v' | 'kind' | 'sim' | 'seq' | 'ts' | 'prevRoot'>;

export class SimEpisodeLog {
  readonly path: string;
  private readonly entries: SimEpisodeEntry[];
  private readonly queue = new SerialQueue();
  private readonly logger: Logger;
  private seq: number;

  constructor(private readonly opts: { dataDir: string; store?: BlobStore; logger?: Logger }) {
    this.path = join(ensureDataDir(opts.dataDir), 'sim-episodes.jsonl');
    this.entries = readEntries(this.path);
    this.seq = this.entries.reduce((m, e) => Math.max(m, e.seq), 0);
    this.logger = opts.logger ?? noopLogger;
  }

  get storageMode(): 'local' | '0g' {
    return this.opts.store ? '0g' : 'local';
  }

  /**
   * Append one episode. Writes are serialised so prevRoot always points at the previous episode. Resolves once
   * the line is on disk (after the 0G upload when configured; a failed upload falls back to local, labelled).
   */
  append(input: SimEpisodeInput): Promise<SimEpisodeEntry> {
    return this.queue.run(async () => {
      const prevRoot = this.entries.at(-1)?.rootHash ?? null;
      const body: SimEpisodeBody = { v: 1, kind: 'ghosty.episode', sim: true, seq: ++this.seq, ts: new Date().toISOString(), ...input, prevRoot };
      const bytes = Buffer.from(JSON.stringify(body), 'utf8');
      let entry: SimEpisodeEntry = {
        seq: body.seq,
        ts: body.ts,
        runId: body.runId,
        scenarioId: body.scenarioId,
        requestId: body.requestId,
        outcome: body.outcome,
        storage: 'local',
        rootHash: `local:${sha256Hex(bytes)}`,
        prevRoot,
        body,
      };
      if (this.opts.store) {
        try {
          const stored = await this.opts.store.upload(bytes, `sim-episode-${body.seq}`);
          entry = { ...entry, storage: '0g', rootHash: stored.rootHash, txHash: stored.txHash };
          this.logger.info({ rootHash: stored.rootHash, requestId: body.requestId, runId: body.runId }, 'sim episode uploaded to 0G');
        } catch (err) {
          entry.storageError = errorMessage(err);
          this.logger.warn({ err: entry.storageError }, 'sim episode 0G upload failed; kept local');
        }
      }
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
      this.entries.push(entry);
      return entry;
    });
  }

  list(opts: { runId?: string; limit?: number } = {}): SimEpisodeEntry[] {
    const all = opts.runId ? this.entries.filter((e) => e.runId === opts.runId) : this.entries;
    return all.slice(-(opts.limit ?? 50));
  }

  byRoot(rootHash: string): SimEpisodeEntry | undefined {
    return this.entries.find((e) => e.rootHash === rootHash);
  }

  idle(): Promise<void> {
    return this.queue.idle();
  }
}

function readEntries(path: string): SimEpisodeEntry[] {
  if (!existsSync(path)) return [];
  const out: SimEpisodeEntry[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as SimEpisodeEntry;
      if (typeof e.rootHash === 'string' && e.body) out.push(e);
    } catch {
      // torn last line
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Replay: walk the chain backwards through prevRoot
// ---------------------------------------------------------------------------

export interface ReplayedEpisode {
  rootHash: string;
  storage: 'local' | '0g';
  requestId: string;
  seq: number | null;
  ts: string | null;
  outcome: string | null;
  sim: boolean;
  runId: string | null;
  prevRoot: string | null;
  /** storagescan link for 0G roots. */
  storagescan: string | null;
  episode: unknown;
}

export interface ReplayResult {
  from: string;
  /** Oldest → newest. */
  episodes: ReplayedEpisode[];
  /** Where the walk stopped: chain start (null), the limit, or an unreadable root. */
  stoppedAt: string | null;
  problems: string[];
}

interface ChainedBody {
  kind?: string;
  prevRoot?: string | null;
  episodes?: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

/**
 * Walk an episode chain from `from` back through each body's prevRoot. Local roots (`local:` or present in the
 * sim log) are read from disk; others are downloaded from 0G Storage when a BlobStore is configured. Works for
 * live 0G episode chains too (single and batch bodies).
 */
export async function replayChain(opts: {
  from: string;
  limit: number;
  simLog: SimEpisodeLog;
  store?: BlobStore;
  storagescan: string;
}): Promise<ReplayResult> {
  const out: ReplayedEpisode[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  let root: string | null = opts.from;
  while (root && out.length < opts.limit) {
    if (seen.has(root)) {
      problems.push(`cycle at ${root}`);
      break;
    }
    seen.add(root);
    const local = opts.simLog.byRoot(root);
    let body: ChainedBody;
    let storage: 'local' | '0g';
    if (local) {
      body = local.body as unknown as ChainedBody;
      storage = local.storage;
    } else if (root.startsWith('local:')) {
      problems.push(`local root ${root} not found in sim-episodes.jsonl`);
      break;
    } else if (!opts.store) {
      problems.push(`0G Storage not configured (OG_PRIVATE_KEY); cannot download ${root}`);
      break;
    } else {
      try {
        body = JSON.parse(Buffer.from(await opts.store.download(root)).toString('utf8')) as ChainedBody;
        storage = '0g';
      } catch (err) {
        problems.push(`download ${root} failed: ${errorMessage(err)}`);
        break;
      }
    }
    const items = body.kind === 'ghosty.episode-batch' && Array.isArray(body.episodes) ? [...body.episodes].reverse() : [body];
    for (const ep of items) {
      out.push({
        rootHash: root,
        storage,
        requestId: String(ep.requestId ?? ''),
        seq: typeof ep.seq === 'number' ? ep.seq : null,
        ts: typeof ep.ts === 'string' ? ep.ts : null,
        outcome: typeof ep.outcome === 'string' ? ep.outcome : null,
        sim: ep.sim === true,
        runId: typeof ep.runId === 'string' ? ep.runId : null,
        prevRoot: body.prevRoot ?? null,
        storagescan: storage === '0g' ? `${opts.storagescan}/submission/${root}` : null,
        episode: ep,
      });
    }
    root = body.prevRoot ?? null;
  }
  return { from: opts.from, episodes: out.reverse(), stoppedAt: root, problems };
}
