import { useEffect, useState } from 'react';

/** Current time, refreshed every `intervalMs`. Lets age labels and stage lights decay without global re-renders. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
