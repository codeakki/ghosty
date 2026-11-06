import { useEffect, useRef, useState } from 'react';
import type { Alert } from '../api/types';
import { beep } from '../lib/audio';
import { formatConfidence, formatSignal, formatUsd } from '../lib/format';
import type { ActionOutcome } from '../state/useTerminal';

/**
 * What the pod would say out loud, as a banner. Announced through an assertive live region,
 * with a soft beep (once the page has had a click, as browsers require).
 */
export function AlertBanner(props: {
  alert: Alert | null;
  safeStop: boolean;
  onConfirm: () => Promise<ActionOutcome>;
  onAck: (id: string) => Promise<ActionOutcome>;
  onDismiss: (id: string) => void;
}) {
  const { alert } = props;
  const lastId = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (alert && alert.id !== lastId.current) {
      lastId.current = alert.id;
      beep();
    }
  }, [alert]);

  return (
    <div className="alert-region" aria-live="assertive" aria-atomic="true">
      {alert ? (
        <div className="alert-banner">
          <div className="alert-icon" aria-hidden="true">
            !
          </div>
          <div className="alert-body">
            <p className="alert-title">
              <span className="alert-id num">{alert.id}</span> {formatSignal(alert.signal)} · {formatConfidence(alert.confidence)}
            </p>
            <p className="alert-text">“{alert.text}”</p>
            {alert.actions.length > 0 ? (
              <p className="alert-legs num">
                {alert.actions.map((a) => `${a.side === 'long' ? '▲ Long' : '▼ Short'} ${a.coin} ${formatUsd(a.sizeUsd)}`).join('  ·  ')}
              </p>
            ) : null}
          </div>
          <div className="alert-actions">
            <button
              type="button"
              className="btn btn-confirm"
              disabled={busy || props.safeStop}
              onClick={async () => {
                setBusy(true);
                await props.onConfirm();
                setBusy(false);
              }}
            >
              {busy ? 'Executing…' : '✓ Confirm'}
            </button>
            <button type="button" className="btn" onClick={() => void props.onAck(alert.id)} title="POST /alerts/:id/ack">
              Mark Heard
            </button>
            <button type="button" className="icon-btn" onClick={() => props.onDismiss(alert.id)} aria-label="Dismiss alert banner">
              <span aria-hidden="true">✕</span>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
