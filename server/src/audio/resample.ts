/**
 * Linear resampler for s16le mono PCM. Good enough for speech going to a small speaker
 * (e.g. OpenAI TTS 24 kHz → device 16 kHz). No anti-alias filter: downsampling 24k → 16k
 * folds 8–12 kHz content back, which TTS voices barely have.
 */
export function resamplePcm16(pcm: Buffer, fromRate: number, toRate: number): Buffer {
  if (!Number.isFinite(fromRate) || !Number.isFinite(toRate) || fromRate <= 0 || toRate <= 0) {
    throw new RangeError(`invalid sample rates ${fromRate} -> ${toRate}`);
  }
  const inSamples = Math.floor(pcm.length / 2);
  if (fromRate === toRate) return Buffer.from(pcm.subarray(0, inSamples * 2));
  if (inSamples === 0) return Buffer.alloc(0);

  const outSamples = Math.max(1, Math.round((inSamples * toRate) / fromRate));
  const out = Buffer.alloc(outSamples * 2);
  const step = fromRate / toRate;
  for (let i = 0; i < outSamples; i++) {
    const pos = i * step;
    const i0 = Math.min(Math.floor(pos), inSamples - 1);
    const i1 = Math.min(i0 + 1, inSamples - 1);
    const frac = pos - Math.floor(pos);
    const a = pcm.readInt16LE(i0 * 2);
    const b = pcm.readInt16LE(i1 * 2);
    const v = Math.round(a + (b - a) * frac);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2);
  }
  return out;
}
