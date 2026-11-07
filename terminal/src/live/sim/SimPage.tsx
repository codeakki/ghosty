import { useState, type ReactNode } from 'react';
import type { SimDecisionRow, SimExecution, SimLiveOrder, SimRun, SimScenario } from '../../api/types';
import { Link } from '../Link';
import type { LiveApi } from '../useLive';
import { coinName, formatAssetPx, formatUsdAmount } from '../words';
import {
  bannerText,
  direction,
  formatDateRange,
  formatPnlUsd,
  formatSimClock,
  formatSimDay,
  isActive,
  pctOf,
  runStatusText,
  SPEEDS,
  summaryLine,
  vsHold,
  type SimState,
  type SpeedId,
} from './simState';

/**
 * The persistent SIM banner: one fixed-height row under the nav while a run is active, on every tab, so a
 * simulation is never mistaken for live trading. The progress bar is a transform (no layout).
 */
export function SimBanner({ sim, onSimulate }: { sim: SimState; onSimulate: boolean }) {
  const run = sim.run;
  if (!isActive(run)) return null;
  const scenario = sim.scenarios?.find((s) => s.id === run.scenarioId);
  const pct = Math.round(run.progress * 100);
  return (
    <div className="lv-sim-banner" role="status" data-status={run.status} data-live={run.execution.liveOrders ? 'true' : undefined}>
      <p className="lv-sim-banner-text">
        <span className="lv-sim-tag">SIM</span>
        {run.execution.liveOrders ? <span className="lv-real-tag">REAL ORDERS</span> : null} {bannerText(run, scenario)}
      </p>
      {onSimulate ? null : (
        <Link to="/simulate" className="lv-sim-banner-link">
          Controls
        </Link>
      )}
      <div className="lv-sim-progress" role="progressbar" aria-label="Simulation progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <span className="lv-sim-progress-fill" style={{ transform: `scaleX(${run.progress})` }} />
      </div>
    </div>
  );
}

type OrderMode = 'paper' | 'live';

/** Simulate tab: pick a past scenario, a speed and how orders go out, run it, then replay the episode log. */
export function SimPanel({ api }: { api: LiveApi }) {
  const { sim, simControls } = api;
  const [picked, setPicked] = useState<string | null>(null);
  const [speed, setSpeed] = useState<SpeedId>('normal');
  const [mode, setMode] = useState<OrderMode>('paper');
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = sim.run;
  const active = isActive(run);
  const scenarios = sim.scenarios ?? [];
  const chosen = picked ?? scenarios[0]?.id ?? null;
  const execution = sim.execution;
  const live = mode === 'live' && execution?.available === true;

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const canStart = !busy && chosen !== null && sim.server === 'ready' && simControls.ready && (!live || ack);

  return (
    <section className="lv-sim" aria-labelledby="sim-title">
      <header className="lv-sim-head">
        <h2 id="sim-title" className="lv-sim-title">
          Simulate
        </h2>
        <p className="lv-sim-sub">Replay a real past news window through Ghosty, at real historical prices.</p>
      </header>

      {sim.server === 'missing' ? (
        <p className="lv-sim-notice" role="status">
          Simulation needs the server update. Pull the latest server and restart it.
        </p>
      ) : null}
      {sim.error && sim.server !== 'missing' ? (
        <p className="lv-sim-notice" role="alert">
          {sim.error}
        </p>
      ) : null}

      {active ? (
        <>
          <RunCard run={run} scenario={sim.scenarios?.find((s) => s.id === run.scenarioId)} busy={busy} api={api} act={act} />
          <Scoreboard run={run} labels={api.feed.labels} />
          {run.execution.liveOrders ? <RealOrders execution={run.execution} labels={api.feed.labels} /> : null}
          <Timeline rows={run.decisionList} total={run.headlines.total} />
        </>
      ) : sim.server === 'missing' ? null : (
        <>
          {sim.finished ? <Summary run={sim.finished} scenario={sim.scenarios?.find((s) => s.id === sim.finished?.scenarioId)} labels={api.feed.labels} /> : null}

          <Step n={1} label="Scenario">
            <ScenarioPicker scenarios={sim.scenarios} server={sim.server} chosen={chosen} onPick={setPicked} labels={api.feed.labels} />
          </Step>

          <Step n={2} label="Speed">
            <div className="lv-sim-seg" role="radiogroup" aria-label="Speed">
              {SPEEDS.map((s) => (
                <button key={s.id} type="button" role="radio" aria-checked={speed === s.id} className="lv-sim-seg-btn" onClick={() => setSpeed(s.id)}>
                  <span>{s.label}</span>
                  <span className="lv-num lv-sim-seg-sub">1 h in {Math.round(3600 / s.speed)} s</span>
                </button>
              ))}
            </div>
          </Step>

          <Step n={3} label="Orders">
            <OrderModePicker
              execution={execution}
              mode={mode}
              onMode={(m) => {
                setMode(m);
                setAck(false);
              }}
            />
            {live ? (
              <label className="lv-sim-ack">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                <span>
                  I understand each trade I confirm places a real {formatUsdAmount(execution!.orderUsd)} order per leg on Hyperliquid mainnet, up to{' '}
                  {formatUsdAmount(execution!.maxRunUsd)} for this run.
                </span>
              </label>
            ) : null}
          </Step>

          <button
            type="button"
            className={`lv-btn lv-btn-primary lv-sim-start${live ? ' lv-sim-start-live' : ''}`}
            disabled={!canStart}
            onClick={() => act(() => simControls.start(chosen!, SPEEDS.find((s) => s.id === speed)!.speed, live))}
          >
            {live ? 'Start with real orders' : 'Start simulation'}
          </button>
        </>
      )}

      <ReplayBox api={api} />
    </section>
  );
}

function Step({ n, label, children }: { n: number; label: string; children: ReactNode }) {
  return (
    <fieldset className="lv-sim-step">
      <legend className="lv-sim-label">
        <span className="lv-sim-step-n lv-num" aria-hidden="true">
          {n}
        </span>
        {label}
      </legend>
      {children}
    </fieldset>
  );
}

function ScenarioPicker({
  scenarios,
  server,
  chosen,
  onPick,
  labels,
}: {
  scenarios: SimScenario[] | null;
  server: SimState['server'];
  chosen: string | null;
  onPick: (id: string) => void;
  labels: Record<string, string>;
}) {
  if (scenarios === null) {
    return server === 'missing' ? null : (
      <ul className="lv-sim-scenarios" aria-label="Loading scenarios">
        <li className="lv-skel lv-sim-scenario-skel" />
        <li className="lv-skel lv-sim-scenario-skel" />
      </ul>
    );
  }
  if (scenarios.length === 0) return <p className="lv-sim-empty">No scenarios on the server yet.</p>;
  return (
    <ul className="lv-sim-scenarios" role="radiogroup" aria-label="Scenarios">
      {scenarios.map((s) => (
        <li key={s.id}>
          <button type="button" role="radio" className="lv-sim-scenario" aria-checked={chosen === s.id} onClick={() => onPick(s.id)}>
            <span className="lv-sim-scenario-top">
              <span className="lv-sim-scenario-title">{s.title}</span>
              {s.category ? <span className="lv-sim-cat">{s.category}</span> : null}
            </span>
            <span className="lv-sim-scenario-meta lv-num">
              {formatDateRange(s.start, s.end)} · {s.headlines.length} {s.headlines.length === 1 ? 'headline' : 'headlines'}
            </span>
            {s.description ? <span className="lv-sim-scenario-desc">{s.description}</span> : null}
            {s.markets.length > 0 ? (
              <span className="lv-sim-markets">
                {s.markets.map((m) => (
                  <span key={m} className="lv-sim-market" title={s.proxies[m] ?? undefined}>
                    {coinName(m, labels)}
                    {s.proxies[m] ? <span aria-label="price from a proxy">*</span> : null}
                  </span>
                ))}
              </span>
            ) : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

function OrderModePicker({ execution, mode, onMode }: { execution: SimExecution | null; mode: OrderMode; onMode: (m: OrderMode) => void }) {
  const available = execution?.available === true;
  return (
    <div className="lv-sim-modes" role="radiogroup" aria-label="Orders">
      <button type="button" role="radio" aria-checked={mode === 'paper' || !available} className="lv-sim-mode" onClick={() => onMode('paper')}>
        <span className="lv-sim-mode-title">Paper only</span>
        <span className="lv-sim-mode-desc">Fills at the historical price. No real money moves.</span>
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={mode === 'live' && available}
        className="lv-sim-mode lv-sim-mode-live"
        disabled={!available}
        onClick={() => onMode('live')}
      >
        <span className="lv-sim-mode-title">
          Paper + real orders <span className="lv-real-tag">MAINNET</span>
        </span>
        <span className="lv-sim-mode-desc">
          {available
            ? `Each confirmed leg also goes to Hyperliquid mainnet at today's price: ${formatUsdAmount(execution!.orderUsd)} per leg, at most ${formatUsdAmount(execution!.maxRunUsd)} per run.`
            : (execution?.unavailable ?? 'Checking whether the server allows real orders…')}
        </span>
      </button>
    </div>
  );
}

/** Scenario, historical clock, progress through the headlines, run status and controls. */
function RunCard({
  run,
  scenario,
  busy,
  api,
  act,
}: {
  run: SimRun;
  scenario: SimScenario | undefined;
  busy: boolean;
  api: LiveApi;
  act: (fn: () => Promise<void>) => Promise<void>;
}) {
  const { simControls } = api;
  const st = runStatusText(run);
  const start = Date.parse(run.start || scenario?.start || '');
  const end = Date.parse(run.end || scenario?.end || '');
  const ticks = scenario && Number.isFinite(start) && Number.isFinite(end) && end > start ? scenario.headlines.map((h) => (Date.parse(h.ts) - start) / (end - start)) : [];
  return (
    <section className="lv-sim-card lv-sim-run" aria-label="Simulation run">
      <div className="lv-sim-run-top">
        <span className="lv-sim-pill" data-tone={st.tone}>
          {st.label}
        </span>
        {run.execution.liveOrders ? <span className="lv-real-tag">Real orders · mainnet</span> : <span className="lv-sim-paper">Paper</span>}
        <div className="lv-sim-run-actions">
          {run.status === 'paused' ? (
            <button type="button" className="lv-btn lv-btn-primary lv-btn-sm" disabled={busy} onClick={() => act(() => simControls.control('resume'))}>
              Resume
            </button>
          ) : (
            <button type="button" className="lv-btn lv-btn-sm" disabled={busy} onClick={() => act(() => simControls.control('pause'))}>
              Pause
            </button>
          )}
          <button type="button" className="lv-btn lv-btn-sm" disabled={busy} onClick={() => act(() => simControls.control('stop'))}>
            Stop
          </button>
        </div>
      </div>

      <div className="lv-sim-run-what">
        <h3 className="lv-sim-card-title">{scenario?.title ?? 'Scenario'}</h3>
        <p className="lv-sim-clock lv-num">
          <span className="lv-sim-clock-day">{formatSimDay(run.simTime)}</span>
          <span className="lv-sim-clock-time">{formatSimClock(run.simTime)}</span>
        </p>
      </div>

      <div className="lv-sim-track" role="progressbar" aria-label="Run progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(run.progress * 100)}>
        <span className="lv-sim-track-fill" style={{ transform: `scaleX(${run.progress})` }} />
        {ticks.map((t, i) => (
          <span key={i} className="lv-sim-track-tick" data-done={i < run.headlines.delivered ? 'true' : undefined} style={{ left: `${Math.max(0, Math.min(1, t)) * 100}%` }} />
        ))}
      </div>
      <p className="lv-sim-hint lv-num">
        {run.headlines.delivered} of {run.headlines.total} headlines{run.speed > 0 ? ` · ${run.speed}×` : ''} · {Math.round(run.progress * 100)}%
      </p>

      {run.pending ? (
        <div className="lv-sim-callout" role="status">
          <p className="lv-sim-callout-title">Ghosty wants to trade. Confirm or skip on the pod.</p>
          <ul className="lv-sim-callout-list">
            {run.pending.actions.map((a, i) => (
              <li key={i}>
                <span className={`lv-sim-side lv-sim-side-${a.side}`}>{a.side === 'long' ? 'Long' : 'Short'}</span> {coinName(a.coin, api.feed.labels)} ·{' '}
                <span className="lv-num">{formatUsdAmount(a.sizeUsd)}</span> paper
                {run.execution.liveOrders ? (
                  <>
                    {' '}
                    + <span className="lv-num">{formatUsdAmount(run.execution.orderUsd)}</span> real on mainnet
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {run.error ? (
        <p className="lv-sim-notice" role="alert">
          {run.error}
        </p>
      ) : null}
    </section>
  );
}

function Signed({ value, text }: { value: number; text?: string }) {
  const dir = direction(value);
  return (
    <span className={`lv-num lv-sim-signed lv-sim-${dir}`}>
      {dir === 'flat' ? null : <span aria-hidden="true">{dir === 'up' ? '▲ ' : '▼ '}</span>}
      {text ?? formatPnlUsd(value)}
    </span>
  );
}

function Stat({ label, value, pct, text }: { label: string; value: number; pct: string | null; text?: string }) {
  return (
    <div className="lv-sim-stat">
      <dt>{label}</dt>
      <dd>
        <Signed value={value} text={text} />
      </dd>
      {pct !== null ? <dd className="lv-sim-stat-sub lv-num">{pct}</dd> : null}
    </div>
  );
}

/** Ghosty vs simply holding, and the paper positions. */
function Scoreboard({ run, labels }: { run: SimRun; labels: Record<string, string> }) {
  const edge = vsHold(run);
  return (
    <section className="lv-sim-card" aria-labelledby="sim-score-title">
      <div className="lv-sim-card-head">
        <h3 id="sim-score-title" className="lv-sim-card-title">
          Paper P&amp;L
        </h3>
        <span className="lv-sim-hint lv-num">
          {run.decisions} {run.decisions === 1 ? 'decision' : 'decisions'}
          {run.notionalUsd > 0 ? ` · % of ${formatUsdAmount(run.notionalUsd)}` : ''}
        </span>
      </div>
      <dl className="lv-sim-stats">
        <Stat label="Ghosty" value={run.pnlUsd} pct={pctOf(run, run.pnlUsd)} />
        <Stat label="Just holding" value={run.baselinePnlUsd} pct={pctOf(run, run.baselinePnlUsd)} />
        <Stat label="Ghosty vs hold" value={run.pnlUsd - run.baselinePnlUsd} pct={null} text={edge.text} />
      </dl>
      <div className="lv-sim-table-wrap">
        <table className="lv-sim-table">
          <caption className="lv-sr-only">Paper positions</caption>
          <colgroup>
            <col />
            <col className="lv-sim-col-side" />
            <col className="lv-sim-col-num" />
            <col className="lv-sim-col-px" />
            <col className="lv-sim-col-num" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Market</th>
              <th scope="col">Side</th>
              <th scope="col" className="lv-sim-r">
                Size
              </th>
              <th scope="col" className="lv-sim-r">
                Entry → mark
              </th>
              <th scope="col" className="lv-sim-r">
                P&amp;L
              </th>
            </tr>
          </thead>
          <tbody>
            {run.positions.length === 0 ? (
              <tr>
                <td colSpan={5} className="lv-sim-none">
                  No positions yet. They appear when you confirm a trade.
                </td>
              </tr>
            ) : (
              run.positions.map((p) => (
                <tr key={`${p.market}-${p.side}`}>
                  <td className="lv-sim-ellipsis">{coinName(p.market, labels)}</td>
                  <td>
                    <span className={`lv-sim-side lv-sim-side-${p.side}`}>{p.side === 'long' ? 'Long' : 'Short'}</span>
                  </td>
                  <td className="lv-sim-r lv-num">{formatUsdAmount(p.sizeUsd)}</td>
                  <td className="lv-sim-r lv-num">
                    {formatAssetPx(p.market, p.entryPx)} → {formatAssetPx(p.market, p.markPx)}
                  </td>
                  <td className="lv-sim-r">
                    <Signed value={p.pnlUsd} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function orderStatusWord(o: SimLiveOrder): string {
  return o.status === 'filled' ? 'Filled' : o.status === 'resting' ? 'Resting' : o.status === 'simulated' ? 'Simulated' : 'Rejected';
}

/** The run's real Hyperliquid mainnet orders. */
function RealOrders({ execution, labels }: { execution: SimExecution; labels: Record<string, string> }) {
  const used = execution.maxRunUsd > 0 ? Math.min(1, execution.spentUsd / execution.maxRunUsd) : 0;
  return (
    <section className="lv-sim-card lv-sim-real" aria-labelledby="sim-real-title">
      <div className="lv-sim-card-head">
        <h3 id="sim-real-title" className="lv-sim-card-title">
          Real orders <span className="lv-real-tag">MAINNET</span>
        </h3>
        <span className="lv-sim-hint lv-num">
          {formatUsdAmount(execution.spentUsd)} of {formatUsdAmount(execution.maxRunUsd)} used
        </span>
      </div>
      <div className="lv-sim-budget" aria-hidden="true">
        <span style={{ transform: `scaleX(${used})` }} />
      </div>
      {execution.orders.length === 0 ? (
        <p className="lv-sim-hint">
          None yet. Confirming a trade sends {formatUsdAmount(execution.orderUsd)} per leg to Hyperliquid mainnet at today&apos;s price.
        </p>
      ) : (
        <ul className="lv-sim-orders">
          {[...execution.orders].reverse().map((o, i) => (
            <li key={`${o.orderId}-${o.coin}-${i}`} className="lv-sim-order">
              <span className="lv-sim-order-what">
                <span className={`lv-sim-side lv-sim-side-${o.isBuy ? 'long' : 'short'}`}>{o.isBuy ? 'Long' : 'Short'}</span> {coinName(o.coin, labels)}{' '}
                <span className="lv-num">{formatUsdAmount(o.sizeUsd)}</span>
              </span>
              <span className={`lv-sim-order-status lv-sim-order-${o.status}`}>{orderStatusWord(o)}</span>
              <span className="lv-sim-order-meta">
                {o.avgPx ? <span className="lv-num">avg {formatAssetPx(o.coin, o.avgPx)}</span> : null}
                {o.error ? <span className="lv-sim-order-err">{o.error}</span> : null}
                {o.url && o.status !== 'rejected' ? (
                  <a href={o.url} target="_blank" rel="noreferrer">
                    View on Hyperliquid
                  </a>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function outcome(r: SimDecisionRow): { text: string; tone: 'trade' | 'hold' | 'skip' | 'warn' } {
  if (r.skipped === 'no_shock') return { text: 'Not a shock', tone: 'skip' };
  if (r.skipped === 'brain_offline') return { text: 'Brain offline', tone: 'warn' };
  if (r.skipped === 'error') return { text: 'Error', tone: 'warn' };
  if (r.actions > 0) return { text: `Trade · ${Math.round((r.confidence ?? 0) * 100)}%`, tone: 'trade' };
  return { text: 'Hold', tone: 'hold' };
}

/** Every headline played so far and what the brain did with it, newest first. */
function Timeline({ rows, total }: { rows: SimDecisionRow[]; total: number }) {
  return (
    <section className="lv-sim-card" aria-labelledby="sim-tl-title">
      <div className="lv-sim-card-head">
        <h3 id="sim-tl-title" className="lv-sim-card-title">
          Headlines
        </h3>
        <span className="lv-sim-hint lv-num">
          {rows.length} of {total}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="lv-sim-hint">The first headline arrives at its historical time.</p>
      ) : (
        <ol className="lv-sim-tl">
          {[...rows].reverse().map((r, i) => {
            const o = outcome(r);
            return (
              <li key={`${r.simTime}-${i}`} className="lv-sim-tl-row">
                <time className="lv-sim-tl-time lv-num" dateTime={r.simTime}>
                  {formatSimClock(r.simTime).replace(' UTC', '')}
                </time>
                <span className="lv-sim-tl-text">{r.headline}</span>
                <span className="lv-sim-chip" data-tone={o.tone} title={r.error ?? undefined}>
                  {o.text}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function Summary({ run, scenario, labels }: { run: SimRun; scenario: SimScenario | undefined; labels: Record<string, string> }) {
  const real = run.execution.orders;
  const filled = real.filter((o) => o.status === 'filled' || o.status === 'resting').length;
  return (
    <section className="lv-sim-card lv-sim-summary" aria-labelledby="sim-summary-title">
      <div className="lv-sim-card-head">
        <h3 id="sim-summary-title" className="lv-sim-card-title">
          {run.progress >= 1 ? 'Run finished' : 'Run stopped'}
          {scenario ? ` · ${scenario.title}` : ''}
        </h3>
      </div>
      <dl className="lv-sim-stats">
        <Stat label="Ghosty" value={run.pnlUsd} pct={pctOf(run, run.pnlUsd)} />
        <Stat label="Just holding" value={run.baselinePnlUsd} pct={pctOf(run, run.baselinePnlUsd)} />
        <Stat label="Ghosty vs hold" value={run.pnlUsd - run.baselinePnlUsd} pct={null} text={vsHold(run).text} />
      </dl>
      <p className="lv-sim-hint">{summaryLine(run)}</p>
      {run.execution.liveOrders ? (
        <p className="lv-sim-hint">
          Real orders: {filled} of {real.length} placed on Hyperliquid mainnet · {formatUsdAmount(run.execution.spentUsd)} notional
          {real[0] ? ` · first: ${real[0].isBuy ? 'long' : 'short'} ${coinName(real[0].coin, labels)}` : ''}
        </p>
      ) : null}
    </section>
  );
}

function ReplayBox({ api }: { api: LiveApi }) {
  const { sim, simControls } = api;
  const r = sim.replay;
  const status =
    r.status === 'loading'
      ? 'Loading the episode log…'
      : r.status === 'playing'
        ? `Playing ${r.shown} of ${r.total} in the feed`
        : r.status === 'done'
          ? `Replayed ${r.total} ${r.total === 1 ? 'episode' : 'episodes'}, oldest first`
          : r.status === 'empty'
            ? 'No episodes logged yet. Run a scenario first.'
            : 'Plays the logged decisions back through the feed, oldest first, each with its 0G request id.';
  return (
    <div className="lv-sim-replay">
      <button
        type="button"
        className="lv-btn lv-btn-sm"
        disabled={!simControls.ready || sim.server === 'missing' || r.status === 'loading' || r.status === 'playing'}
        onClick={() => void simControls.replay()}
      >
        Replay log
      </button>
      <p className="lv-sim-hint" aria-live="polite">
        {status}
      </p>
    </div>
  );
}
