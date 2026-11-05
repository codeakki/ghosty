/**
 * Minimal RIFF/WAVE reader and writer for the device protocol.
 * Device → server: 44-byte WAV header + PCM s16le mono (16 kHz expected).
 * Server → device: raw PCM s16le mono 16 kHz, no header.
 */

export interface WavAudio {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Raw little-endian PCM samples, header stripped. */
  pcm: Buffer;
}

export class WavFormatError extends Error {
  override name = 'WavFormatError';
}

/** Parse a WAV buffer. Rejects anything that is not 16-bit mono PCM. */
export function parseWav(buf: Buffer): WavAudio {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new WavFormatError('not a RIFF/WAVE file');
  }

  let fmt: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | undefined;
  let pcm: Buffer | undefined;
  let offset = 12;

  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const declared = buf.readUInt32LE(offset + 4);
    const start = offset + 8;
    // ESP32 recorders that stream often write a placeholder size; clamp to what we actually got.
    const end = Math.min(start + declared, buf.length);

    if (id === 'fmt ') {
      if (end - start < 16) throw new WavFormatError('fmt chunk too short');
      fmt = {
        audioFormat: buf.readUInt16LE(start),
        channels: buf.readUInt16LE(start + 2),
        sampleRate: buf.readUInt32LE(start + 4),
        bitsPerSample: buf.readUInt16LE(start + 14),
      };
    } else if (id === 'data') {
      // A streamed recording may leave the data size at 0: treat that as "rest of the body".
      pcm = buf.subarray(start, declared === 0 ? buf.length : end);
      break;
    }
    offset = end + (declared % 2); // chunks are word-aligned
  }

  if (!fmt) throw new WavFormatError('missing fmt chunk');
  if (!pcm) throw new WavFormatError('missing data chunk');
  // 1 = PCM, 0xFFFE = WAVE_FORMAT_EXTENSIBLE (still integer PCM for 16-bit mono in practice)
  if (fmt.audioFormat !== 1 && fmt.audioFormat !== 0xfffe) {
    throw new WavFormatError(`unsupported audio format ${fmt.audioFormat}, expected PCM`);
  }
  if (fmt.bitsPerSample !== 16) throw new WavFormatError(`expected 16-bit samples, got ${fmt.bitsPerSample}-bit`);
  if (fmt.channels !== 1) throw new WavFormatError(`expected mono, got ${fmt.channels} channels`);

  return { sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: fmt.bitsPerSample, pcm };
}

/** Wrap raw PCM in a canonical 44-byte WAV header. Used by tests and by STT providers that want a file. */
export function encodeWav(pcm: Buffer, opts: { sampleRate?: number; channels?: number; bitsPerSample?: number } = {}): Buffer {
  const sampleRate = opts.sampleRate ?? 16000;
  const channels = opts.channels ?? 1;
  const bitsPerSample = opts.bitsPerSample ?? 16;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
