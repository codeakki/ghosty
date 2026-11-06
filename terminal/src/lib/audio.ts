/**
 * Browser audio for the virtual pod: record the mic, turn it into exactly what the ESP32 sends
 * (16 kHz mono s16le WAV), and play the raw PCM the server answers with.
 */

/** Box-filter downsample to `outRate` and convert to signed 16-bit. */
export function downsampleTo16k(input: Float32Array, inRate: number, outRate = 16000): Int16Array {
  const ratio = inRate / outRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let n = 0;
    for (let j = start; j < end; j++) {
      sum += input[j]!;
      n++;
    }
    const v = n ? sum / n : (input[Math.min(input.length - 1, start)] ?? 0);
    const s = Math.max(-1, Math.min(1, v));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** 44-byte RIFF/WAVE header + PCM s16le mono: the pod's wire format. */
export function encodeWav(pcm: Int16Array, rate: number): ArrayBuffer {
  const dataLen = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + dataLen, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, 'data');
  v.setUint32(40, dataLen, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, pcm[i]!, true);
  return buf;
}

export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

let ctx: AudioContext | null = null;

/** Shared AudioContext, resumed on use (browsers start it suspended until a gesture). */
export function audioContext(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/** Play raw PCM s16le mono. Resolves when playback ends. */
export function playPcm(buf: ArrayBuffer, rate: number): Promise<void> {
  const n = Math.floor(buf.byteLength / 2);
  if (n === 0) return Promise.resolve();
  const ac = audioContext();
  const dv = new DataView(buf);
  const ab = ac.createBuffer(1, n, rate);
  const ch = ab.getChannelData(0);
  for (let i = 0; i < n; i++) ch[i] = dv.getInt16(i * 2, true) / 32768;
  const src = ac.createBufferSource();
  src.buffer = ab;
  src.connect(ac.destination);
  return new Promise((resolve) => {
    src.onended = () => resolve();
    src.start();
  });
}

/** Two soft 880 Hz blips for an incoming alert. Silent until the page has had a user gesture. */
export function beep(): void {
  try {
    // Never create the context here: browsers only allow it after a click, and would log a warning.
    const ac = ctx;
    if (!ac || ac.state !== 'running') return;
    const t0 = ac.currentTime;
    for (const offset of [0, 0.2]) {
      const osc = ac.createOscillator();
      const g = ac.createGain();
      osc.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, t0 + offset);
      g.gain.exponentialRampToValueAtTime(0.12, t0 + offset + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + offset + 0.15);
      osc.connect(g).connect(ac.destination);
      osc.start(t0 + offset);
      osc.stop(t0 + offset + 0.17);
    }
  } catch {
    // Audio unavailable: the banner still shows.
  }
}

/** Create the AudioContext on the first click or key press, so alert beeps can play afterwards. */
export function unlockAudioOnFirstGesture(): void {
  const unlock = () => {
    try {
      audioContext();
    } catch {
      // No Web Audio: alerts stay visual.
    }
  };
  window.addEventListener('pointerdown', unlock, { once: true, capture: true });
  window.addEventListener('keydown', unlock, { once: true, capture: true });
}

// ---------------------------------------------------------------------------
// Mic recorder (AudioWorklet tap, ScriptProcessor fallback)
// ---------------------------------------------------------------------------

const TAP_SOURCE =
  "registerProcessor('pcm-tap', class extends AudioWorkletProcessor {" +
  ' process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; } });';

let tapReady: Promise<void> | null = null;

async function createTap(ac: AudioContext, onFrame: (f: Float32Array) => void): Promise<AudioNode> {
  if (ac.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
    if (!tapReady) {
      const url = URL.createObjectURL(new Blob([TAP_SOURCE], { type: 'application/javascript' }));
      tapReady = ac.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    }
    await tapReady;
    const node = new AudioWorkletNode(ac, 'pcm-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    node.port.onmessage = (e: MessageEvent<Float32Array>) => onFrame(e.data);
    return node;
  }
  const node = ac.createScriptProcessor(4096, 1, 1);
  node.onaudioprocess = (e) => onFrame(new Float32Array(e.inputBuffer.getChannelData(0)));
  return node;
}

export const MAX_RECORD_MS = 10_000;
const MIN_RECORD_S = 0.25;

export class MicRecorder {
  private chunks: Float32Array[] = [];
  private stream: MediaStream | null = null;
  private nodes: AudioNode[] = [];
  private rate = 48000;
  private cancelled = false;

  static supported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  }

  /** Ask for the mic and start capturing. Throws when permission is denied. */
  async start(): Promise<void> {
    const ac = audioContext();
    this.rate = ac.sampleRate;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (this.cancelled) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = stream;
    const source = ac.createMediaStreamSource(stream);
    const tap = await createTap(ac, (f) => this.chunks.push(f));
    // The tap must reach the destination to be pulled; zero gain keeps it silent.
    const mute = ac.createGain();
    mute.gain.value = 0;
    source.connect(tap);
    tap.connect(mute);
    mute.connect(ac.destination);
    this.nodes = [source, tap, mute];
  }

  /** Stop and return a 16 kHz WAV, or null when the clip is too short. */
  stop(): ArrayBuffer | null {
    this.cancelled = true;
    for (const n of this.nodes) n.disconnect();
    for (const n of this.nodes) if (n instanceof AudioWorkletNode) n.port.close();
    this.stream?.getTracks().forEach((t) => t.stop());
    const total = this.chunks.reduce((s, c) => s + c.length, 0);
    if (total < this.rate * MIN_RECORD_S) return null;
    const samples = new Float32Array(total);
    let off = 0;
    for (const c of this.chunks) {
      samples.set(c, off);
      off += c.length;
    }
    return encodeWav(downsampleTo16k(samples, this.rate), 16000);
  }
}
