/**
 * ============================================================================================================
 * DEV FIXTURE: NOT PRODUCTION CODE.
 * Loaded only with `?simFixture=1` under `vite dev` (useSim.ts guards the dynamic import with
 * `import.meta.env.DEV`, so production builds drop it). It stands in for the server's /sim/* routes so the
 * Simulate layout can be checked before the backend ships: fake scenarios, a scripted run, fake replay episodes.
 * Every event it emits is sim-tagged; it never calls the server and never touches real money.
 * ============================================================================================================
 */
import type { ApiResult, ReplayEpisode, SimRun, SimScenario, SseEventType } from '../../api/types';
import type { SimApi } from './useSim';

const SCENARIOS: SimScenario[] = [
  {
    id: 'fixture-mideast',
    title: 'Middle East weekend',
    description: 'Strikes reported over a weekend; oil and gold gap on the Sunday open.',
    start: '2026-06-13T00:00:00Z',
    end: '2026-06-15T06:00:00Z',
    markets: ['xyz:CL', 'xyz:GOLD', 'BTC'],
    headlines: Array.from({ length: 14 }, (_, i) => ({ ts: `2026-06-13T0${i % 10}:00:00Z`, title: `Fixture headline ${i + 1}`, source: 'fixture', url: '' })),
  },
  {
    id: 'fixture-sec',
    title: 'Exchange crackdown',
    description: 'A regulator sues a major exchange; crypto sells off into the US close.',
    start: '2026-03-05T13:00:00Z',
    end: '2026-03-05T22:00:00Z',
    markets: ['BTC', 'ETH'],
    headlines: Array.from({ length: 9 }, (_, i) => ({ ts: `2026-03-05T1${i}:00:00Z`, title: `Fixture headline ${i + 1}`, source: 'fixture', url: '' })),
  },
];

const ok = <T,>(data: T): ApiResult<T> => ({ ok: true, status: 200, data });

export function createFixtureSimApi(emit: (event: SseEventType, data: unknown) => void): SimApi {
  let run: SimRun = { runId: '', scenarioId: '', status: 'idle', simTime: '', progress: 0, pnlUsd: 0, baselinePnlUsd: 0, positions: [], decisions: 0, episodes: 0 };
  let timer: ReturnType<typeof setInterval> | null = null;
  let step = 0;

  const simAt = (startIso: string, endIso: string, p: number) =>
    new Date(Date.parse(startIso) + (Date.parse(endIso) - Date.parse(startIso)) * p).toISOString();

  const tick = () => {
    if (run.status !== 'running') return;
    const sc = SCENARIOS.find((s) => s.id === run.scenarioId) ?? SCENARIOS[0]!;
    step += 1;
    const progress = Math.min(1, run.progress + 0.02);
    const simTime = simAt(sc.start, sc.end, progress);
    const tag = { sim: true, runId: run.runId };
    if (step === 1) emit('news', { ...tag, id: 'fx-n1', title: 'Reports of strikes near a Gulf shipping lane', source: 'rss', url: '', publishedAt: simTime, signal: 'geopolitical_shock' });
    if (step === 2) emit('market', { ...tag, ts: simTime, mids: { BTC: 61000, 'xyz:CL': 81.2 } });
    if (step === 3)
      emit('decision', {
        ...tag,
        requestId: 'fx-req-0001-aaaa',
        signal: 'geopolitical_shock',
        confidence: 0.78,
        rationale: 'Supply risk to crude is real and the move is early; a small long on oil with a tight stop.',
        trigger: 'button',
        transcript: '',
        headline: 'Reports of strikes near a Gulf shipping lane',
        at: simTime,
        actions: [{ venue: 'hyperliquid', kind: 'perp', coin: 'xyz:CL', side: 'long', sizeUsd: 25, reason: 'supply shock' }],
      });
    if (step === 4)
      emit('alert', {
        ...tag,
        id: 'fx-alert-1',
        text: 'Oil may jump on the Gulf reports. Long crude, twenty-five dollars?',
        signal: 'geopolitical_shock',
        actions: [{ coin: 'xyz:CL', side: 'long', sizeUsd: 25, reason: 'supply shock' }],
        requestId: 'fx-req-0001-aaaa',
        confidence: 0.78,
        status: 'pending',
        createdAt: simTime,
      });
    if (step === 5) emit('order', { ...tag, orderId: 'fx-o1', coin: 'xyz:CL', isBuy: true, sizeUsd: 25, status: 'simulated', avgPx: 81.4, requestId: 'fx-req-0001-aaaa', at: simTime });
    if (step === 6) emit('episode', { ...tag, seq: 1, at: simTime, requestId: 'fx-req-0001-aaaa', outcome: 'executed', actions: [] });
    const positions = step >= 5 ? [{ market: 'xyz:CL', side: 'long' as const, sizeUsd: 25, entryPx: 81.4, markPx: 81.4 + progress * 3, pnlUsd: (25 * progress * 3) / 81.4 }] : [];
    const pnlUsd = positions.reduce((s, p) => s + p.pnlUsd, 0);
    run = { ...run, progress, simTime, positions, pnlUsd, baselinePnlUsd: -0.35 * progress, decisions: step >= 3 ? 1 : 0, episodes: step >= 6 ? 1 : 0, status: progress >= 1 ? 'done' : 'running' };
    emit('sim', run);
    if (run.status === 'done' && timer) clearInterval(timer);
  };

  return {
    scenarios: () => Promise.resolve(ok(SCENARIOS)),
    run: () => Promise.resolve(ok(run)),
    start: (scenarioId) => {
      if (timer) clearInterval(timer);
      step = 0;
      const sc = SCENARIOS.find((s) => s.id === scenarioId) ?? SCENARIOS[0]!;
      run = { ...run, runId: `fx-run-${Date.now()}`, scenarioId, status: 'running', simTime: sc.start, progress: 0, positions: [], pnlUsd: 0, baselinePnlUsd: 0, decisions: 0, episodes: 0 };
      timer = setInterval(tick, 500);
      emit('sim', run);
      return Promise.resolve(ok({ runId: run.runId }));
    },
    control: (action) => {
      if (action === 'pause' && run.status === 'running') run = { ...run, status: 'paused' };
      if (action === 'resume' && run.status === 'paused') run = { ...run, status: 'running' };
      if (action === 'stop') {
        if (timer) clearInterval(timer);
        run = { ...run, status: 'idle' };
      }
      emit('sim', run);
      return Promise.resolve(ok(true as const));
    },
    replay: () => {
      const eps: ReplayEpisode[] = [
        { ts: '2026-06-13T02:10:00Z', requestId: 'fx-req-0001-aaaa', decision: { signal: 'geopolitical_shock', confidence: 0.78, rationale: 'Long crude on the Gulf reports.' }, actions: [{ venue: 'hyperliquid', kind: 'perp', coin: 'xyz:CL', side: 'long', sizeUsd: 25, reason: '' }], orders: 1, storage: '0g', rootHash: '0xfixture0000000000000000000000000000000000000000000000000000beef', storagescanUrl: 'https://storagescan-galileo.0g.ai' },
        { ts: '2026-06-13T09:40:00Z', requestId: 'fx-req-0002-bbbb', decision: { signal: 'none', confidence: 0.31, rationale: 'Follow-up headline adds nothing new; hold.' }, actions: [], orders: 0, storage: 'local' },
        { ts: '2026-06-14T21:05:00Z', requestId: 'fx-req-0003-cccc', decision: { signal: 'geopolitical_shock', confidence: 0.66, rationale: 'Gold bid into the Sunday open; small long.' }, actions: [{ venue: 'hyperliquid', kind: 'perp', coin: 'xyz:GOLD', side: 'long', sizeUsd: 20, reason: '' }], orders: 1, storage: '0g', rootHash: '0xfixture1111111111111111111111111111111111111111111111111111cafe', storagescanUrl: 'https://storagescan-galileo.0g.ai' },
      ];
      return Promise.resolve(ok(eps));
    },
  };
}
