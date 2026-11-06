import { useCallback, useEffect, useReducer, useState } from 'react';
import { loadSettings, type ClientSettings, type UnauthorizedInfo } from '../api/client';
import { SettingsDialog } from '../components/SettingsDialog';
import '../design/tokens.css';
import { DevicePage } from './device/DevicePage';
import { FeedPage } from './feed/FeedPage';
import './live.css';
import './sim/sim.css';
import { SimBanner, SimPanel } from './sim/SimPage';
import { TokenBanner } from './settings/TokenBanner';
import { commitSettings, initialTokenPrompt, rememberAutoOpened, tokenPromptReducer } from './settings/tokenPrompt';
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
  const [settings, setSettings] = useState<ClientSettings>(loadSettings);
  const [prompt, promptDispatch] = useReducer(tokenPromptReducer, undefined, () => initialTokenPrompt());
  const onUnauthorized = useCallback((info: UnauthorizedInfo) => promptDispatch({ type: 'unauthorized', info }), []);
  const api = useLive(settings, onUnauthorized);
  const openSettings = useCallback(() => promptDispatch({ type: 'open' }), []);
  const closeSettings = useCallback(() => promptDispatch({ type: 'close' }), []);
  const saveSettings = useCallback((next: ClientSettings) => {
    // New settings object → new client → SSE and polls reconnect with the new URL and token. No reload.
    commitSettings(next, setSettings);
    promptDispatch({ type: 'saved' });
  }, []);

  useEffect(() => {
    if (prompt.autoOpened) rememberAutoOpened();
  }, [prompt.autoOpened]);

  useEffect(() => {
    document.title = TITLES[route];
  }, [route]);

  // An unreachable server has its own bar; a stale "add your token" under it would be noise.
  const showTokenBanner = prompt.needsToken && api.state.serverReachable !== false;

  return (
    <div
      className="lv-app"
      data-route={route}
      data-sim={isActive(api.sim.run) ? 'true' : undefined}
      data-auth={showTokenBanner ? 'needed' : undefined}
    >
      <a href="#main" className="lv-skip">
        Skip to content
      </a>
      <h1 className="lv-sr-only">Ghosty: market intelligence you wear</h1>
      <TopNav route={route} state={api.state} onSettings={openSettings} />
      <SimBanner sim={api.sim} onSimulate={route === 'simulate'} />
      {showTokenBanner ? <TokenBanner onSettings={openSettings} /> : null}
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
      {prompt.open ? <SettingsDialog settings={settings} onClose={closeSettings} onSave={saveSettings} /> : null}
    </div>
  );
}
