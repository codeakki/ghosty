import { describe, expect, it } from 'vitest';
import type { MarketSnapshot, ProvidersStatus, X402Status } from '../../api/types';
import { feedReducer, filterCards, initialFeed, systemText, type FeedAction, type FeedCard, type FeedState } from './feedReducer';

const T0 = Date.UTC(2026, 10, 6, 9, 0, 0);
const sse = (event: Extract<FeedAction, { type: 'sse' }>['event'], data: unknown, at = T0): FeedAction => ({ type: 'sse', event, data, at });
const run = (actions: FeedAction[], from: FeedState = initialFeed()) => actions.reduce(feedReducer, from);
const only = <K extends FeedCard['kind']>(s: FeedState, kind: K) => s.cards.filter((c): c is Extract<FeedCard, { kind: K }> => c.kind === kind);

const news = {
  id: 'rss:reuters:1',
  source: 'rss',
  title: 'Missile strikes reported near oil terminal',
  url: 'https://example.com/a',
  publishedAt: '2026-11-06T08:59:00Z',
  handle: 'Reuters',
  credibility: { handle: 'Reuters', score: 1427, level: 'reputable', weight: 1 },
  signal: 'geopolitical_shock',
};

const decision = {
  requestId: 'chatcmpl-abc123',
  signal: 'geopolitical_shock',
  confidence: 0.81,
  rationale: 'Strike near an oil terminal: oil and gold usually bid.',
  trigger: 'inject',
  transcript: '',
  headline: news.title,
  at: '2026-11-06T09:00:01Z',
  actions: [{ venue: 'hyperliquid', kind: 'perp', coin: 'xyz:GOLD', side: 'long', sizeUsd: 12.5, reason: 'haven' }],
};

const snapshot = (over: Record<string, unknown> = {}) => ({
  news: [news],
  credibility: {},
  lastDecision: null,
  plannedActions: [],
  orders: [],
  swaps: [],
  episodes: [],
  safeStop: false,
  alerts: [],
  ...over,
});

const market: MarketSnapshot = {
  network: 'mainnet',
  ts: '2026-11-06T09:00:00Z',
  missing: [],
  assets: [
    { coin: 'BTC', dex: '', label: 'Bitcoin', mid: 100, prevDayPx: null, change24hPct: null, funding: null, openInterest: null, openInterestUsd: null, volume24h: null },
  ],
};

describe('feed reducer: event → card', () => {
  it('seeds the latest real headlines from the first state snapshot, once', () => {
    const s = run([sse('state', snapshot()), sse('state', snapshot())]);
    expect(only(s, 'news')).toHaveLength(1);
    expect(only(s, 'news')[0]!.item.title).toBe(news.title);
  });

  it('news → headline card, deduped by id', () => {
    const s = run([sse('news', news), sse('news', news)]);
    expect(only(s, 'news')).toHaveLength(1);
    expect(only(s, 'news')[0]!.item.credibility?.level).toBe('reputable');
  });

  it('decision → brain card with signal, confidence, rationale, legs and request id', () => {
    const s = run([sse('decision', decision)]);
    const [card] = only(s, 'brain');
    expect(card).toMatchObject({ status: 'done', requestId: 'chatcmpl-abc123', signal: 'geopolitical_shock', confidence: 0.81 });
    expect(card!.actions[0]!.coin).toBe('xyz:GOLD');
  });

  it('a pending brain card is replaced in place by the matching decision', () => {
    const s = run([
      { type: 'feed/brain-pending', localId: 'l1', prompt: 'TEST headline', trigger: 'inject', at: T0 },
      sse('decision', decision, T0 + 2000),
      { type: 'feed/brain-result', localId: 'l1', at: T0 + 2100, result: { ok: true, requestId: 'chatcmpl-abc123', signal: 'geopolitical_shock', confidence: 0.81, rationale: 'x', actions: [] } },
    ]);
    const brain = only(s, 'brain');
    expect(brain).toHaveLength(1);
    expect(brain[0]).toMatchObject({ status: 'done', requestId: 'chatcmpl-abc123', at: T0 });
  });

  it('a setup failure (missing key) removes the thinking card: it is not an agent event', () => {
    const s = run([
      { type: 'feed/brain-pending', localId: 'l2', prompt: 'TEST headline', trigger: 'inject', at: T0 },
      {
        type: 'feed/brain-result',
        localId: 'l2',
        at: T0 + 500,
        result: { ok: false, failure: { ok: false, kind: 'not_configured', status: 503, message: 'not_configured', provider: '0g-storage', missingEnv: ['OG_PRIVATE_KEY'] } },
      },
    ]);
    expect(only(s, 'brain')).toEqual([]);
  });

  it('a real failure (server error) keeps the card, marked failed', () => {
    const s = run([
      { type: 'feed/brain-pending', localId: 'l3', prompt: 'TEST headline', trigger: 'inject', at: T0 },
      { type: 'feed/brain-result', localId: 'l3', at: T0 + 500, result: { ok: false, failure: { ok: false, kind: 'http', status: 500, message: 'boom' } } },
    ]);
    expect(only(s, 'brain')[0]!.status).toBe('failed');
  });

  it('alert → "pinged your pod" card', () => {
    const s = run([sse('alert', { id: 'alert-1', text: 'Long gold?', signal: 'geopolitical_shock', actions: decision.actions, requestId: 'r', confidence: 0.8, status: 'pending', createdAt: '2026-11-06T09:00:02Z' })]);
    expect(only(s, 'alert')[0]!.alert.text).toBe('Long gold?');
  });

  it('order → Hyperliquid transaction card', () => {
    const s = run([sse('order', { orderId: '123', coin: 'xyz:GOLD', isBuy: true, sizeUsd: 12.5, status: 'filled', requestId: 'r', at: '2026-11-06T09:00:03Z', url: 'https://app.hyperliquid.xyz/explorer' })]);
    const [card] = only(s, 'tx');
    expect(card).toMatchObject({ tx: 'order', track: 'hyperliquid' });
  });

  it('episode → 0G Storage transaction card', () => {
    const s = run([sse('episode', { seq: 4, at: '2026-11-06T09:00:04Z', requestId: 'r', outcome: 'executed', actions: [], rootHash: '0xroot', txHash: '0xtx' })]);
    expect(only(s, 'tx')[0]).toMatchObject({ tx: 'episode', track: '0g' });
  });

  it('a new swap in a state snapshot → Uniswap card (once)', () => {
    const swap = { action: { tokenIn: 'USDC', tokenOut: 'WETH', amount: '5', chainId: 1, reason: 'x' }, result: { quoteId: 'q', txHash: '0xswap', status: 'confirmed', explorerUrl: 'https://etherscan.io/tx/0xswap' }, requestId: 'r', at: '2026-11-06T09:00:05Z' };
    const s = run([sse('state', snapshot()), sse('state', snapshot({ swaps: [swap] })), sse('state', snapshot({ swaps: [swap] }))]);
    expect(only(s, 'tx').filter((c) => c.tx === 'swap')).toHaveLength(1);
  });

  it('x402 lastPayment → Hedera payment card when the tx id changes', () => {
    const status = (txId: string | null): X402Status =>
      ({
        mode: 'real',
        lastPayment: txId ? { mode: 'real', txId, hashscanUrl: `https://hashscan.io/mainnet/transaction/${txId}`, amountTinybar: 1_000_000, at: '2026-11-06T09:00:06Z' } : null,
      }) as X402Status;
    const s = run([
      { type: 'x402', data: status(null), at: T0 },
      { type: 'x402', data: status('0.0.1@1'), at: T0 },
      { type: 'x402', data: status('0.0.1@1'), at: T0 },
    ]);
    const pays = only(s, 'tx').filter((c) => c.tx === 'payment');
    expect(pays).toHaveLength(1);
    expect(pays[0]!.track).toBe('hedera');
  });

  it('market mids → move card once a watched coin moves past the threshold', () => {
    const s = run([
      { type: 'market/snapshot', result: { ok: true, status: 200, data: market }, at: T0 },
      sse('market', { ts: 'x', mids: { BTC: 100 } }, T0),
      sse('market', { ts: 'x', mids: { BTC: 100.1 } }, T0 + 20_000),
      sse('market', { ts: 'x', mids: { BTC: 100.6 } }, T0 + 40_000),
    ]);
    const [card] = only(s, 'market');
    expect(card!.move).toMatchObject({ coin: 'BTC', reason: 'move' });
    expect(card!.points).toEqual([100, 100.1, 100.6]);
  });

  it('no move cards before the watch list is known', () => {
    const s = run([sse('market', { ts: 'x', mids: { BTC: 100 } }, T0), sse('market', { ts: 'x', mids: { BTC: 110 } }, T0 + 1000)]);
    expect(only(s, 'market')).toEqual([]);
  });

  it('provider state change → plain-English system card (but not on the first poll)', () => {
    const p = (state: 'live' | 'not_configured'): ProvidersStatus => ({
      providers: [{ id: 'groq', label: 'Groq STT', track: 'audio', state, detail: 'probe text', missingEnv: state === 'live' ? [] : ['GROQ_API_KEY'] }],
    });
    const s = run([sse('providers', p('not_configured')), sse('providers', p('live'), T0 + 1)]);
    const sys = only(s, 'system');
    expect(sys).toHaveLength(1);
    expect(systemText(sys[0]!)).toMatchObject({ title: 'Voice input online', tone: 'ok' });
    expect(systemText(sys[0]!).raw[0]).toContain('probe text');
  });

  it('a provider losing its config is a Setup notice, never a System card', () => {
    const p = (state: 'live' | 'not_configured'): ProvidersStatus => ({
      providers: [{ id: '0g-storage', label: '0G Storage', track: '0g', state, detail: 'OG_PRIVATE_KEY missing', missingEnv: state === 'live' ? [] : ['OG_PRIVATE_KEY'] }],
    });
    const s = run([sse('providers', p('live')), sse('providers', p('not_configured'), T0 + 1)]);
    expect(only(s, 'system')).toEqual([]);
    expect(s.cards.some((c) => c.kind === 'brain')).toBe(false);
  });

  it('a network blip across several providers is one card, led by the most important one', () => {
    const many = (state: 'live' | 'offline'): ProvidersStatus => ({
      providers: [
        { id: 'rss', label: 'RSS feeds', track: 'data', state, detail: state === 'live' ? '4/4 feeds reachable' : '0/4 feeds reachable', missingEnv: [] },
        { id: '0g-router', label: '0G Compute Router (decisions)', track: '0g', state, detail: 'key set; 0 models, glm-4.7 NOT listed', missingEnv: [] },
      ],
    });
    const s = run([sse('providers', many('live')), sse('providers', many('offline'), T0 + 1)]);
    const [card] = only(s, 'system');
    const text = systemText(card!);
    expect(text.title).toBe('0G brain unreachable, trading paused');
    expect(text.detail).toContain('News wires unreachable');
    expect(text.title).not.toContain('glm-4.7');
    expect(text.detail).not.toContain('glm-4.7');
    // The raw probe text is only in the collapsed details.
    expect(text.raw.join('\n')).toContain('glm-4.7 NOT listed');
    expect(text.tone).toBe('warn');
  });

  it('flapping within 60 s updates the same card in place; after 60 s a new card starts', () => {
    const p = (state: 'live' | 'offline', detail = ''): ProvidersStatus => ({
      providers: [{ id: 'rss', label: 'RSS feeds', track: 'data', state, detail, missingEnv: [] }],
    });
    const s1 = run([
      sse('providers', p('live')),
      sse('providers', p('offline'), T0 + 1_000),
      sse('providers', p('live', '4/4 feeds reachable'), T0 + 20_000),
      sse('providers', p('offline'), T0 + 50_000),
      sse('providers', p('live', '4/4 feeds reachable'), T0 + 70_000),
    ]);
    const sys = only(s1, 'system');
    expect(sys).toHaveLength(1);
    expect(sys[0]!.flips).toBe(4);
    expect(systemText(sys[0]!).title).toBe('News wires online (4/4)');
    expect(systemText(sys[0]!).detail).toContain('Changed 4 times');
    const s2 = run([sse('providers', p('offline'), T0 + 200_000)], s1);
    expect(only(s2, 'system')).toHaveLength(2);
  });

  it('safe-stop toggles → one system card that updates in place while flapping', () => {
    const s = run([sse('state', snapshot()), sse('state', snapshot({ safeStop: true }), T0 + 1), sse('state', snapshot({ safeStop: false }), T0 + 2)]);
    const sys = only(s, 'system');
    expect(sys).toHaveLength(1);
    expect(systemText(sys[0]!).title).toBe('Safe-stop off, trading allowed');
    const later = run([sse('state', snapshot({ safeStop: true }), T0 + 120_000)], s);
    expect(only(later, 'system').map((c) => systemText(c).title)).toEqual(['Safe-stop on, trading paused', 'Safe-stop off, trading allowed']);
  });

  it('an order that changes status updates its card in place', () => {
    const order = (status: string) => ({ orderId: '77', coin: 'xyz:GOLD', isBuy: true, sizeUsd: 12.5, status, requestId: 'r', at: '2026-11-06T09:00:03Z' });
    const s = run([sse('order', order('resting'), T0), sse('news', news, T0 + 1000), sse('order', order('filled'), T0 + 2000)]);
    const tx = only(s, 'tx');
    expect(tx).toHaveLength(1);
    expect(tx[0]!.tx === 'order' && tx[0]!.order.status).toBe('filled');
    expect(s.cards.map((c) => c.kind)).toEqual(['news', 'tx']);
  });

  it('keeps cards newest first and filters by chip', () => {
    const s = run([sse('news', news, T0), sse('decision', decision, T0 + 1000), sse('episode', { seq: 1, at: 'x', requestId: 'r', outcome: 'proposed', actions: [] }, T0 + 2000)]);
    expect(s.cards.map((c) => c.kind)).toEqual(['tx', 'brain', 'news']);
    expect(filterCards(s.cards, 'agent').map((c) => c.kind)).toEqual(['brain']);
    expect(filterCards(s.cards, 'tx')).toHaveLength(1);
    expect(filterCards(s.cards, 'news')).toHaveLength(1);
    expect(filterCards(s.cards, 'all')).toHaveLength(3);
  });

  it('ignores malformed payloads', () => {
    const s = run([sse('news', { nope: true }), sse('decision', null), sse('order', 'x'), sse('market', {})]);
    expect(s.cards).toEqual([]);
  });
});
