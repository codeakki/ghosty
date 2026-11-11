import { describe, expect, it } from 'vitest';
import { initialPodMirror, mirrorsPod, MODE_TIMEOUT_MS, podLevelAt, podMirrorReducer, type PodMirrorAction, type PodMirrorView } from './podMirror';

const pod = (data: object, at: number): PodMirrorAction => ({ type: 'pod', data: { source: 'pod', ts: 1, ...data }, at });
const run = (actions: PodMirrorAction[]) => actions.reduce<PodMirrorView>(podMirrorReducer, initialPodMirror);

describe('pod mirror reducer', () => {
  it('follows listening → thinking → speaking → idle', () => {
    let s = run([pod({ state: 'listening' }, 1000)]);
    expect(s.mode).toBe('listening');
    s = podMirrorReducer(s, pod({ state: 'thinking' }, 3000));
    expect(s.mode).toBe('thinking');
    s = podMirrorReducer(s, pod({ state: 'speaking', envelope: [0.2, 1, 0.5], durationMs: 150 }, 5000));
    expect(s).toMatchObject({ mode: 'speaking', since: 5000, envelope: [0.2, 1, 0.5] });
    s = podMirrorReducer(s, pod({ state: 'idle' }, 5150));
    expect(s.mode).toBe('idle');
  });

  it('level samples update the meter without restarting listening', () => {
    const s = run([pod({ state: 'listening' }, 1000), pod({ state: 'listening', level: 0.7 }, 1100)]);
    expect(s.since).toBe(1000);
    expect(podLevelAt(s, 1200)).toBe(0.7);
  });

  it('ignores events that are not from the pod or not a known state', () => {
    const s = run([{ type: 'pod', data: { source: 'web', state: 'listening' }, at: 1 }, { type: 'pod', data: { source: 'pod', state: 'dancing' }, at: 2 }]);
    expect(s).toBe(initialPodMirror);
  });

  it('drives the level from the envelope by time, then 0 after the reply', () => {
    const s = run([pod({ state: 'speaking', envelope: [0, 1, 0.5], durationMs: 150 }, 10_000)]);
    expect(podLevelAt(s, 10_000)).toBe(0);
    expect(podLevelAt(s, 10_025)).toBeCloseTo(0.5);
    expect(podLevelAt(s, 10_050)).toBe(1);
    expect(podLevelAt(s, 10_200)).toBe(0);
  });

  it('falls back to idle when a mode outlives its timeout (lost pod)', () => {
    const s = run([pod({ state: 'listening' }, 0)]);
    expect(podMirrorReducer(s, { type: 'pod/expire', at: MODE_TIMEOUT_MS.listening - 1 })).toBe(s);
    expect(podMirrorReducer(s, { type: 'pod/expire', at: MODE_TIMEOUT_MS.listening }).mode).toBe('idle');
  });

  it('the local browser turn always wins over the mirror', () => {
    const s = run([pod({ state: 'thinking' }, 0)]);
    expect(mirrorsPod(s, 'idle')).toBe(true);
    expect(mirrorsPod(s, 'alert')).toBe(true);
    expect(mirrorsPod(s, 'listening')).toBe(false);
    expect(mirrorsPod(s, 'speaking')).toBe(false);
    expect(mirrorsPod(initialPodMirror, 'idle')).toBe(false);
  });
});
