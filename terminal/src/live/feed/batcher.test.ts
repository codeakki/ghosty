import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BATCH_WINDOW_MS, createBatcher } from './batcher';
import { FEED_LIMIT, applyBatch, initialFeed, type FeedAction } from './feedReducer';

describe('SSE batcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces actions that arrive within 150 ms into one apply, in order', () => {
    const applied: number[][] = [];
    const b = createBatcher<number>((xs) => applied.push(xs));
    b.push(1);
    vi.advanceTimersByTime(50);
    b.push(2);
    vi.advanceTimersByTime(90);
    b.push(3);
    expect(applied).toEqual([]);
    vi.advanceTimersByTime(10);
    expect(applied).toEqual([[1, 2, 3]]);
  });

  it('opens a new window after a flush (bounded latency, no sliding window)', () => {
    const applied: number[][] = [];
    const b = createBatcher<number>((xs) => applied.push(xs));
    b.push(1);
    vi.advanceTimersByTime(BATCH_WINDOW_MS);
    b.push(2);
    vi.advanceTimersByTime(BATCH_WINDOW_MS - 1);
    expect(applied).toEqual([[1]]);
    vi.advanceTimersByTime(1);
    expect(applied).toEqual([[1], [2]]);
  });

  it('flush() applies immediately and cancel() drops the queue', () => {
    const applied: number[][] = [];
    const b = createBatcher<number>((xs) => applied.push(xs));
    b.push(1);
    b.flush();
    expect(applied).toEqual([[1]]);
    b.push(2);
    b.cancel();
    vi.advanceTimersByTime(1000);
    expect(applied).toEqual([[1]]);
  });

  it('never applies an empty batch', () => {
    const apply = vi.fn();
    const b = createBatcher<number>(apply);
    b.flush();
    vi.advanceTimersByTime(1000);
    expect(apply).not.toHaveBeenCalled();
  });
});

describe('applyBatch: one render per burst', () => {
  const T0 = Date.UTC(2026, 10, 6, 9, 0, 0);
  const news = (i: number): FeedAction => ({
    type: 'sse',
    event: 'news',
    at: T0 + i,
    data: { id: `rss:x:${i}`, source: 'rss', title: `Headline ${i}`, url: '', publishedAt: '2026-11-06T09:00:00Z', credibility: null, signal: 'none' },
  });

  it('folds a burst and lists the new cards of that batch, newest first', () => {
    const seeded = { ...initialFeed(), seeded: true };
    const s = applyBatch(seeded, [news(1), news(2), news(3)]);
    expect(s.cards).toHaveLength(3);
    expect(s.lastBatch).toEqual(['news:rss:x:3', 'news:rss:x:2', 'news:rss:x:1']);
  });

  it('the very first snapshot is history: no entrance glow for the seed', () => {
    const s = applyBatch(initialFeed(), [news(1), news(2)]);
    expect(s.cards).toHaveLength(2);
    expect(s.lastBatch).toEqual([]);
  });

  it('returns the same state when nothing in the batch changes it', () => {
    const s0 = applyBatch(initialFeed(), [news(1)]);
    expect(applyBatch(s0, [news(1)])).toBe(s0);
  });

  it(`caps the feed at ${FEED_LIMIT} cards, dropping the oldest`, () => {
    const actions = Array.from({ length: FEED_LIMIT + 25 }, (_, i) => news(i));
    const s = applyBatch(initialFeed(), actions);
    expect(FEED_LIMIT).toBe(100);
    expect(s.cards).toHaveLength(FEED_LIMIT);
    expect(s.cards[0]!.id).toBe(`news:rss:x:${FEED_LIMIT + 24}`);
    expect(s.cards.at(-1)!.id).toBe('news:rss:x:25');
  });
});
