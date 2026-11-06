import { memo } from 'react';
import type { TerminalState } from '../state/reducer';
import { Link } from './Link';
import { ROUTE_PATH, type Route } from './router';

const TABS: Array<{ route: Exclude<Route, 'pro'>; label: string }> = [
  { route: 'live', label: 'Live' },
  { route: 'device', label: 'Device' },
  { route: 'feed', label: 'Feed' },
];

type Status = { tone: 'ok' | 'warn' | 'bad' | 'muted'; icon: string; text: string; title: string };

function connectionStatus(state: TerminalState): Status {
  const safeStop = state.snapshot?.safeStop === true || state.health?.safeStop === true;
  if (state.serverReachable === false) return { tone: 'bad', icon: '✕', text: 'Offline', title: 'The Ghosty server did not answer /health' };
  if (safeStop) return { tone: 'warn', icon: '■', text: 'Safe-stop', title: '0G brain unreachable: every trade is blocked' };
  if (state.connection !== 'open') return { tone: 'muted', icon: '○', text: 'Connecting…', title: 'Opening the live event stream' };
  if (state.zeroG?.computeOnline && state.zeroG.computeMode === '0g')
    return { tone: 'ok', icon: '●', text: '0G live', title: `0G Compute online${state.zeroG.model ? ` · ${state.zeroG.model}` : ''}` };
  return { tone: 'ok', icon: '●', text: 'Connected', title: 'Live event stream open' };
}

/**
 * The mark is the device itself, small: the ghost orb with its two eyes (same shapes as the Device page orb),
 * on a soft halo. Not a generic ghost icon.
 */
function GhostMark() {
  return (
    <svg className="lv-mark" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
      <circle cx="12" cy="12" r="11" className="lv-mark-halo" />
      <circle cx="12" cy="12" r="8" className="lv-mark-core" />
      <ellipse cx="9.6" cy="11.4" rx="1.05" ry="1.6" className="lv-mark-eye" />
      <ellipse cx="14.4" cy="11.4" rx="1.05" ry="1.6" className="lv-mark-eye" />
    </svg>
  );
}

export const TopNav = memo(function TopNav({ route, state }: { route: Route; state: TerminalState }) {
  const status = connectionStatus(state);
  const network = state.market.data?.network ?? null;
  return (
    <header className="lv-nav">
      <Link to="/" className="lv-wordmark" translate="no" aria-label="ghosty, Live view">
        <GhostMark />
        <span className="lv-wordmark-text">ghosty</span>
      </Link>
      <nav className="lv-tabs" aria-label="Views">
        {TABS.map((t) => (
          <Link key={t.route} to={ROUTE_PATH[t.route]} className="lv-tab" aria-current={route === t.route ? 'page' : undefined}>
            {t.label}
          </Link>
        ))}
        {/* Plain link: /pro is a separate app with its own stylesheet. */}
        <a href="/pro" className="lv-tab lv-tab-pro" title="The dense terminal: every panel at once">
          Pro
        </a>
      </nav>
      <div className="lv-nav-status">
        <span className={`lv-status-dot lv-tone-${status.tone}`} title={status.title} role="status">
          <span aria-hidden="true" className="lv-status-icon">
            {status.icon}
            {/* Heartbeat: re-mounts (and pulses once) on every SSE event. */}
            {state.lastEventAt !== null && status.tone === 'ok' ? <span key={state.lastEventAt} className="lv-beat" /> : null}
          </span>
          <span className="lv-status-text">{status.text}</span>
        </span>
        <span
          className={`lv-status-dot lv-network${network === 'mainnet' ? ' lv-network-main' : ''}`}
          title={network === 'mainnet' ? 'Hyperliquid mainnet: real prices, real money' : network ? `Hyperliquid ${network}` : 'Network not known yet'}
        >
          <span aria-hidden="true" className="lv-status-icon">
            ◆
          </span>
          <span className="lv-status-text">{network === 'mainnet' ? 'Mainnet' : network === 'testnet' ? 'Testnet' : 'Network…'}</span>
        </span>
      </div>
    </header>
  );
});
