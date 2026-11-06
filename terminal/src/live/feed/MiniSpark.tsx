import { memo } from 'react';

const W = 96;
const H = 28;
const PAD = 3;

/**
 * Tiny session sparkline for a move card: one 2px line in the muted ink, the last point marked in the
 * direction colour. Direction is also in the text (▲/▼ and a sign), so the colour is never the only cue.
 */
export const MiniSpark = memo(function MiniSpark({ points, dir, label }: { points: readonly number[]; dir: 'up' | 'down'; label: string }) {
  if (points.length < 2) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    if (p < min) min = p;
    if (p > max) max = p;
  }
  const range = max - min || Math.abs(max) * 0.0005 || 1;
  const x = (i: number) => PAD + (i / (points.length - 1)) * (W - PAD * 2);
  const y = (v: number) => PAD + (1 - (v - min) / range) * (H - PAD * 2);
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(p).toFixed(1)}`).join('');
  const last = points.length - 1;
  return (
    <svg className={`lv-spark lv-spark-${dir}`} viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={label}>
      <path d={d} className="lv-spark-line" />
      {/* Draw-in: a surface-coloured cover that slides off to the right (transform only). */}
      <rect x={0} y={0} width={W} height={H} className="lv-spark-cover" />
      <circle cx={x(last)} cy={y(points[last]!)} r={3} className="lv-spark-dot" />
    </svg>
  );
});
