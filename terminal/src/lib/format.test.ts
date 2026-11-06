import { describe, expect, it } from 'vitest';
import {
  DASH,
  formatAge,
  formatClock,
  formatCompact,
  formatConfidence,
  formatFunding,
  formatHbar,
  formatPct,
  formatPrice,
  formatSignal,
  formatUsd,
  isStubNewsId,
  seriesChangePct,
  shockTag,
  shortId,
  splitCoin,
} from './format';
import { downsampleTo16k, encodeWav } from './audio';

describe('number formatters', () => {
  it('never turns a missing value into 0', () => {
    for (const f of [formatUsd, formatPrice, formatPct, formatFunding, formatCompact, formatHbar, formatConfidence]) {
      expect(f(null)).toBe(DASH);
      expect(f(undefined)).toBe(DASH);
      expect(f(Number.NaN)).toBe(DASH);
    }
  });

  it('price decimals follow magnitude', () => {
    expect(formatPrice(104230.4)).toBe('104,230');
    expect(formatPrice(3412.55)).toBe('3,412.6');
    expect(formatPrice(72.481)).toBe('72.48');
    expect(formatPrice(0.48213)).toBe('0.4821');
  });

  it('percent is signed with a real minus', () => {
    expect(formatPct(1.234)).toBe('+1.23%');
    expect(formatPct(-0.5)).toBe('−0.50%');
    expect(formatPct(0.0001)).toBe('0.00%');
  });

  it('funding is an hourly rate', () => {
    expect(formatFunding(0.0000125)).toBe('+0.0013%/h');
  });

  it('usd, hbar, confidence, compact', () => {
    expect(formatUsd(13)).toBe('$13');
    expect(formatUsd(12.5, { cents: true })).toBe('$12.50');
    expect(formatHbar(1_000_000)).toBe('0.01 ℏ');
    expect(formatHbar(0)).toBe('0.00 ℏ');
    expect(formatConfidence(0.954)).toBe('95%');
    expect(formatConfidence(1.4)).toBe('100%');
    expect(formatCompact(1_250_000)).toBe('1.25M');
  });
});

describe('time formatters', () => {
  const now = Date.parse('2026-11-06T10:00:00Z');
  it('ages', () => {
    expect(formatAge('2026-11-06T09:59:58Z', now)).toBe('now');
    expect(formatAge('2026-11-06T09:59:18Z', now)).toBe('42s');
    expect(formatAge('2026-11-06T09:53:00Z', now)).toBe('7m');
    expect(formatAge('2026-11-06T07:00:00Z', now)).toBe('3h');
    expect(formatAge('2026-11-03T10:00:00Z', now)).toBe('3d');
    expect(formatAge('2026-11-07T10:00:00Z', now)).toBe('now');
    expect(formatAge('garbage', now)).toBe(DASH);
  });

  it('clocks in UTC and IST', () => {
    const d = new Date('2026-11-06T10:00:05Z');
    expect(formatClock(d, 'UTC')).toBe('10:00:05');
    expect(formatClock(d, 'Asia/Kolkata')).toBe('15:30:05');
  });
});

describe('labels', () => {
  it('shortens ids in the middle', () => {
    expect(shortId('0x3f2c1234567890abcdef9a1b')).toBe('0x3f2c…9a1b');
    expect(shortId('short')).toBe('short');
    expect(shortId(null)).toBe(DASH);
  });

  it('tags shock headlines like the server shock detector', () => {
    expect(shockTag('War breaks out near oil route')).toEqual({ kind: 'war', tag: 'WAR' });
    expect(shockTag('Missile strikes reported')).toEqual({ kind: 'war', tag: 'STRIKE' });
    expect(shockTag('Treasury sanctions exchange')).toEqual({ kind: 'sanction', tag: 'SANCTION' });
    expect(shockTag('Bridge hacked for $40M')).toEqual({ kind: 'hack', tag: 'HACK' });
    expect(shockTag('Stablecoin depegs')).toEqual({ kind: 'hack', tag: 'DEPEG' });
    expect(shockTag('Fed holds rates')).toBeNull();
  });

  it('signals, coins, stub ids', () => {
    expect(formatSignal('geopolitical_shock')).toBe('Geopolitical shock');
    expect(formatSignal('new_thing')).toBe('new thing');
    expect(splitCoin('xyz:GOLD')).toEqual({ ticker: 'GOLD', dex: 'xyz' });
    expect(splitCoin('BTC')).toEqual({ ticker: 'BTC', dex: '' });
    expect(isStubNewsId('rss:coindesk:fake-1')).toBe(true);
    expect(isStubNewsId('rss:coindesk:12345')).toBe(false);
    expect(seriesChangePct([100, 110])).toBeCloseTo(10);
    expect(seriesChangePct([100])).toBeNull();
  });
});

describe('pod audio wire format', () => {
  it('encodes 16 kHz mono s16le WAV with a 44-byte header', () => {
    const pcm = downsampleTo16k(new Float32Array(48000).fill(0.5), 48000);
    expect(pcm.length).toBe(16000);
    const wav = encodeWav(pcm, 16000);
    const v = new DataView(wav);
    expect(wav.byteLength).toBe(44 + 32000);
    expect(String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3))).toBe('RIFF');
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getInt16(44, true)).toBe(Math.floor(0.5 * 0x7fff));
  });
});
