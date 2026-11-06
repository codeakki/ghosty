import { memo, useRef, useState, type FormEvent } from 'react';
import type { NewsEntry } from '../api/types';
import { formatAge, isStubNewsId, shockTag } from '../lib/format';
import { useNow } from '../lib/useNow';
import type { ActionOutcome } from '../state/useTerminal';
import { Empty, Panel, Tag } from './ui';

const LEVEL_TONE = {
  exemplary: 'ok',
  reputable: 'ok',
  neutral: 'muted',
  questionable: 'warn',
  untrusted: 'bad',
} as const;

function CredBadge({ item }: { item: NewsEntry }) {
  const c = item.credibility;
  if (c) {
    return (
      <Tag tone={LEVEL_TONE[c.level] ?? 'muted'} title={`Ethos: @${c.handle.replace(/^@/, '')} ${c.level}${c.score !== null ? `, score ${c.score}` : ''}, weight ${c.weight.toFixed(2)}`}>
        {c.score !== null ? `ETHOS ${c.score}` : c.level.toUpperCase()}
      </Tag>
    );
  }
  if (item.weight !== undefined) {
    return (
      <Tag tone={item.weight >= 0.7 ? 'ok' : item.weight < 0.4 ? 'warn' : 'muted'} title="Source-table credibility weight (0.2 to 1.0)">
        W {item.weight.toFixed(2)}
      </Tag>
    );
  }
  return (
    <Tag tone="muted" title="No handle to score">
      UNSCORED
    </Tag>
  );
}

const SHOCK_TONE = { war: 'bad', sanction: 'warn', hack: 'stub' } as const;

const NewsRow = memo(function NewsRow({ item, now }: { item: NewsEntry; now: number }) {
  const shock = shockTag(`${item.title} ${item.summary ?? ''}`);
  const source = item.handle ? `@${item.handle.replace(/^@/, '')}` : item.domain ?? item.source;
  const stub = isStubNewsId(item.id);
  return (
    <li className="news-row">
      <div className="news-meta">
        <span className="news-source" title={`Provider: ${item.source}`}>
          {item.source === 'inject' ? <span className="inject-mark">TEST</span> : null}
          {source}
        </span>
        <time className="news-age num" dateTime={item.publishedAt} title={item.publishedAt}>
          {formatAge(item.publishedAt, now)}
        </time>
      </div>
      <p className="news-title">
        {item.url && !stub ? (
          <a href={item.url} target="_blank" rel="noreferrer noopener">
            {item.title}
          </a>
        ) : (
          item.title
        )}
      </p>
      <div className="news-tags">
        {stub ? (
          <Tag tone="stub" title="Server stub feed: set NEWS_LIVE=true and provider keys for live news">
            STUB FEED
          </Tag>
        ) : null}
        <CredBadge item={item} />
        {shock ? <Tag tone={SHOCK_TONE[shock.kind]}>{shock.tag}</Tag> : null}
        {item.probability !== undefined ? (
          <Tag tone="info" title="Polymarket implied probability">
            P {(item.probability * 100).toFixed(0)}%
          </Tag>
        ) : null}
      </div>
    </li>
  );
});

const PRESETS = [
  { title: 'Missile strikes reported near major Gulf oil terminal', source: 'Reuters' },
  { title: 'US Treasury announces new sanctions on crypto exchange', source: 'business' },
];

export const NewsTape = memo(function NewsTape(props: {
  news: NewsEntry[] | null;
  onInject: (title: string, source?: string) => Promise<ActionOutcome>;
}) {
  const now = useNow(5000);
  const [title, setTitle] = useState('');
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ActionOutcome | null>(null);

  const titleRef = useRef<HTMLInputElement>(null);

  const send = async (t: string, s?: string) => {
    if (!t.trim()) {
      setOutcome({ ok: false, message: 'Type a headline first, or use one of the examples.' });
      titleRef.current?.focus();
      return;
    }
    setBusy(true);
    setOutcome(null);
    const r = await props.onInject(t.trim(), s?.trim() || undefined);
    setOutcome(r);
    setBusy(false);
    if (r.ok) setTitle('');
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void send(title, source);
  };

  return (
    <Panel id="news" title="News tape" hint="Wires, prediction markets and vetted X accounts, scored for credibility" className="panel-news">
      <form className="inject" onSubmit={submit} aria-describedby="inject-help">
        <label className="field">
          <span className="field-label">Manual test headline</span>
          <input
            ref={titleRef}
            name="headline"
            autoComplete="off"
            placeholder="e.g. War breaks out near oil route…"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={500}
          />
        </label>
        <div className="inject-row">
          <label className="field field-inline">
            <span className="sr-only">Source handle (optional)</span>
            <input
              name="source"
              autoComplete="off"
              spellCheck={false}
              placeholder="Source / X handle (optional)…"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              maxLength={100}
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Deciding…' : 'Inject'}
          </button>
        </div>
        <p id="inject-help" className="field-help">
          Clearly a test: runs the real pipeline on your headline.{' '}
          {PRESETS.map((p, i) => (
            <button key={p.title} type="button" className="link-btn" disabled={busy} onClick={() => void send(p.title, p.source)}>
              {i === 0 ? 'Try war headline' : 'Try sanctions headline'}
            </button>
          ))}
        </p>
        <p className={`outcome ${outcome ? (outcome.ok ? 'outcome-ok' : 'outcome-bad') : ''}`} aria-live="polite">
          {outcome?.message ?? ''}
        </p>
      </form>

      {props.news === null ? (
        <Empty title="Connecting to the news stream…" />
      ) : props.news.length === 0 ? (
        <Empty tone="info" title="Waiting for first headline">
          Live feeds start with NEWS_LIVE=true on the server. Inject a manual test headline above to run the pipeline now.
        </Empty>
      ) : (
        <ol className="news-list" aria-label="Headlines, newest first">
          {props.news.map((item) => (
            <NewsRow key={item.id} item={item} now={now} />
          ))}
        </ol>
      )}
    </Panel>
  );
});
