import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodeWav, parseWav, WavFormatError } from '../src/audio/wav.js';

describe('parseWav', () => {
  it('parses 16-bit mono PCM and strips the header', () => {
    const pcm = Buffer.alloc(3200, 1);
    const wav = parseWav(encodeWav(pcm));
    assert.equal(wav.sampleRate, 16000);
    assert.equal(wav.channels, 1);
    assert.equal(wav.bitsPerSample, 16);
    assert.equal(wav.pcm.length, 3200);
  });

  it('rejects stereo and non-16-bit audio', () => {
    assert.throws(() => parseWav(encodeWav(Buffer.alloc(64), { channels: 2 })), /mono/);
    assert.throws(() => parseWav(encodeWav(Buffer.alloc(64), { bitsPerSample: 8 })), /16-bit/);
    assert.throws(() => parseWav(encodeWav(Buffer.alloc(64), { bitsPerSample: 32 })), WavFormatError);
  });

  it('rejects non-WAV input', () => {
    assert.throws(() => parseWav(Buffer.from('hello world, not a wav file')), WavFormatError);
    assert.throws(() => parseWav(Buffer.alloc(4)), WavFormatError);
  });

  it('treats a streamed data size of 0 as the rest of the body', () => {
    const buf = encodeWav(Buffer.alloc(320, 7));
    buf.writeUInt32LE(0, 40);
    assert.equal(parseWav(buf).pcm.length, 320);
  });
});
