import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent } from 'react';
import { describeError } from '../../api/client';
import type { MarketAsset } from '../../api/types';
import type { LiveApi } from '../useLive';
import { coinName, formatAssetPx, formatSignedPct } from '../words';
import { FeedCardView, type CardContext } from './cards';
import { filterCards, isSetupFailure, type FeedCard, type FeedFilter } from './feedReducer';
import { setupNotice, watching, watchingText, type SetupNotice } from './setup';

const FILTERS: Array<{ id: FeedFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'market', label: 'Market' },
  { id: 'news', label: 'News' },
  { id: 'agent', label: 'Agent' },
  { id: 'tx', label: 'Transactions' },
];

const PULSE = ['BTC', 'ETH', 'xyz:GOLD', 'xyz:CL', 'xyz:SP500'];
const PAUSE_SCROLL_PX = 24;
/** A price repaints at most twice a second (matches --tick-min-interval). */
const TICK_MIN_MS = 500;
/** How long a programmatic scroll (anchoring / reveal) suppresses pause detection if `scrollend` never fires. */
const AUTO_SCROLL_MS = 900;

function filterFromSearch(): FeedFilter {
  const f = new URLSearchParams(window.location.search).get('filter');
  return FILTERS.some((x) => x.id === f) ? (f as FeedFilter) : 'all';
}

/** Stable key: a "thinking" card keeps its key when it becomes the decision (same element, morphs in place). */
function keyOf(c: FeedCard): string {
  return c.kind === 'brain' && c.localId ? c.localId : c.id;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/**
 * The live feed: newest on top. Stability rules (docs/design/ghosty-design.md, "Motion & stability"):
 *  - bursts arrive pre-batched (150 ms) from useLive, so one burst = one layout change;
 *  - inserting above what you are reading never moves it: scrollTop is compensated in the same frame
 *    (scroll anchoring), then, if you were at the top, the list scrolls smoothly to reveal the new card;
 *  - hovering or scrolling down freezes the list and a floating "N New" pill (in reserved space) offers a jump back.
 */
export function FeedPage({ api, full = false }: { api: LiveApi; full?: boolean }) {
  const { feed, state, feedViewRef } = api;
  const [filter, setFilter] = useState<FeedFilter>(filterFromSearch);
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState<Set<string> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLOListElement>(null);

  const filtered = useMemo(() => filterCards(feed.cards, filter), [feed.cards, filter]);
  const visible = useMemo(() => (frozen ? filtered.filter((c) => frozen.has(keyOf(c))) : filtered), [filtered, frozen]);
  const newCount = filtered.length - visible.length;

  // Refs mirror the pause inputs so scroll/pointer handlers stay stable.
  const keysRef = useRef<string[]>([]);
  const pauseRef = useRef({ hover: false, scroll: false });
  const autoScroll = useRef<{ until: number }>({ until: 0 });
  const anchor = useRef<{ key: string; top: number } | null>(null);
  useEffect(() => {
    keysRef.current = filtered.map(keyOf);
  }, [filtered]);

  /** Freeze the visible set when a pause starts; release it when the pause ends. */
  const applyPause = useCallback((next: { hover?: boolean; scroll?: boolean }) => {
    const p = { ...pauseRef.current, ...next };
    if (p.hover === pauseRef.current.hover && p.scroll === pauseRef.current.scroll) return;
    pauseRef.current = p;
    const on = p.hover || p.scroll;
    setPaused(on);
    setFrozen((prev) => (on ? (prev ?? new Set(keysRef.current)) : null));
  }, []);

  // Tell the dispatcher whether an in-place morph would be on screen.
  useEffect(() => {
    feedViewRef.current = { mounted: true, paused, filter };
  }, [feedViewRef, paused, filter]);
  useEffect(
    () => () => {
      feedViewRef.current = { ...feedViewRef.current, mounted: false };
    },
    [feedViewRef],
  );

  /** The first card at the top edge of the scroller: what the user is reading. */
  const recordAnchor = useCallback(() => {
    const sc = scrollRef.current;
    const list = listRef.current;
    if (!sc || !list) return;
    const top = sc.scrollTop;
    for (const child of Array.from(list.children) as HTMLElement[]) {
      if (child.offsetTop + child.offsetHeight > top) {
        const key = child.dataset.key;
        anchor.current = key ? { key, top: child.offsetTop } : null;
        return;
      }
    }
    anchor.current = null;
  }, []);

  const markAutoScroll = useCallback(() => {
    autoScroll.current.until = performance.now() + AUTO_SCROLL_MS;
  }, []);

  // Scroll anchoring: after every list change, keep the anchor card where it was on screen (same frame, so it is
  // a scroll, not a layout shift). If the reader was at the top, then glide up to reveal what arrived.
  useLayoutEffect(() => {
    const sc = scrollRef.current;
    const list = listRef.current;
    if (!sc || !list) return;
    const a = anchor.current;
    if (a) {
      const el = list.querySelector<HTMLElement>(`[data-key="${CSS.escape(a.key)}"]`);
      const delta = el ? el.offsetTop - a.top : 0;
      if (delta !== 0) {
        const wasAtTop = sc.scrollTop <= PAUSE_SCROLL_PX;
        markAutoScroll();
        sc.scrollTop += delta;
        if (wasAtTop && !pauseRef.current.hover && !pauseRef.current.scroll) {
          const reduced = prefersReducedMotion();
          requestAnimationFrame(() => {
            markAutoScroll();
            sc.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
          });
        }
      }
    }
    recordAnchor();
  }, [visible, recordAnchor, markAutoScroll]);

  // Scrolling down pauses inserts (programmatic scrolls do not count).
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        recordAnchor();
        if (performance.now() < autoScroll.current.until) return;
        applyPause({ scroll: sc.scrollTop > PAUSE_SCROLL_PX });
      });
    };
    const onEnd = () => {
      autoScroll.current.until = 0;
      recordAnchor();
    };
    sc.addEventListener('scroll', onScroll, { passive: true });
    sc.addEventListener('scrollend', onEnd);
    return () => {
      cancelAnimationFrame(raf);
      sc.removeEventListener('scroll', onScroll);
      sc.removeEventListener('scrollend', onEnd);
    };
  }, [applyPause, recordAnchor]);

  const jumpToNew = useCallback(() => {
    applyPause({ hover: false, scroll: false });
    anchor.current = null;
    markAutoScroll();
    scrollRef.current?.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, [applyPause, markAutoScroll]);

  const chooseFilter = (f: FeedFilter) => {
    setFilter(f);
    setFrozen(null);
    pauseRef.current = { hover: false, scroll: false };
    setPaused(false);
    anchor.current = null;
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    const q = new URLSearchParams(window.location.search);
    if (f === 'all') q.delete('filter');
    else q.set('filter', f);
    const qs = q.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
  };

  const onEnter = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') applyPause({ hover: true });
  };
  const onLeave = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') applyPause({ hover: false });
  };

  const storagescan = state.zeroG?.links.storagescan;
  const ctx: CardContext = useMemo(() => ({ labels: feed.labels, storagescan }), [feed.labels, storagescan]);
  const batchOrder = useMemo(() => new Map(feed.lastBatch.map((id, i) => [id, i])), [feed.lastBatch]);
  const providers = state.providers.data?.providers;
  const setup = useMemo(() => setupNotice(providers), [providers]);
  const watch = useMemo(() => watching(providers, state.market.data?.assets.length ?? null), [providers, state.market.data?.assets.length]);
  // First render waits for both the snapshot and provider status, so the notice/intro never push cards in later.
  const loading = (!feed.seeded || state.providers.status === 'loading') && state.serverReachable !== false;
  const hasStory = feed.cards.some((c) => c.kind === 'brain' || c.kind === 'alert' || c.kind === 'tx');
  const showIntro = !loading && !hasStory && (filter === 'all' || filter === 'agent');

  return (
    <section className={`lv-feed${full ? ' lv-feed-full' : ''}`} aria-labelledby="feed-title">
      <div className="lv-feed-top">
        <PulseStrip assets={state.market.data?.assets ?? null} mids={state.mids} status={state.market.status} message={state.market.message} />
        {/* The "N New" pill lives in the title row: outside the scroller, fixed height, never over a card. */}
        <div className="lv-feed-head">
          <h2 id="feed-title" className="lv-feed-title">
            Live feed
          </h2>
          {newCount > 0 ? (
            <button type="button" className="lv-new-pill" onClick={jumpToNew}>
              <span aria-hidden="true">↑</span> <span className="lv-num">{newCount}</span> New
            </button>
          ) : null}
        </div>
        <div className="lv-chips" role="group" aria-label="Filter the feed">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" className="lv-chip" aria-pressed={filter === f.id} onClick={() => chooseFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="lv-feed-scroll" ref={scrollRef}>
        {!loading && setup ? <SetupBox notice={setup} /> : null}
        {showIntro ? (
          <section className="lv-intro" aria-label="What Ghosty is watching">
            <p className="lv-intro-title">Watching {watchingText(watch)}.</p>
            <p className="lv-intro-body">
              Ghosty speaks up when a headline could move one of them. Big price moves show below as one-line rows.
            </p>
          </section>
        ) : null}
        <ol className="lv-cards" ref={listRef} aria-live="polite" aria-relevant="additions" aria-label="Feed cards, newest first" onPointerEnter={onEnter} onPointerLeave={onLeave}>
          {(loading ? [] : visible).map((card) => {
            const key = keyOf(card);
            const order = batchOrder.get(card.id);
            return (
              <FeedCardView
                key={key}
                dataKey={key}
                card={card}
                ctx={ctx}
                fresh={order !== undefined}
                style={order !== undefined ? ({ '--i': order } as CSSProperties) : undefined}
              />
            );
          })}
          {loading ? <SkeletonCards /> : null}
        </ol>
        {!loading && visible.length === 0 ? <EmptyFeed filter={filter} api={api} /> : null}
        {/* Only after the first snapshot: it sits below the cards, so it never gets pushed down by them. */}
        {feed.seeded ? <TestHeadline api={api} onSend={jumpToNew} /> : null}
      </div>
    </section>
  );
}

/** One calm notice for everything the server still needs. Env var names only inside Details. */
function SetupBox({ notice }: { notice: SetupNotice }) {
  const needed = notice.issues.filter((i) => i.blocking);
  const optional = notice.issues.filter((i) => !i.blocking);
  return (
    <details className="lv-setup">
      <summary>
        <span className="lv-setup-tag">Setup</span>
        <span className="lv-setup-text">{notice.headline}</span>
        <span className="lv-setup-more">Details</span>
      </summary>
      {needed.length > 0 ? <SetupList title="Needed" issues={needed} /> : null}
      {optional.length > 0 ? <SetupList title="Optional" issues={optional} /> : null}
      <p className="lv-setup-foot">Set these in server/.env and restart the server. Everything else keeps working.</p>
    </details>
  );
}

function SetupList({ title, issues }: { title: string; issues: SetupNotice['issues'] }) {
  return (
    <>
      <p className="lv-setup-group">{title}</p>
      <ul className="lv-setup-list">
        {issues.map((i) => (
          <li key={i.id}>
            <span className="lv-setup-label">{i.label}</span> <span className="lv-setup-effect">for {i.effect}</span>
            {i.env.length > 0 ? (
              <span className="lv-setup-env">
                {' '}
                · set{' '}
                {i.env.map((e, n) => (
                  <code key={e} className="lv-mono" translate="no">
                    {n > 0 ? ' + ' : ''}
                    {e}
                  </code>
                ))}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}

/** Placeholders with the final card dimensions, so the first real cards replace them without a jump. */
function SkeletonCards() {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <li key={i} className="lv-card lv-skeleton" aria-hidden="true">
          <span className="lv-skel-line lv-skel-short" />
          <span className="lv-skel-line" />
          <span className="lv-skel-line lv-skel-mid" />
        </li>
      ))}
    </>
  );
}

function EmptyFeed({ filter, api }: { filter: FeedFilter; api: LiveApi }) {
  const { state } = api;
  const rss = state.providers.data?.providers.find((p) => p.id === 'rss');
  const feeds = rss?.detail.match(/(\d+)\/(\d+) feeds/)?.[2];
  let text: string;
  switch (filter) {
    case 'market':
      text = `Quiet so far. A row appears when a market moves ${api.moveOptions.thresholdPct}% within 5 minutes, makes a new 1-hour high or low, or crosses 2% on the day.`;
      break;
    case 'news':
      text = `Waiting for the next headline — the agent watches ${feeds ?? 'its'} news wires + Polymarket.`;
      break;
    case 'agent':
      text = 'No decisions yet. Ghosty decides on 0G when you ask it something or a headline is injected.';
      break;
    case 'tx':
      text = 'No transactions yet. Orders, swaps, x402 payments and 0G Storage episodes show up here with explorer links.';
      break;
    default:
      text = state.serverReachable === false ? 'The Ghosty server is unreachable. Start it with: cd server && npm run dev' : 'Waiting for the first event…';
  }
  return (
    <p className="lv-empty" role="status">
      {text}
    </p>
  );
}

/** Send a clearly-labelled test headline through the real pipeline (POST /news/inject). */
function TestHeadline({ api, onSend }: { api: LiveApi; onSend: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const input = e.currentTarget.elements.namedItem('headline') as HTMLInputElement | null;
    const raw = input?.value.trim();
    if (!raw) return;
    setBusy(true);
    setResult(null);
    const title = /^test\b/i.test(raw) ? raw : `TEST: ${raw}`;
    // Show the "thinking on 0G" card as it lands.
    onSend();
    const r = await api.live.injectNews(title);
    setBusy(false);
    if (r.ok) {
      setResult(r.data.alert ? 'Decision made: your pod was pinged.' : 'Decision made: nothing actionable.');
      if (input) input.value = '';
    } else {
      setResult(isSetupFailure(r) ? 'Couldn’t run: Ghosty isn’t fully set up yet (see Setup above).' : describeError(r));
    }
  };
  return (
    <details className="lv-test">
      <summary>Try It: Send a Test Headline</summary>
      <form onSubmit={onSubmit} className="lv-test-form">
        <label htmlFor="test-headline" className="lv-test-label">
          Runs the real agent on 0G. Marked “TEST” in the feed.
        </label>
        <div className="lv-test-row">
          <input id="test-headline" name="headline" className="lv-input" type="text" autoComplete="off" placeholder="e.g. Missile strikes near Gulf oil terminal…" />
          <button type="submit" className="lv-btn" disabled={busy}>
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
        <p className="lv-test-result" role="status">
          {result}
        </p>
      </form>
    </details>
  );
}

/**
 * A price that updates in place: at most twice a second, tabular digits in a fixed-width cell, and a brief
 * up/down tint (an opacity-only overlay) when it changes.
 */
const TickerPrice = memo(function TickerPrice({ coin, value }: { coin: string; value: number | null }) {
  const [shown, setShown] = useState(value);
  const [flash, setFlash] = useState<{ dir: 'up' | 'down' | null; n: number }>({ dir: null, n: 0 });
  const shownRef = useRef(value);
  const lastAt = useRef(0);
  useEffect(() => {
    if (value === null) return;
    const wait = Math.max(0, lastAt.current + TICK_MIN_MS - performance.now());
    const t = setTimeout(() => {
      const prev = shownRef.current;
      if (prev === value) return;
      lastAt.current = performance.now();
      shownRef.current = value;
      setShown(value);
      if (prev !== null) setFlash((f) => ({ dir: value > prev ? 'up' : 'down', n: f.n + 1 }));
    }, wait);
    return () => clearTimeout(t);
  }, [value]);
  return (
    <span className="lv-tick lv-num">
      {flash.dir ? <span key={flash.n} className={`lv-tick-flash lv-tick-${flash.dir}`} aria-hidden="true" /> : null}
      {shown !== null ? formatAssetPx(coin, shown) : '—'}
    </span>
  );
});

const PulseStrip = memo(function PulseStrip({
  assets,
  mids,
  status,
  message,
}: {
  assets: MarketAsset[] | null;
  mids: Record<string, number>;
  status: string;
  message?: string;
}) {
  if (!assets) {
    // Same tiles, same size: the strip never pops in.
    return (
      <ul className="lv-pulse" aria-label={status === 'loading' ? 'Loading live prices…' : (message ?? 'Live prices unavailable')}>
        {PULSE.map((c) => (
          <li key={c} className="lv-pulse-item lv-pulse-skel" aria-hidden="true">
            <span className="lv-pulse-name">{coinName(c)}</span>
            <span className="lv-pulse-px lv-num">{status === 'loading' ? '' : '—'}</span>
            <span className="lv-delta lv-num" />
          </li>
        ))}
      </ul>
    );
  }
  const picked = PULSE.map((c) => assets.find((a) => a.coin === c)).filter((a): a is MarketAsset => a !== undefined);
  const list = picked.length > 0 ? picked : assets.slice(0, 5);
  return (
    <ul className="lv-pulse" aria-label="Live prices, change over 24 hours">
      {list.map((a) => {
        const mid = mids[a.coin] ?? a.mid;
        const change = mid !== null && a.prevDayPx ? ((mid - a.prevDayPx) / a.prevDayPx) * 100 : a.change24hPct;
        const dir = change === null ? 'flat' : change >= 0 ? 'up' : 'down';
        return (
          <li key={a.coin} className="lv-pulse-item">
            <span className="lv-pulse-name">{coinName(a.coin)}</span>
            <span className="lv-pulse-px">
              <TickerPrice coin={a.coin} value={mid} />
            </span>
            <span className={`lv-delta lv-delta-${dir} lv-num`} title="Change over 24 hours">
              {change === null ? (
                '—'
              ) : (
                <>
                  <span aria-hidden="true">{dir === 'up' ? '▲' : '▼'}</span> {formatSignedPct(change)}
                </>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
});
