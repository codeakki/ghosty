import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as StorageSdkModule from '@0gfoundation/0g-storage-ts-sdk';
import type * as EthersModule from 'ethers';
import { noopLogger, type Logger } from './log.js';

/** A blob on 0G Storage: merkle root (content address) plus the flow-contract submission tx. */
export interface StoredBlob {
  rootHash: string;
  txHash: string;
}

/** The two storage calls the agent needs. Mocked in tests; ZeroGBlobStore in production. */
export interface BlobStore {
  upload(data: Uint8Array, label: string): Promise<StoredBlob>;
  download(rootHash: string): Promise<Uint8Array>;
}

/** Runs async jobs one at a time, in order. Storage uploads share one signer, so parallel txs would race on the nonce. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private size = 0;

  run<T>(job: () => Promise<T>): Promise<T> {
    this.size++;
    const result = this.tail.then(job, job);
    this.tail = result.then(
      () => this.size--,
      () => this.size--,
    );
    return result;
  }

  get pending(): number {
    return this.size;
  }

  /** Resolves once every job queued so far has settled. */
  async idle(): Promise<void> {
    let seen: Promise<unknown> | undefined;
    while (seen !== this.tail) {
      seen = this.tail;
      await seen;
    }
  }
}

/** server/.ghosty — resolves the same from src/agent (tsx) and dist/agent (build). */
export const DEFAULT_DATA_DIR = fileURLToPath(new URL('../../.ghosty/', import.meta.url));

/** Create the local cache dir with a self-ignoring .gitignore so pointers never get committed. */
export function ensureDataDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
  return dir;
}

export interface ZeroGBlobStoreOptions {
  privateKey: string;
  /** 0G Galileo EVM RPC, e.g. https://evmrpc-testnet.0g.ai */
  rpcUrl: string;
  /** e.g. https://indexer-storage-testnet-turbo.0g.ai */
  indexerUrl: string;
  logger?: Logger;
  uploadTimeoutMs?: number;
  downloadTimeoutMs?: number;
}

type StorageSdk = typeof StorageSdkModule;
type Ethers = typeof EthersModule;
/** The SDK's .d.ts resolves ethers' CJS typings while we load the ESM build; same class at runtime. */
type SdkSigner = Parameters<InstanceType<StorageSdk['Indexer']>['upload']>[2];

/**
 * 0G Storage through `@0gfoundation/0g-storage-ts-sdk`: temp file → ZgFile → merkleTree → indexer.upload.
 * Downloads use downloadToBlob with merkle proof verification on. The SDK and ethers are loaded lazily
 * so the server (and tests) start without touching them when 0G Storage is not configured.
 */
export class ZeroGBlobStore implements BlobStore {
  private readonly logger: Logger;
  private readonly uploads = new SerialQueue();
  private loaded?: Promise<{ sdk: StorageSdk; indexer: InstanceType<StorageSdk['Indexer']>; signer: InstanceType<Ethers['Wallet']> }>;

  constructor(private readonly opts: ZeroGBlobStoreOptions) {
    this.logger = opts.logger ?? noopLogger;
  }

  private load() {
    this.loaded ??= (async () => {
      const [sdk, { ethers }] = await Promise.all([import('@0gfoundation/0g-storage-ts-sdk'), import('ethers')]);
      const signer = new ethers.Wallet(this.opts.privateKey, new ethers.JsonRpcProvider(this.opts.rpcUrl));
      return { sdk, indexer: new sdk.Indexer(this.opts.indexerUrl), signer };
    })();
    return this.loaded;
  }

  /** Address that pays for uploads (fund it at faucet.0g.ai). */
  async address(): Promise<string> {
    return (await this.load()).signer.address;
  }

  upload(data: Uint8Array, label: string): Promise<StoredBlob> {
    return this.uploads.run(() => withTimeout(this.uploadNow(data, label), this.opts.uploadTimeoutMs ?? 180_000, '0G upload'));
  }

  private async uploadNow(data: Uint8Array, label: string): Promise<StoredBlob> {
    const { sdk, indexer, signer } = await this.load();
    const dir = await mkdtemp(join(tmpdir(), 'ghosty-0g-'));
    const path = join(dir, `${label.replace(/[^a-z0-9_.-]/gi, '_')}-${randomUUID()}.bin`);
    await writeFile(path, data);
    const file = await sdk.ZgFile.fromFilePath(path);
    try {
      const [tree, treeErr] = await file.merkleTree();
      if (treeErr || !tree) throw new Error(`merkle tree failed: ${treeErr?.message ?? 'no tree'}`);
      const expectedRoot = tree.rootHash();
      const [tx, err] = await indexer.upload(file, this.opts.rpcUrl, signer as unknown as SdkSigner);
      if (err) throw err;
      const result: StoredBlob =
        'rootHash' in tx
          ? { rootHash: tx.rootHash, txHash: tx.txHash }
          : { rootHash: tx.rootHashes[0] ?? '', txHash: tx.txHashes[0] ?? '' };
      if (expectedRoot && result.rootHash && result.rootHash !== expectedRoot) {
        this.logger.warn({ expectedRoot, rootHash: result.rootHash }, '0G upload root differs from local merkle root');
      }
      if (!result.rootHash) throw new Error('0G upload returned no root hash');
      this.logger.info({ label, bytes: data.length, ...result }, '0G storage upload');
      return result;
    } finally {
      await file.close().catch(() => undefined);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async download(rootHash: string): Promise<Uint8Array> {
    const { indexer } = await this.load();
    const [blob, err] = await withTimeout(
      indexer.downloadToBlob(rootHash, { proof: true }),
      this.opts.downloadTimeoutMs ?? 60_000,
      '0G download',
    );
    if (err) throw err;
    return new Uint8Array(await blob.arrayBuffer());
  }
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
