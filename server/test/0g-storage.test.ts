import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createAgent, zeroGStatus } from '../src/agent/index.js';
import { noopLogger } from '../src/agent/log.js';
import { decryptBytes, DecryptionError, deriveMemoryKey, encryptBytes, encryptJson, decryptJson } from '../src/agent/crypto.js';
import { FakeDecider, ZeroGDecider, type Decision } from '../src/agent/decide.js';
import { InMemoryEpisodeLog, ZeroGEpisodeLog } from '../src/agent/episode.js';
import { defaultMemory, InMemoryMemoryStore, MemoryUnavailableError, ZeroGMemory } from '../src/agent/memory.js';
import { resetZeroGState, zeroGState } from '../src/agent/status.js';
import { SerialQueue, type BlobStore, type StoredBlob } from '../src/agent/storage.js';
import { loadConfig } from '../src/config.js';
import { resetBrainHealthCache } from '../src/safety/safeStop.js';

/** In-memory stand-in for 0G Storage: root hash = sha256 of the bytes. */
class FakeBlobStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  uploads = 0;
  failNext = 0;

  async upload(data: Uint8Array, _label: string): Promise<StoredBlob> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('insufficient funds for gas');
    }
    this.uploads++;
    const rootHash = `0x${createHash('sha256').update(data).digest('hex')}`;
    this.blobs.set(rootHash, Uint8Array.from(data));
    return { rootHash, txHash: `0xtx${this.uploads}` };
  }

  async download(rootHash: string): Promise<Uint8Array> {
    const blob = this.blobs.get(rootHash);
    if (!blob) throw new Error(`not found: ${rootHash}`);
    return blob;
  }
}

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghosty-0g-test-'));
  resetZeroGState();
  resetBrainHealthCache();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('AES-256-GCM envelope', () => {
  it('round-trips JSON', () => {
    const memory = defaultMemory();
    const blob = encryptJson(KEY, memory);
    assert.ok(!blob.toString('utf8').includes('watchlist'), 'ciphertext does not leak plaintext');
    assert.deepEqual(decryptJson(KEY, blob), memory);
  });

  it('uses a fresh IV per encryption', () => {
    const a = encryptBytes(KEY, Buffer.from('same'));
    const b = encryptBytes(KEY, Buffer.from('same'));
    assert.notDeepEqual(a, b);
  });

  it('fails loudly on a wrong key or a tampered blob', () => {
    const blob = encryptBytes(KEY, Buffer.from('secret risk profile'));
    assert.throws(() => decryptBytes(OTHER_KEY, blob), DecryptionError);
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1]! ^= 1;
    assert.throws(() => decryptBytes(KEY, tampered), DecryptionError);
    assert.throws(() => decryptBytes(KEY, Buffer.from('plain')), DecryptionError);
  });

  it('derives keys from OG_MEMORY_KEY or OG_PRIVATE_KEY', () => {
    const hex = 'ab'.repeat(32);
    assert.deepEqual(deriveMemoryKey({ memoryKeyHex: `0x${hex}`, privateKey: '0x01' }), Buffer.from(hex, 'hex'));
    const k1 = deriveMemoryKey({ privateKey: '0xABCDEF' });
    const k2 = deriveMemoryKey({ privateKey: 'abcdef' });
    assert.equal(k1.length, 32);
    assert.deepEqual(k1, k2, 'normalises 0x prefix and case');
    assert.throws(() => deriveMemoryKey({ memoryKeyHex: 'abcd' }));
    assert.throws(() => deriveMemoryKey({}));
  });
});

describe('ZeroGMemory', () => {
  it('returns defaults before the first save', async () => {
    const mem = new ZeroGMemory({ store: new FakeBlobStore(), key: KEY, dataDir: dir });
    assert.deepEqual(await mem.load('u1'), defaultMemory());
  });

  it('encrypts, uploads, records the root hash, and reloads from storage after a restart', async () => {
    const store = new FakeBlobStore();
    const mem = new ZeroGMemory({ store, key: KEY, dataDir: dir, waitForUpload: true });
    const m = defaultMemory();
    m.riskProfile = 'conservative';
    m.history.push({ at: '2026-11-07T09:00:00.000Z', requestId: 'req_1', signal: 'none', outcome: 'cancelled' });
    await mem.save('u1', m);

    const ptr = mem.pointer('u1');
    assert.ok(ptr);
    assert.equal(ptr.txHash, '0xtx1');
    assert.equal(zeroGState.memoryRootHash, ptr.rootHash);
    const uploaded = store.blobs.get(ptr.rootHash)!;
    assert.ok(!Buffer.from(uploaded).toString('utf8').includes('conservative'), 'blob on storage is encrypted');

    const cache = JSON.parse(readFileSync(join(dir, 'memory.json'), 'utf8')) as { users: Record<string, { rootHash: string }> };
    assert.equal(cache.users.u1!.rootHash, ptr.rootHash);
    assert.ok(existsSync(join(dir, '.gitignore')), 'data dir ignores itself');

    // New process: nothing in RAM, must download + decrypt.
    const fresh = new ZeroGMemory({ store, key: KEY, dataDir: dir });
    assert.deepEqual(await fresh.load('u1'), m);
  });

  it('throws MemoryUnavailableError with the wrong key instead of resetting to defaults', async () => {
    const store = new FakeBlobStore();
    await new ZeroGMemory({ store, key: KEY, dataDir: dir, waitForUpload: true }).save('u1', defaultMemory());
    const wrong = new ZeroGMemory({ store, key: OTHER_KEY, dataDir: dir });
    await assert.rejects(wrong.load('u1'), MemoryUnavailableError);
  });

  it('coalesces background saves and flush() waits for them', async () => {
    const store = new FakeBlobStore();
    const mem = new ZeroGMemory({ store, key: KEY, dataDir: dir });
    const m = defaultMemory();
    for (let i = 0; i < 5; i++) {
      m.history.push({ at: `t${i}`, requestId: `r${i}`, signal: 'none', outcome: 'cancelled' });
      await mem.save('u1', m);
    }
    await mem.flush();
    assert.ok(store.uploads <= 2, `expected coalesced uploads, got ${store.uploads}`);
    const fresh = new ZeroGMemory({ store, key: KEY, dataDir: dir });
    assert.equal((await fresh.load('u1')).history.length, 5, 'latest state was uploaded');
  });
});

const decision = (requestId: string): Decision => ({
  signal: 'geopolitical_shock',
  confidence: 0.8,
  rationale: 'test',
  suggestedActions: [{ venue: 'hyperliquid', coin: 'BTC', side: 'short', sizeUsd: 5, reason: 'test' }],
  requestId,
  newsIds: ['rss:reuters:1'],
});

const episode = (requestId: string) => ({
  decision: decision(requestId),
  requestId,
  actions: decision(requestId).suggestedActions,
  outcome: 'proposed' as const,
});

describe('ZeroGEpisodeLog', () => {
  it('uploads one JSON per decision and appends to the local index', async () => {
    const store = new FakeBlobStore();
    const log = new ZeroGEpisodeLog({ store, dataDir: dir, waitForUpload: true });
    const r1 = await log.append(episode('req_1'));
    const r2 = await log.append({ ...episode('req_2'), outcome: 'executed', receipts: ['oid-9'] });

    assert.equal(store.uploads, 2);
    assert.deepEqual((await log.list()).map((r) => r.seq), [1, 2]);
    assert.ok(r1.rootHash && r2.rootHash && r1.rootHash !== r2.rootHash);

    const lines = readFileSync(join(dir, 'episodes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(
      lines.map((l) => [l.requestId, l.rootHash, l.txHash]),
      [
        ['req_1', r1.rootHash, '0xtx1'],
        ['req_2', r2.rootHash, '0xtx2'],
      ],
    );
    assert.equal(zeroGState.episodeCount, 2);
    assert.equal(zeroGState.lastEpisodeRoot, r2.rootHash);

    const body = JSON.parse(Buffer.from(store.blobs.get(r2.rootHash!)!).toString('utf8'));
    assert.equal(body.kind, 'ghosty.episode');
    assert.equal(body.requestId, 'req_2');
    assert.deepEqual(body.newsIds, ['rss:reuters:1']);
    assert.deepEqual(body.orders, ['oid-9']);
    assert.equal(body.outcome, 'executed');
    assert.equal(body.prevRoot, r1.rootHash, 'episodes are chained');

    const v = await log.verify(r2.rootHash!);
    assert.equal(v.ok, true, v.problems.join('; '));
    assert.equal(v.episodes[0]!.requestId, 'req_2');
  });

  it('survives a restart: index reloads and seq continues', async () => {
    const store = new FakeBlobStore();
    await new ZeroGEpisodeLog({ store, dataDir: dir, waitForUpload: true }).append(episode('req_1'));
    const again = new ZeroGEpisodeLog({ store, dataDir: dir, waitForUpload: true });
    assert.equal(again.listIndex().length, 1);
    const r = await again.append(episode('req_2'));
    assert.equal(r.seq, 2);
    assert.equal(again.listIndex().length, 2);
  });

  it('batches N episodes per upload and flushes the remainder', async () => {
    const store = new FakeBlobStore();
    const log = new ZeroGEpisodeLog({ store, dataDir: dir, batchSize: 2 });
    await log.append(episode('a'));
    assert.equal(store.uploads, 0);
    assert.equal(log.pending, 1);
    await log.append(episode('b'));
    await log.append(episode('c'));
    await log.flush();
    assert.equal(store.uploads, 2);
    assert.equal(log.pending, 0);

    const index = log.listIndex();
    assert.deepEqual(index.map((e) => e.batchSize), [2, 2, 1]);
    assert.equal(index[0]!.rootHash, index[1]!.rootHash);
    const v = await log.verify(index[0]!.rootHash);
    assert.equal(v.ok, true, v.problems.join('; '));
    assert.deepEqual(v.episodes.map((e) => e.requestId), ['a', 'b']);
  });

  it('keeps failed uploads and retries them with the next one', async () => {
    const store = new FakeBlobStore();
    store.failNext = 1;
    const log = new ZeroGEpisodeLog({ store, dataDir: dir });
    await log.append(episode('x'));
    await log.flush();
    assert.equal(store.uploads, 0);
    assert.equal(log.pending, 1);
    assert.match(zeroGState.lastStorageError ?? '', /insufficient funds/);

    await log.append(episode('y'));
    await log.flush();
    assert.equal(log.pending, 0);
    assert.deepEqual(log.listIndex().map((e) => e.requestId), ['x', 'y']);
  });

  it('verify() flags a blob that does not match the index', async () => {
    const store = new FakeBlobStore();
    const log = new ZeroGEpisodeLog({ store, dataDir: dir, waitForUpload: true });
    const r = await log.append(episode('req_1'));
    store.blobs.set(r.rootHash!, Buffer.from(JSON.stringify({ kind: 'ghosty.episode', requestId: 'forged' })));
    const v = await log.verify(r.rootHash!);
    assert.equal(v.ok, false);
    assert.ok(v.problems.some((p) => p.includes('sha256')));
    assert.ok(v.problems.some((p) => p.includes('req_1')));
  });
});

describe('SerialQueue', () => {
  it('runs jobs one at a time even when one fails', async () => {
    const q = new SerialQueue();
    const order: string[] = [];
    let running = 0;
    const job = (name: string, fail = false) => async () => {
      running++;
      assert.equal(running, 1);
      await new Promise((r) => setTimeout(r, 5));
      order.push(name);
      running--;
      if (fail) throw new Error(name);
    };
    const results = await Promise.allSettled([q.run(job('a')), q.run(job('b', true)), q.run(job('c'))]);
    assert.deepEqual(order, ['a', 'b', 'c']);
    assert.equal(results[1]!.status, 'rejected');
    await q.idle();
    assert.equal(q.pending, 0);
  });
});

describe('createAgent / zeroGStatus', () => {
  it('uses fakes when no 0G keys are set', async () => {
    const agent = createAgent(loadConfig({}));
    assert.ok(agent.decider instanceof FakeDecider);
    assert.ok(agent.memory instanceof InMemoryMemoryStore);
    assert.ok(agent.episodes instanceof InMemoryEpisodeLog);
    const status = await zeroGStatus();
    assert.equal(status.computeOnline, true);
    assert.equal(status.computeMode, 'fake');
    assert.equal(status.storageMode, 'memory');
  });

  it('picks the 0G implementations when keys are set', async () => {
    const config = loadConfig({
      OG_API_KEY: 'sk-test',
      OG_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
      OG_DATA_DIR: dir,
      OG_EPISODE_BATCH: 'true',
      OG_EPISODE_BATCH_SIZE: '3',
      SIMULATE_BRAIN_OFFLINE: 'true',
    });
    const store = new FakeBlobStore();
    const agent = createAgent(config, { blobStore: store, logger: noopLogger });
    assert.ok(agent.decider instanceof ZeroGDecider);
    assert.ok(agent.memory instanceof ZeroGMemory);
    assert.ok(agent.episodes instanceof ZeroGEpisodeLog);

    await agent.episodes.append(episode('req_s'));
    await agent.memory.save('device-0', defaultMemory());
    await agent.flush();

    const status = await zeroGStatus(config);
    assert.equal(status.computeOnline, false, 'SIMULATE_BRAIN_OFFLINE');
    assert.equal(status.computeMode, '0g');
    assert.equal(status.storageMode, '0g');
    assert.equal(status.episodeCount, 1, 'partial batch flushed');
    assert.ok(status.lastEpisodeRoot);
    assert.ok(status.memoryRootHash);
  });
});
