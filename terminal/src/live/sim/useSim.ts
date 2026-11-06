import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch } from 'react';
import { describeError, type GhostyClient } from '../../api/client';
import type { Alert, ApiResult, ReplayEpisode, SimAction as ControlAction, SimRun, SimScenario, SseEventType } from '../../api/types';
import type { Action as TerminalAction } from '../../state/reducer';
import type { FeedAction } from '../feed/feedReducer';
import { playReplay } from './replay';
import { isActive, type SimAction, type SimState } from './simState';

/** The five /sim + /episodes calls, so a dev fixture can stand in for the server. */
export interface SimApi {
  scenarios(): Promise<ApiResult<SimScenario[]>>;
  run(): Promise<ApiResult<SimRun>>;
  start(scenarioId: string, speed: number): Promise<ApiResult<{ runId: string }>>;
  control(action: ControlAction): Promise<ApiResult<true>>;
  replay(from?: string): Promise<ApiResult<ReplayEpisode[]>>;
}

function clientSimApi(client: GhostyClient): SimApi {
  return {
    scenarios: () => client.simScenarios(),
    run: () => client.simRun(),
    // Auto-pause on an alert, so a confirm on the device happens at the sim time it was asked.
    start: (id, speed) => client.simStart(id, speed, true),
    control: (a) => client.simControl(a),
    replay: (from) => client.episodesReplay(from, 20),
  };
}

/** DEV ONLY: `?simFixture=1` swaps the server for a local scripted run (see devFixture.ts). False in production builds. */
function wantsSimFixture(): boolean {
  return import.meta.env.DEV && typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('simFixture') === '1';
}

/** A backup poll while a run is active, in case the event stream drops a `sim` event. */
const RUN_POLL_MS = 2_000;

interface Args {
  client: GhostyClient;
  sim: SimState;
  simDispatch: Dispatch<SimAction>;
  /** The terminal dispatch (also taps the feed): the dev fixture emits its fake SSE events through it. */
  dispatch: (action: TerminalAction) => void;
  feedDispatch: (action: FeedAction) => void;
  banner: Alert | null;
  dismissAlert: (id: string) => void;
  /** Newest episode root on 0G Storage: where the replay starts. */
  latestRoot: string | null;
}

export function useSim({ client, sim, simDispatch, dispatch, feedDispatch, banner, dismissAlert, latestRoot }: Args) {
  const real = useMemo(() => clientSimApi(client), [client]);
  const fixtureWanted = wantsSimFixture();
  const [fixture, setFixture] = useState<SimApi | null>(null);
  useEffect(() => {
    if (!import.meta.env.DEV || !wantsSimFixture()) return;
    let alive = true;
    const emit = (event: SseEventType, data: unknown) => dispatch({ type: 'sse', event, data, at: Date.now() });
    void import('./devFixture').then((m) => {
      if (alive) setFixture(m.createFixtureSimApi(emit));
    });
    return () => {
      alive = false;
    };
  }, [dispatch]);
  const api = fixtureWanted ? fixture : real;

  // Scenarios and any run already in progress (a reload mid-run picks it back up).
  useEffect(() => {
    if (!api) return;
    let alive = true;
    void Promise.all([api.scenarios(), api.run()]).then(([s, r]) => {
      if (!alive) return;
      simDispatch({ type: 'sim/scenarios', result: s });
      simDispatch({ type: 'sim/run', result: r });
    });
    return () => {
      alive = false;
    };
  }, [api, simDispatch]);

  const active = isActive(sim.run);
  useEffect(() => {
    if (!api || !active) return;
    const t = setInterval(() => {
      void api.run().then((r) => simDispatch({ type: 'sim/run', result: r }));
    }, RUN_POLL_MS);
    return () => clearInterval(t);
  }, [api, active, simDispatch]);

  const fail = useCallback(
    (r: Extract<ApiResult<unknown>, { ok: false }>) =>
      simDispatch({ type: 'sim/error', message: r.kind === 'not_found' ? 'Simulation needs the server update.' : describeError(r) }),
    [simDispatch],
  );

  const refreshRun = useCallback(async () => {
    if (!api) return;
    simDispatch({ type: 'sim/run', result: await api.run() });
  }, [api, simDispatch]);

  const start = useCallback(
    async (scenarioId: string, speed: number) => {
      if (!api) return;
      // A fresh run starts from a clean feed: no cards left over from the last one.
      feedDispatch({ type: 'feed/sim-clear' });
      const r = await api.start(scenarioId, speed);
      if (!r.ok) {
        if (r.kind === 'not_found') simDispatch({ type: 'sim/scenarios', result: r });
        fail(r);
        return;
      }
      simDispatch({ type: 'sim/error', message: null });
      await refreshRun();
    },
    [api, feedDispatch, simDispatch, fail, refreshRun],
  );

  const control = useCallback(
    async (action: ControlAction) => {
      if (!api) return;
      const r = await api.control(action);
      if (!r.ok) {
        fail(r);
        return;
      }
      simDispatch({ type: 'sim/error', message: null });
      if (action === 'stop') {
        // Leaving the simulation restores the live view: sim cards and any paper trade waiting on the pod go away.
        simDispatch({ type: 'sim/left' });
        feedDispatch({ type: 'feed/sim-clear' });
        if (banner?.sim) dismissAlert(banner.id);
        return;
      }
      await refreshRun();
    },
    [api, banner, dismissAlert, feedDispatch, simDispatch, fail, refreshRun],
  );

  const cancelReplay = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelReplay.current?.(), []);
  const replaySeq = useRef(0);

  const replay = useCallback(async () => {
    if (!api) return;
    cancelReplay.current?.();
    feedDispatch({ type: 'feed/replay-clear' });
    simDispatch({ type: 'sim/replay', status: 'loading', shown: 0, total: 0 });
    const r = await api.replay(latestRoot ?? undefined);
    if (!r.ok) {
      simDispatch({ type: 'sim/replay', status: 'idle' });
      fail(r);
      return;
    }
    if (r.data.length === 0) {
      simDispatch({ type: 'sim/replay', status: 'empty', shown: 0, total: 0 });
      return;
    }
    const replayId = `${Date.now()}-${++replaySeq.current}`;
    cancelReplay.current = playReplay(
      r.data,
      (episode, index, total) => {
        feedDispatch({ type: 'feed/replay', replayId, episode, index, total, at: Date.now() });
        simDispatch({ type: 'sim/replay', status: 'playing', shown: index, total });
      },
      () => simDispatch({ type: 'sim/replay', status: 'done' }),
    );
  }, [api, latestRoot, feedDispatch, simDispatch, fail]);

  return useMemo(() => ({ ready: api !== null, start, control, replay }), [api, start, control, replay]);
}

export type SimControls = ReturnType<typeof useSim>;
