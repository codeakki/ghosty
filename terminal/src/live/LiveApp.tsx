import { useEffect, useState } from 'react';
import { loadSettings } from '../api/client';
import '../design/tokens.css';
import { DevicePage } from './device/DevicePage';
import { FeedPage } from './feed/FeedPage';
import './live.css';
import './sim/sim.css';
import { SimBanner, SimPanel } from './sim/SimPage';
import { isActive } from './sim/simState';
import type { Route } from './router';
import { TopNav } from './TopNav';
import { useLive } from './useLive';

const TITLES: Record<Exclude<Route, 'pro'>, string> = {
  live: 'Ghosty · Live',
  device: 'Ghosty · Device',
  feed: 'Ghosty · Feed',
  simulate: 'Ghosty · Simulate',
};

/** The simple Live view: the device (pod stand-in) and the live feed, side by side or one at a time. */
export function LiveApp({ route }: { route: Exclude<Route, 'pro'> }) {
  const [settings] = useState(loadSettings);
  const api = useLive(settings);

  useEffect(() => {
    document.title = TITLES[route];
  }, [route]);

  return (
    <div className="lv-app" data-route={route} data-sim={isActive(api.sim.run) ? 'true' : undefined}>
      <a href="#main" className="lv-skip">
        Skip to content
      </a>
      <h1 className="lv-sr-only">Ghosty: market intelligence you wear</h1>
      <TopNav route={route} state={api.state} />
      <SimBanner sim={api.sim} onSimulate={route === 'simulate'} />
      {api.state.serverReachable === false ? (
        <p className="lv-offline-bar" role="alert">
          <span aria-hidden="true">✕</span> The Ghosty server is unreachable. Start it with <code className="lv-mono">cd server &amp;&amp; npm run dev</code>.
        </p>
      ) : null}
      <main id="main" className={`lv-main lv-main-${route}`} tabIndex={-1}>
        {route === 'live' ? (
          <>
            <DevicePage api={api} />
            <FeedPage api={api} />
          </>
        ) : route === 'simulate' ? (
          <>
            <SimPanel api={api} />
            <DevicePage api={api} />
            <FeedPage api={api} />
          </>
        ) : route === 'device' ? (
          <DevicePage api={api} full />
        ) : (
          <FeedPage api={api} full />
        )}
      </main>
    </div>
  );
}
