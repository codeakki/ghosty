import { useState } from 'react';
import type { SimRun, SimScenario } from '../../api/types';
import { Link } from '../Link';
import type { LiveApi } from '../useLive';
import { coinName, formatAssetPx, formatUsdAmount } from '../words';
import {
  bannerText,
  direction,
  formatDateRange,
  formatPnlUsd,
  isActive,
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
    <div className="lv-sim-banner" role="status" data-status={run.status}>
      <p className="lv-sim-banner-text">
        <span className="lv-sim-tag">SIM</span> <span className="lv-num">{bannerText(run, scenario)}</span>
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

/** Simulate tab: pick a past scenario, run it at a chosen speed with paper trades, then replay the episode log. */
export function SimPanel({ api }: { api: LiveApi }) {
  const { sim, simControls } = api;
  const [picked, setPicked] = useState<string | null>(null);
  const [speed, setSpeed] = useState<SpeedId>('normal');
  const [busy, setBusy] = useState(false);
  const run = sim.run;
  const active = isActive(run);
  const scenarios = sim.scenarios ?? [];
  const chosen = picked ?? scenarios[0]?.id ?? null;

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="lv-sim" aria-labelledby="sim-title">
      <header className="lv-sim-head">
        <h2 id="sim-title" className="lv-sim-title">
          Simulate
        </h2>
        <p className="lv-sim-sub">Replay a past news window through Ghosty. Trades go to a paper venue: no real money moves.</p>
      </header>

      {sim.server === 'missing' ? (
        <p className="lv-sim-notice" role="status">
          <span aria-hidden="true">○</span> Simulation needs the server update. Pull the latest server and restart it.
        </p>
      ) : null}
      {sim.error && sim.server !== 'missing' ? (
        <p className="lv-sim-notice" role="alert">
          {sim.error}
        </p>
      ) : null}

      {active ? (
        <>
          <div className="lv-sim-controls" role="group" aria-label="Run controls">
            {run.status === 'paused' ? (
              <button type="button" className="lv-btn lv-btn-primary" disabled={busy} onClick={() => act(() => simControls.control('resume'))}>
                Resume
              </button>
            ) : (
              <button type="button" className="lv-btn" disabled={busy} onClick={() => act(() => simControls.control('pause'))}>
                Pause
              </button>
            )}
            <button type="button" className="lv-btn" disabled={busy} onClick={() => act(() => simControls.control('stop'))}>
              Stop
            </button>
            <span className="lv-sim-hint">
              {run.status === 'paused' ? 'Paused. A paper trade may be waiting on the pod.' : 'Running. Confirm paper trades on the pod.'}
            </span>
          </div>
          <Scoreboard run={run} labels={api.feed.labels} />
        </>
      ) : (
        <>
          {sim.finished ? <Summary run={sim.finished} scenario={sim.scenarios?.find((s) => s.id === sim.finished?.scenarioId)} /> : null}
          <ScenarioPicker scenarios={sim.scenarios} server={sim.server} chosen={chosen} onPick={setPicked} />
          <fieldset className="lv-sim-speed">
            <legend className="lv-sim-label">Speed</legend>
            <div className="lv-chips" role="group" aria-label="Speed">
              {SPEEDS.map((s) => (
                <button key={s.id} type="button" className="lv-chip" aria-pressed={speed === s.id} onClick={() => setSpeed(s.id)} title={`${s.speed}× real time`}>
                  {s.label} <span className="lv-num lv-sim-mult">{s.speed}×</span>
                </button>
              ))}
            </div>
          </fieldset>
          <div className="lv-sim-controls">
            <button
              type="button"
              className="lv-btn lv-btn-primary"
              disabled={busy || !chosen || sim.server !== 'ready' || !simControls.ready}
              onClick={() => act(() => simControls.start(chosen!, SPEEDS.find((s) => s.id === speed)!.speed))}
            >
              Start simulation
            </button>
          </div>
        </>
      )}

      <ReplayBox api={api} />
    </section>
  );
}

function ScenarioPicker({
  scenarios,
  server,
  chosen,
  onPick,
}: {
  scenarios: SimScenario[] | null;
  server: SimState['server'];
  chosen: string | null;
  onPick: (id: string) => void;
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
    <ul className="lv-sim-scenarios" role="group" aria-label="Scenarios">
      {scenarios.map((s) => (
        <li key={s.id}>
          <button type="button" className="lv-sim-scenario" aria-pressed={chosen === s.id} onClick={() => onPick(s.id)}>
            <span className="lv-sim-scenario-title">{s.title}</span>
            <span className="lv-sim-scenario-meta lv-num">
              {formatDateRange(s.start, s.end)} · {s.headlines.length} {s.headlines.length === 1 ? 'headline' : 'headlines'}
            </span>
            <span className="lv-sim-scenario-desc">{s.description}</span>
          </button>
        </li>
      ))}
    </ul>
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

/** Ghosty vs simply holding, the paper positions, and how many decisions the run produced. */
function Scoreboard({ run, labels }: { run: SimRun; labels: Record<string, string> }) {
  const edge = vsHold(run);
  return (
    <section className="lv-sim-card" aria-label="Scoreboard">
      <dl className="lv-sim-stats">
        <div>
          <dt>Ghosty P&amp;L</dt>
          <dd>
            <Signed value={run.pnlUsd} />
          </dd>
        </div>
        <div>
          <dt>Hold baseline</dt>
          <dd>
            <Signed value={run.baselinePnlUsd} />
          </dd>
        </div>
        <div>
          <dt>vs hold</dt>
          <dd>
            <Signed value={run.pnlUsd - run.baselinePnlUsd} text={edge.text} />
          </dd>
        </div>
        <div>
          <dt>Decisions</dt>
          <dd className="lv-num">{run.decisions}</dd>
        </div>
      </dl>
      <table className="lv-sim-table">
        <caption className="lv-sr-only">Paper positions</caption>
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
                No paper positions yet.
              </td>
            </tr>
          ) : (
            run.positions.map((p) => (
              <tr key={`${p.market}-${p.side}`}>
                <td>{coinName(p.market, labels)}</td>
                <td>{p.side === 'long' ? 'Long' : 'Short'}</td>
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
    </section>
  );
}

function Summary({ run, scenario }: { run: SimRun; scenario: SimScenario | undefined }) {
  return (
    <section className="lv-sim-card lv-sim-summary" aria-labelledby="sim-summary-title">
      <h3 id="sim-summary-title" className="lv-sim-card-title">
        {run.status === 'done' ? 'Run finished' : 'Run stopped'}
        {scenario ? ` · ${scenario.title}` : ''}
      </h3>
      <p className="lv-sim-summary-line lv-num">{summaryLine(run)}</p>
      <p className="lv-sim-hint">
        Ghosty <Signed value={run.pnlUsd} /> · hold <Signed value={run.baselinePnlUsd} /> · paper trades only
      </p>
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
        className="lv-btn"
        disabled={!simControls.ready || sim.server === 'missing' || r.status === 'loading' || r.status === 'playing'}
        onClick={() => void simControls.replay()}
      >
        Replay
      </button>
      <p className="lv-sim-hint" aria-live="polite">
        {status}
      </p>
    </div>
  );
}
