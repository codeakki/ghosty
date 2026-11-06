import { memo, useState } from 'react';
import type { ClientSettings } from '../api/client';
import { formatClock, formatHbar } from '../lib/format';
import { useNow } from '../lib/useNow';
import type { TerminalState } from '../state/reducer';
import type { ActionOutcome } from '../state/useTerminal';
import { SettingsDialog } from './SettingsDialog';

function Clock() {
  const now = useNow(1000);
  const d = new Date(now);
  return (
    <div className="clock" aria-label="Clocks">
      <span>
        <span className="clock-zone">UTC</span>
        <time className="num" dateTime={d.toISOString()}>
          {formatClock(d, 'UTC')}
        </time>
      </span>
      <span>
        <span className="clock-zone">IST</span>
        <time className="num">{formatClock(d, 'Asia/Kolkata')}</time>
      </span>
    </div>
  );
}

interface Props {
  state: TerminalState;
  settings: ClientSettings;
  onSettings: (s: ClientSettings) => void;
  onSafeStop: (enabled: boolean) => Promise<ActionOutcome>;
}

export const TopBar = memo(function TopBar({ state, settings, onSettings, onSafeStop }: Props) {
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const safeStop = state.snapshot?.safeStop === true || state.health?.safeStop === true;
  const network = state.market.data?.network ?? (state.execution ? (state.execution.testnet ? 'testnet' : 'mainnet') : null);
  const brainMode = state.zeroG?.computeMode;
  const reachable = state.serverReachable;

  const toggle = async () => {
    setBusy(true);
    await onSafeStop(!safeStop);
    setBusy(false);
  };

  let brain: { tone: string; icon: string; text: string; title: string };
  if (reachable === false) brain = { tone: 'bad', icon: '✕', text: 'Server unreachable', title: 'The Ghosty server did not answer /health' };
  else if (safeStop) brain = { tone: 'bad', icon: '■', text: 'Safe-stop', title: '0G brain offline: every trade is blocked' };
  else if (brainMode === '0g') brain = { tone: 'ok', icon: '●', text: '0G live', title: `0G Compute online${state.zeroG?.model ? ` · ${state.zeroG.model}` : ''}` };
  else if (brainMode === 'fake') brain = { tone: 'stub', icon: '◐', text: 'Stub brain', title: 'Keyword stub decider. Set OG_API_KEY for 0G Compute.' };
  else brain = { tone: 'muted', icon: '○', text: 'Brain …', title: 'Waiting for /zerog/status' };

  const x402 = state.x402;

  return (
    <header className="topbar">
      <div className="brand">
        <h1 className="wordmark" translate="no">
          GHOSTY
        </h1>
        <span className="tagline">Market intelligence you wear</span>
        {/* Full page load on purpose: it drops the Pro stylesheet when going back to the Live view. */}
        <a className="tagline" href="/">
          ← Live view
        </a>
      </div>

      <div className="topbar-badges">
        <span
          className={`pill pill-${network === 'mainnet' ? 'warn' : network ? 'info' : 'muted'}`}
          title={network ? `Hyperliquid ${network}` : 'Network unknown until /market/snapshot or /execution/markets answers'}
        >
          <span aria-hidden="true">◆</span> {network ? network.toUpperCase() : 'NETWORK —'}
        </span>
        <span className={`pill pill-${brain.tone}`} title={brain.title} role="status" aria-live="polite">
          <span aria-hidden="true">{brain.icon}</span> {brain.text}
        </span>
        <span className="pill pill-muted" title={x402 ? `x402 spend today on ${x402.network}, cap ${formatHbar(x402.cap)}` : 'Waiting for /x402/status'}>
          <span className="pill-label">x402 today</span>
          <span className="num">{x402 ? `${formatHbar(x402.spentToday)} / ${formatHbar(x402.cap)}` : '—'}</span>
          {x402?.mode === 'fake' ? <span className="pill-sub">sim</span> : null}
        </span>
        <span
          className={`pill pill-${state.connection === 'open' ? 'ok' : 'warn'}`}
          title={state.connection === 'open' ? 'Live event stream connected' : 'Event stream reconnecting'}
        >
          <span aria-hidden="true">{state.connection === 'open' ? '●' : '◌'}</span> {state.connection === 'open' ? 'Stream' : 'Reconnecting…'}
        </span>
      </div>

      <div className="topbar-right">
        <Clock />
        <button
          type="button"
          role="switch"
          aria-checked={safeStop}
          className={`switch ${safeStop ? 'switch-on' : ''}`}
          onClick={toggle}
          disabled={busy || reachable === false}
          title="Simulate 0G being unreachable. Trading is blocked while on."
        >
          <span className="switch-track" aria-hidden="true">
            <span className="switch-thumb" />
          </span>
          <span>Safe-stop</span>
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setSettingsOpen(true)} aria-haspopup="dialog">
          Settings
        </button>
      </div>
      {settingsOpen ? (
        <SettingsDialog
          settings={settings}
          onClose={() => setSettingsOpen(false)}
          onSave={(s) => {
            onSettings(s);
            setSettingsOpen(false);
          }}
        />
      ) : null}
    </header>
  );
});
