import { memo } from 'react';
import type { TerminalState } from '../state/reducer';
import { GhostMark } from './brand/GhostMark';
import { Link } from './Link';
import { ROUTE_PATH, type AppRoute } from './router';

const TABS: Array<{ route: AppRoute; label: string }> = [
  { route: 'live', label: 'Live' },
  { route: 'device', label: 'Device' },
  { route: 'feed', label: 'Feed' },
  { route: 'simulate', label: 'Simulate' },
];

type Tone = 'ok' | 'warn' | 'bad' | 'muted';
type StatusInfo = { tone: Tone; text: string; title: string; live: boolean };

function connectionStatus(state: TerminalState): StatusInfo {
  const safeStop = state.snapshot?.safeStop === true || state.health?.safeStop === true;
  if (state.serverReachable === false) return { tone: 'bad', text: 'Offline', title: 'The Ghosty server did not answer /health', live: false };
  if (safeStop) return { tone: 'warn', text: '0G offline · safe-stop', title: '0G brain unreachable: every trade is blocked', live: false };
  if (state.connection !== 'open') return { tone: 'muted', text: 'Connecting…', title: 'Opening the live event stream', live: false };
  if (state.zeroG?.computeOnline && state.zeroG.computeMode === '0g')
    return { tone: 'ok', text: '0G live', title: `0G Compute online${state.zeroG.model ? ` · ${state.zeroG.model}` : ''}`, live: true };
  return { tone: 'ok', text: 'Connected', title: 'Live event stream open', live: true };
}

/**
 * One header status as quiet text. The standby light (a small steady mint dot) shows only while the live event
 * stream is really open: it means "Ghosty is live and listening", and appears nowhere else in the header.
 * Below 640px the word is visually hidden when the light can stand in for it; the word stays for screen readers.
 */
function Status(props: { tone: Tone; text: string; title: string; live?: boolean; role?: 'status'; kind?: 'network' }) {
  return (
    <span className={`lv-status lv-tone-${props.tone}`} data-live={props.live ? 'true' : undefined} data-kind={props.kind} title={props.title} role={props.role}>
      {props.live ? <span className="lv-standby" aria-hidden="true" /> : null}
      <span className="lv-status-text">{props.text}</span>
    </span>
  );
}

function GearIcon() {
  return (
    <svg className="lv-gear" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M8.3 1.5h3.4l.5 2.4c.5.2 1 .5 1.5.9l2.3-.8 1.7 2.9-1.8 1.6a6 6 0 0 1 0 1.8l1.8 1.6-1.7 2.9-2.3-.8c-.5.4-1 .7-1.5.9l-.5 2.4H8.3l-.5-2.4c-.5-.2-1-.5-1.5-.9l-2.3.8-1.7-2.9 1.8-1.6a6 6 0 0 1 0-1.8L2.3 6.9 4 4l2.3.8c.5-.4 1-.7 1.5-.9l.5-2.4ZM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"
      />
    </svg>
  );
}

export const TopNav = memo(function TopNav({ route, state, onSettings }: { route: AppRoute; state: TerminalState; onSettings: () => void }) {
  const status = connectionStatus(state);
  const network = state.market.data?.network ?? null;
  const networkText = network === 'mainnet' ? 'Mainnet' : network === 'testnet' ? 'Testnet' : 'Network…';
  return (
    <header className="lv-nav">
      <Link to={ROUTE_PATH.home} className="lv-wordmark" translate="no" aria-label="ghosty, home">
        <GhostMark size={26} className="lv-mark" />
        <span className="lv-wordmark-text">ghosty</span>
      </Link>
      <nav className="lv-tabs" aria-label="Views">
        {TABS.map((t) => (
          <Link key={t.route} to={ROUTE_PATH[t.route]} className="lv-tab" aria-current={route === t.route ? 'page' : undefined}>
            {t.label}
          </Link>
        ))}
      </nav>
      <div className="lv-nav-end">
        <Status tone={status.tone} text={status.text} title={status.title} live={status.live} role="status" />
        <Status
          kind="network"
          tone="muted"
          text={networkText}
          title={network === 'mainnet' ? 'Hyperliquid mainnet: real prices, real money' : network ? `Hyperliquid ${network}` : 'Network not known yet'}
        />
        <button type="button" className="lv-nav-btn" onClick={onSettings} aria-haspopup="dialog" aria-label="Settings">
          <GearIcon />
          <span className="lv-nav-btn-text">Settings</span>
        </button>
      </div>
    </header>
  );
});
