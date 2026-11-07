import { useSyncExternalStore } from 'react';

/**
 * A tiny path router: six routes (`/` is the landing page, the Live view is `/live`), real URLs (the Ghosty server serves index.html for unknown GETs, and so does
 * Vite in dev), history.pushState for in-app links. No dependency needed.
 */

export type Route = 'home' | 'live' | 'device' | 'feed' | 'simulate' | 'pro';

/** The routes the Live app renders (not the landing page, not the separate Pro terminal). */
export type AppRoute = Exclude<Route, 'home' | 'pro'>;

export const ROUTE_PATH: Record<Route, string> = {
  home: '/',
  live: '/live',
  device: '/device',
  feed: '/feed',
  simulate: '/simulate',
  pro: '/pro',
};

export function routeOf(pathname: string): Route {
  const p = pathname.replace(/\/+$/, '') || '/';
  if (p === '/') return 'home';
  if (p === '/live') return 'live';
  if (p === '/device') return 'device';
  if (p === '/feed') return 'feed';
  if (p === '/simulate') return 'simulate';
  if (p === '/pro') return 'pro';
  return 'live';
}

const NAV_EVENT = 'ghosty:navigate';

function subscribe(cb: () => void): () => void {
  window.addEventListener('popstate', cb);
  window.addEventListener(NAV_EVENT, cb);
  return () => {
    window.removeEventListener('popstate', cb);
    window.removeEventListener(NAV_EVENT, cb);
  };
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, () => routeOf(window.location.pathname), () => 'home');
}

/** Navigate in-app, keeping the query string (e.g. ?moveThreshold=0.05) across tabs. */
export function navigate(path: string): void {
  const url = `${path}${window.location.search}`;
  if (url === `${window.location.pathname}${window.location.search}`) return;
  window.history.pushState(null, '', url);
  window.dispatchEvent(new Event(NAV_EVENT));
  window.scrollTo(0, 0);
}
