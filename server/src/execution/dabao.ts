import { createL1ActionHash } from '@nktkas/hyperliquid/signing';
import { hashTypedData, recoverAddress, type Hex } from 'viem';

/**
 * Hyperliquid orders signed on the Dabao (Baochip-1x) next to the pod, never on the server.
 *
 * The server sends the order FIELDS in a frame; the Dabao checks them against its own limits (per order, per day,
 * speed), rebuilds the exact bytes Hyperliquid hashes and returns r||s. Its key never leaves the chip. The C side is
 * firmware/dabao/ghosty_signer/hl_signer.c; both must produce the same digest for the same fields.
 *
 * Frame: 0xA5 | type u8 | len u16 LE | payload | crc16 u16 LE (CRC-16/CCITT-FALSE over type, len, payload).
 */

export const FRAME_START = 0xa5;
export const CMD_GET_INFO = 0x01;
export const CMD_SIGN_ORDER = 0x02;
export const RSP_INFO = 0x81;
export const RSP_SIGNATURE = 0x82;
export const RSP_ERROR = 0xff;

/** Error codes from hl_signer.h, as the speaker should say them. */
export const DABAO_ERRORS: Record<number, string> = {
  1: 'the signer got a damaged message',
  2: 'the signer did not know the command',
  3: 'the signer rejected a malformed order',
  4: 'the signer does not allow this asset',
  5: 'the order is above the signer limit',
  6: 'the signer is set to a different network',
  7: 'the signer saw an old nonce',
  8: 'nobody pressed the signer button in time',
  9: 'the signer has no key',
  10: 'the signer failed to sign',
  11: 'the order would pass the signer daily limit of 50 dollars',
  12: 'the signer allows one order every 10 seconds',
};

/** Exactly what the Dabao signs: one IOC limit order, no vault, no expiry. */
export interface HlOrderFields {
  asset: number;
  isBuy: boolean;
  /** Hyperliquid wire decimal strings ("4106", "0.0025"). */
  px: string;
  sz: string;
  /** ms timestamp, also the /exchange nonce. */
  nonce: number;
  testnet: boolean;
  /** Close-only order: it can only shrink a position. The Dabao exempts it from its spend limits. */
  reduceOnly?: boolean;
}

export function crc16(data: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

export function encodeFrame(type: number, payload: Uint8Array = new Uint8Array()): Buffer {
  const out = Buffer.alloc(6 + payload.length);
  out[0] = FRAME_START;
  out[1] = type;
  out.writeUInt16LE(payload.length, 2);
  out.set(payload, 4);
  out.writeUInt16LE(crc16(out.subarray(1, 4 + payload.length)), 4 + payload.length);
  return out;
}

export class DabaoFrameError extends Error {
  override readonly name = 'DabaoFrameError';
}

/** First valid frame in `data` (bytes before it, like boot text, are skipped). */
export function decodeFrame(data: Uint8Array): { type: number; payload: Buffer } {
  const buf = Buffer.from(data);
  for (let i = buf.indexOf(FRAME_START); i >= 0 && i + 6 <= buf.length; i = buf.indexOf(FRAME_START, i + 1)) {
    const len = buf.readUInt16LE(i + 2);
    if (i + 6 + len > buf.length) continue;
    if (crc16(buf.subarray(i + 1, i + 4 + len)) !== buf.readUInt16LE(i + 4 + len)) continue;
    return { type: buf[i + 1]!, payload: buf.subarray(i + 4, i + 4 + len) };
  }
  throw new DabaoFrameError('no valid frame from the signer');
}

export function encodeSignRequest(f: HlOrderFields): Buffer {
  const px = Buffer.from(f.px, 'ascii');
  const sz = Buffer.from(f.sz, 'ascii');
  // The reduce-only byte is sent only when set, so older Dabao firmware still parses opening orders.
  const p = Buffer.alloc(14 + 1 + px.length + 1 + sz.length + (f.reduceOnly ? 1 : 0));
  p.writeUInt32LE(f.asset, 0);
  p[4] = f.isBuy ? 1 : 0;
  p[5] = f.testnet ? 1 : 0;
  p.writeBigUInt64LE(BigInt(f.nonce), 6);
  p[14] = px.length;
  px.copy(p, 15);
  p[15 + px.length] = sz.length;
  sz.copy(p, 16 + px.length);
  if (f.reduceOnly) p[16 + px.length + sz.length] = 1;
  return encodeFrame(CMD_SIGN_ORDER, p);
}

/** The /exchange action for these fields, keys in Hyperliquid's canonical order. */
export function orderAction(f: HlOrderFields) {
  return {
    type: 'order' as const,
    orders: [{ a: f.asset, b: f.isBuy, p: f.px, s: f.sz, r: f.reduceOnly ?? false, t: { limit: { tif: 'Ioc' as const } } }],
    grouping: 'na' as const,
  };
}

/** The EIP-712 digest Hyperliquid verifies, computed with the SDK's own L1 action hash. */
export function orderDigest(f: HlOrderFields): Hex {
  const connectionId = createL1ActionHash({ action: orderAction(f), nonce: f.nonce }) as Hex;
  return hashTypedData({
    domain: { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: '0x0000000000000000000000000000000000000000' },
    types: { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] },
    primaryType: 'Agent',
    message: { source: f.testnet ? 'b' : 'a', connectionId },
  });
}

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

export interface HlSignature {
  r: Hex;
  s: Hex;
  v: 27 | 28;
}

/**
 * Turn the Dabao's r||s into an /exchange signature: low-s form, and the v that recovers `signer`.
 * Throws if no v recovers the expected address, so a wrong or tampered signature never reaches Hyperliquid.
 */
export async function toExchangeSignature(digest: Hex, rs: Uint8Array, signer: string): Promise<HlSignature> {
  if (rs.length !== 64) throw new DabaoFrameError(`signature must be 64 bytes, got ${rs.length}`);
  const r = BigInt(`0x${Buffer.from(rs.subarray(0, 32)).toString('hex')}`);
  let s = BigInt(`0x${Buffer.from(rs.subarray(32)).toString('hex')}`);
  if (s > SECP256K1_N / 2n) s = SECP256K1_N - s;
  const hex = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
  for (const v of [27, 28] as const) {
    const signature = { r: hex(r), s: hex(s), v: BigInt(v) };
    const addr = await recoverAddress({ hash: digest, signature }).catch(() => undefined);
    if (addr && addr.toLowerCase() === signer.toLowerCase()) return { r: hex(r), s: hex(s), v };
  }
  throw new DabaoFrameError('signature does not match the Dabao address');
}

/** `0x…` address from a GET_INFO reply payload. */
export function infoAddress(payload: Uint8Array): Hex {
  return `0x${Buffer.from(payload.subarray(0, 20)).toString('hex')}`;
}
