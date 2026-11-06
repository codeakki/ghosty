import { describe, expect, it, vi } from 'vitest';
import { parseSimRun, parseSimScenarios } from '../../api/client';
import type { ReplayEpisode, SimRun } from '../../api/types';
import { initialState, reducer, type Action } from '../../state/reducer';
import { applyBatch, feedReducer, initialFeed, type FeedAction, type FeedState } from '../feed/feedReducer';
import { playReplay, replayOrder, type ReplayTimers } from './replay';
import {
  bannerText,
  formatDateRange,
  formatPnlUsd,
  formatSignedPct1,
  formatSimClock,
  initialSim,
  isActive,
  simReducer,
  summaryLine,
  vsHold,
} from './simState';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const sse = (event: Extract<Action, { type: 'sse' }>['event'], data: unknown, at = NOW): Extract<Action, { type: 'sse' }> => ({
  type: 'sse',
  event,
  data,
  at,
});
const SIM = { sim: true, runId: 'run-1' };

function run(over: Partial<SimRun> = {}): SimRun {
  return {
    runId: 'run-1',
    scenarioId: 'mideast',
    status: 'running',
    simTime: '2026-06-14T03:12:00Z',
    progress: 0.4,
    pnlUsd: 1.5,
    baselinePnlUsd: -0.6,
    positions: [{ market: 'xyz:CL', side: 'long', sizeUsd: 100, entryPx: 80, markPx: 81, pnlUsd: 1.5 }],
    decisions: 3,
    episodes: 3,
    ...over,
  };
}

function fold(state: FeedState, ...actions: FeedAction[]): FeedState {
  return actions.reduce(feedReducer, state);
}

/** A feed that is watching BTC (so live ticks run the move detector). */
function watchingFeed(): FeedState {
  return fold(initialFeed(), {
    type: 'market/snapshot',
    at: NOW,
    result: {
      ok: true,
      status: 200,
      data: { network: 'mainnet', ts: '', missing: [], assets: [{ coin: 'BTC', dex: '', label: 'Bitcoin', mid: 60000, prevDayPx: null, change24hPct: null, funding: null, openInterest: null, openInterestUsd: null, volume24h: null }] },
    },
  });
}

describe('feed: sim-tagged events', () => {
  it('turns a sim headline into a card tagged SIM, timed by the historical clock but sorted by arrival', () => {
    const live = fold(initialFeed(), sse('news', { id: 'n-live', title: 'Live headline', source: 'rss', publishedAt: '2026-11-06T11:59:00Z' }, NOW - 1000));
    const next = fold(live, sse('news', { ...SIM, id: 'n1', title: 'Strikes near a Gulf lane', source: 'rss', publishedAt: '2026-06-13T03:12:00Z' }));
    const card = next.cards[0]!;
    expect(card.kind).toBe('news');
    expect(card.sim).toEqual({ runId: 'run-1', simAt: Date.parse('2026-06-13T03:12:00Z') });
    // Newest arrival on top, even though its sim time is months old.
    expect(card.at).toBe(NOW);
    expect(next.cards[1]!.sim).toBeUndefined();
  });

  it('keeps sim and live ids apart: a sim decision never replaces a live "thinking" card', () => {
    const pending = fold(initialFeed(), { type: 'feed/brain-pending', localId: 'l1', prompt: 'gold?', trigger: 'text', at: NOW - 10 });
    const next = fold(pending, sse('decision', { ...SIM, requestId: 'req-9', signal: 'geopolitical_shock', confidence: 0.7, rationale: 'x', at: '2026-06-13T04:00:00Z', actions: [] }));
    expect(next.cards).toHaveLength(2);
    expect(next.cards.find((c) => c.kind === 'brain' && c.localId === 'l1')).toMatchObject({ status: 'thinking' });
    expect(next.cards.find((c) => c.sim)).toMatchObject({ kind: 'brain', status: 'done', id: 'sim:brain:run-1:req-9' });
  });

  it('tags sim orders, alerts and episodes', () => {
    const next = fold(
      initialFeed(),
      sse('alert', { ...SIM, id: 'a1', text: 'Long oil?', requestId: 'r1', createdAt: '2026-06-13T04:01:00Z' }),
      sse('order', { ...SIM, orderId: 'o1', coin: 'xyz:CL', isBuy: true, sizeUsd: 25, status: 'simulated', requestId: 'r1', at: '2026-06-13T04:02:00Z' }),
      sse('episode', { ...SIM, seq: 1, requestId: 'r1', at: '2026-06-13T04:03:00Z', outcome: 'executed' }),
    );
    expect(next.cards.map((c) => c.kind).sort()).toEqual(['alert', 'tx', 'tx']);
    expect(next.cards.every((c) => c.sim?.runId === 'run-1')).toBe(true);
  });

  it('never mixes sim market ticks into the live series or move detector', () => {
    const feed = watchingFeed();
    const afterSim = fold(feed, sse('market', { ...SIM, ts: '2026-06-13T04:00:00Z', mids: { BTC: 30000 } }));
    expect(afterSim).toBe(feed);
    const afterLive = fold(feed, sse('market', { ts: '', mids: { BTC: 60010 } }));
    expect(afterLive.series.BTC).toEqual([60010]);
  });

  it('clears only sim cards when leaving the simulation', () => {
    const next = fold(
      initialFeed(),
      sse('news', { id: 'live', title: 'Live', source: 'rss' }, NOW - 5),
      sse('news', { ...SIM, id: 's', title: 'Sim', source: 'rss' }),
      { type: 'feed/sim-clear' },
    );
    expect(next.cards.map((c) => c.id)).toEqual(['news:live']);
  });
});

describe('terminal state: live ticker stays live', () => {
  it('ignores sim market ticks and sim headlines', () => {
    const s1 = reducer(initialState, sse('market', { ts: '', mids: { BTC: 60000 } }));
    const s2 = reducer(s1, sse('market', { ...SIM, ts: '', mids: { BTC: 30000, ETH: 1000 } }));
    expect(s2.mids).toEqual({ BTC: 60000 });
    expect(s2.series.BTC).toEqual([60000]);
    const s3 = reducer(s2, sse('news', { ...SIM, id: 'n', title: 'Sim headline', source: 'rss' }));
    expect(s3.snapshot?.news ?? []).toHaveLength(0);
  });

  it('keeps a sim alert on the pod while the run is active, and drops it when the run ends', () => {
    const alerted = reducer(initialState, sse('alert', { ...SIM, id: 'a1', text: 'Long oil?', requestId: 'r1' }));
    expect(alerted.banner?.sim?.runId).toBe('run-1');
    expect(reducer(alerted, sse('sim', run({ status: 'paused' }))).banner?.id).toBe('a1');
    expect(reducer(alerted, sse('sim', run({ status: 'done' }))).banner).toBeNull();
  });

  it('never drops a live alert when a run ends', () => {
    const alerted = reducer(initialState, sse('alert', { id: 'live-1', text: 'Live!', requestId: 'r1' }));
    expect(reducer(alerted, sse('sim', run({ status: 'done' }))).banner?.id).toBe('live-1');
  });
});

describe('sim state', () => {
  it('follows SSE `sim` events: running → done keeps the summary', () => {
    const running = simReducer(initialSim, sse('sim', run()));
    expect(isActive(running.run)).toBe(true);
    const done = simReducer(running, sse('sim', run({ status: 'done', progress: 1 })));
    expect(done.run).toBeNull();
    expect(done.finished?.status).toBe('done');
    // A new run clears the old summary.
    expect(simReducer(done, sse('sim', run({ runId: 'run-2' }))).finished).toBeNull();
  });

  it('marks the server as missing simulation on a 404', () => {
    const s = simReducer(initialSim, { type: 'sim/scenarios', result: { ok: false, kind: 'not_found', status: 404, message: 'endpoint not found' } });
    expect(s.server).toBe('missing');
    // The server's catch-all 404 is JSON with its own code; still "needs the server update".
    const json404 = simReducer(initialSim, { type: 'sim/run', result: { ok: false, kind: 'http', status: 404, message: 'Route GET:/sim/run not found' } });
    expect(json404.server).toBe('missing');
  });

  it('Stop keeps what the run did as the summary', () => {
    const running = simReducer(initialSim, sse('sim', run()));
    const left = simReducer(running, { type: 'sim/left' });
    expect(left.run).toBeNull();
    expect(left.finished?.runId).toBe('run-1');
  });

  it('parses the contract, including counts sent as lists', () => {
    const r = parseSimRun({ ...run(), decisions: [{}, {}], episodes: 4, progress: 1.7 });
    expect(r).toMatchObject({ decisions: 2, episodes: 4, progress: 1 });
    expect(parseSimRun({ status: 'warp' })).toBeNull();
    expect(parseSimScenarios([{ id: 's1', title: 'T', headlines: [{ ts: 'x', title: 'h' }] }])?.[0]?.headlines).toHaveLength(1);
  });
});

describe('P&L and words', () => {
  it('formats P&L with a sign and a real minus', () => {
    expect(formatPnlUsd(12.4)).toBe('+$12.40');
    expect(formatPnlUsd(-3.1)).toBe('−$3.10');
    expect(formatPnlUsd(0.001)).toBe('$0.00');
    expect(formatPnlUsd(1234.5)).toBe('+$1,234.50');
    expect(formatSignedPct1(2.06)).toBe('+2.1%');
    expect(formatSignedPct1(-0.44)).toBe('−0.4%');
    expect(formatSignedPct1(0.01)).toBe('0.0%');
  });

  it('compares Ghosty with holding, in % of paper notional (or dollars with no positions)', () => {
    expect(vsHold(run())).toEqual({ text: '+2.1%', dir: 'up' });
    expect(vsHold(run({ positions: [], pnlUsd: -1, baselinePnlUsd: 0.5 }))).toEqual({ text: '−$1.50', dir: 'down' });
    expect(summaryLine(run())).toBe('3 calls · +2.1% vs hold · every decision logged with its 0G request id');
    expect(summaryLine(run({ decisions: 1 }))).toMatch(/^1 call · /);
  });

  it('shows the historical clock and the scenario in the banner', () => {
    expect(formatSimClock('2026-06-14T03:12:59Z')).toBe('03:12 UTC');
    expect(formatSimClock('nope')).toBe('—');
    const scenario = { id: 'mideast', title: 'Middle East weekend', description: '', start: '2026-06-13T00:00:00Z', end: '2026-06-15T00:00:00Z', markets: [], headlines: [] };
    expect(bannerText(run(), scenario)).toBe('Simulation · Middle East weekend, Jun 2026 · sim time 03:12 UTC · paper trades only');
    expect(bannerText(run({ status: 'paused' }), scenario)).toContain('· paused ·');
    expect(formatDateRange(scenario.start, scenario.end)).toBe('Jun 13 – 15, 2026');
    expect(formatDateRange('2026-06-30T00:00:00Z', '2026-07-02T00:00:00Z')).toBe('Jun 30 – Jul 2, 2026');
  });
});

describe('replay', () => {
  const ep = (requestId: string, ts: string): ReplayEpisode => ({ ts, requestId, decision: null, actions: [], orders: 0, storage: 'local' });

  it('orders oldest → newest and drops repeated request ids', () => {
    const order = replayOrder([ep('b', '2026-06-13T05:00:00Z'), ep('a', '2026-06-13T01:00:00Z'), ep('b', '2026-06-13T05:00:00Z'), ep('c', 'bad')]);
    expect(order.map((e) => e.requestId)).toEqual(['a', 'b', 'c']);
  });

  it('plays one episode right away, then one per interval, and finishes with the last', () => {
    vi.useFakeTimers();
    const timers: ReplayTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
    const steps: string[] = [];
    const done = vi.fn();
    playReplay([ep('a', '2026-06-13T01:00:00Z'), ep('b', '2026-06-13T02:00:00Z'), ep('c', '2026-06-13T03:00:00Z')], (e, i, n) => steps.push(`${e.requestId}${i}/${n}`), done, 1000, timers);
    expect(steps).toEqual(['a1/3']);
    vi.advanceTimersByTime(999);
    expect(steps).toEqual(['a1/3']);
    vi.advanceTimersByTime(1);
    expect(steps).toEqual(['a1/3', 'b2/3']);
    vi.advanceTimersByTime(1000);
    expect(steps).toEqual(['a1/3', 'b2/3', 'c3/3']);
    expect(done).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(5000);
    expect(steps).toHaveLength(3);
    vi.useRealTimers();
  });

  it('stops when cancelled', () => {
    vi.useFakeTimers();
    const steps: string[] = [];
    const cancel = playReplay([ep('a', '1'), ep('b', '2')], (e) => steps.push(e.requestId), () => steps.push('done'), 500);
    cancel();
    vi.advanceTimersByTime(5000);
    expect(steps).toEqual(['a']);
    vi.useRealTimers();
  });

  it('replays into the feed as agent cards, one per step', () => {
    let feed = initialFeed();
    feed = applyBatch(feed, [{ type: 'feed/replay', replayId: 'r', episode: ep('a', '2026-06-13T01:00:00Z'), index: 1, total: 2, at: NOW }]);
    feed = applyBatch(feed, [{ type: 'feed/replay', replayId: 'r', episode: ep('b', '2026-06-13T02:00:00Z'), index: 2, total: 2, at: NOW + 1200 }]);
    expect(feed.cards.map((c) => (c.kind === 'replay' ? c.episode.requestId : c.kind))).toEqual(['b', 'a']);
    expect(fold(feed, { type: 'feed/replay-clear' }).cards).toHaveLength(0);
  });
});
