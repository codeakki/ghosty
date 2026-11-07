import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeGuestError, GhostyClient, loadSettings, toResult, type UnauthorizedInfo } from '../../api/client';
import { AUTO_OPENED_KEY, commitSettings, guestLabel, guestSettings, initialTokenPrompt, rememberAutoOpened, tokenPromptReducer, type TokenPromptState } from './tokenPrompt';

const action: UnauthorizedInfo = { method: 'POST', path: '/button' };
const poll: UnauthorizedInfo = { method: 'GET', path: '/alerts/next' };

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

const fresh: TokenPromptState = { needsToken: false, open: false, autoOpened: false };

describe('token prompt: 401 → banner, auto-open once', () => {
  it('a 401 from background polling shows the banner but never opens the dialog', () => {
    const s = tokenPromptReducer(fresh, { type: 'unauthorized', info: poll });
    expect(s).toEqual({ needsToken: true, open: false, autoOpened: false });
  });

  it('the first 401 from a user action opens the dialog once', () => {
    const s1 = tokenPromptReducer(fresh, { type: 'unauthorized', info: action });
    expect(s1).toEqual({ needsToken: true, open: true, autoOpened: true });
    const closed = tokenPromptReducer(s1, { type: 'close' });
    const s2 = tokenPromptReducer(closed, { type: 'unauthorized', info: action });
    expect(s2.open).toBe(false);
    expect(s2.needsToken).toBe(true);
  });

  it('a poll 401 first, then a user action, still auto-opens once', () => {
    const s = [poll, action].reduce<TokenPromptState>((acc, info) => tokenPromptReducer(acc, { type: 'unauthorized', info }), fresh);
    expect(s.open).toBe(true);
  });

  it('saving clears the banner and closes the dialog; a wrong token brings the banner back without re-opening', () => {
    const opened = tokenPromptReducer(fresh, { type: 'unauthorized', info: action });
    const saved = tokenPromptReducer(opened, { type: 'saved' });
    expect(saved).toEqual({ needsToken: false, open: false, autoOpened: true });
    const again = tokenPromptReducer(saved, { type: 'unauthorized', info: action });
    expect(again).toEqual({ needsToken: true, open: false, autoOpened: true });
  });

  it('the once-per-session flag survives a reload through sessionStorage', () => {
    const storage = memoryStorage();
    expect(initialTokenPrompt(storage).autoOpened).toBe(false);
    rememberAutoOpened(storage);
    expect(storage.getItem(AUTO_OPENED_KEY)).toBe('1');
    const s = tokenPromptReducer(initialTokenPrompt(storage), { type: 'unauthorized', info: action });
    expect(s.open).toBe(false);
    expect(s.needsToken).toBe(true);
  });

  it('repeated 401s are a no-op once the banner is up (no re-render churn)', () => {
    const s = tokenPromptReducer(fresh, { type: 'unauthorized', info: poll });
    expect(tokenPromptReducer(s, { type: 'unauthorized', info: poll })).toBe(s);
  });
});

describe('GhostyClient: 401 hook and live settings', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('localStorage', memoryStorage());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reports every 401 with method and path, never the token', async () => {
    const seen: UnauthorizedInfo[] = [];
    const client = new GhostyClient({ baseUrl: '', deviceToken: 'secret-token' }, { onUnauthorized: (i) => seen.push(i) });
    const r = await client.button('cancel');
    expect(r.ok).toBe(false);
    expect(seen).toEqual([{ method: 'POST', path: '/button' }]);
    expect(JSON.stringify(seen)).not.toContain('secret-token');
    await client.alertsNext();
    expect(seen[1]).toEqual({ method: 'GET', path: '/alerts/next' });
  });

  it('a 200 does not fire the hook', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, version: '1', safeStop: false }), { status: 200 }));
    const onUnauthorized = vi.fn();
    await new GhostyClient(undefined, { onUnauthorized }).health();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('saving settings persists them and the rebuilt client sends the new token', async () => {
    let current = loadSettings();
    expect(current.deviceToken).toBe('');
    commitSettings({ baseUrl: '', deviceToken: 'tok-123' }, (s) => {
      current = s;
    });
    expect(loadSettings()).toEqual({ baseUrl: '', deviceToken: 'tok-123' });
    expect(current.deviceToken).toBe('tok-123');

    await new GhostyClient(current).button('cancel');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-device-token']).toBe('tok-123');
  });
});

describe('guest pass', () => {
  it('stores the pass in the same settings slot with the guest scope, keeping the server URL', () => {
    const next = guestSettings({ baseUrl: 'https://x', deviceToken: 'old' }, { token: 'a'.repeat(32), expiresAt: '2026-11-08T10:00:00.000Z' });
    expect(next).toEqual({ baseUrl: 'https://x', deviceToken: 'a'.repeat(32), scope: 'guest', guestExpiresAt: '2026-11-08T10:00:00.000Z' });
  });

  it('labels the pass with what it allows and when it expires', () => {
    const now = Date.parse('2026-11-07T10:00:00Z');
    expect(guestLabel('2026-11-08T10:00:00Z', now)).toBe('Guest · questions only · expires in 24 h');
    expect(guestLabel('2026-11-07T10:20:00Z', now)).toBe('Guest · questions only · expires in 20 min');
    expect(guestLabel('2026-11-07T09:00:00Z', now)).toBe('Guest · pass expired');
    expect(guestLabel(undefined, now)).toBe('Guest · questions only');
  });

  it('a saved guest pass survives a reload; an owner token never carries a scope', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    commitSettings(guestSettings({ baseUrl: '', deviceToken: '' }, { token: 'b'.repeat(32), expiresAt: '2026-11-08T10:00:00.000Z' }), () => undefined);
    expect(loadSettings()).toMatchObject({ scope: 'guest', deviceToken: 'b'.repeat(32) });
    commitSettings({ baseUrl: '', deviceToken: 'owner' }, () => undefined);
    expect(loadSettings().scope).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('guest refusals and limits read as calm sentences', () => {
    expect(describeGuestError('guest_forbidden')).toBe("Guests can ask questions; trading needs the owner's pod.");
    expect(describeGuestError('guest_rate_limited', 1800)).toBe("That's the guest limit for this hour. Try again in 30 min.");
    expect(describeGuestError('guest_daily_cap')).toMatch(/tomorrow/);
  });

  it('maps 429 guest_rate_limited to a guest failure with retryAfterSec; 401 guest_expired keeps its code', async () => {
    const limited = await toResult(new Response(JSON.stringify({ error: 'guest_rate_limited', retryAfterSec: 120 }), { status: 429 }), () => null);
    expect(limited).toMatchObject({ ok: false, kind: 'guest', code: 'guest_rate_limited', retryAfterSec: 120 });
    const expired = await toResult(new Response(JSON.stringify({ error: 'guest_expired' }), { status: 401 }), () => null);
    expect(expired).toMatchObject({ ok: false, kind: 'unauthorized', code: 'guest_expired' });
  });
});
