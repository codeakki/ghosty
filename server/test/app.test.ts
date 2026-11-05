import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.js';
import { encodeWav } from '../src/audio/wav.js';
import { loadConfig } from '../src/config.js';

const silentWav = (seconds = 1, channels = 1) => encodeWav(Buffer.alloc(16000 * 2 * channels * seconds), { channels });

describe('config', () => {
  it('never throws on missing or malformed values', () => {
    const cfg = loadConfig({ PORT: 'abc', MAX_TRADE_USD: '', HL_TESTNET: 'false' });
    assert.equal(cfg.PORT, 3000);
    assert.equal(cfg.MAX_TRADE_USD, 25);
    assert.equal(cfg.HL_TESTNET, false);
    assert.equal(cfg.SAFE_STOP_ENABLED, true);
    assert.equal(cfg.DEVICE_TOKEN, undefined);
  });
});

describe('HTTP API', () => {
  it('GET /health', async () => {
    const app = buildApp({ config: loadConfig({}) });
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.version, '0.1.0');
    assert.equal(body.safeStop, false);
  });

  it('POST /voice returns 0.5 s of 16 kHz s16le PCM', async () => {
    const app = buildApp({ config: loadConfig({}) });
    const res = await app.inject({
      method: 'POST',
      url: '/voice',
      headers: { 'content-type': 'audio/wav' },
      payload: silentWav(),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'application/octet-stream');
    assert.equal(res.rawPayload.length, 16000);
    assert.equal(res.headers['x-signal'], 'geopolitical_shock');
  });

  it('POST /voice rejects stereo WAV with 400', async () => {
    const app = buildApp({ config: loadConfig({}) });
    const res = await app.inject({
      method: 'POST',
      url: '/voice',
      headers: { 'content-type': 'application/octet-stream' },
      payload: silentWav(1, 2),
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'bad_wav');
  });

  it('checks X-Device-Token when DEVICE_TOKEN is set', async () => {
    const app = buildApp({ config: loadConfig({ DEVICE_TOKEN: 's3cret' }) });
    const req = (token?: string) =>
      app.inject({
        method: 'POST',
        url: '/voice',
        headers: { 'content-type': 'audio/wav', ...(token ? { 'x-device-token': token } : {}) },
        payload: silentWav(),
      });
    assert.equal((await req()).statusCode, 401);
    assert.equal((await req('wrong')).statusCode, 401);
    assert.equal((await req('s3cret')).statusCode, 200);
  });

  it('POST /button confirm executes the planned actions', async () => {
    const app = buildApp({ config: loadConfig({ MAX_TRADE_USD: '100' }) });
    const res = await app.inject({ method: 'POST', url: '/button', payload: { action: 'confirm' } });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.signal, 'geopolitical_shock');
    assert.equal(body.executed, true);
    assert.deepEqual(
      body.actions.map((a: { coin: string }) => a.coin),
      ['xyz:GOLD', 'xyz:WTI', 'BTC'],
    );
    assert.equal(body.orders.length, 3);
  });

  it('POST /button rejects bad bodies', async () => {
    const app = buildApp({ config: loadConfig({}) });
    const res = await app.inject({ method: 'POST', url: '/button', payload: { action: 'yolo' } });
    assert.equal(res.statusCode, 400);
  });

  it('safe-stop: 503 brain_offline from /voice and /button when 0G is unreachable', async () => {
    const app = buildApp({ config: loadConfig({ SIMULATE_BRAIN_OFFLINE: 'true' }) });
    const voice = await app.inject({
      method: 'POST',
      url: '/voice',
      headers: { 'content-type': 'audio/wav' },
      payload: silentWav(),
    });
    const button = await app.inject({ method: 'POST', url: '/button', payload: { action: 'confirm' } });
    assert.equal(voice.statusCode, 503);
    assert.deepEqual(voice.json(), { error: 'brain_offline' });
    assert.equal(button.statusCode, 503);
    assert.deepEqual(button.json(), { error: 'brain_offline' });
    const health = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(health.json().safeStop, true);
  });
});
