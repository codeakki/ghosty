import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { FakeEthosScorer } from '../src/credibility/ethos.js';
import { dedupeKeys, NewsAggregator, NewsPoller, normalizeTitle, normalizeUrl } from '../src/news/aggregator.js';
import type { NewsItem, NewsProvider } from '../src/news/types.js';

const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

const item = (id: string, title: string, url: string, ageMin = 5, extra: Partial<NewsItem> = {}): NewsItem => ({
  id,
  source: id.split(':')[0]!,
  title,
  url,
  publishedAt: minutesAgo(ageMin),
  ...extra,
});

/** Provider whose next batch is set by the test. */
class StubProvider implements NewsProvider {
  calls = 0;
  constructor(
    readonly name: string,
    public items: NewsItem[] = [],
    private readonly delayMs = 0,
  ) {}
  async fetchLatest(): Promise<NewsItem[]> {
    this.calls++;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    return this.items;
  }
}

class FailingProvider implements NewsProvider {
  readonly name = 'broken';
  async fetchLatest(): Promise<NewsItem[]> {
    throw new Error('503');
  }
}

const tmpDirs: string[] = [];
after(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});
async function seenPath() {
  const dir = await mkdtemp(join(tmpdir(), 'ghosty-news-'));
  tmpDirs.push(dir);
  return join(dir, 'nested', 'news-seen.json');
}

describe('normalization', () => {
  it('normalizes titles and urls for dedupe', () => {
    assert.equal(normalizeTitle('  BREAKING: U.S. strikes — Iran!! '), 'breaking u s strikes iran');
    assert.equal(normalizeUrl('https://www.CoinDesk.com/markets/x/?utm_source=rss#top'), 'coindesk.com/markets/x');
    assert.deepEqual(dedupeKeys(item('rss:a', 'Short', 'https://a.com/1')), ['id:rss:a', 'url:a.com/1']);
  });
});

describe('NewsAggregator', () => {
  it('dedupes across providers by url and by normalized title', async () => {
    const rss = new StubProvider('rss', [
      item('rss:coindesk:1', 'Missile strike near Hormuz sends oil higher', 'https://www.coindesk.com/a?utm_source=rss'),
      item('rss:theblock:9', 'Exchange lists new token', 'https://theblock.co/9'),
    ]);
    const cp = new StubProvider('cryptopanic', [
      item('cryptopanic:7', 'Something else entirely', 'https://coindesk.com/a/'), // same url
      item('cryptopanic:8', 'MISSILE STRIKE near Hormuz sends oil higher!', 'https://other.com/b'), // same title
      item('cryptopanic:9', 'Fresh story', 'https://other.com/c'),
    ]);
    const agg = new NewsAggregator({ providers: [rss, cp], now: () => NOW });
    const r = await agg.poll();
    assert.deepEqual(r.fresh.map((i) => i.id).sort(), ['cryptopanic:9', 'rss:coindesk:1', 'rss:theblock:9']);
    assert.equal(r.window.length, 3);
    assert.deepEqual(r.errors, []);
  });

  it('keeps a rolling window: drops old items on arrival and prunes as time passes', async () => {
    let now = NOW;
    const p = new StubProvider('rss', [
      item('rss:a', 'Recent headline number one', 'https://a.com/1', 30),
      item('rss:b', 'Too old headline number two', 'https://a.com/2', 200),
      item('rss:c', 'Future dated headline three', 'https://a.com/3', -30), // clamped to now
    ]);
    const agg = new NewsAggregator({ providers: [p], windowMinutes: 120, now: () => now });
    const r = await agg.poll();
    assert.deepEqual(
      r.window.map((i) => i.id),
      ['rss:c', 'rss:a'],
    );
    assert.equal(r.window[0]!.publishedAt, new Date(NOW).toISOString());

    now += 100 * 60_000; // rss:a is now 130 min old
    assert.deepEqual(
      agg.window().map((i) => i.id),
      ['rss:c'],
    );
  });

  it('isolates failures and times out slow providers', async () => {
    const ok = new StubProvider('rss', [item('rss:a', 'A healthy provider headline', 'https://a.com/1')]);
    const slow = new StubProvider('slow', [item('slow:a', 'Too slow to matter here', 'https://a.com/2')], 200);
    const agg = new NewsAggregator({ providers: [ok, new FailingProvider(), slow], timeoutMs: 20, now: () => NOW });
    const r = await agg.poll();
    assert.deepEqual(
      r.fresh.map((i) => i.id),
      ['rss:a'],
    );
    assert.deepEqual(
      r.errors.map((e) => e.provider),
      ['broken', 'slow'],
    );
    assert.match(r.errors[1]!.message, /timed out after 20 ms/);
  });

  it('per-provider timeout overrides apply by provider name', async () => {
    const slow = new StubProvider('grok', [item('grok:1', 'Slow but allowed headline', 'https://x.com/a/status/1')], 40);
    const agg = new NewsAggregator({ providers: [slow], timeoutMs: 10, timeouts: { grok: 500 }, now: () => NOW });
    assert.equal((await agg.poll()).fresh.length, 1);
  });

  it('persists seen keys so a restart does not re-announce, but still rebuilds the window', async () => {
    const path = await seenPath();
    const p = new StubProvider('rss', [item('rss:a', 'Persisted headline for restart', 'https://a.com/1')]);
    const first = new NewsAggregator({ providers: [p], seenPath: path, now: () => NOW });
    assert.equal((await first.poll()).fresh.length, 1);
    const saved = JSON.parse(await readFile(path, 'utf8')) as { keys: string[] };
    assert.ok(saved.keys.includes('id:rss:a'));

    const restarted = new NewsAggregator({ providers: [p], seenPath: path, now: () => NOW });
    const r = await restarted.poll();
    assert.equal(r.fresh.length, 0);
    assert.equal(r.window.length, 1);
  });

  it('refreshes a repeated provider id in the window without re-announcing it (Polymarket odds)', async () => {
    const p = new StubProvider('polymarket', [item('polymarket:1', 'US strikes Iran by Nov 30?', 'https://polymarket.com/event/x', 1, { probability: 0.3 })]);
    const agg = new NewsAggregator({ providers: [p], now: () => NOW });
    await agg.poll();
    p.items = [item('polymarket:1', 'US strikes Iran by Nov 30?', 'https://polymarket.com/event/x', 0, { probability: 0.45 })];
    const r = await agg.poll();
    assert.equal(r.fresh.length, 0);
    assert.equal(r.window[0]!.probability, 0.45);
  });

  it('attaches credibility to fresh items when given a scorer', async () => {
    const p = new StubProvider('rss', [
      item('rss:a', 'Reuters wire headline here', 'https://www.reuters.com/world/x', 1, { domain: 'reuters.com' }),
      item('grok:1', 'Rumour from a random account', 'https://x.com/randomtrader123/status/1', 1, { handle: 'randomtrader123', domain: 'x.com' }),
    ]);
    const agg = new NewsAggregator({ providers: [p], scorer: new FakeEthosScorer(), now: () => NOW });
    const r = await agg.poll();
    const byId = Object.fromEntries(r.fresh.map((i) => [i.id, i.credibility]));
    assert.equal(byId['rss:a'], 1.0);
    // x.com is a known domain at 0.5; randomtrader123 has Ethos 600 → 0.371; max wins
    assert.equal(byId['grok:1'], 0.5);
    assert.equal(r.window.find((i) => i.id === 'rss:a')?.credibility, 1.0);
  });

  it('is a NewsProvider: fetchLatest polls once, then serves the window', async () => {
    const p = new StubProvider('rss', [item('rss:a', 'Provider facade headline', 'https://a.com/1')]);
    const agg = new NewsAggregator({ providers: [p], now: () => NOW });
    assert.equal((await agg.fetchLatest()).length, 1);
    await agg.fetchLatest();
    assert.equal(p.calls, 1);
  });
});

describe('NewsPoller', () => {
  it('emits onNew once per new item across ticks', async () => {
    const p = new StubProvider('rss', [item('rss:a', 'First headline of the day', 'https://a.com/1')]);
    const agg = new NewsAggregator({ providers: [p], now: () => NOW });
    const batches: string[][] = [];
    const poller = new NewsPoller(agg).onNew((items) => {
      batches.push(items.map((i) => i.id));
    });

    await poller.tick();
    await poller.tick(); // same items again: nothing new
    p.items = [...p.items, item('rss:b', 'Second headline of the day', 'https://a.com/2')];
    await poller.tick();
    assert.deepEqual(batches, [['rss:a'], ['rss:b']]);
  });

  it('does not overlap ticks, survives listener errors, and start/stop manage the timer', async () => {
    const p = new StubProvider('rss', [item('rss:a', 'Overlap check headline', 'https://a.com/1')], 20);
    const errors: unknown[] = [];
    const seen: string[] = [];
    const poller = new NewsPoller(new NewsAggregator({ providers: [p], now: () => NOW }), {
      intervalMs: 60_000,
      onError: (e) => errors.push(e),
    })
      .onNew(() => {
        throw new Error('listener blew up');
      })
      .onNew((items) => {
        seen.push(...items.map((i) => i.id));
      });

    await Promise.all([poller.tick(), poller.tick()]);
    assert.equal(p.calls, 1, 'concurrent ticks share one poll');
    assert.deepEqual(seen, ['rss:a']);
    assert.equal(errors.length, 1);

    poller.start();
    assert.equal(poller.started, true);
    poller.stop();
    assert.equal(poller.started, false);
  });
});
