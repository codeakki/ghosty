import { describe, expect, it } from 'vitest';
import {
  describeError,
  normalizeBaseUrl,
  parseMarketHistory,
  parseMarketSnapshot,
  parseMarketTick,
  parseProviders,
  parseSnapshot,
  toResult,
} from './client';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('parseSnapshot', () => {
  it('reads a real /state body and drops malformed items', () => {
    const snap = parseSnapshot({
      news: [
        {
          id: 'inject:1',
          source: 'inject',
          title: 'Missile strikes reported',
          url: '',
          publishedAt: '2026-11-06T10:00:00.000Z',
          handle: 'Reuters',
          credibility: { handle: 'Reuters', score: 2100, level: 'reputable', weight: 0.9 },
          signal: 'geopolitical_shock',
        },
        { id: 'broken' }, // no title
        'nonsense',
      ],
      credibility: { Reuters: { handle: 'Reuters', score: 2100, level: 'reputable', weight: 0.9 } },
      lastDecision: {
        requestId: 'req-1',
        signal: 'geopolitical_shock',
        confidence: 0.8,
        rationale: 'War.',
        trigger: 'inject',
        transcript: '',
        at: '2026-11-06T10:00:01.000Z',
      },
      plannedActions: [{ venue: 'hyperliquid', kind: 'perp', coin: 'xyz:GOLD', side: 'long', sizeUsd: 13, reason: 'haven' }],
      orders: [],
      swaps: [],
      episodes: [{ seq: 1, at: '2026-11-06T10:00:01.000Z', requestId: 'req-1', outcome: 'proposed', actions: [] }],
      safeStop: false,
      alerts: [],
    });
    expect(snap).not.toBeNull();
    expect(snap!.news).toHaveLength(1);
    expect(snap!.news[0]!.credibility?.score).toBe(2100);
    expect(snap!.lastDecision?.requestId).toBe('req-1');
    expect(snap!.lastDecision).not.toHaveProperty('actions');
    expect(snap!.plannedActions[0]).toMatchObject({ coin: 'xyz:GOLD', side: 'long', sizeUsd: 13 });
    expect(snap!.episodes[0]!.seq).toBe(1);
  });

  it('fills defaults instead of crashing on a partial body', () => {
    const snap = parseSnapshot({ safeStop: true });
    expect(snap).toEqual({
      news: [],
      credibility: {},
      lastDecision: null,
      plannedActions: [],
      orders: [],
      swaps: [],
      episodes: [],
      safeStop: true,
      alerts: [],
    });
    expect(parseSnapshot(null)).toBeNull();
  });

  it('keeps unknown signals out of the UI', () => {
    const snap = parseSnapshot({ news: [{ id: 'a', title: 't', signal: 'moon' }] });
    expect(snap!.news[0]!.signal).toBe('none');
  });
});

describe('new endpoint parsers', () => {
  it('parses /providers/status and coerces unknown tracks and states', () => {
    const p = parseProviders({
      providers: [
        { id: 'groq', label: 'Groq STT', track: 'audio', state: 'not_configured', detail: '', missingEnv: ['GROQ_API_KEY'] },
        { id: 'x', track: 'mars', state: 'weird' },
        { label: 'no id' },
      ],
    });
    expect(p!.providers).toHaveLength(2);
    expect(p!.providers[0]!.missingEnv).toEqual(['GROQ_API_KEY']);
    expect(p!.providers[1]).toMatchObject({ track: 'data', state: 'offline', label: 'x' });
    expect(parseProviders({})).toBeNull();
  });

  it('parses /market/snapshot with nulls kept as nulls', () => {
    const s = parseMarketSnapshot({
      network: 'mainnet',
      ts: 't',
      assets: [{ coin: 'BTC', dex: '', label: 'Bitcoin', mid: '104000.5', prevDayPx: 100000, funding: null }],
      missing: ['xyz:TSLA'],
    });
    expect(s!.network).toBe('mainnet');
    expect(s!.assets[0]).toMatchObject({ coin: 'BTC', mid: 104000.5, prevDayPx: 100000, funding: null, openInterestUsd: null });
    expect(s!.missing).toEqual(['xyz:TSLA']);
  });

  it('parses /market/history candles from numbers or strings, oldest first', () => {
    const h = parseMarketHistory({
      network: 'testnet',
      coin: 'BTC',
      interval: '1h',
      candles: [
        { t: 2000, o: '2', h: '3', l: '1', c: '2.5', v: '10' },
        { t: 1000, o: 1, h: 2, l: 1, c: 1.5, v: 5 },
        { t: 3000 }, // no close: dropped
      ],
    });
    expect(h!.candles.map((c) => c.c)).toEqual([1.5, 2.5]);
  });

  it('drops non-positive mids from SSE market ticks', () => {
    expect(parseMarketTick({ ts: 't', mids: { BTC: 1, ETH: '2', BAD: 0, NAN: 'x' } })!.mids).toEqual({ BTC: 1, ETH: 2 });
  });
});

describe('toResult', () => {
  const parse = (b: unknown) => b;

  it('maps a framework 404 to "backend upgrade pending"', async () => {
    const r = await toResult(json(404, { message: 'Route GET:/providers/status not found', error: 'Not Found', statusCode: 404 }), parse);
    expect(r).toMatchObject({ ok: false, kind: 'not_found' });
    if (!r.ok) expect(describeError(r)).toMatch(/Backend upgrade pending/);
  });

  it('keeps an app-level 404 (unknown coin) as a plain HTTP error', async () => {
    const r = await toResult(json(404, { error: 'unknown_coin', coin: 'FOO' }), parse);
    expect(r).toMatchObject({ ok: false, kind: 'http', status: 404 });
  });

  it('maps 503 brain_offline to safe-stop', async () => {
    const r = await toResult(json(503, { error: 'brain_offline' }), parse);
    expect(r).toMatchObject({ ok: false, kind: 'brain_offline' });
    if (!r.ok) expect(describeError(r)).toMatch(/safe-stop/);
  });

  it('maps 503 not_configured with the env vars to set', async () => {
    const r = await toResult(
      json(503, { error: 'not_configured', provider: 'groq', missingEnv: ['GROQ_API_KEY'], message: 'GROQ_API_KEY is not set' }),
      parse,
    );
    expect(r).toMatchObject({ ok: false, kind: 'not_configured', provider: 'groq', missingEnv: ['GROQ_API_KEY'] });
    if (!r.ok) expect(describeError(r)).toBe('Not configured: set GROQ_API_KEY (groq).');
  });

  it('treats brain_offline with reason not_configured as not configured', async () => {
    const r = await toResult(
      json(503, { error: 'brain_offline', reason: 'not_configured', provider: '0g-router', missingEnv: ['OG_API_KEY'] }),
      parse,
    );
    expect(r).toMatchObject({ ok: false, kind: 'not_configured', missingEnv: ['OG_API_KEY'] });
  });

  it('maps 401 and unexpected shapes', async () => {
    expect(await toResult(json(401, { error: 'unauthorized' }), parse)).toMatchObject({ kind: 'unauthorized' });
    expect(await toResult(json(200, { x: 1 }), () => null)).toMatchObject({ ok: false, kind: 'parse' });
  });
});

describe('normalizeBaseUrl', () => {
  it('trims and drops trailing slashes', () => {
    expect(normalizeBaseUrl(' http://pod.local:3000// ')).toBe('http://pod.local:3000');
    expect(normalizeBaseUrl('')).toBe('');
  });
});
