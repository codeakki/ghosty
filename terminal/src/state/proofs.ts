import type { TerminalState } from './reducer';

/**
 * "Evidence for judges": every verifiable id the system produced, newest first, with an explorer link
 * when one exists. Simulated ids (stub providers) are labelled and never linked.
 */

export type ProofKind = '0g-compute' | '0g-storage' | 'hedera' | 'hyperliquid' | 'uniswap';

export interface Proof {
  key: string;
  kind: ProofKind;
  /** What the id proves, in a few words. */
  label: string;
  value: string;
  href?: string;
  at: string;
  simulated: boolean;
}

export const PROOF_KIND_LABEL: Record<ProofKind, string> = {
  '0g-compute': '0G Compute',
  '0g-storage': '0G Storage',
  hedera: 'Hedera x402',
  hyperliquid: 'Hyperliquid',
  uniswap: 'Uniswap',
};

const PROOF_LIMIT = 60;

/** chainscan base from the storagescan base the server reports (Galileo vs mainnet). */
export function chainscanBase(storagescan: string | undefined): string {
  if (!storagescan) return 'https://chainscan-galileo.0g.ai';
  return storagescan.replace('storagescan', 'chainscan');
}

function isFakeId(id: string): boolean {
  return /^fake[-_]/i.test(id);
}

export function selectProofs(state: TerminalState): Proof[] {
  const snap = state.snapshot;
  const out: Proof[] = [];
  const storagescan = state.zeroG?.links.storagescan;
  const chainscan = chainscanBase(storagescan);
  const computeStub = state.zeroG?.computeMode === 'fake';

  // 0G Compute request ids + 0G Storage roots, from the episode log (one record per decision).
  const seenRequest = new Set<string>();
  for (const ep of snap?.episodes ?? []) {
    if (!seenRequest.has(ep.requestId)) {
      seenRequest.add(ep.requestId);
      const trace = ep.decision?.zeroG;
      out.push({
        key: `req:${ep.requestId}`,
        kind: '0g-compute',
        label: trace ? `inference · ${trace.model}` : 'decision request id',
        value: trace?.traceRequestId ?? ep.requestId,
        at: ep.at,
        simulated: isFakeId(ep.requestId) || (computeStub && !trace),
      });
    }
    if (ep.rootHash) {
      out.push({
        key: `root:${ep.seq}`,
        kind: '0g-storage',
        label: `episode #${ep.seq} root`,
        value: ep.rootHash,
        href: ep.txHash ? `${chainscan}/tx/${ep.txHash}` : storagescan,
        at: ep.at,
        simulated: false,
      });
    }
  }

  // Hedera x402 payment (the server keeps the latest).
  const payment = state.x402?.lastPayment ?? state.lastPayment?.result ?? null;
  if (payment) {
    const simulated = payment.mode === 'fake';
    out.push({
      key: `hbar:${payment.txId}`,
      kind: 'hedera',
      label: 'paid /signal',
      value: payment.txId,
      href: simulated ? undefined : payment.hashscanUrl,
      at: payment.at,
      simulated,
    });
  }

  // Hyperliquid orders.
  for (const o of snap?.orders ?? []) {
    if (!o.orderId) continue;
    const simulated = o.status === 'simulated' || isFakeId(o.orderId);
    out.push({
      key: `hl:${o.orderId}`,
      kind: 'hyperliquid',
      label: `${o.isBuy ? 'long' : 'short'} ${o.coin} · ${o.status}`,
      value: o.orderId,
      href: simulated ? undefined : o.url,
      at: o.at,
      simulated,
    });
  }

  // Uniswap spot legs.
  for (const s of snap?.swaps ?? []) {
    if (!s.result) continue;
    const simulated = s.result.status === 'simulated';
    out.push({
      key: `uni:${s.result.txHash}`,
      kind: 'uniswap',
      label: `swap · ${s.result.status}`,
      value: s.result.txHash,
      href: simulated ? undefined : s.result.explorerUrl,
      at: s.at,
      simulated,
    });
  }

  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, PROOF_LIMIT);
}
