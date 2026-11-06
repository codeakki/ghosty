import { HBAR_ASSET_ID, toMirrorTxId } from './hedera.js';

/**
 * Hedera mirror node reads (public REST API, no key). Three jobs:
 * 1. verifyPaymentOnMirror: after the facilitator says "settled", independently confirm on chain that the
 *    transaction succeeded and moved the right amount of the right asset from the agent to the merchant.
 *    Only then is a payment marked `verified: true`.
 * 2. readTopicMessages: read the HCS audit topic back (GET /hedera/audit).
 * 3. accountInfo / tokenBalance: what `npm run hedera:setup` checks before creating anything.
 */

export interface ExpectedTransfer {
  /** Facilitator tx id, either `0.0.x@s.n` or `0.0.x-s-n`. */
  txId: string;
  payer: string;
  payTo: string;
  /** `0.0.0` for HBAR, or an HTS token id. */
  asset: string;
  /** Atomic units: tinybars or token micro-units. */
  amount: string;
}

export type Verification =
  | { verified: true; consensusTimestamp: string; checkedAt: string }
  | { verified: false; reason: string; checkedAt: string };

export interface MirrorOptions {
  /** Mirror node base URL, e.g. https://testnet.mirrornode.hedera.com */
  mirrorUrl: string;
  fetch?: typeof globalThis.fetch;
}

export interface VerifyOptions extends MirrorOptions {
  /** Give up after this long (default 15 s). */
  timeoutMs?: number;
  /** Poll interval (default 1 s). The mirror node usually has the tx 3-6 s after consensus. */
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface MirrorTransaction {
  result?: string;
  consensus_timestamp?: string;
  transfers?: Array<{ account: string; amount: number }>;
  token_transfers?: Array<{ token_id: string; account: string; amount: number }>;
}

/**
 * Check one mirror-node transaction against what we expected to pay. Pure, so tests can feed it JSON.
 * Returns undefined when it matches, or the reason it does not.
 */
export function checkTransfer(tx: MirrorTransaction, expected: ExpectedTransfer): string | undefined {
  if (tx.result !== 'SUCCESS') return `result ${tx.result ?? 'missing'}`;
  const amount = BigInt(expected.amount);
  const moves =
    expected.asset === HBAR_ASSET_ID
      ? (tx.transfers ?? []).map((t) => ({ account: t.account, amount: BigInt(t.amount) }))
      : (tx.token_transfers ?? []).filter((t) => t.token_id === expected.asset).map((t) => ({ account: t.account, amount: BigInt(t.amount) }));
  const received = moves.filter((m) => m.account === expected.payTo).reduce((sum, m) => sum + m.amount, 0n);
  const sent = moves.filter((m) => m.account === expected.payer).reduce((sum, m) => sum + m.amount, 0n);
  if (received !== amount) return `payTo ${expected.payTo} received ${received}, expected ${amount} of ${expected.asset}`;
  if (sent > -amount) return `payer ${expected.payer} sent ${-sent}, expected at least ${amount} of ${expected.asset}`;
  return undefined;
}

/** Poll GET /api/v1/transactions/{id} until the transfer is confirmed, contradicted, or the timeout passes. */
export async function verifyPaymentOnMirror(expected: ExpectedTransfer, opts: VerifyOptions): Promise<Verification> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.timeoutMs ?? 15_000);
  const url = `${opts.mirrorUrl}/api/v1/transactions/${encodeURIComponent(toMirrorTxId(expected.txId))}`;
  const checkedAt = () => new Date(now()).toISOString();
  let lastProblem = 'not on the mirror node yet';

  while (true) {
    try {
      const res = await doFetch(url, { headers: { accept: 'application/json' } });
      if (res.ok) {
        const body = (await res.json()) as { transactions?: MirrorTransaction[] };
        const txs = body.transactions ?? [];
        // A tx id can map to several records (e.g. child records); the payment is the one that matches.
        const problems = txs.map((tx) => checkTransfer(tx, expected));
        const ok = txs.find((_tx, i) => problems[i] === undefined);
        if (ok) return { verified: true, consensusTimestamp: ok.consensus_timestamp ?? '', checkedAt: checkedAt() };
        // A final, failed or mismatching record will not change: stop polling.
        if (txs.length > 0) return { verified: false, reason: problems[0] ?? 'no matching transfer', checkedAt: checkedAt() };
      } else if (res.status !== 404) {
        lastProblem = `mirror node answered ${res.status}`;
      }
    } catch (err) {
      lastProblem = `mirror node unreachable: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (now() >= deadline) return { verified: false, reason: `timeout: ${lastProblem}`, checkedAt: checkedAt() };
    await sleep(opts.intervalMs ?? 1000);
  }
}

export interface TopicMessage {
  sequenceNumber: number;
  consensusTimestamp: string;
  /** Raw message text (base64-decoded). */
  text: string;
}

/** Newest-first messages of an HCS topic (GET /api/v1/topics/{id}/messages). */
export async function readTopicMessages(topicId: string, limit: number, opts: MirrorOptions): Promise<TopicMessage[]> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const url = `${opts.mirrorUrl}/api/v1/topics/${encodeURIComponent(topicId)}/messages?limit=${limit}&order=desc`;
  const res = await doFetch(url, { headers: { accept: 'application/json' } });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`mirror node answered ${res.status} for topic ${topicId}`);
  const body = (await res.json()) as { messages?: Array<{ sequence_number: number; consensus_timestamp: string; message: string }> };
  return (body.messages ?? []).map((m) => ({
    sequenceNumber: m.sequence_number,
    consensusTimestamp: m.consensus_timestamp,
    text: Buffer.from(m.message, 'base64').toString('utf8'),
  }));
}

/** HBAR balance (tinybars) of an account, or undefined when it does not exist. */
export async function accountTinybar(accountId: string, opts: MirrorOptions): Promise<bigint | undefined> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const res = await doFetch(`${opts.mirrorUrl}/api/v1/accounts/${encodeURIComponent(accountId)}`);
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`mirror node answered ${res.status} for account ${accountId}`);
  const body = (await res.json()) as { balance?: { balance?: number } };
  return BigInt(body.balance?.balance ?? 0);
}

/** Token balance in atomic units, or undefined when the account is not associated with the token. */
export async function tokenBalance(accountId: string, tokenId: string, opts: MirrorOptions): Promise<bigint | undefined> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const res = await doFetch(`${opts.mirrorUrl}/api/v1/accounts/${encodeURIComponent(accountId)}/tokens?token.id=${encodeURIComponent(tokenId)}`);
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`mirror node answered ${res.status} for ${accountId} tokens`);
  const body = (await res.json()) as { tokens?: Array<{ token_id: string; balance: number }> };
  const row = body.tokens?.find((t) => t.token_id === tokenId);
  return row ? BigInt(row.balance) : undefined;
}
