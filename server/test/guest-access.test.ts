import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Decider, DecideInput, Decision } from '../src/agent/decide.js';
import { buildApp } from '../src/app.js';
import { encodeWav } from '../src/audio/wav.js';
import type { AssistantReply, VoiceAssistant } from '../src/claude/voice.js';
import { loadConfig } from '../src/config.js';
import type { MarketOrderRequest, OrderResult, PerpVenue } from '../src/execution/hyperliquid.js';
import { GUEST_TRADE_REPLY, GuestAccess } from '../src/guest/access.js';
import type { PodEvent } from '../src/sim/state.js';

const OWNER = { 'x-device-token': 'owner-secret' };
const silentWav = () => encodeWav(Buffer.alloc(32000));

class FakeAssistant implements VoiceAssistant {
  questions: string[] = [];
  async answer(question: string): Promise<AssistantReply> {
    this.questions.push(question);
    return { text: 'Gold is up about one percent.', id: `msg_${this.questions.length}` };
  }
}

class SpyDecider implements Decider {
  calls = 0;
  async decide(input: DecideInput): Promise<Decision> {
    this.calls += 1;
    return {
      signal: 'geopolitical_shock',
      confidence: 0.8,
      rationale: 'Shock. Press to confirm.',
      requestId: `0g-spy-${this.calls}`,
      suggestedActions: [{ venue: 'hyperliquid', kind: 'perp', coin: 'BTC', side: 'short', sizeUsd: 10, reason: 'test' }],
      newsIds: input.news.map((n) => n.id),
    };
  }
}

class SpyVenue implements PerpVenue {
  calls: MarketOrderRequest[] = [];
  async placeMarketOrder(req: MarketOrderRequest): Promise<OrderResult> {
    this.calls.push(req);
    return { orderId: `o-${this.calls.length}`, coin: req.coin, isBuy: req.isBuy, sizeUsd: req.sizeUsd, status: 'filled', avgPx: 1, url: 'https://example.com' };
  }
  async listMarkets() {
    return [];
  }
}

function setup(env: Record<string, string> = {}, now?: () => number) {
  const assistant = new FakeAssistant();
  const decider = new SpyDecider();
  const venue = new SpyVenue();
  const orderAgentCalls: string[] = [];
  const app = buildApp({
    config: loadConfig({ DEVICE_TOKEN: 'owner-secret', GUEST_ACCESS: 'true', ...env }),
    assistant,
    deps: { decider, venue },
    orderAgent: {
      handle: async (u: string) => {
        orderAgentCalls.push(u);
        return { text: 'done', id: 'msg_order', orders: [] };
      },
    },
    guestNow: now,
  });
  const voiceEvents: PodEvent[] = [];
  app.ghosty.state.subscribe((e) => {
    if (e.type === 'voice') voiceEvents.push(e);
  });
  const guestToken = async (ip = '203.0.113.7') => {
    const res = await app.inject({ method: 'POST', url: '/guest/token', headers: { 'x-forwarded-for': ip } });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().token as string;
  };
  return { app, assistant, decider, venue, orderAgentCalls, voiceEvents, guestToken };
}

describe('GuestAccess store', () => {
  it('issues 32-hex tokens, limits issuance per IP per hour, and expires tokens', () => {
    let t = Date.parse('2026-11-07T10:00:00Z');
    const g = new GuestAccess({ ttlSec: 60, issuePerIpPerHour: 2 }, { now: () => t });
    const a = g.issue('1.1.1.1');
    assert.ok(a.ok);
    assert.match(a.token, /^[0-9a-f]{32}$/);
    assert.ok(g.issue('1.1.1.1').ok);
    const third = g.issue('1.1.1.1');
    assert.equal(third.ok, false);
    assert.equal(!third.ok && third.error, 'guest_issue_limited');
    assert.ok(g.issue('2.2.2.2').ok, 'another IP is unaffected');
    assert.ok(g.verify(a.token));
    t += 61_000;
    assert.equal(g.verify(a.token), undefined);
  });

  it('caps active tokens globally', () => {
    const g = new GuestAccess({ maxActive: 2, issuePerIpPerHour: 10 });
    assert.ok(g.issue('a').ok);
    assert.ok(g.issue('b').ok);
    const r = g.issue('c');
    assert.equal(!r.ok && r.error, 'guest_capacity');
  });

  it('persists only token hashes and reloads them after a restart', () => {
    const persistPath = join(mkdtempSync(join(tmpdir(), 'ghosty-guests-')), 'guests.json');
    const g = new GuestAccess({}, { persistPath });
    const issued = g.issue('ip');
    assert.ok(issued.ok);
    const again = new GuestAccess({}, { persistPath });
    assert.ok(again.verify(issued.token), 'token survives a restart');
    assert.equal(again.verify('0'.repeat(32)), undefined);
  });
});

describe('guest access over HTTP', () => {
  it('is off by default: no /guest/token, GET /access says so', async () => {
    const app = buildApp({ config: loadConfig({ DEVICE_TOKEN: 'owner-secret' }) });
    assert.equal((await app.inject({ method: 'POST', url: '/guest/token' })).statusCode, 404);
    const access = (await app.inject({ method: 'GET', url: '/access' })).json();
    assert.equal(access.guestAccess, false);
    assert.equal((await app.inject({ method: 'GET', url: '/health' })).json().guestAccess, false);
  });

  it('issues a guest token, limits it per IP (5/hour), and /access reports the scope', async () => {
    const { app, guestToken } = setup();
    const token = await guestToken('198.51.100.1');
    assert.match(token, /^[0-9a-f]{32}$/);
    for (let i = 0; i < 4; i++) await guestToken('198.51.100.1');
    const sixth = await app.inject({ method: 'POST', url: '/guest/token', headers: { 'x-forwarded-for': '198.51.100.1' } });
    assert.equal(sixth.statusCode, 429);
    assert.equal(sixth.json().error, 'guest_issue_limited');
    assert.ok(Number(sixth.headers['retry-after']) > 0);
    const access = (await app.inject({ method: 'GET', url: '/access', headers: { 'x-device-token': token } })).json();
    assert.equal(access.guestAccess, true);
    assert.equal(access.scope, 'guest');
    assert.ok(access.expiresAt);
    assert.equal((await app.inject({ method: 'GET', url: '/access', headers: OWNER })).json().scope, 'owner');
  });

  it('a guest can ask a question (Claude path), without 0G, orders, or the public feed', async () => {
    const { app, guestToken, assistant, decider, orderAgentCalls, voiceEvents } = setup();
    const token = await guestToken();
    const res = await app.inject({ method: 'POST', url: '/voice/text', headers: { 'x-device-token': token }, payload: { text: "What's moving gold?" } });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.answeredBy, 'claude');
    assert.equal(body.reply, 'Gold is up about one percent.');
    assert.deepEqual(assistant.questions, ["What's moving gold?"]);
    assert.equal(decider.calls, 0);
    assert.deepEqual(orderAgentCalls, [], 'the order agent never hears a guest');
    assert.equal(voiceEvents.length, 0, 'guest turns stay off the shared feed');
  });

  it('a guest trade request is answered with the guest line: no decider, executor, order agent or payment', async () => {
    const { app, guestToken, decider, venue, orderAgentCalls } = setup();
    const token = await guestToken();
    const text = await app.inject({ method: 'POST', url: '/voice/text', headers: { 'x-device-token': token }, payload: { text: 'go long BTC now' } });
    assert.equal(text.statusCode, 200);
    assert.equal(text.json().reply, GUEST_TRADE_REPLY);
    assert.equal(text.json().signal, 'none');
    assert.deepEqual(text.json().actions, []);
    // Voice too (the fake STT hears a trade request).
    const voice = await app.inject({ method: 'POST', url: '/voice', headers: { 'x-device-token': token, 'content-type': 'audio/wav' }, payload: silentWav() });
    assert.equal(voice.statusCode, 200);
    assert.equal(voice.headers['x-signal'], 'none');
    assert.equal(decider.calls, 0);
    assert.equal(venue.calls.length, 0);
    assert.deepEqual(orderAgentCalls, []);
    // A guest "yes" can never confirm anything either.
    const yes = await app.inject({ method: 'POST', url: '/voice/text', headers: { 'x-device-token': token }, payload: { text: 'yes' } });
    assert.equal(yes.json().reply, GUEST_TRADE_REPLY);
  });

  it('guests are blocked (403) from the button, inject, pay-signal, pod state, safe-stop and live sim runs', async () => {
    const { app, guestToken, decider, venue } = setup();
    const h = { 'x-device-token': await guestToken() };
    const calls: Array<[string, string, object]> = [
      ['POST', '/button', { action: 'confirm' }],
      ['POST', '/news/inject', { title: 'Missile strike near the Strait' }],
      ['POST', '/sim/pay-signal', {}],
      ['POST', '/pod/state', { state: 'listening' }],
      ['POST', '/sim/safe-stop', { enabled: true }],
      ['POST', '/sim/run', { scenarioId: 'x', liveOrders: true }],
      ['POST', '/sim/run', { scenarioId: 'x' }],
      ['POST', '/sim/control', { action: 'stop' }],
      ['GET', '/alerts/next', {}],
      ['GET', '/announce', {}],
    ];
    for (const [method, url, payload] of calls) {
      const res = await app.inject({ method: method as 'GET' | 'POST', url, headers: h, ...(method === 'POST' ? { payload } : {}) });
      assert.equal(res.statusCode, 403, `${method} ${url} → ${res.statusCode}`);
      assert.equal(res.json().error, 'guest_forbidden');
    }
    assert.equal(decider.calls, 0);
    assert.equal(venue.calls.length, 0);
  });

  it('GUEST_SIM=true lets guests start paper runs only, never live ones', async () => {
    const { app, guestToken } = setup({ GUEST_SIM: 'true' });
    const h = { 'x-device-token': await guestToken() };
    const live = await app.inject({ method: 'POST', url: '/sim/run', headers: h, payload: { scenarioId: 'nope', liveOrders: true } });
    assert.equal(live.statusCode, 403);
    const paper = await app.inject({ method: 'POST', url: '/sim/run', headers: h, payload: { scenarioId: 'nope' } });
    assert.notEqual(paper.statusCode, 403, 'paper run passes auth (unknown scenario is a 4xx from the engine)');
    assert.notEqual(paper.statusCode, 401);
  });

  it('rate limits a guest (429 guest_rate_limited with retryAfterSec); the owner is unaffected', async () => {
    const { app, guestToken } = setup({ GUEST_MAX_PER_HOUR: '2' });
    const h = { 'x-device-token': await guestToken() };
    const ask = (headers: Record<string, string>) => app.inject({ method: 'POST', url: '/voice/text', headers, payload: { text: 'how is BTC doing?' } });
    assert.equal((await ask(h)).statusCode, 200);
    assert.equal((await ask(h)).statusCode, 200);
    const limited = await ask(h);
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error, 'guest_rate_limited');
    assert.ok(limited.json().retryAfterSec > 0);
    for (let i = 0; i < 4; i++) assert.equal((await ask(OWNER)).statusCode, 200, 'owner never hits guest limits');
  });

  it('caps guest turns per day across all guests', async () => {
    const { app, guestToken } = setup({ GUEST_MAX_PER_DAY: '2' });
    const a = { 'x-device-token': await guestToken('10.0.0.1') };
    const b = { 'x-device-token': await guestToken('10.0.0.2') };
    const ask = (headers: Record<string, string>) => app.inject({ method: 'POST', url: '/voice/text', headers, payload: { text: 'hello?' } });
    assert.equal((await ask(a)).statusCode, 200);
    assert.equal((await ask(b)).statusCode, 200);
    const capped = await ask(a);
    assert.equal(capped.statusCode, 429);
    assert.equal(capped.json().error, 'guest_daily_cap');
  });

  it('an expired guest token answers 401 guest_expired', async () => {
    let t = Date.parse('2026-11-07T10:00:00Z');
    const { app, guestToken } = setup({ GUEST_TTL_SEC: '60' }, () => t);
    const h = { 'x-device-token': await guestToken() };
    t += 61_000;
    const res = await app.inject({ method: 'POST', url: '/voice/text', headers: h, payload: { text: 'hello?' } });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error, 'guest_expired');
  });

  it('the owner token keeps full access (trade path reaches 0G, button confirms)', async () => {
    const { app, decider, venue } = setup({ MAX_TRADE_USD: '100' });
    // orderAgent is set in setup, so turn it off for this owner check by using a plain app.
    const plain = buildApp({ config: loadConfig({ DEVICE_TOKEN: 'owner-secret', GUEST_ACCESS: 'true' }), assistant: new FakeAssistant(), deps: { decider, venue } });
    const turn = await plain.inject({ method: 'POST', url: '/voice/text', headers: OWNER, payload: { text: 'go long BTC now' } });
    assert.equal(turn.statusCode, 200);
    assert.equal(turn.json().answeredBy, '0g');
    assert.equal(decider.calls, 1);
    const press = await plain.inject({ method: 'POST', url: '/button', headers: OWNER, payload: { action: 'confirm' } });
    assert.equal(press.statusCode, 200);
    assert.equal(venue.calls.length, 1);
    assert.equal((await app.inject({ method: 'POST', url: '/button', payload: { action: 'confirm' } })).statusCode, 401);
  });
});
