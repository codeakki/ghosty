import { describe, expect, it } from 'vitest';
import type { ButtonResult } from '../api/types';
import { ACTIVE_MS, selectStages } from './pipeline';
import { selectProofs } from './proofs';
import { appendMids, initialState, reducer, type Action, type TerminalState } from './reducer';

const T0 = 1_800_000_000_000;
const sse = (event: Extract<Action, { type: 'sse' }>['event'], data: unknown, at = T0): Action => ({ type: 'sse', event, data, at });
const fold = (actions: Action[], from: TerminalState = initialState) => actions.reduce(reducer, from);

const decision = {
  requestId: 'fake-req-1',
  signal: 'geopolitical_shock',
  confidence: 0.95,
  rationale: 'War headline. Long gold?',
  trigger: 'inject',
  transcript: '',
  headline: 'Missile strikes',
  at: '2026-11-06T10:00:00.000Z',
  actions: [{ venue: 'hyperliquid', kind: 'perp', coin: 'xyz:GOLD', side: 'long', sizeUsd: 13, reason: 'haven' }],
};

describe('reducer: SSE folding', () => {
  it('starts from a state snapshot and prepends news without duplicates', () => {
    const s = fold([
      sse('state', { news: [{ id: 'a', title: 'old', publishedAt: '2026-11-06T09:00:00Z' }], safeStop: false }),
      sse('news', { id: 'b', title: 'Missile strikes', source: 'inject', handle: 'Reuters', credibility: { handle: 'Reuters', score: 2000, level: 'reputable', weight: 0.9 } }),
      sse('news', { id: 'b', title: 'Missile strikes', source: 'inject' }),
    ]);
    expect(s.snapshot!.news.map((n) => n.id)).toEqual(['b', 'a']);
    expect(s.stageHits.news).toBe(T0);
    expect(s.stageHits.credibility).toBe(T0);
    expect(s.console[0]!.type).toBe('news');
  });

  it('a decision sets the pending legs and lights the brain', () => {
    const s = fold([sse('decision', decision)]);
    expect(s.snapshot!.lastDecision!.requestId).toBe('fake-req-1');
    expect(s.snapshot!.plannedActions).toHaveLength(1);
    expect(s.decisionActions[0]!.coin).toBe('xyz:GOLD');
    expect(s.stageHits.brain).toBe(T0);
  });

  it('an alert raises the banner; the button for that request clears it', () => {
    const alert = { id: 'alert-1', text: 'War. Long gold?', signal: 'geopolitical_shock', actions: [], requestId: 'fake-req-1', confidence: 0.95, status: 'pending', createdAt: 'x' };
    let s = fold([sse('decision', decision), sse('alert', alert)]);
    expect(s.banner?.id).toBe('alert-1');
    const result: ButtonResult = { action: 'confirm', requestId: 'fake-req-1', signal: 'geopolitical_shock', executed: true, actions: [], orders: [], swaps: [] };
    s = reducer(s, { type: 'button', result, at: T0 + 1 });
    expect(s.banner).toBeNull();
    expect(s.lastButton?.result.executed).toBe(true);
    expect(s.stageHits.execute).toBe(T0 + 1);
  });

  it('a later state snapshot keeps the decision legs after the button cleared plannedActions', () => {
    const s = fold([
      sse('decision', decision),
      sse('state', { lastDecision: decision, plannedActions: [], safeStop: false }),
    ]);
    expect(s.snapshot!.plannedActions).toEqual([]);
    expect(s.decisionActions).toHaveLength(1);
  });

  it('orders and episodes are prepended and deduplicated', () => {
    const order = { orderId: 'fake-hl-1', coin: 'xyz:GOLD', isBuy: true, sizeUsd: 13, status: 'simulated', requestId: 'fake-req-1', at: 'x' };
    const ep = { seq: 2, at: 'x', requestId: 'fake-req-1', outcome: 'executed', actions: [] };
    const s = fold([sse('order', order), sse('order', order), sse('episode', ep), sse('episode', { ...ep, rootHash: '0xabc' })]);
    expect(s.snapshot!.orders).toHaveLength(1);
    expect(s.snapshot!.episodes).toHaveLength(1);
    expect(s.snapshot!.episodes[0]!.rootHash).toBe('0xabc');
  });

  it('market ticks update mids and series but never the console', () => {
    const s = fold([sse('market', { ts: 't', mids: { BTC: 100 } }), sse('market', { ts: 't', mids: { BTC: 101, ETH: 5 } })]);
    expect(s.mids).toEqual({ BTC: 101, ETH: 5 });
    expect(s.series.BTC).toEqual([100, 101]);
    expect(s.console).toHaveLength(0);
  });

  it('ignores malformed events', () => {
    const s = fold([sse('decision', { nope: true }), sse('alert', 42), sse('state', 'x')]);
    expect(s.snapshot).toBeNull();
    expect(s.banner).toBeNull();
  });
});

describe('reducer: missing endpoints degrade', () => {
  it('a 404 marks providers and market as pending (backend upgrade)', () => {
    const notFound = { ok: false as const, kind: 'not_found' as const, status: 404, message: 'x' };
    const s = fold([
      { type: 'providers', result: notFound },
      { type: 'market/snapshot', result: notFound, at: T0 },
    ]);
    expect(s.providers.status).toBe('pending');
    expect(s.market.status).toBe('pending');
  });

  it('SSE providers flips the grid to live', () => {
    const s = fold([sse('providers', { providers: [{ id: 'og', label: '0G', track: '0g', state: 'live', detail: '', missingEnv: [] }] })]);
    expect(s.providers.status).toBe('live');
  });

  it('market history keeps hourly closes per coin', () => {
    const s = reducer(initialState, {
      type: 'market/history',
      coin: 'BTC',
      result: { ok: true, status: 200, data: { network: 'testnet', coin: 'BTC', interval: '1h', candles: [{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 0 }, { t: 2, o: 2, h: 2, l: 2, c: 2, v: 0 }] } },
    });
    expect(s.history.BTC).toEqual([1, 2]);
  });
});

describe('appendMids', () => {
  it('caps each series at the limit', () => {
    let series: Record<string, number[]> = {};
    for (let i = 0; i < 5; i++) series = appendMids(series, { BTC: i }, 3);
    expect(series.BTC).toEqual([2, 3, 4]);
  });
});

describe('selectors', () => {
  it('pipeline: stages light up after activity and decay', () => {
    const s = fold([sse('decision', decision)]);
    const brainNow = selectStages(s, T0 + 100).find((x) => x.id === 'brain')!;
    const brainLater = selectStages(s, T0 + ACTIVE_MS + 1).find((x) => x.id === 'brain')!;
    expect(brainNow.status).toBe('active');
    expect(brainLater.status).toBe('done');
    expect(selectStages(s, T0).find((x) => x.id === 'confirm')!.status).toBe('waiting');
  });

  it('pipeline: safe-stop blocks the brain, confirm and execute', () => {
    const s = fold([sse('state', { safeStop: true })]);
    const blocked = selectStages(s, T0).filter((x) => x.status === 'blocked').map((x) => x.id);
    expect(blocked).toEqual(['brain', 'confirm', 'execute']);
  });

  it('proofs: simulated ids are labelled and never linked', () => {
    const s = fold([
      sse('order', { orderId: 'fake-hl-1', coin: 'BTC', isBuy: false, sizeUsd: 10, status: 'simulated', url: 'https://app.hyperliquid.xyz', requestId: 'r', at: '2026-11-06T10:00:02Z' }),
      sse('episode', { seq: 1, at: '2026-11-06T10:00:01Z', requestId: 'fake-r', outcome: 'executed', actions: [], rootHash: '0xroot', txHash: '0xtx' }),
    ]);
    const proofs = selectProofs(s);
    const hl = proofs.find((p) => p.kind === 'hyperliquid')!;
    expect(hl.simulated).toBe(true);
    expect(hl.href).toBeUndefined();
    const root = proofs.find((p) => p.kind === '0g-storage')!;
    expect(root.href).toBe('https://chainscan-galileo.0g.ai/tx/0xtx');
    expect(proofs[0]!.kind).toBe('hyperliquid'); // newest first
  });
});
