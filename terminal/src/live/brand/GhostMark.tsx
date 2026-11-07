import { GHOST_BODY_PATH, GHOST_EYES, GHOST_MARK_VIEWBOX } from './ghost';

/**
 * The small Ghosty ghost (nav, landing, footer). Body in `currentColor`, eyes in `--ghost-eye` (dark by default), so
 * the parent's CSS picks the colours. Decorative: always next to the "ghosty" wordmark.
 */
export function GhostMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className ? `ghost-mark ${className}` : 'ghost-mark'}
      viewBox={GHOST_MARK_VIEWBOX}
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <path className="ghost-mark-body" d={GHOST_BODY_PATH} fill="currentColor" />
      {GHOST_EYES.map((e) => (
        <ellipse key={e.cx} className="ghost-mark-eye" cx={e.cx} cy={e.cy} rx={e.rx} ry={e.ry} fill="var(--ghost-eye, #06201a)" />
      ))}
    </svg>
  );
}
