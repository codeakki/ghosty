import { memo, useState } from 'react';
import type { ConsoleEntry } from '../state/reducer';

const FILTERS: Array<{ id: 'all' | ConsoleEntry['type']; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'news', label: 'News' },
  { id: 'decision', label: 'Decision' },
  { id: 'alert', label: 'Alert' },
  { id: 'order', label: 'Order' },
  { id: 'episode', label: 'Episode' },
  { id: 'providers', label: 'Providers' },
  { id: 'ui', label: 'Actions' },
  { id: 'error', label: 'Errors' },
];

const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

/** Compact, filterable log of every SSE event and every action taken from the terminal. */
export const EventConsole = memo(function EventConsole({ entries }: { entries: ConsoleEntry[] }) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('all');
  const shown = filter === 'all' ? entries : entries.filter((e) => e.type === filter);
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);

  return (
    <section className="console" aria-labelledby="console-title">
      <header className="console-head">
        <h2 id="console-title" className="panel-title">
          Event console
        </h2>
        <div className="chips" role="group" aria-label="Filter events">
          {FILTERS.map((f) => {
            const n = f.id === 'all' ? entries.length : (counts.get(f.id) ?? 0);
            return (
              <button
                key={f.id}
                type="button"
                className="chip"
                aria-pressed={filter === f.id}
                onClick={() => setFilter(f.id)}
                disabled={f.id !== 'all' && n === 0}
              >
                {f.label}
                <span className="chip-count num">{n}</span>
              </button>
            );
          })}
        </div>
      </header>
      {shown.length === 0 ? (
        <p className="console-empty muted">No events yet. They stream in from GET /events as the pipeline runs.</p>
      ) : (
        <ol className="console-list" aria-label="Events, newest first">
          {shown.map((e) => (
            <li key={e.seq} className={`console-row console-${e.type}`}>
              <time className="num muted" dateTime={new Date(e.at).toISOString()}>
                {timeFmt.format(e.at)}
              </time>
              <span className="console-type">{e.type}</span>
              <span className="console-text">{e.summary}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
});
