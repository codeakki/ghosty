import type { Alert } from '../../api/types';

/**
 * The pod's state machine. One button, six modes:
 *   idle → (hold) listening → (release) thinking → (reply with audio) speaking → idle
 *   alert arrives → alert; tap = confirm, "Not now" = cancel
 *   brain offline / server gone → offline (talk disabled) until it comes back
 * Pure: the hook in useDevice.ts runs the side effects (mic, fetch, playback) and feeds results back in.
 */

export type DeviceMode = 'idle' | 'listening' | 'thinking' | 'speaking' | 'alert' | 'offline';

export interface DeviceState {
  mode: DeviceMode;
  /** Pending alert, kept while the user talks so it comes back afterwards. */
  alert: Alert | null;
  /** What the "thinking" is about, in words. */
  busy: 'voice' | 'text' | 'confirm' | 'cancel' | null;
  /** Last thing Ghosty said (reply text, alert text). */
  caption: string | null;
  /** Inline problem to show under the button. */
  note: { tone: 'warn' | 'info'; text: string } | null;
  offline: boolean;
  /** Set when the alert has been announced (spoken/chimed) once. */
  announced: string | null;
}

export const initialDevice: DeviceState = {
  mode: 'idle',
  alert: null,
  busy: null,
  caption: null,
  note: null,
  offline: false,
  announced: null,
};

export type DeviceEvent =
  | { type: 'PRESS' }
  | { type: 'RELEASE'; hasAudio: boolean }
  | { type: 'SUBMIT_TEXT' }
  | { type: 'REPLY'; caption: string | null; hasAudio: boolean; note?: DeviceState['note'] }
  | { type: 'SPEECH_END' }
  | { type: 'FAIL'; note: NonNullable<DeviceState['note']> }
  | { type: 'ALERT'; alert: Alert }
  | { type: 'ANNOUNCED'; id: string }
  | { type: 'CONFIRM' }
  | { type: 'CANCEL' }
  | { type: 'BUTTON_DONE'; caption: string | null; note?: DeviceState['note'] }
  | { type: 'ALERT_CLEARED'; id: string }
  | { type: 'OFFLINE'; offline: boolean }
  | { type: 'DISMISS_NOTE' };

/** Where to rest when nothing is happening. */
function rest(s: DeviceState): DeviceMode {
  if (s.offline) return 'offline';
  return s.alert ? 'alert' : 'idle';
}

export function deviceReducer(s: DeviceState, e: DeviceEvent): DeviceState {
  switch (e.type) {
    case 'PRESS':
      // Talk is possible from rest states only; offline means the brain cannot answer.
      if (s.mode !== 'idle' && s.mode !== 'alert') return s;
      return { ...s, mode: 'listening', note: null };
    case 'RELEASE':
      if (s.mode !== 'listening') return s;
      if (!e.hasAudio) return { ...s, mode: rest(s), note: { tone: 'info', text: 'Too short. Hold the button while you talk.' } };
      return { ...s, mode: 'thinking', busy: 'voice' };
    case 'SUBMIT_TEXT':
      if (s.mode !== 'idle' && s.mode !== 'alert') return s;
      return { ...s, mode: 'thinking', busy: 'text', note: null };
    case 'REPLY':
      if (s.mode !== 'thinking') return s;
      return {
        ...s,
        busy: null,
        caption: e.caption ?? s.caption,
        note: e.note ?? null,
        mode: e.hasAudio ? 'speaking' : rest(s),
      };
    case 'SPEECH_END':
      if (s.mode !== 'speaking') return s;
      return { ...s, mode: rest(s) };
    case 'FAIL':
      return { ...s, busy: null, note: e.note, mode: rest(s) };
    case 'ALERT': {
      if (s.alert?.id === e.alert.id) return s;
      const next = { ...s, alert: e.alert, caption: e.alert.text || s.caption };
      // Never cut the user off: the alert waits until the current turn ends.
      return s.mode === 'idle' ? { ...next, mode: 'alert' } : next;
    }
    case 'ANNOUNCED':
      return { ...s, announced: e.id };
    case 'CONFIRM':
      if (s.mode !== 'alert' || !s.alert) return s;
      return { ...s, mode: 'thinking', busy: 'confirm', note: null };
    case 'CANCEL':
      if (s.mode !== 'alert' || !s.alert) return s;
      return { ...s, mode: 'thinking', busy: 'cancel', note: null };
    case 'BUTTON_DONE': {
      const cleared = { ...s, alert: null, busy: null, caption: e.caption ?? s.caption, note: e.note ?? null };
      return { ...cleared, mode: rest(cleared) };
    }
    case 'ALERT_CLEARED': {
      if (s.alert?.id !== e.id) return s;
      const cleared = { ...s, alert: null };
      return { ...cleared, mode: s.mode === 'alert' ? rest(cleared) : s.mode };
    }
    case 'OFFLINE': {
      if (s.offline === e.offline) return s;
      const next = { ...s, offline: e.offline };
      // Going offline stops a pending turn's UI but never a recording mid-word; coming back returns to rest.
      if (e.offline) return s.mode === 'listening' ? next : { ...next, mode: 'offline', busy: null };
      return s.mode === 'offline' ? { ...next, mode: rest(next) } : next;
    }
    case 'DISMISS_NOTE':
      return { ...s, note: null };
  }
}

/** The plain-words label under the orb. */
export function modeLabel(s: DeviceState): string {
  switch (s.mode) {
    case 'idle':
      return 'Watching the markets';
    case 'listening':
      return 'Listening…';
    case 'thinking':
      return s.busy === 'confirm' ? 'Placing your trade…' : s.busy === 'cancel' ? 'Standing down…' : 'Thinking on 0G…';
    case 'speaking':
      return 'Speaking';
    case 'alert':
      return 'Heads up';
    case 'offline':
      return 'Brain offline: trading paused';
  }
}
