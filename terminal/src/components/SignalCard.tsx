import { memo, useState } from 'react';
import type { DecisionEntry, PlannedAction } from '../api/types';
import { formatAge, formatSignal, formatUsd, shortId, splitCoin } from '../lib/format';
import { useNow } from '../lib/useNow';
import type { TerminalState } from '../state/reducer';
import type { ActionOutcome } from '../state/useTerminal';
import { CopyButton, Empty, Panel, Tag } from './ui';

function ConfidenceMeter({ value }: { value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  const band = pct >= 70 ? 'high' : pct >= 40 ? 'mid' : 'low';
  return (
    <div className="meter-wrap">
      <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Confidence">
        <div className={`meter-fill meter-${band}`} style={{ transform: `scaleX(${pct / 100})` }} />
      </div>
      <span className="meter-value num">{pct}%</span>
      <span className="meter-band">{band === 'high' ? 'high' : band === 'mid' ? 'medium' : 'low'}</span>
    </div>
  );
}

function Ticket({ actions, spotLeg }: { actions: PlannedAction[]; spotLeg: boolean }) {
  const total = actions.reduce((s, a) => s + a.sizeUsd, 0);
  return (
    <div className="table-scroll">
      <table className="ticket">
        <caption className="sr-only">Suggested order legs</caption>
        <thead>
          <tr>
            <th scope="col">Venue</th>
            <th scope="col">Market</th>
            <th scope="col">Side</th>
            <th scope="col" className="num-col">
              Size USD
            </th>
            <th scope="col" className="why-col hide-sm">
              Why
            </th>
          </tr>
        </thead>
        <tbody>
          {spotLeg ? (
            <tr>
              <td>Uniswap</td>
              <td className="mono">spot leg</td>
              <td>
                <span className="side side-swap">⇄ Swap</span>
              </td>
              <td className="num-col muted">config</td>
              <td className="why-col hide-sm">Runs first through the Trading API (UNISWAP_SPOT_LEG)</td>
            </tr>
          ) : null}
          {actions.map((a, i) => {
            const { ticker, dex } = splitCoin(a.coin);
            return (
              <tr key={`${a.coin}-${i}`}>
                <td>Hyperliquid</td>
                <td className="mono">
                  {dex ? <span className="dex">{dex}:</span> : null}
                  {ticker}
                </td>
                <td>
                  <span className={`side side-${a.side}`}>
                    <span aria-hidden="true">{a.side === 'long' ? '▲' : '▼'}</span> {a.side === 'long' ? 'Long' : 'Short'}
                  </span>
                </td>
                <td className="num-col num">{formatUsd(a.sizeUsd)}</td>
                <td className="why-col hide-sm">{a.reason}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={3}>
              Total notional
            </th>
            <td className="num-col num">{formatUsd(total)}</td>
            <td className="why-col hide-sm muted">capped by MAX_TRADE_USD</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function DecisionHead({ d, stub, now }: { d: DecisionEntry; stub: boolean; now: number }) {
  return (
    <div className="signal-head">
      <div className="signal-name">
        <span className={`signal-dot signal-${d.signal}`} aria-hidden="true" />
        <h3>{formatSignal(d.signal)}</h3>
        <Tag tone="muted">via {d.trigger}</Tag>
        {stub ? (
          <Tag tone="stub" title="Stub decider, not 0G Compute. Set OG_API_KEY.">
            STUB BRAIN
          </Tag>
        ) : (
          <Tag tone="accent">0G Compute</Tag>
        )}
      </div>
      <div className="signal-req">
        <span className="muted">req</span>
        <code translate="no" title={d.requestId}>{shortId(d.requestId, 10, 6)}</code>
        <CopyButton value={d.requestId} label="0G request id" />
        <time className="muted num" dateTime={d.at}>
          {formatAge(d.at, now)}
        </time>
      </div>
    </div>
  );
}

export const SignalCard = memo(function SignalCard(props: {
  state: TerminalState;
  onButton: (action: 'confirm' | 'cancel') => Promise<ActionOutcome>;
}) {
  const { state } = props;
  const now = useNow(5000);
  const [busy, setBusy] = useState<'confirm' | 'cancel' | null>(null);
  const [outcome, setOutcome] = useState<ActionOutcome | null>(null);
  const snap = state.snapshot;
  const d = snap?.lastDecision ?? null;
  const safeStop = snap?.safeStop === true || state.health?.safeStop === true;
  const pending = snap?.plannedActions ?? [];
  const legs = pending.length > 0 ? pending : state.decisionActions;
  const stub = state.zeroG?.computeMode === 'fake' || (d?.requestId.startsWith('fake-') ?? false);
  const spotLeg = state.execution?.spotLeg != null;

  const press = async (action: 'confirm' | 'cancel') => {
    setBusy(action);
    setOutcome(null);
    setOutcome(await props.onButton(action));
    setBusy(null);
  };

  const lb = state.lastButton;
  const executedNow = lb && d && lb.result.requestId === d.requestId;

  return (
    <Panel
      id="signal"
      title="Signal"
      hint="What the 0G brain decided and the trade it suggests"
      className="panel-signal"
      actions={pending.length > 0 && !safeStop ? <Tag tone="warn">◷ Awaiting your press</Tag> : null}
    >
      {safeStop ? (
        <Empty tone="bad" title="Brain offline: trading blocked (safe-stop)">
          0G is unreachable (or simulated off). Ghosty never fakes a decision: Confirm returns 503 and no order is sent. Turn off
          Safe-stop in the top bar to resume.
        </Empty>
      ) : null}

      {!snap ? (
        <Empty title="Connecting to the pod state…" />
      ) : !d ? (
        <Empty tone="info" title="No decision yet">
          Inject a manual test headline, ask the virtual pod a question, or press Confirm: with nothing pending the brain decides
          from the current news.
        </Empty>
      ) : (
        <div className="signal">
          <DecisionHead d={d} stub={stub} now={now} />
          {d.headline ? (
            <p className="signal-headline">
              <span className="muted">On:</span> {d.headline}
            </p>
          ) : null}
          {d.transcript ? (
            <p className="signal-headline">
              <span className="muted">Asked:</span> “{d.transcript}”
            </p>
          ) : null}
          <ConfidenceMeter value={d.confidence} />
          <p className="rationale">{d.rationale}</p>
          {d.signal === 'none' ? (
            <p className="muted small">No actionable signal: nothing to trade.</p>
          ) : legs.length > 0 ? (
            <Ticket actions={legs} spotLeg={spotLeg} />
          ) : (
            <p className="muted small">No legs: the playbook produced no order for this signal.</p>
          )}
          {executedNow && pending.length === 0 ? (
            <p className={`exec-note ${lb.result.action === 'confirm' ? 'exec-ok' : 'exec-cancel'}`}>
              {lb.result.action === 'confirm'
                ? `Confirmed · ${lb.result.orders.length} order(s): ${lb.result.orders.map((o) => `${o.coin} ${o.status}`).join(', ') || 'none'}`
                : 'Cancelled by the wearer · logged as an episode'}
            </p>
          ) : null}
        </div>
      )}

      <div className="pod-buttons" role="group" aria-label="Pod button">
        <button
          type="button"
          className="btn btn-confirm btn-big"
          onClick={() => void press('confirm')}
          disabled={busy !== null || safeStop}
          aria-describedby="pod-button-help"
        >
          {busy === 'confirm' ? 'Executing…' : '✓ Confirm'}
        </button>
        <button
          type="button"
          className="btn btn-cancel btn-big"
          onClick={() => void press('cancel')}
          disabled={busy !== null || safeStop}
          aria-describedby="pod-button-help"
        >
          {busy === 'cancel' ? 'Cancelling…' : '✕ Cancel'}
        </button>
      </div>
      <p id="pod-button-help" className="field-help">
        Mirrors the pod's one button (POST /button).{' '}
        {pending.length === 0 && !safeStop ? 'Nothing pending: Confirm decides from current news first. ' : ''}
        Orders use the server's venue: {state.execution ? (state.execution.perpMode === 'real' ? 'Hyperliquid (real)' : 'simulated (no HL keys)') : '…'}.
      </p>
      <p className={`outcome ${outcome ? (outcome.ok ? 'outcome-ok' : 'outcome-bad') : ''}`} aria-live="polite">
        {outcome?.message ?? ''}
      </p>
    </Panel>
  );
});
