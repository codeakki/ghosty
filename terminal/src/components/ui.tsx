import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ProviderState } from '../api/types';

/** Small building blocks shared by every panel. */

export function Panel(props: {
  id?: string;
  title: string;
  hint?: string;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const headingId = props.id ? `${props.id}-title` : undefined;
  return (
    <section className={`panel ${props.className ?? ''}`} aria-labelledby={headingId} id={props.id}>
      <header className="panel-head">
        <div className="panel-titles">
          <h2 id={headingId} className="panel-title">
            {props.title}
          </h2>
          {props.hint ? <p className="panel-hint">{props.hint}</p> : null}
        </div>
        {props.actions ? <div className="panel-actions">{props.actions}</div> : null}
      </header>
      <div className="panel-body">{props.children}</div>
    </section>
  );
}

/** Explicit empty / not-configured / pending state. Never a blank box, never placeholder numbers. */
export function Empty(props: { tone?: 'info' | 'warn' | 'bad' | 'muted'; title: string; children?: ReactNode }) {
  const icon = props.tone === 'bad' ? '✕' : props.tone === 'warn' ? '!' : 'i';
  return (
    <div className={`empty empty-${props.tone ?? 'muted'}`} role="status">
      <span className="empty-icon" aria-hidden="true">
        {icon}
      </span>
      <div>
        <p className="empty-title">{props.title}</p>
        {props.children ? <div className="empty-body">{props.children}</div> : null}
      </div>
    </div>
  );
}

const STATE_META: Record<ProviderState, { icon: string; label: string }> = {
  live: { icon: '●', label: 'Live' },
  degraded: { icon: '▲', label: 'Degraded' },
  offline: { icon: '✕', label: 'Offline' },
  not_configured: { icon: '○', label: 'Not configured' },
};

/** State dot with an icon and a text label: colour is never the only signal. */
export function StateBadge({ state, compact }: { state: ProviderState; compact?: boolean }) {
  const m = STATE_META[state];
  return (
    <span className={`state state-${state}`}>
      <span aria-hidden="true" className="state-icon">
        {m.icon}
      </span>
      {compact ? <span className="sr-only">{m.label}</span> : <span>{m.label}</span>}
    </span>
  );
}

export function Tag(props: { tone?: 'ok' | 'warn' | 'bad' | 'info' | 'stub' | 'muted' | 'accent'; children: ReactNode; title?: string }) {
  return (
    <span className={`tag tag-${props.tone ?? 'muted'}`} title={props.title}>
      {props.children}
    </span>
  );
}

/** Copies a value; announces the result to screen readers. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <button type="button" className="icon-btn" onClick={copy} aria-label={`Copy ${label}`} title={`Copy ${label}`}>
      <span aria-hidden="true">{copied ? '✓' : '⧉'}</span>
      <span className="sr-only" aria-live="polite">
        {copied ? 'Copied' : ''}
      </span>
    </button>
  );
}

export function ExternalLink({ href, children, label }: { href: string; children: ReactNode; label?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="ext-link" aria-label={label}>
      {children}
      <span aria-hidden="true" className="ext-icon">
        ↗
      </span>
    </a>
  );
}
