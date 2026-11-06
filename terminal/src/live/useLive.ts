import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { ClientSettings } from '../api/client';
import type { ApiResult, InjectResult, TextTurnResult, VoiceReply } from '../api/types';
import { useTerminal } from '../state/useTerminal';
import { createBatcher, type Batcher } from './feed/batcher';
import { applyBatch, initialFeed, type FeedAction, type FeedCard, type FeedFilter, type FeedState } from './feed/feedReducer';
import { DEFAULT_MOVE_OPTIONS, thresholdFromSearch } from './feed/moveDetector';

/**
 * One connection to the Ghosty server for the whole Live view: the terminal's SSE + polls, with the feed reducer
 * folding the same actions. Device and Feed share it, so the split view opens one event stream, not two.
 */
export function useLive(settings: ClientSettings) {
  const [moveOptions] = useMoveOptions();
  const [feed, setFeed] = useState<FeedState>(() => initialFeed(moveOptions));
  const feedRef = useRef(feed);
  /** Written by the Feed page: whether new cards would be visible right now (mounted, not paused, matching filter). */
  const feedViewRef = useRef<FeedView>({ mounted: false, paused: false, filter: 'all' });

  // SSE bursts are coalesced (150 ms) into one render, so a burst never cascades into several jumps.
  // A card that changes in place on screen (thinking → decision) morphs inside a View Transition.
  const batcherRef = useRef<Batcher<FeedAction> | null>(null);
  const getBatcher = useCallback(() => {
    if (!batcherRef.current) {
      batcherRef.current = createBatcher<FeedAction>((batch) => {
        const prev = feedRef.current;
        const next = applyBatch(prev, batch);
        if (next === prev) return;
        feedRef.current = next;
        if (morphsOnScreen(prev.cards, next.cards, feedViewRef.current)) {
          document.startViewTransition(() => {
            flushSync(() => setFeed(feedRef.current));
          });
        } else {
          setFeed(next);
        }
      });
    }
    return batcherRef.current;
  }, []);
  const feedDispatch = useCallback((action: FeedAction) => getBatcher().push(action), [getBatcher]);
  useEffect(() => () => batcherRef.current?.cancel(), []);
  const { state, client, actions } = useTerminal(settings, feedDispatch);
  const seq = useRef(0);

  /** Run a request that asks the 0G brain, with a "thinking" card in the feed until it answers. */
  const tracked = useCallback(
    async <T,>(
      prompt: string,
      trigger: string,
      call: () => Promise<ApiResult<T>>,
      toDecision: (data: T) => { requestId: string; signal: InjectResult['decision']['signal']; confidence: number; rationale: string; actions: InjectResult['decision']['actions'] } | null,
    ): Promise<ApiResult<T>> => {
      const localId = `local-${Date.now()}-${++seq.current}`;
      feedDispatch({ type: 'feed/brain-pending', localId, prompt, trigger, at: Date.now() });
      const r = await call();
      if (!r.ok) {
        feedDispatch({ type: 'feed/brain-result', localId, at: Date.now(), result: { ok: false, failure: r } });
      } else {
        const d = toDecision(r.data);
        if (d) feedDispatch({ type: 'feed/brain-result', localId, at: Date.now(), result: { ok: true, ...d } });
      }
      return r;
    },
    [feedDispatch],
  );

  const injectNews = useCallback(
    (title: string) => tracked(title, 'inject', () => client.injectNews(title, 'terminal-test'), (d) => d.decision),
    [client, tracked],
  );

  const voiceText = useCallback(
    (text: string) =>
      tracked<TextTurnResult>(`“${text}”`, 'text', () => client.voiceText(text), (d) => ({
        requestId: d.requestId,
        signal: d.signal,
        confidence: d.confidence,
        rationale: d.rationale,
        actions: d.actions,
      })),
    [client, tracked],
  );

  // /voice answers with audio only; the SSE `decision` (with the transcript) completes the card.
  const voice = useCallback(
    (wav: ArrayBuffer) => tracked<VoiceReply>('You asked by voice', 'voice', () => client.voice(wav), () => null),
    [client, tracked],
  );

  const live = useMemo(() => ({ injectNews, voiceText, voice }), [injectNews, voiceText, voice]);
  return { state, feed, client, actions, live, moveOptions, feedViewRef };
}

export interface FeedView {
  mounted: boolean;
  paused: boolean;
  filter: FeedFilter;
}

function supportsViewTransitions(): boolean {
  return (
    typeof document !== 'undefined' &&
    typeof document.startViewTransition === 'function' &&
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches &&
    document.visibilityState === 'visible'
  );
}

/** A "thinking" card near the top just resolved (decision or failure): morph it in place. */
function morphsOnScreen(prev: FeedCard[], next: FeedCard[], view: FeedView): boolean {
  if (!view.mounted || view.paused || (view.filter !== 'all' && view.filter !== 'agent') || !supportsViewTransitions()) return false;
  const was = new Map<string, string>();
  for (const c of prev.slice(0, 12)) if (c.kind === 'brain' && c.localId) was.set(c.localId, c.status);
  return next.slice(0, 12).some((c) => c.kind === 'brain' && c.localId !== undefined && was.has(c.localId) && was.get(c.localId) !== c.status);
}

/** The move threshold can be lowered for a demo with ?moveThreshold=0.05 (read once per page load). */
function useMoveOptions() {
  return useMemo(() => {
    const thresholdPct = typeof window === 'undefined' ? DEFAULT_MOVE_OPTIONS.thresholdPct : thresholdFromSearch(window.location.search);
    return [{ ...DEFAULT_MOVE_OPTIONS, thresholdPct }] as const;
  }, []);
}

export type LiveApi = ReturnType<typeof useLive>;
