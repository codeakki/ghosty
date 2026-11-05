import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.js';
import { encodeWav } from '../src/audio/wav.js';
import { loadConfig } from '../src/config.js';

const silentWav = () => encodeWav(Buffer.alloc(16000 * 2));
const WAR = 'Missile strike reported near the Taiwan Strait';

describe('virtual pod', () => {
  it('GET /state returns the full snapshot shape', async () => {
    const app = buildApp({ config: loadConfig({}) });
    const res = await app.inject({ method: 'GET', url: '/state' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    for (const key of ['news', 'credibility', 'lastDecision', 'plannedActions', 'orders', 'episodes', 'safeStop', 'alerts']) {
      assert.ok(key in body, `missing ${key}`);
    }
    assert.equal(body.safeStop, false);
    assert.deepEqual(body.alerts, []);
    await app.close();
  });

  it('POST /news/inject with a war headline decides and queues an alert', async () => {
    const app = buildApp({ config: loadConfig({}) });
    const res = await app.inject({ method: 'POST', url: '/news/inject', payload: { title: WAR, source: 'Reuters' } });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.item.title, WAR);
    assert.equal(body.decision.signal, 'geopolitical_shock');
    assert.match(body.decision.rationale, /Taiwan Strait/);
    assert.equal(body.alert.status, 'pending');
    assert.equal(body.alert.requestId, body.decision.requestId);

    const state = (await app.inject({ method: 'GET', url: '/state' })).json();
    assert.equal(state.lastDecision.trigger, 'inject');
    assert.equal(state.lastDecision.headline, WAR);
    assert.equal(state.alerts[0].id, body.alert.id);
    assert.equal(state.plannedActions.length, 3);
    const injected = state.news.find((n: { title: string }) => n.title === WAR);
    assert.equal(injected.credibility.level, 'exemplary');
    assert.equal(injected.signal, 'geopolitical_shock');
    assert.equal(state.credibility.Reuters.score, 2300);
    await app.close();
  });

  it('POST /news/inject with a benign headline and a quiet feed queues no alert', async () => {
    const app = buildApp({ config: loadConfig({}), deps: { news: [] } });
    const res = await app.inject({ method: 'POST', url: '/news/inject', payload: { title: 'Ether ETF inflows steady' } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().decision.signal, 'none');
    assert.equal(res.json().alert, null);
    assert.equal((await app.inject({ method: 'GET', url: '/alerts/next' })).statusCode, 204);
    await app.close();
  });

  it('POST /news/inject rejects a missing title', async () => {
    const app = buildApp({ config: loadConfig({}) });
    const res = await app.inject({ method: 'POST', url: '/news/inject', payload: { source: 'Reuters' } });
    assert.equal(res.statusCode, 400);
    await app.close();
  });

  it('GET /alerts/next dequeues oldest first, then answers 204; ack marks it', async () => {
    const app = buildApp({ config: loadConfig({}) });
    const first = (await app.inject({ method: 'POST', url: '/news/inject', payload: { title: WAR } })).json();
    const second = (await app.inject({ method: 'POST', url: '/news/inject', payload: { title: 'Invasion fears grow' } })).json();

    const a = await app.inject({ method: 'GET', url: '/alerts/next' });
    assert.equal(a.statusCode, 200);
    assert.equal(a.json().id, first.alert.id);
    assert.deepEqual(Object.keys(a.json()).slice(0, 5), ['id', 'text', 'signal', 'actions', 'requestId']);
    const b = await app.inject({ method: 'GET', url: '/alerts/next' });
    assert.equal(b.json().id, second.alert.id);
    const empty = await app.inject({ method: 'GET', url: '/alerts/next' });
    assert.equal(empty.statusCode, 204);
    assert.equal(empty.body, '');

    const ack = await app.inject({ method: 'POST', url: `/alerts/${first.alert.id}/ack` });
    assert.equal(ack.statusCode, 200);
    assert.equal(ack.json().alert.status, 'acked');
    assert.equal((await app.inject({ method: 'POST', url: '/alerts/nope/ack' })).statusCode, 404);
    await app.close();
  });

  it('the button acts on the injected decision and the orders land in the state', async () => {
    const app = buildApp({ config: loadConfig({ MAX_TRADE_USD: '100' }) });
    const injected = (await app.inject({ method: 'POST', url: '/news/inject', payload: { title: WAR } })).json();
    const press = (await app.inject({ method: 'POST', url: '/button', payload: { action: 'confirm' } })).json();
    assert.equal(press.requestId, injected.decision.requestId);
    assert.equal(press.executed, true);

    const state = (await app.inject({ method: 'GET', url: '/state' })).json();
    assert.equal(state.orders.length, 3);
    assert.equal(state.orders[0].requestId, injected.decision.requestId);
    assert.deepEqual(state.plannedActions, []);
    assert.deepEqual(
      state.episodes.map((e: { outcome: string }) => e.outcome),
      ['executed', 'proposed'],
    );
    await app.close();
  });

  it('POST /voice/text returns the decision as JSON with base64 PCM', async () => {
    const app = buildApp({ config: loadConfig({}) });
    const res = await app.inject({ method: 'POST', url: '/voice/text', payload: { text: 'what is moving gold?' } });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.transcript, 'what is moving gold?');
    assert.equal(body.signal, 'geopolitical_shock');
    assert.equal(body.sampleRate, 16000);
    assert.equal(body.audioBytes, 16000);
    assert.equal(Buffer.from(body.audioBase64, 'base64').length, 16000);

    const state = (await app.inject({ method: 'GET', url: '/state' })).json();
    assert.equal(state.lastDecision.trigger, 'text');
    assert.equal(state.lastDecision.requestId, body.requestId);

    assert.equal((await app.inject({ method: 'POST', url: '/voice/text', payload: { text: '  ' } })).statusCode, 400);
    await app.close();
  });

  it('sim routes that act check X-Device-Token', async () => {
    const app = buildApp({ config: loadConfig({ DEVICE_TOKEN: 's3cret' }) });
    const calls = [
      { method: 'POST', url: '/news/inject', payload: { title: WAR } },
      { method: 'POST', url: '/voice/text', payload: { text: 'hi' } },
      { method: 'GET', url: '/alerts/next' },
      { method: 'POST', url: '/sim/safe-stop', payload: { enabled: true } },
    ] as const;
    for (const call of calls) {
      assert.equal((await app.inject(call)).statusCode, 401, `${call.method} ${call.url}`);
    }
    const ok = await app.inject({ ...calls[0], headers: { 'x-device-token': 's3cret' } });
    assert.equal(ok.statusCode, 200);
    // Read-only views stay open (EventSource cannot send headers).
    assert.equal((await app.inject({ method: 'GET', url: '/state' })).statusCode, 200);
    await app.close();
  });

  it('GET /events streams text/event-stream and starts with a state event', async () => {
    const app = buildApp({ config: loadConfig({}) });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const abort = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/events`, { signal: abort.signal });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream/);
      assert.ok(res.body);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      while (!/event: state\ndata: .*\n\n/.test(text)) {
        const { value, done } = await reader.read();
        assert.equal(done, false, 'stream ended before the first event');
        text += decoder.decode(value, { stream: true });
      }
      const block = text.slice(text.indexOf('event: state'));
      const data = JSON.parse(block.split('\n')[1]!.slice('data: '.length));
      assert.equal(data.safeStop, false);
      assert.ok(Array.isArray(data.alerts));

      // A change shows up as a typed event on the open stream.
      await fetch(`http://127.0.0.1:${port}/news/inject`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: WAR }),
      });
      while (!text.includes('event: alert')) {
        const { value, done } = await reader.read();
        assert.equal(done, false);
        text += decoder.decode(value, { stream: true });
      }
    } finally {
      abort.abort();
      await app.close();
    }
  });

  it('POST /sim/safe-stop makes /voice return 503 until it is turned off', async () => {
    const app = buildApp({ config: loadConfig({}) });
    const voice = () =>
      app.inject({ method: 'POST', url: '/voice', headers: { 'content-type': 'audio/wav' }, payload: silentWav() });
    assert.equal((await voice()).statusCode, 200);

    const on = await app.inject({ method: 'POST', url: '/sim/safe-stop', payload: { enabled: true } });
    assert.deepEqual(on.json(), { safeStop: true, simulateOffline: true });
    const blocked = await voice();
    assert.equal(blocked.statusCode, 503);
    assert.deepEqual(blocked.json(), { error: 'brain_offline' });
    assert.equal((await app.inject({ method: 'POST', url: '/button', payload: { action: 'confirm' } })).statusCode, 503);
    assert.equal((await app.inject({ method: 'POST', url: '/news/inject', payload: { title: WAR } })).statusCode, 503);
    assert.equal((await app.inject({ method: 'GET', url: '/health' })).json().safeStop, true);
    assert.equal((await app.inject({ method: 'GET', url: '/state' })).json().safeStop, true);

    await app.inject({ method: 'POST', url: '/sim/safe-stop', payload: { enabled: false } });
    assert.equal((await voice()).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/sim/safe-stop', payload: { enabled: 'yes' } })).statusCode, 400);
    await app.close();
  });

  it('SAFE_STOP_ENABLED=false keeps safe-stop off even when the sim asks for it', async () => {
    const app = buildApp({ config: loadConfig({ SAFE_STOP_ENABLED: 'false' }) });
    const res = await app.inject({ method: 'POST', url: '/sim/safe-stop', payload: { enabled: true } });
    assert.equal(res.json().safeStop, false);
    await app.close();
  });

  it('GET /sim serves the HTML page', async () => {
    const app = buildApp({ config: loadConfig({}) });
    const res = await app.inject({ method: 'GET', url: '/sim' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] as string, /^text\/html/);
    assert.match(res.body, /<title>Ghosty virtual pod<\/title>/);
    await app.close();
  });
});
