import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.js';
import { encodeWav } from '../src/audio/wav.js';
import { loadConfig } from '../src/config.js';
import { ENVELOPE_MAX_VALUES, loudnessEnvelope, PodMirror, type PodMirrorEvent } from '../src/pod/mirror.js';

const OWNER = { 'x-device-token': 'owner-secret' };
const silentWav = () => encodeWav(Buffer.alloc(32000));

/** PCM s16le with constant amplitude per 50 ms window. */
function pcm(amplitudes: number[], perWindow = 800): Buffer {
  const buf = Buffer.alloc(amplitudes.length * perWindow * 2);
  amplitudes.forEach((a, w) => {
    for (let i = 0; i < perWindow; i++) buf.writeInt16LE(Math.round(a * 32767) * (i % 2 ? 1 : -1), (w * perWindow + i) * 2);
  });
  return buf;
}

describe('loudnessEnvelope', () => {
  it('is RMS per 50 ms window, normalised to the loudest window', () => {
    const env = loudnessEnvelope(pcm([0.5, 0.25, 0, 0.5]));
    assert.deepEqual(env, [1, 0.5, 0, 1]);
  });

  it('empty and silent audio give no / zero values', () => {
    assert.deepEqual(loudnessEnvelope(Buffer.alloc(0)), []);
    assert.deepEqual(loudnessEnvelope(Buffer.alloc(3200)), [0, 0]);
  });

  it('never exceeds the max value count for long replies', () => {
    const minute = Buffer.alloc(16000 * 2 * 60, 1);
    const env = loudnessEnvelope(minute);
    assert.ok(env.length <= ENVELOPE_MAX_VALUES, `${env.length}`);
    assert.ok(env.length >= ENVELOPE_MAX_VALUES - 1);
  });
});

describe('PodMirror', () => {
  it('drops level samples faster than 10/s and outside listening', () => {
    let t = 1_000;
    const seen: PodMirrorEvent[] = [];
    const m = new PodMirror({ publish: (e) => seen.push(e), now: () => t });
    assert.equal(m.level(0.5), false, 'not listening');
    m.set('listening');
    assert.equal(m.level(0.5), true);
    t += 50;
    assert.equal(m.level(0.6), false);
    t += 60;
    assert.equal(m.level(2), true);
    assert.equal(seen.at(-1)?.level, 1, 'clamped');
  });
});

function setup() {
  const app = buildApp({ config: loadConfig({ DEVICE_TOKEN: 'owner-secret', GUEST_ACCESS: 'true' }) });
  const pod: PodMirrorEvent[] = [];
  app.ghosty.state.subscribe((e) => {
    if (e.type === 'pod') pod.push(e.data as PodMirrorEvent);
  });
  return { app, pod };
}

describe('POST /pod/state and the pod mirror', () => {
  it('needs the owner token (401 without, 403 for a guest) and validates the body', async () => {
    const { app, pod } = setup();
    assert.equal((await app.inject({ method: 'POST', url: '/pod/state', payload: { state: 'listening' } })).statusCode, 401);
    const guest = (await app.inject({ method: 'POST', url: '/guest/token' })).json().token as string;
    assert.equal((await app.inject({ method: 'POST', url: '/pod/state', headers: { 'x-device-token': guest }, payload: { state: 'listening' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/pod/state', headers: OWNER, payload: { state: 'dancing' } })).statusCode, 400);
    assert.equal(pod.length, 0);
  });

  it('emits listening (and idle on cancel) as SSE `pod` events', async () => {
    const { app, pod } = setup();
    const res = await app.inject({ method: 'POST', url: '/pod/state', headers: OWNER, payload: { state: 'listening' } });
    assert.equal(res.statusCode, 200);
    await app.inject({ method: 'POST', url: '/pod/state', headers: OWNER, payload: { state: 'listening', level: 0.4 } });
    await app.inject({ method: 'POST', url: '/pod/state', headers: OWNER, payload: { state: 'idle' } });
    assert.deepEqual(
      pod.map((e) => [e.state, e.source]),
      [
        ['listening', 'pod'],
        ['listening', 'pod'],
        ['idle', 'pod'],
      ],
    );
    assert.equal(pod[1]?.level, 0.4);
  });

  it('a pod-tagged /voice turn emits thinking → speaking (envelope, duration) → idle', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { app, pod } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/voice',
      headers: { ...OWNER, 'content-type': 'audio/wav', 'x-ghosty-client': 'pod' },
      payload: silentWav(),
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(pod.map((e) => e.state), ['thinking', 'speaking']);
    const speaking = pod[1]!;
    const samples = res.rawPayload.length / 2;
    assert.equal(speaking.durationMs, Math.round((samples / 16000) * 1000));
    assert.ok(Array.isArray(speaking.envelope) && speaking.envelope.length > 0);
    assert.ok(speaking.envelope.every((v) => v >= 0 && v <= 1));
    t.mock.timers.tick(speaking.durationMs!);
    assert.deepEqual(pod.map((e) => e.state), ['thinking', 'speaking', 'idle']);
  });

  it('web-tagged and untagged /voice turns never drive the pod mirror', async () => {
    const { app, pod } = setup();
    for (const client of ['web', undefined]) {
      const res = await app.inject({
        method: 'POST',
        url: '/voice',
        headers: { ...OWNER, 'content-type': 'audio/wav', ...(client ? { 'x-ghosty-client': client } : {}) },
        payload: silentWav(),
      });
      assert.equal(res.statusCode, 200);
    }
    await app.inject({ method: 'POST', url: '/voice/text', headers: { ...OWNER, 'x-ghosty-client': 'web' }, payload: { text: 'hello?' } });
    assert.equal(pod.length, 0);
  });

  it('hands-free pod audio without the wake word never shows thinking: 204 → idle', async () => {
    const app = buildApp({
      config: loadConfig({ DEVICE_TOKEN: 'owner-secret' }),
      deps: { stt: { transcribe: async () => ({ text: 'the TV is on in the next room', provider: 'fake' }) } },
    });
    const pod: PodMirrorEvent[] = [];
    app.ghosty.state.subscribe((e) => {
      if (e.type === 'pod') pod.push(e.data as PodMirrorEvent);
    });
    const res = await app.inject({
      method: 'POST',
      url: '/voice',
      headers: { ...OWNER, 'content-type': 'audio/wav', 'x-ghosty-client': 'pod', 'x-listen': 'always' },
      payload: silentWav(),
    });
    assert.equal(res.statusCode, 204);
    assert.deepEqual(pod.map((e) => e.state), ['idle']);
  });

  it('hands-free pod audio with the wake word: thinking → speaking', async () => {
    const app = buildApp({
      config: loadConfig({ DEVICE_TOKEN: 'owner-secret' }),
      deps: { stt: { transcribe: async () => ({ text: 'Ghosty, what is gold at?', provider: 'fake' }) } },
    });
    const pod: PodMirrorEvent[] = [];
    app.ghosty.state.subscribe((e) => {
      if (e.type === 'pod') pod.push(e.data as PodMirrorEvent);
    });
    const res = await app.inject({
      method: 'POST',
      url: '/voice',
      headers: { ...OWNER, 'content-type': 'audio/wav', 'x-ghosty-client': 'pod', 'x-listen': 'always' },
      payload: silentWav(),
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(pod.map((e) => e.state), ['thinking', 'speaking']);
    await app.close();
  });

  it('a guest claiming to be the pod does not drive the mirror', async () => {
    const { app, pod } = setup();
    const guest = (await app.inject({ method: 'POST', url: '/guest/token' })).json().token as string;
    const res = await app.inject({
      method: 'POST',
      url: '/voice',
      headers: { 'x-device-token': guest, 'content-type': 'audio/wav', 'x-ghosty-client': 'pod' },
      payload: silentWav(),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(pod.length, 0);
  });
});
