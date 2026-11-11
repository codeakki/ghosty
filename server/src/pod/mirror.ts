/**
 * Pod mirror: the web orb follows the physical pod. The pod reports "listening" (POST /pod/state); the server knows
 * when a pod-tagged /voice turn is thinking and when its reply audio starts. Each change is an SSE `pod` event.
 * Browser-originated turns never drive it (the browser animates itself).
 */

export type PodMirrorState = 'idle' | 'listening' | 'thinking' | 'speaking';

export interface PodMirrorEvent {
  state: PodMirrorState;
  source: 'pod';
  /** Epoch ms. */
  ts: number;
  /** Mic loudness 0–1 while listening (POST /pod/state level samples). */
  level?: number;
  /** Reply loudness 0–1, one value per ENVELOPE_WINDOW_MS, for `speaking`. */
  envelope?: number[];
  /** Reply length, for `speaking`. idle follows after it. */
  durationMs?: number;
}

export const ENVELOPE_WINDOW_MS = 50;
export const ENVELOPE_MAX_VALUES = 600;
/** Level samples faster than this are dropped (≤ 10/s). */
export const LEVEL_MIN_INTERVAL_MS = 100;

/**
 * Loudness of PCM s16le mono: RMS per `windowMs`, normalised so the loudest window is 1. At most `maxValues`
 * values (longer audio is bucketed into wider windows). Silence → all zeros. Rounded to 3 decimals.
 */
export function loudnessEnvelope(pcm: Buffer, sampleRate = 16_000, windowMs = ENVELOPE_WINDOW_MS, maxValues = ENVELOPE_MAX_VALUES): number[] {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) return [];
  let perWindow = Math.max(1, Math.round((sampleRate * windowMs) / 1000));
  if (Math.ceil(samples / perWindow) > maxValues) perWindow = Math.ceil(samples / maxValues);
  const rms: number[] = [];
  for (let start = 0; start < samples; start += perWindow) {
    const end = Math.min(samples, start + perWindow);
    let sum = 0;
    for (let i = start; i < end; i++) {
      const v = pcm.readInt16LE(i * 2) / 32768;
      sum += v * v;
    }
    rms.push(Math.sqrt(sum / (end - start)));
  }
  const peak = Math.max(...rms);
  return rms.map((v) => (peak > 0 ? Math.round((v / peak) * 1000) / 1000 : 0));
}

export interface PodMirrorOptions {
  publish: (event: PodMirrorEvent) => void;
  now?: () => number;
  sampleRate?: number;
}

export class PodMirror {
  private current: PodMirrorState = 'idle';
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private lastLevelAt = 0;
  private readonly now: () => number;

  constructor(private readonly opts: PodMirrorOptions) {
    this.now = opts.now ?? Date.now;
  }

  get state(): PodMirrorState {
    return this.current;
  }

  /** Move to `state` and broadcast it. */
  set(state: Exclude<PodMirrorState, 'speaking'>): void {
    this.clearIdle();
    this.current = state;
    this.opts.publish({ state, source: 'pod', ts: this.now() });
  }

  /** A mic level sample while listening. Returns false when dropped (too frequent, or not listening). */
  level(level: number): boolean {
    const now = this.now();
    if (this.current !== 'listening' || now - this.lastLevelAt < LEVEL_MIN_INTERVAL_MS) return false;
    this.lastLevelAt = now;
    this.opts.publish({ state: 'listening', source: 'pod', ts: now, level: Math.min(1, Math.max(0, level)) });
    return true;
  }

  /** The pod is about to play `pcm`: speaking with its envelope, then idle once it has played. */
  speaking(pcm: Buffer): void {
    this.clearIdle();
    const sampleRate = this.opts.sampleRate ?? 16_000;
    const durationMs = Math.round((Math.floor(pcm.length / 2) / sampleRate) * 1000);
    if (durationMs === 0) return this.set('idle');
    this.current = 'speaking';
    this.opts.publish({ state: 'speaking', source: 'pod', ts: this.now(), envelope: loudnessEnvelope(pcm, sampleRate), durationMs });
    this.idleTimer = setTimeout(() => this.set('idle'), durationMs);
    this.idleTimer.unref?.();
  }

  close(): void {
    this.clearIdle();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }
}
