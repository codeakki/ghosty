import { describeError, parseSimRun } from '../../api/client';
import type { ApiResult, SimRun, SimScenario } from '../../api/types';
import type { Action as TerminalAction } from '../../state/reducer';

/**
 * Simulation mode: a historical scenario replayed through the real pipeline, with paper trades only.
 * Pure state, folded from SSE `sim` events and the /sim/* calls, so the banner, scoreboard and summary are tested
 * without a browser. Live and sim never share state: sim prices and headlines stay out of the live ticker.
 */

export type SimServer = 'unknown' | 'ready' | 'missing';

export type ReplayStatus = 'idle' | 'loading' | 'playing' | 'done' | 'empty';

export interface SimState {
  /** `missing`: the server answered 404 on /sim/*, so it does not have simulation yet. */
  server: SimServer;
  scenarios: SimScenario[] | null;
  /** The run in progress (running or paused). */
  run: SimRun | null;
  /** The last run that finished, for the summary card. Cleared when a new run starts. */
  finished: SimRun | null;
  /** One sentence for the last failed action (start, pause, replay…). */
  error: string | null;
  replay: { status: ReplayStatus; shown: number; total: number };
}

export const initialSim: SimState = {
  server: 'unknown',
  scenarios: null,
  run: null,
  finished: null,
  error: null,
  replay: { status: 'idle', shown: 0, total: 0 },
};

export type SimLocalAction =
  | { type: 'sim/scenarios'; result: ApiResult<SimScenario[]> }
  | { type: 'sim/run'; result: ApiResult<SimRun> }
  | { type: 'sim/error'; message: string | null }
  /** Stop pressed: back to the live view, keep what the run did as the summary. */
  | { type: 'sim/left' }
  | { type: 'sim/replay'; status: ReplayStatus; shown?: number; total?: number };

export type SimAction = TerminalAction | SimLocalAction;

/** Sim seconds per real second. */
export const SPEEDS = [
  { id: 'slow', label: 'Slow', speed: 120 },
  { id: 'normal', label: 'Normal', speed: 360 },
  { id: 'fast', label: 'Fast', speed: 1800 },
] as const;

export type SpeedId = (typeof SPEEDS)[number]['id'];

/**
 * The server has no simulation routes yet. Any 404 counts: the server's own catch-all answers
 * `{error: "not_found"}`, which the generic client reads as a real answer, but /sim/* never 404s once it exists.
 */
export function simMissing(r: ApiResult<unknown>): boolean {
  return !r.ok && (r.kind === 'not_found' || r.status === 404);
}

export function isActive(run: SimRun | null): run is SimRun {
  return run !== null && (run.status === 'running' || run.status === 'paused');
}

function foldRun(state: SimState, run: SimRun): SimState {
  if (run.status === 'done') return { ...state, server: 'ready', run: null, finished: run };
  if (run.status === 'idle') return { ...state, server: 'ready', run: null };
  // A different run starting replaces the last summary.
  const finished = state.finished?.runId === run.runId || state.run?.runId !== run.runId ? null : state.finished;
  return { ...state, server: 'ready', run, finished };
}

export function simReducer(state: SimState, action: SimAction): SimState {
  switch (action.type) {
    case 'sse': {
      if (action.event !== 'sim') return state;
      const run = parseSimRun(action.data);
      return run ? foldRun(state, run) : state;
    }
    case 'sim/scenarios': {
      const r = action.result;
      if (r.ok) return { ...state, server: 'ready', scenarios: r.data };
      if (simMissing(r)) return { ...state, server: 'missing', error: null };
      return { ...state, error: describeError(r) };
    }
    case 'sim/run': {
      const r = action.result;
      if (r.ok) return foldRun(state, r.data);
      if (simMissing(r)) return { ...state, server: 'missing', run: null };
      return state;
    }
    case 'sim/error':
      return state.error === action.message ? state : { ...state, error: action.message };
    case 'sim/left':
      return { ...state, run: null, finished: state.run ?? state.finished };
    case 'sim/replay':
      return {
        ...state,
        replay: { status: action.status, shown: action.shown ?? state.replay.shown, total: action.total ?? state.replay.total },
      };
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Words and numbers
// ---------------------------------------------------------------------------

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "+$12.40" / "−$3.10" / "$0.00": sign first, real minus sign. */
export function formatPnlUsd(v: number): string {
  const rounded = Math.round(v * 100) / 100;
  if (rounded === 0) return usd.format(0);
  return `${rounded > 0 ? '+' : '−'}${usd.format(Math.abs(rounded))}`;
}

/** "+2.1%" / "−0.4%" / "0.0%". */
export function formatSignedPct1(v: number): string {
  const rounded = Math.round(v * 10) / 10;
  if (rounded === 0) return '0.0%';
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded).toFixed(1)}%`;
}

export function direction(v: number): 'up' | 'down' | 'flat' {
  const r = Math.round(v * 100) / 100;
  return r > 0 ? 'up' : r < 0 ? 'down' : 'flat';
}

/** Total paper notional of the run's positions (the base for "% vs hold"). */
export function notionalUsd(run: SimRun): number {
  return run.positions.reduce((sum, p) => sum + Math.abs(p.sizeUsd), 0);
}

/** Ghosty's edge over simply holding: in % of the paper notional when there is one ("+2.1%"), in dollars otherwise. */
export function vsHold(run: SimRun): { text: string; dir: 'up' | 'down' | 'flat' } {
  const edge = run.pnlUsd - run.baselinePnlUsd;
  const base = notionalUsd(run);
  const text = base > 0 ? formatSignedPct1((edge / base) * 100) : formatPnlUsd(edge);
  return { text, dir: direction(edge) };
}

/** "3 calls · +2.1% vs hold · every decision logged with its 0G request id". */
export function summaryLine(run: SimRun): string {
  const calls = `${run.decisions} ${run.decisions === 1 ? 'call' : 'calls'}`;
  return `${calls} · ${vsHold(run).text} vs hold · every decision logged with its 0G request id`;
}

/** "03:12 UTC" from an ISO time or ms epoch; "—" when unknown. */
export function formatSimClock(at: string | number): string {
  const t = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Jun 2026". */
export function formatScenarioMonth(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "Jun 13 – 15, 2026" · "Jun 30 – Jul 2, 2026" · "Dec 31, 2025 – Jan 2, 2026". */
export function formatDateRange(startIso: string, endIso: string): string {
  const a = Date.parse(startIso);
  const b = Date.parse(endIso);
  if (!Number.isFinite(a)) return '';
  const s = new Date(a);
  const sDay = `${MONTHS[s.getUTCMonth()]} ${s.getUTCDate()}`;
  if (!Number.isFinite(b)) return `${sDay}, ${s.getUTCFullYear()}`;
  const e = new Date(b);
  if (s.getUTCFullYear() !== e.getUTCFullYear())
    return `${sDay}, ${s.getUTCFullYear()} – ${MONTHS[e.getUTCMonth()]} ${e.getUTCDate()}, ${e.getUTCFullYear()}`;
  if (s.getUTCMonth() === e.getUTCMonth() && s.getUTCDate() === e.getUTCDate()) return `${sDay}, ${s.getUTCFullYear()}`;
  const eDay = s.getUTCMonth() === e.getUTCMonth() ? `${e.getUTCDate()}` : `${MONTHS[e.getUTCMonth()]} ${e.getUTCDate()}`;
  return `${sDay} – ${eDay}, ${s.getUTCFullYear()}`;
}

/** "Simulation · Middle East weekend, Jun 2026 · sim time 03:12 UTC · paper trades only". */
export function bannerText(run: SimRun, scenario: SimScenario | undefined): string {
  const name = scenario ? `${scenario.title}${scenario.start ? `, ${formatScenarioMonth(scenario.start)}` : ''}` : 'Scenario';
  const paused = run.status === 'paused' ? ' · paused' : '';
  return `Simulation · ${name} · sim time ${formatSimClock(run.simTime)}${paused} · paper trades only`;
}
