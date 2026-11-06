import { memo, useState } from 'react';
import { useNow } from '../lib/useNow';
import { selectStages, stageMeta, type StageStatus } from '../state/pipeline';
import type { StageId, TerminalState } from '../state/reducer';

const STATUS_META: Record<StageStatus, { icon: string; label: string }> = {
  active: { icon: '◉', label: 'just ran' },
  done: { icon: '●', label: 'done' },
  waiting: { icon: '◷', label: 'waiting for you' },
  blocked: { icon: '■', label: 'blocked by safe-stop' },
  idle: { icon: '○', label: 'idle' },
};

/**
 * The explainability centrepiece: News → Credibility → 0G Brain → Alert → Confirm → Execute → Log → Pay.
 * Each stage lights up as its SSE event arrives. Hover, focus or click a stage to read what it does.
 */
export const PipelineStrip = memo(function PipelineStrip({ state }: { state: TerminalState }) {
  const now = useNow(1000);
  const stages = selectStages(state, now);
  const [pinned, setPinned] = useState<StageId | null>(null);
  const [hovered, setHovered] = useState<StageId | null>(null);
  const focus = hovered ?? pinned;
  const meta = focus ? stageMeta(focus) : null;

  return (
    <nav className="pipeline" aria-label="Decision pipeline">
      <ol className="pipeline-list">
        {stages.map((s) => {
          const st = STATUS_META[s.status];
          return (
            <li key={s.id} className={`stage stage-${s.status}`}>
              <button
                type="button"
                className="stage-btn"
                aria-pressed={pinned === s.id}
                aria-describedby="pipeline-explain"
                onClick={() => setPinned((p) => (p === s.id ? null : s.id))}
                onMouseEnter={() => setHovered(s.id)}
                onMouseLeave={() => setHovered(null)}
                onFocus={() => setHovered(s.id)}
                onBlur={() => setHovered(null)}
              >
                <span className="stage-top">
                  <span className="stage-step num" aria-hidden="true">
                    {s.step}
                  </span>
                  <span className="stage-label">{s.label}</span>
                  <span className="stage-status" title={st.label}>
                    <span aria-hidden="true">{st.icon}</span>
                    <span className="sr-only">{st.label}</span>
                  </span>
                </span>
                <span className="stage-value" title={s.value}>
                  {s.value}
                </span>
                <span className="stage-detail" title={s.detail}>
                  {s.stub ? <span className="stub-mark">STUB</span> : null}
                  {s.detail}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <p id="pipeline-explain" className="pipeline-explain" aria-live="polite">
        {meta ? (
          <>
            <strong>{meta.label}</strong>
            <span className="pipeline-track">{meta.track}</span>
            {meta.explain}
          </>
        ) : (
          <span className="muted">
            One headline flows left to right. Hover or click a stage to see what it does and which sponsor powers it.{' '}
            <span className="stub-mark">STUB</span> means that stage ran on a stand-in because its keys are not set.
          </span>
        )}
      </p>
    </nav>
  );
});
