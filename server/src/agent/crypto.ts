import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM envelope for blobs we put on 0G Storage.
 *
 * Why not the SDK's built-in `encryption: { type: 'aes256' }`? It is AES-256-CTR without an auth tag,
 * so a wrong key silently returns garbage (documented by 0G). GCM fails loudly on a wrong key or a
 * tampered blob, which is what we want for a user's risk profile.
 *
 * Layout: MAGIC (4) | IV (12) | TAG (16) | CIPHERTEXT
 */
const MAGIC = Buffer.from('GHM1', 'ascii');
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + IV_LEN + TAG_LEN;

export class DecryptionError extends Error {
  override readonly name = 'DecryptionError';
}

export function encryptBytes(key: Uint8Array, plaintext: Uint8Array): Buffer {
  assertKey(key);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(MAGIC);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptBytes(key: Uint8Array, blob: Uint8Array): Buffer {
  assertKey(key);
  const buf = Buffer.from(blob);
  if (buf.length < HEADER_LEN || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new DecryptionError('not a Ghosty encrypted blob (bad magic)');
  }
  const iv = buf.subarray(MAGIC.length, MAGIC.length + IV_LEN);
  const tag = buf.subarray(MAGIC.length + IV_LEN, HEADER_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(buf.subarray(HEADER_LEN)), decipher.final()]);
  } catch (err) {
    throw new DecryptionError('decryption failed: wrong key or tampered blob', { cause: err });
  }
}

export function encryptJson(key: Uint8Array, value: unknown): Buffer {
  return encryptBytes(key, Buffer.from(JSON.stringify(value), 'utf8'));
}

export function decryptJson(key: Uint8Array, blob: Uint8Array): unknown {
  return JSON.parse(decryptBytes(key, blob).toString('utf8'));
}

/**
 * Memory key: OG_MEMORY_KEY (64 hex chars) if set, else sha256("ghosty:memory:v1:" + OG_PRIVATE_KEY).
 * The derived key is stable for a given wallet, so memory survives restarts without another secret.
 */
export function deriveMemoryKey(opts: { memoryKeyHex?: string; privateKey?: string }): Buffer {
  if (opts.memoryKeyHex) {
    const hex = opts.memoryKeyHex.trim().replace(/^0x/i, '');
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('OG_MEMORY_KEY must be 32 bytes as 64 hex chars');
    return Buffer.from(hex, 'hex');
  }
  if (opts.privateKey) {
    const pk = opts.privateKey.trim().replace(/^0x/i, '').toLowerCase();
    return createHash('sha256').update(`ghosty:memory:v1:${pk}`).digest();
  }
  throw new Error('memory key needs OG_MEMORY_KEY or OG_PRIVATE_KEY');
}

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function assertKey(key: Uint8Array): void {
  if (key.length !== 32) throw new Error(`AES-256 key must be 32 bytes, got ${key.length}`);
}
