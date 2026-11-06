import { memo } from 'react';
import type { ProviderStatus, Track } from '../api/types';
import { formatAge } from '../lib/format';
import { useNow } from '../lib/useNow';
import { deriveProviders, TRACK_LABEL, TRACK_ORDER } from '../state/providers';
import type { TerminalState } from '../state/reducer';
import { Empty, Panel, StateBadge } from './ui';

function ProviderRow({ p, now }: { p: ProviderStatus; now: number }) {
  return (
    <li className={`provider provider-${p.state}`}>
      <div className="provider-top">
        <span className="provider-label">{p.label}</span>
        <StateBadge state={p.state} />
      </div>
      {p.detail ? <p className="provider-detail">{p.detail}</p> : null}
      {p.missingEnv.length > 0 ? (
        <p className="provider-env">
          <span className="muted">Set</span>{' '}
          {p.missingEnv.map((e) => (
            <code key={e} className="env" translate="no">
              {e}
            </code>
          ))}
        </p>
      ) : null}
      {p.lastOkAt || p.latencyMs !== undefined ? (
        <p className="provider-meta muted num">
          {p.lastOkAt ? `ok ${formatAge(p.lastOkAt, now)} ago` : ''}
          {p.lastOkAt && p.latencyMs !== undefined ? ' · ' : ''}
          {p.latencyMs !== undefined ? `${Math.round(p.latencyMs)} ms` : ''}
        </p>
      ) : null}
    </li>
  );
}

export const ProviderGrid = memo(function ProviderGrid({ state }: { state: TerminalState }) {
  const now = useNow(10_000);
  const pending = state.providers.status !== 'live';
  const list: ProviderStatus[] = state.providers.data?.providers ?? deriveProviders(state);
  const byTrack = new Map<Track, ProviderStatus[]>();
  for (const p of list) byTrack.set(p.track, [...(byTrack.get(p.track) ?? []), p]);
  const live = list.filter((p) => p.state === 'live').length;

  return (
    <Panel
      id="providers"
      title="Provider health"
      hint="Every integration, grouped by sponsor track"
      className="panel-providers"
      actions={list.length > 0 ? <span className="muted small num">{live}/{list.length} live</span> : null}
    >
      {pending && state.providers.status !== 'loading' ? (
        <p className="note note-warn" role="status">
          <span aria-hidden="true">!</span> Backend upgrade pending: GET /providers/status is not on the server yet. Showing what
          /zerog, /x402 and /execution report; Data and Audio appear once it ships.
        </p>
      ) : null}
      {list.length === 0 ? (
        <Empty title={state.serverReachable === false ? 'Server unreachable' : 'Checking providers…'} tone={state.serverReachable === false ? 'bad' : 'muted'} />
      ) : (
        <div className="tracks">
          {TRACK_ORDER.filter((t) => byTrack.has(t)).map((t) => (
            <section key={t} className="track" aria-label={`${TRACK_LABEL[t]} providers`}>
              <h3 className="track-title">{TRACK_LABEL[t]}</h3>
              <ul className="provider-list">
                {byTrack.get(t)!.map((p) => (
                  <ProviderRow key={p.id} p={p} now={now} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Panel>
  );
});
