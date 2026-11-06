import { useCallback, useState } from 'react';
import { loadSettings, saveSettings, type ClientSettings } from './api/client';
import { AlertBanner } from './components/AlertBanner';
import { EventConsole } from './components/EventConsole';
import { MarketWatch } from './components/MarketWatch';
import { NewsTape } from './components/NewsTape';
import { PipelineStrip } from './components/PipelineStrip';
import { PodDock } from './components/PodDock';
import { ProofLog } from './components/ProofLog';
import { ProviderGrid } from './components/ProviderGrid';
import { SignalCard } from './components/SignalCard';
import { TopBar } from './components/TopBar';
import { useTerminal } from './state/useTerminal';

export function App() {
  const [settings, setSettings] = useState<ClientSettings>(loadSettings);
  const { state, client, actions } = useTerminal(settings);
  const safeStop = state.snapshot?.safeStop === true || state.health?.safeStop === true;

  const updateSettings = useCallback((s: ClientSettings) => {
    saveSettings(s);
    setSettings(s);
  }, []);
  const confirm = useCallback(() => actions.pressButton('confirm'), [actions]);

  return (
    <div className="app">
      <a href="#signal" className="skip-link">
        Skip to signal
      </a>
      <TopBar state={state} settings={settings} onSettings={updateSettings} onSafeStop={actions.setSafeStop} />
      {state.serverReachable === false ? (
        <p className="offline-bar" role="alert">
          <span aria-hidden="true">✕</span> Ghosty server unreachable at {settings.baseUrl || 'this origin'}. Start it with{' '}
          <code>cd server &amp;&amp; npm run dev</code> or change the URL in Settings.
        </p>
      ) : null}
      <PipelineStrip state={state} />
      <AlertBanner
        alert={state.banner}
        safeStop={safeStop}
        onConfirm={confirm}
        onAck={actions.ackAlert}
        onDismiss={actions.dismissAlert}
      />
      <main className="main">
        <div className="col col-left">
          <NewsTape news={state.snapshot?.news ?? null} onInject={actions.injectNews} />
        </div>
        <div className="col col-center">
          <SignalCard state={state} onButton={actions.pressButton} />
          <MarketWatch state={state} />
        </div>
        <div className="col col-right">
          <ProviderGrid state={state} />
          <ProofLog state={state} onPay={actions.paySignal} />
        </div>
      </main>
      <footer className="dock">
        <PodDock client={client} lastDecision={state.snapshot?.lastDecision ?? null} safeStop={safeStop} onLog={actions.logLine} />
        <EventConsole entries={state.console} />
      </footer>
    </div>
  );
}
