import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { describeError, GhostyClient, type ClientSettings } from '../api/client';
import type { ApiResult, SseEventType } from '../api/types';
import { initialState, reducer, type Action } from './reducer';

const SSE_EVENTS: SseEventType[] = ['state', 'news', 'decision', 'alert', 'order', 'episode', 'market', 'providers'];

const STATUS_POLL_MS = 5_000;
const EXECUTION_POLL_MS = 30_000;
const PROVIDERS_POLL_MS = 15_000;
const MARKET_POLL_MS = 30_000;
const PENDING_EVERY = 4;
const HISTORY_REFRESH_MS = 5 * 60_000;
const HISTORY_COINS = 8;

/** Outcome of a terminal action, for inline feedback next to the button that triggered it. */
export type ActionOutcome = { ok: true; message: string } | { ok: false; message: string };

/**
 * Connects the terminal to the Ghosty server: one SSE stream, a few slow polls for status routes
 * that have no events, and the action callbacks the panels call.
 */
export function useTerminal(settings: ClientSettings, tap?: (action: Action) => void) {
  const [state, rawDispatch] = useReducer(reducer, initialState);
  const client = useMemo(() => new GhostyClient(settings), [settings]);

  // Optional observer of every action (the Live feed folds the same stream). Kept in a ref so it never re-subscribes.
  const tapRef = useRef(tap);
  useEffect(() => {
    tapRef.current = tap;
  }, [tap]);
  const dispatch = useCallback((action: Action) => {
    rawDispatch(action);
    tapRef.current?.(action);
  }, []);

  // ---- SSE ----------------------------------------------------------------
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    dispatch({ type: 'connection', status: 'connecting', at: Date.now() });
    const es = new EventSource(client.url('/events'));
    es.onopen = () => dispatch({ type: 'connection', status: 'open', at: Date.now() });
    es.onerror = () => dispatch({ type: 'connection', status: 'reconnecting', at: Date.now() });
    const handlers = SSE_EVENTS.map((event) => {
      const fn = (e: MessageEvent<string>) => {
        let data: unknown;
        try {
          data = JSON.parse(e.data);
        } catch {
          return;
        }
        dispatch({ type: 'sse', event, data, at: Date.now() });
      };
      es.addEventListener(event, fn as EventListener);
      return [event, fn] as const;
    });
    return () => {
      for (const [event, fn] of handlers) es.removeEventListener(event, fn as EventListener);
      es.close();
    };
  }, [client, dispatch]);

  // ---- Status polls ---------------------------------------------------------
  useEffect(() => {
    let alive = true;
    const pollStatus = async () => {
      const [health, zeroG, x402] = await Promise.all([client.health(), client.zeroG(), client.x402()]);
      if (!alive) return;
      const at = Date.now();
      dispatch({ type: 'health', result: health, at });
      if (zeroG.ok) dispatch({ type: 'zerog', data: zeroG.data });
      if (x402.ok) dispatch({ type: 'x402', data: x402.data, at });
    };
    const pollExecution = async () => {
      const r = await client.executionMarkets();
      if (alive && r.ok) dispatch({ type: 'execution', data: r.data });
    };
    // A missing endpoint (404, backend upgrade pending) is re-checked 4x less often, so the console stays quiet.
    const skip = { providers: 0, market: 0 };
    const pollProviders = async () => {
      if (skip.providers > 0) {
        skip.providers--;
        return;
      }
      const r = await client.providers();
      if (!alive) return;
      skip.providers = !r.ok && r.kind === 'not_found' ? PENDING_EVERY - 1 : 0;
      dispatch({ type: 'providers', result: r });
    };
    let historyAt = 0;
    const pollMarket = async () => {
      if (skip.market > 0) {
        skip.market--;
        return;
      }
      const r = await client.marketSnapshot();
      if (!alive) return;
      skip.market = !r.ok && r.kind === 'not_found' ? PENDING_EVERY - 1 : 0;
      dispatch({ type: 'market/snapshot', result: r, at: Date.now() });
      // 24 h of hourly closes per watched coin for the sparklines, refreshed every few minutes.
      if (r.ok && Date.now() - historyAt > HISTORY_REFRESH_MS) {
        historyAt = Date.now();
        await Promise.all(
          r.data.assets.slice(0, HISTORY_COINS).map(async (a) => {
            const h = await client.marketHistory(a.coin, 24, '1h');
            if (alive) dispatch({ type: 'market/history', coin: a.coin, result: h });
          }),
        );
      }
    };
    void pollStatus();
    void pollExecution();
    void pollProviders();
    void pollMarket();
    const timers = [
      setInterval(pollStatus, STATUS_POLL_MS),
      setInterval(pollExecution, EXECUTION_POLL_MS),
      setInterval(pollProviders, PROVIDERS_POLL_MS),
      setInterval(pollMarket, MARKET_POLL_MS),
    ];
    return () => {
      alive = false;
      timers.forEach(clearInterval);
    };
  }, [client, dispatch]);

  // ---- Actions ----------------------------------------------------------------
  // Refreshing status right after an action makes the strip and badges move without waiting for a poll.
  const clientRef = useRef(client);
  useEffect(() => {
    clientRef.current = client;
  }, [client]);

  const refreshStatus = useCallback(async () => {
    const c = clientRef.current;
    const [health, zeroG, x402] = await Promise.all([c.health(), c.zeroG(), c.x402()]);
    const at = Date.now();
    dispatch({ type: 'health', result: health, at });
    if (zeroG.ok) dispatch({ type: 'zerog', data: zeroG.data });
    if (x402.ok) dispatch({ type: 'x402', data: x402.data, at });
  }, [dispatch]);

  const fail = useCallback((what: string, r: Extract<ApiResult<unknown>, { ok: false }>): ActionOutcome => {
    const message = describeError(r);
    dispatch({ type: 'log', level: 'error', summary: `${what} → ${r.status || 'network'} ${r.kind}: ${message}`, at: Date.now() });
    return { ok: false, message };
  }, [dispatch]);

  const injectNews = useCallback(
    async (title: string, source?: string): Promise<ActionOutcome> => {
      dispatch({ type: 'log', level: 'ui', summary: `POST /news/inject "${title}"`, at: Date.now() });
      const r = await clientRef.current.injectNews(title, source);
      if (!r.ok) return fail('POST /news/inject', r);
      void refreshStatus();
      return { ok: true, message: r.data.alert ? `Decision made, ${r.data.alert.id} queued` : 'Decision made: no actionable signal' };
    },
    [dispatch, fail, refreshStatus],
  );

  const pressButton = useCallback(
    async (action: 'confirm' | 'cancel'): Promise<ActionOutcome> => {
      dispatch({ type: 'log', level: 'ui', summary: `POST /button ${action}`, at: Date.now() });
      const r = await clientRef.current.button(action);
      if (!r.ok) return fail(`POST /button ${action}`, r);
      dispatch({ type: 'button', result: r.data, at: Date.now() });
      void refreshStatus();
      return {
        ok: true,
        message:
          action === 'cancel' ? 'Cancelled. Logged to the episode log.' : r.data.executed ? `Executed ${r.data.orders.length} order(s)` : 'Nothing to execute',
      };
    },
    [dispatch, fail, refreshStatus],
  );

  const setSafeStop = useCallback(
    async (enabled: boolean): Promise<ActionOutcome> => {
      dispatch({ type: 'log', level: 'ui', summary: `POST /sim/safe-stop enabled=${enabled}`, at: Date.now() });
      const r = await clientRef.current.safeStop(enabled);
      if (!r.ok) return fail('POST /sim/safe-stop', r);
      void refreshStatus();
      return { ok: true, message: r.data.safeStop ? 'Safe-stop engaged' : 'Brain back online' };
    },
    [dispatch, fail, refreshStatus],
  );

  const paySignal = useCallback(async (): Promise<ActionOutcome> => {
    dispatch({ type: 'log', level: 'ui', summary: 'POST /sim/pay-signal', at: Date.now() });
    const r = await clientRef.current.paySignal();
    if (!r.ok) return fail('POST /sim/pay-signal', r);
    dispatch({ type: 'payment', result: r.data, at: Date.now() });
    void refreshStatus();
    return { ok: true, message: `Paid · tx ${r.data.txId}` };
  }, [dispatch, fail, refreshStatus]);

  const ackAlert = useCallback(
    async (id: string): Promise<ActionOutcome> => {
      dispatch({ type: 'banner/dismiss', id });
      const r = await clientRef.current.ackAlert(id);
      if (!r.ok) return fail(`POST /alerts/${id}/ack`, r);
      return { ok: true, message: `${id} acknowledged` };
    },
    [dispatch, fail],
  );

  const dismissAlert = useCallback((id: string) => dispatch({ type: 'banner/dismiss', id }), [dispatch]);

  const logLine = useCallback(
    (level: 'ui' | 'error', summary: string) => dispatch({ type: 'log', level, summary, at: Date.now() }),
    [dispatch],
  );

  const actions = useMemo(
    () => ({ injectNews, pressButton, setSafeStop, paySignal, ackAlert, dismissAlert, logLine, refreshStatus }),
    [injectNews, pressButton, setSafeStop, paySignal, ackAlert, dismissAlert, logLine, refreshStatus],
  );

  return { state, client, actions };
}

export type TerminalActions = ReturnType<typeof useTerminal>['actions'];
