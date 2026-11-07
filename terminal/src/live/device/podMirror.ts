/**
 * The web orb mirrors the physical pod (SSE `pod`). Pure: useLive folds events in, DevicePage reads the view and
 * drives the orb's level from the reply envelope by time. Browser-originated turns never arrive here (the server
 * only mirrors pod-tagged requests).
 */

export type PodMirrorMode = 'idle' | 'listening' | 'thinking' | 'speaking';

export interface PodMirrorView {
  mode: PodMirrorMode;
  /** Local ms when the current mode started (receipt time, so server clock skew never matters). */
  since: number;
  /** Local ms after which a stuck mode falls back to idle (pod lost power mid-turn, dropped event). */
  until: number;
  /** Reply loudness 0–1 per ENVELOPE_STEP_MS, for speaking. */
  envelope: number[];
  /** Last mic level 0–1, for listening. */
  level: number;
}

export type PodMirrorAction = { type: 'pod'; data: unknown; at: number } | { type: 'pod/expire'; at: number };

export const ENVELOPE_STEP_MS = 50;
/** How long a mode may last without a follow-up event. */
export const MODE_TIMEOUT_MS: Record<Exclude<PodMirrorMode, 'idle'>, number> = { listening: 30_000, thinking: 90_000, speaking: 60_000 };

export const initialPodMirror: PodMirrorView = { mode: 'idle', since: 0, until: Infinity, envelope: [], level: 0 };

const MODES: readonly PodMirrorMode[] = ['idle', 'listening', 'thinking', 'speaking'];
const clamp01 = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

export function podMirrorReducer(s: PodMirrorView, a: PodMirrorAction): PodMirrorView {
  if (a.type === 'pod/expire') return s.mode !== 'idle' && a.at >= s.until ? { ...initialPodMirror, since: a.at } : s;
  const d = a.data;
  if (typeof d !== 'object' || d === null) return s;
  const e = d as Record<string, unknown>;
  if (e.source !== 'pod' || !MODES.includes(e.state as PodMirrorMode)) return s;
  const mode = e.state as PodMirrorMode;
  switch (mode) {
    case 'idle':
      return s.mode === 'idle' ? s : { ...initialPodMirror, since: a.at };
    case 'listening':
      // A level sample while already listening only moves the meter.
      if (s.mode === 'listening') return { ...s, level: clamp01(e.level), until: a.at + MODE_TIMEOUT_MS.listening };
      return { mode, since: a.at, until: a.at + MODE_TIMEOUT_MS.listening, envelope: [], level: clamp01(e.level) };
    case 'thinking':
      return { mode, since: a.at, until: a.at + MODE_TIMEOUT_MS.thinking, envelope: [], level: 0 };
    case 'speaking': {
      const envelope = Array.isArray(e.envelope) ? e.envelope.slice(0, 2000).map(clamp01) : [];
      const durationMs = typeof e.durationMs === 'number' && e.durationMs > 0 ? e.durationMs : envelope.length * ENVELOPE_STEP_MS;
      // The server sends idle after durationMs; the timeout is only a safety net.
      const until = a.at + Math.min(MODE_TIMEOUT_MS.speaking, durationMs + 1500);
      return { mode, since: a.at, until, envelope, level: 0 };
    }
  }
}

/** The orb level right now: the envelope sample for speaking, the last mic level for listening, else 0. */
export function podLevelAt(s: PodMirrorView, now: number): number {
  if (s.mode === 'listening') return s.level;
  if (s.mode !== 'speaking' || s.envelope.length === 0) return 0;
  const pos = (now - s.since) / ENVELOPE_STEP_MS;
  if (pos < 0 || pos >= s.envelope.length) return 0;
  // Linear between samples so the pulse never steps at 20 Hz.
  const i = Math.floor(pos);
  const a = s.envelope[i] ?? 0;
  const b = s.envelope[i + 1] ?? a;
  return a + (b - a) * (pos - i);
}

/** Mirror the pod only while this browser is not in a turn of its own (the local user always wins). */
export function mirrorsPod(s: PodMirrorView, localMode: string): boolean {
  return s.mode !== 'idle' && (localMode === 'idle' || localMode === 'alert' || localMode === 'offline');
}

export function podModeLabel(mode: PodMirrorMode): string {
  switch (mode) {
    case 'listening':
      return 'Listening on the pod…';
    case 'thinking':
      return 'Thinking on 0G…';
    case 'speaking':
      return 'Speaking on the pod';
    case 'idle':
      return 'Watching the markets';
  }
}
