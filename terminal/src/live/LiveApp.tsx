import { useCallback, useEffect, useReducer, useState } from 'react';
import { describeError, loadSettings, type ClientSettings, type UnauthorizedInfo } from '../api/client';
import type { AccessInfo } from '../api/types';
import { SettingsDialog } from '../components/SettingsDialog';
import '../design/tokens.css';
import { DevicePage } from './device/DevicePage';
import { FeedPage } from './feed/FeedPage';
import './live.css';
import './sim/sim.css';
import { SimBanner, SimPanel } from './sim/SimPage';
import { TokenBanner } from './settings/TokenBanner';
import {
  commitSettings,
  GUEST_CAN,
  GUEST_CANNOT,
  guestLabel,
  guestSettings,
  initialTokenPrompt,
  rememberAutoOpened,
  tokenPromptReducer,
} from './settings/tokenPrompt';
import { isActive } from './sim/simState';
import type { AppRoute } from './router';
import { TopNav } from './TopNav';
import { useLive } from './useLive';

const TITLES: Record<AppRoute, string> = {
  live: 'Ghosty · Live',
  device: 'Ghosty · Device',
  feed: 'Ghosty · Feed',
  simulate: 'Ghosty · Simulate',
};

/** The simple Live view: the device (pod stand-in) and the live feed, side by side or one at a time. */
export function LiveApp({ route }: { route: AppRoute }) {
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

  // Guest passes: offered only when the server says so (GET /access, GUEST_ACCESS=true).
  const { client } = api;
  const [access, setAccess] = useState<AccessInfo | null>(null);
  useEffect(() => {
    let alive = true;
    void client.access().then((r) => {
      if (alive) setAccess(r.ok ? r.data : null);
    });
    return () => {
      alive = false;
    };
  }, [client]);
  const [guest, setGuest] = useState<{ busy: boolean; note: string | null }>({ busy: false, note: null });
  const startGuest = useCallback(async () => {
    setGuest({ busy: true, note: null });
    const r = await client.guestToken();
    if (!r.ok) return setGuest({ busy: false, note: describeError(r) });
    setGuest({ busy: false, note: null });
    saveSettings(guestSettings(settings, r.data));
  }, [client, settings, saveSettings]);
  const guestAccess = access?.guestAccess === true;
  const isGuest = settings.scope === 'guest' && settings.deviceToken !== '';
  const passLabel = isGuest ? guestLabel(settings.guestExpiresAt) : null;

  useEffect(() => {
    document.title = TITLES[route];
  }, [route]);

  // An unreachable server has its own bar; a stale "add your token" under it would be noise.
  // Also shown up front when guest passes are on offer and this browser has no token yet, and while a pass is in use.
  const showTokenBanner =
    api.state.serverReachable !== false && (prompt.needsToken || isGuest || (guestAccess && settings.deviceToken === ''));

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
      {showTokenBanner ? (
        <TokenBanner
          onSettings={openSettings}
          guestAccess={guestAccess}
          onGuest={() => void startGuest()}
          guestBusy={guest.busy}
          guestNote={guest.note}
          guestLabel={prompt.needsToken && !isGuest ? null : passLabel}
        />
      ) : null}
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
      {prompt.open ? (
        <SettingsDialog
          settings={settings}
          onClose={closeSettings}
          onSave={saveSettings}
          guest={
            guestAccess
              ? { onGuest: () => void startGuest(), busy: guest.busy, note: guest.note, label: passLabel, can: GUEST_CAN, cannot: GUEST_CANNOT }
              : undefined
          }
        />
      ) : null}
    </div>
  );
}
