import { describe, expect, it } from 'vitest';
import type { ProviderStatus } from '../../api/types';
import { setupNotice, watching, watchingText } from './setup';

const p = (id: string, state: ProviderStatus['state'], missingEnv: string[] = [], detail = ''): ProviderStatus => ({
  id,
  label: id,
  track: 'data',
  state,
  detail,
  missingEnv,
});

describe('setup notice', () => {
  it('leads with the most important blocker, in plain words (no env var names in the headline)', () => {
    const n = setupNotice([
      p('groq', 'not_configured', ['GROQ_API_KEY']),
      p('0g-router', 'live'),
      p('0g-storage', 'not_configured', ['OG_PRIVATE_KEY']),
      p('hyperliquid', 'not_configured', ['HL_MASTER_ADDRESS', 'HL_AGENT_PRIVATE_KEY']),
    ]);
    expect(n!.headline).toBe('Ghosty can’t decide yet — the storage wallet isn’t set up.');
    expect(n!.headline).not.toMatch(/[A-Z]{2,}_[A-Z]/);
    expect(n!.issues.map((i) => i.id)).toEqual(['0g-storage', 'hyperliquid', 'groq']);
    expect(n!.issues[0]!.env).toEqual(['OG_PRIVATE_KEY']);
  });

  it('is null when everything is set up, and while status is unknown', () => {
    expect(setupNotice([p('0g-router', 'live'), p('rss', 'live')])).toBeNull();
    expect(setupNotice(null)).toBeNull();
  });

  it('does not flag voice output when the backup voice is live', () => {
    const n = setupNotice([p('elevenlabs', 'not_configured', ['ELEVENLABS_API_KEY']), p('openai-tts', 'live')]);
    expect(n).toBeNull();
  });

  it('ignores providers that are merely offline (that is safe-stop, not setup)', () => {
    expect(setupNotice([p('0g-router', 'offline')])).toBeNull();
  });
});

describe('what Ghosty is watching', () => {
  it('uses real counts from the server', () => {
    const w = watching([p('rss', 'live', [], '4/4 feeds reachable'), p('polymarket', 'live')], 8);
    expect(watchingText(w)).toBe('4 news wires, Polymarket and 8 markets');
  });

  it('says less when the server says less', () => {
    expect(watchingText(watching([], null))).toBe('the news and the markets');
    expect(watchingText(watching([p('polymarket', 'live')], 8))).toBe('Polymarket and 8 markets');
  });
});
