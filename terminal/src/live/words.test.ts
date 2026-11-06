import { describe, expect, it } from 'vitest';
import { assetDecimals, formatAssetPx, formatSignedPct } from './words';

/** Digits only (locale-independent): the digit count pins the precision. */
const digits = (s: string) => s.replace(/\D/g, '');

describe('per-asset price precision', () => {
  it('uses the fixed precision map', () => {
    expect(assetDecimals('BTC')).toBe(0);
    expect(assetDecimals('ETH')).toBe(2);
    expect(assetDecimals('SOL')).toBe(2);
    expect(assetDecimals('xyz:GOLD')).toBe(1);
    expect(assetDecimals('xyz:CL')).toBe(2);
    expect(assetDecimals('xyz:SP500')).toBe(1);
    expect(assetDecimals('xyz:TSLA')).toBe(2);
    expect(assetDecimals('xyz:NVDA')).toBe(2);
  });

  it('defaults to 2 dp for anything else, whatever its size', () => {
    expect(assetDecimals('DOGE')).toBe(2);
    expect(assetDecimals('xyz:UNKNOWN')).toBe(2);
  });

  it('formats with exactly that many decimals, so prices never change width', () => {
    expect(digits(formatAssetPx('BTC', 76148.42))).toBe('76148');
    expect(digits(formatAssetPx('ETH', 2238.9))).toBe('223890');
    expect(digits(formatAssetPx('xyz:GOLD', 4067.54))).toBe('40675');
    expect(digits(formatAssetPx('xyz:SP500', 7373.66))).toBe('73737');
    expect(digits(formatAssetPx('xyz:CL', 61.5))).toBe('6150');
    expect(digits(formatAssetPx('DOGE', 0.41234))).toBe('041');
  });

  it('signs percentages with a real minus', () => {
    expect(formatSignedPct(0.5)).toBe('+0.50%');
    expect(formatSignedPct(-0.31)).toBe('−0.31%');
  });
});
