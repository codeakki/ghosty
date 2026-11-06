import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrivateKey } from '@hiero-ledger/sdk';

/** Shared Hedera helpers for the x402 server, the paying client and the HCS audit log. */

export type HederaNetworkName = 'testnet' | 'mainnet';
export type HederaCaip2 = 'hedera:testnet' | 'hedera:mainnet';

/** x402 uses `0.0.0` as the asset id for native HBAR; amounts are tinybars. */
export const HBAR_ASSET_ID = '0.0.0';
export const TINYBAR_PER_HBAR = 100_000_000;

/** Local, gitignored state directory: server/.ghosty (resolved from this file, works from src/ and dist/). */
export const DEFAULT_STATE_DIR = fileURLToPath(new URL('../../.ghosty/', import.meta.url));

export function caip2(network: HederaNetworkName): HederaCaip2 {
  return `hedera:${network}`;
}

/**
 * Parse a Hedera private key. DER strings (302e…/3030…) carry their type. Raw 32-byte hex
 * (optionally 0x-prefixed, as shown by portal.hedera.com for ECDSA accounts) is ambiguous, so
 * the caller says which curve it is.
 */
export function parseHederaKey(raw: string, keyType: 'ecdsa' | 'ed25519' = 'ecdsa'): PrivateKey {
  const s = raw.trim().replace(/^0x/i, '');
  if (/^[0-9a-f]{64}$/i.test(s)) {
    return keyType === 'ed25519' ? PrivateKey.fromStringED25519(s) : PrivateKey.fromStringECDSA(s);
  }
  return PrivateKey.fromStringDer(s);
}

/**
 * HashScan link for a transaction id. Facilitators return the SDK form `0.0.123@1700000000.123456789`;
 * HashScan (like the mirror node) uses `0.0.123-1700000000-123456789`.
 */
export function hashscanTxUrl(txId: string, network: HederaNetworkName = 'testnet'): string {
  const m = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/.exec(txId.trim());
  const id = m ? `${m[1]}-${m[2]}-${m[3]}` : txId.trim();
  return `https://hashscan.io/${network}/transaction/${encodeURIComponent(id)}`;
}

export function hashscanTopicUrl(topicId: string, network: HederaNetworkName = 'testnet'): string {
  return `https://hashscan.io/${network}/topic/${encodeURIComponent(topicId)}`;
}

export function readJsonFile<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Write-then-rename so a crash mid-write never leaves a truncated state file. */
export function writeJsonFile(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}
