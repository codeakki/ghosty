import { describe, expect, it } from 'vitest';
import type { Alert } from '../../api/types';
import { deviceReducer, initialDevice, modeLabel, type DeviceEvent, type DeviceState } from './machine';

const alert: Alert = {
  id: 'alert-1',
  text: 'Gold looks bid on the strike headline. Long gold, twelve fifty?',
  signal: 'geopolitical_shock',
  actions: [{ venue: 'hyperliquid', kind: 'perp', coin: 'xyz:GOLD', side: 'long', sizeUsd: 12.5, reason: 'haven' }],
  requestId: 'req-1',
  confidence: 0.82,
  status: 'pending',
  createdAt: '2026-11-06T09:00:00Z',
};

const run = (events: DeviceEvent[], from: DeviceState = initialDevice) => events.reduce(deviceReducer, from);

describe('device state machine', () => {
  it('goes idle → listening → thinking → speaking → idle on a voice turn', () => {
    const modes: string[] = [];
    let s = initialDevice;
    for (const e of [
      { type: 'PRESS' },
      { type: 'RELEASE', hasAudio: true },
      { type: 'REPLY', caption: null, hasAudio: true },
      { type: 'SPEECH_END' },
    ] as DeviceEvent[]) {
      s = deviceReducer(s, e);
      modes.push(s.mode);
    }
    expect(modes).toEqual(['listening', 'thinking', 'speaking', 'idle']);
    expect(modeLabel({ ...s, mode: 'thinking', busy: 'voice' })).toBe('Thinking on 0G…');
    expect(modeLabel(s)).toBe('Watching the markets');
  });

  it('a too-short press goes back to idle with a hint', () => {
    const s = run([{ type: 'PRESS' }, { type: 'RELEASE', hasAudio: false }]);
    expect(s.mode).toBe('idle');
    expect(s.note?.text).toMatch(/Too short/);
  });

  it('a reply without audio (TTS not configured) goes straight back to rest with the caption', () => {
    const s = run([{ type: 'SUBMIT_TEXT' }, { type: 'REPLY', caption: 'No signal right now.', hasAudio: false }]);
    expect(s.mode).toBe('idle');
    expect(s.caption).toBe('No signal right now.');
  });

  it('a failed turn returns to rest with the reason', () => {
    const s = run([
      { type: 'PRESS' },
      { type: 'RELEASE', hasAudio: true },
      { type: 'FAIL', note: { tone: 'warn', text: 'Voice needs GROQ_API_KEY + ELEVENLABS_API_KEY — type instead.' } },
    ]);
    expect(s.mode).toBe('idle');
    expect(s.busy).toBeNull();
    expect(s.note?.tone).toBe('warn');
  });

  it('an alert from idle shows immediately and its text becomes the caption', () => {
    const s = run([{ type: 'ALERT', alert }]);
    expect(s.mode).toBe('alert');
    expect(s.caption).toBe(alert.text);
    expect(modeLabel(s)).toBe('Heads up');
  });

  it('an alert never interrupts a turn: it waits until speaking ends', () => {
    const s1 = run([{ type: 'PRESS' }, { type: 'ALERT', alert }]);
    expect(s1.mode).toBe('listening');
    const s2 = run([{ type: 'RELEASE', hasAudio: true }, { type: 'REPLY', caption: 'ok', hasAudio: true }, { type: 'SPEECH_END' }], s1);
    expect(s2.mode).toBe('alert');
  });

  it('confirm: alert → thinking (placing trade) → idle, alert cleared', () => {
    const s1 = run([{ type: 'ALERT', alert }, { type: 'CONFIRM' }]);
    expect(s1.mode).toBe('thinking');
    expect(modeLabel(s1)).toBe('Placing your trade…');
    const s2 = deviceReducer(s1, { type: 'BUTTON_DONE', caption: 'Done.' });
    expect(s2.mode).toBe('idle');
    expect(s2.alert).toBeNull();
  });

  it('cancel: alert → thinking (standing down) → idle', () => {
    const s = run([{ type: 'ALERT', alert }, { type: 'CANCEL' }]);
    expect(s.busy).toBe('cancel');
    expect(deviceReducer(s, { type: 'BUTTON_DONE', caption: null }).mode).toBe('idle');
  });

  it('confirm and cancel do nothing without a pending alert', () => {
    expect(run([{ type: 'CONFIRM' }])).toBe(initialDevice);
    expect(run([{ type: 'CANCEL' }])).toBe(initialDevice);
  });

  it('a hold during an alert talks instead of confirming, and the alert comes back after', () => {
    const s = run([{ type: 'ALERT', alert }, { type: 'PRESS' }]);
    expect(s.mode).toBe('listening');
    expect(s.alert?.id).toBe('alert-1');
    expect(run([{ type: 'RELEASE', hasAudio: false }], s).mode).toBe('alert');
  });

  it('an alert acked elsewhere clears it', () => {
    const s = run([{ type: 'ALERT', alert }, { type: 'ALERT_CLEARED', id: 'alert-1' }]);
    expect(s.mode).toBe('idle');
    expect(s.alert).toBeNull();
  });

  it('offline disables talk and recovers to rest', () => {
    const s1 = run([{ type: 'OFFLINE', offline: true }]);
    expect(s1.mode).toBe('offline');
    expect(modeLabel(s1)).toBe('Brain offline: trading paused');
    expect(deviceReducer(s1, { type: 'PRESS' }).mode).toBe('offline');
    expect(deviceReducer(s1, { type: 'OFFLINE', offline: false }).mode).toBe('idle');
  });

  it('coming back online with a pending alert returns to the alert', () => {
    const s = run([{ type: 'ALERT', alert }, { type: 'OFFLINE', offline: true }, { type: 'OFFLINE', offline: false }]);
    expect(s.mode).toBe('alert');
  });

  it('going offline mid-recording keeps listening so the user is not cut off', () => {
    const s = run([{ type: 'PRESS' }, { type: 'OFFLINE', offline: true }]);
    expect(s.mode).toBe('listening');
    expect(deviceReducer(s, { type: 'RELEASE', hasAudio: false }).mode).toBe('offline');
  });
});
