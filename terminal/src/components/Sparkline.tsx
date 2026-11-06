import { memo, useState, type PointerEvent } from 'react';
import { formatPct, formatPrice, seriesChangePct } from '../lib/format';

const W = 112;
const H = 30;
const PAD = 3;

/**
 * Trend sparkline (24 h hourly closes, or session ticks from SSE) with a crosshair readout on hover.
 * Direction is also stated in text (aria-label, % column), never by colour alone.
 */
export const Sparkline = memo(function Sparkline({
  points,
  label,
  span = 'session',
}: {
  points: readonly number[];
  label: string;
  span?: '24h' | 'session';
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (points.length < 2) {
    return (
      <span className="spark-empty" aria-label={`${label}: collecting ticks`}>
        collecting…
      </span>
    );
  }
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    if (p < min) min = p;
    if (p > max) max = p;
  }
  const range = max - min || Math.abs(max) * 0.001 || 1;
  const x = (i: number) => PAD + (i / (points.length - 1)) * (W - PAD * 2);
  const y = (v: number) => PAD + (1 - (v - min) / range) * (H - PAD * 2);
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p).toFixed(1)}`).join('');
  const change = seriesChangePct(points);
  const dir = change === null || change === 0 ? 'flat' : change > 0 ? 'up' : 'down';
  const last = points.length - 1;
  const hi = hover ?? last;
  const hv = points[hi]!;

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientX - rect.left) / rect.width;
    setHover(Math.max(0, Math.min(last, Math.round(rel * last))));
  };

  return (
    <span className="spark">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        role="img"
        aria-label={`${label} trend ${formatPct(change)}, low ${formatPrice(min)}, high ${formatPrice(max)}`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        className={`spark-svg spark-${dir}`}
      >
        <path d={d} className="spark-line" />
        {hover !== null ? <line x1={x(hi)} x2={x(hi)} y1={0} y2={H} className="spark-cross" /> : null}
        <circle cx={x(hi)} cy={y(hv)} r={2.5} className="spark-dot" />
      </svg>
      {hover !== null ? (
        <span className="spark-tip num" role="status">
          {formatPrice(hv)} · {span === '24h' ? (hi === last ? 'now' : `${last - hi}h ago`) : `tick ${hi + 1}/${points.length}`}
        </span>
      ) : null}
    </span>
  );
});
