import { formatSince, useClock } from '../clock';

/** A timestamp that ticks on its own ("just now" → "12s ago"). Fixed min-width + tabular digits: no reflow. */
export function RelTime({ at, className }: { at: number; className?: string }) {
  const now = useClock();
  return (
    <time className={className} dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>
      {formatSince(at, now)}
    </time>
  );
}
