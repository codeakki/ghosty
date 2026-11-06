import { memo, useState } from 'react';
import { formatAge, shortId } from '../lib/format';
import { useNow } from '../lib/useNow';
import { PROOF_KIND_LABEL, selectProofs, type ProofKind } from '../state/proofs';
import type { TerminalState } from '../state/reducer';
import type { ActionOutcome } from '../state/useTerminal';
import { CopyButton, Empty, ExternalLink, Panel, Tag } from './ui';

const KIND_TONE: Record<ProofKind, 'accent' | 'info' | 'stub' | 'warn' | 'ok'> = {
  '0g-compute': 'accent',
  '0g-storage': 'accent',
  hedera: 'info',
  hyperliquid: 'ok',
  uniswap: 'stub',
};

export const ProofLog = memo(function ProofLog(props: { state: TerminalState; onPay: () => Promise<ActionOutcome> }) {
  const now = useNow(5000);
  const proofs = selectProofs(props.state);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ActionOutcome | null>(null);
  const safeStop = props.state.snapshot?.safeStop === true;
  const x402 = props.state.x402;

  const pay = async () => {
    setBusy(true);
    setOutcome(null);
    setOutcome(await props.onPay());
    setBusy(false);
  };

  return (
    <Panel
      id="proofs"
      title="Proof log"
      hint="Evidence for judges: ids you can open on each explorer, newest first"
      className="panel-proofs"
      actions={
        <button
          type="button"
          className="btn btn-small"
          onClick={() => void pay()}
          disabled={busy}
          title={x402 ? `Agent pays /signal via x402 on ${x402.network} (${x402.mode})` : 'Agent pays /signal via x402'}
        >
          {busy ? 'Paying…' : 'Pay for Signal (x402)'}
        </button>
      }
    >
      <p className={`outcome ${outcome ? (outcome.ok ? 'outcome-ok' : 'outcome-bad') : ''}`} aria-live="polite">
        {outcome?.message ?? ''}
      </p>
      {proofs.length === 0 ? (
        <Empty tone="info" title="No proofs yet">
          Each decision adds a 0G request id and an episode on 0G Storage; a press adds Hyperliquid and Uniswap ids; “Pay for
          Signal” adds a Hedera transaction.{safeStop ? ' Safe-stop is on, so nothing new is produced.' : ''}
        </Empty>
      ) : (
        <ol className="proof-list" aria-label="Proofs, newest first">
          {proofs.map((p) => (
            <li key={p.key} className="proof">
              <div className="proof-top">
                <Tag tone={KIND_TONE[p.kind]}>{PROOF_KIND_LABEL[p.kind]}</Tag>
                {p.simulated ? (
                  <Tag tone="muted" title="Produced by a stub provider; not on any chain">
                    SIMULATED
                  </Tag>
                ) : null}
                <span className="proof-label">{p.label}</span>
                <time className="proof-age muted num" dateTime={p.at}>
                  {formatAge(p.at, now)}
                </time>
              </div>
              <div className="proof-value">
                {p.href ? (
                  <ExternalLink href={p.href} label={`Open ${PROOF_KIND_LABEL[p.kind]} ${p.label} in explorer`}>
                    <code translate="no" title={p.value}>{shortId(p.value, 12, 8)}</code>
                  </ExternalLink>
                ) : (
                  <code translate="no" title={p.value}>{shortId(p.value, 12, 8)}</code>
                )}
                <CopyButton value={p.value} label={`${PROOF_KIND_LABEL[p.kind]} id`} />
              </div>
            </li>
          ))}
        </ol>
      )}
      {x402?.hcsTopicUrl ? (
        <p className="small">
          <ExternalLink href={x402.hcsTopicUrl}>HCS payment audit topic</ExternalLink>
        </p>
      ) : null}
    </Panel>
  );
});
