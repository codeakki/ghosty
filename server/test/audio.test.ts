import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resamplePcm16 } from '../src/audio/resample.js';
import { createStt, FakeStt, GroqStt, SttError } from '../src/audio/stt.js';
import type { TtsError } from '../src/audio/tts.js';
import { createTts, ElevenLabsTts, OpenAiTts, ToneTts } from '../src/audio/tts.js';
import { encodeWav, parseWav } from '../src/audio/wav.js';

interface Call {
  url: string;
  init: RequestInit;
}

/** A fetch stub that records calls and replies with `respond(call)`. */
function mockFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(input), init };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fn, calls };
}

const pcm16 = (samples: number[]) => {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => b.writeInt16LE(s, i * 2));
  return b;
};
const samplesOf = (b: Buffer) => Array.from({ length: b.length / 2 }, (_, i) => b.readInt16LE(i * 2));

describe('resamplePcm16', () => {
  it('24 kHz → 16 kHz keeps duration: 2400 samples become 1600', () => {
    const out = resamplePcm16(Buffer.alloc(2400 * 2), 24000, 16000);
    assert.equal(out.length, 1600 * 2);
  });

  it('interpolates linearly between neighbours', () => {
    // step = 1.5: out[i] = in at position 0, 1.5, 3, 4.5
    const out = resamplePcm16(pcm16([0, 100, 200, 300, 400, 500]), 24000, 16000);
    assert.deepEqual(samplesOf(out), [0, 150, 300, 450]);
  });

  it('upsamples and clamps at the last sample', () => {
    const out = resamplePcm16(pcm16([0, 1000]), 8000, 16000);
    assert.deepEqual(samplesOf(out), [0, 500, 1000, 1000]);
  });

  it('same rate copies, empty stays empty, odd trailing byte is dropped', () => {
    assert.deepEqual(samplesOf(resamplePcm16(pcm16([1, -2, 3]), 16000, 16000)), [1, -2, 3]);
    assert.equal(resamplePcm16(Buffer.alloc(0), 24000, 16000).length, 0);
    assert.equal(resamplePcm16(Buffer.alloc(5), 16000, 16000).length, 4);
    assert.throws(() => resamplePcm16(Buffer.alloc(4), 0, 16000), RangeError);
  });
});

describe('GroqStt', () => {
  const audio = parseWav(encodeWav(Buffer.alloc(16000 * 2, 3))); // 1 s of 16 kHz

  it('posts a multipart WAV with model + verbose_json and parses text/language/duration', async () => {
    const { fn, calls } = mockFetch(() =>
      Response.json({ text: '  Ghosty, buy gold. ', language: 'English', duration: 1.25 }),
    );
    const stt = new GroqStt({ apiKey: 'gsk_test', fetch: fn });
    const t = await stt.transcribe(audio);

    assert.deepEqual(t, { text: 'Ghosty, buy gold.', provider: 'groq:whisper-large-v3-turbo', language: 'English', durationMs: 1250 });
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.url, 'https://api.groq.com/openai/v1/audio/transcriptions');
    assert.equal(call.init.method, 'POST');
    assert.equal((call.init.headers as Record<string, string>).authorization, 'Bearer gsk_test');
    assert.ok(call.init.signal, 'request has a timeout signal');

    const form = call.init.body as FormData;
    assert.ok(form instanceof FormData);
    assert.equal(form.get('model'), 'whisper-large-v3-turbo');
    assert.equal(form.get('response_format'), 'verbose_json');
    const file = form.get('file') as File;
    assert.equal(file.name, 'ptt.wav');
    assert.equal(file.type, 'audio/wav');
    const wav = Buffer.from(await file.arrayBuffer());
    assert.equal(wav.length, 44 + 32000);
    assert.equal(parseWav(wav).sampleRate, 16000);
  });

  it('falls back to the PCM duration and honours a custom model', async () => {
    const { fn, calls } = mockFetch(() => Response.json({ text: 'hi' }));
    const t = await new GroqStt({ apiKey: 'k', model: 'whisper-large-v3', fetch: fn }).transcribe(audio);
    assert.equal(t.durationMs, 1000);
    assert.equal(t.language, undefined);
    assert.equal((calls[0]!.init.body as FormData).get('model'), 'whisper-large-v3');
  });

  it('throws SttError with the status on HTTP errors and on network errors', async () => {
    const { fn } = mockFetch(() => new Response('{"error":"bad key"}', { status: 401 }));
    await assert.rejects(new GroqStt({ apiKey: 'k', fetch: fn }).transcribe(audio), (e: SttError) => e.status === 401);
    const boom = (async () => {
      throw new Error('ECONNRESET');
    }) as typeof fetch;
    await assert.rejects(new GroqStt({ apiKey: 'k', fetch: boom }).transcribe(audio), SttError);
  });

  it('createStt picks Groq only when GROQ_API_KEY is set', () => {
    assert.ok(createStt({ GROQ_API_KEY: undefined, GROQ_STT_MODEL: 'x' }) instanceof FakeStt);
    assert.ok(createStt({ GROQ_API_KEY: 'k', GROQ_STT_MODEL: 'x' }) instanceof GroqStt);
  });
});

describe('ElevenLabsTts', () => {
  it('streams pcm_16000 from the voice endpoint and returns whole s16le samples', async () => {
    const pcm = Buffer.alloc(3201, 1); // odd length from a cut stream: last byte dropped
    const { fn, calls } = mockFetch(() => new Response(new Uint8Array(pcm), { headers: { 'content-type': 'audio/pcm' } }));
    const out = await new ElevenLabsTts({ apiKey: 'xi_test', fetch: fn }).synthesize('Geopolitical shock detected.');

    assert.equal(out.length, 3200);
    const call = calls[0]!;
    assert.equal(
      call.url,
      'https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/stream?output_format=pcm_16000',
    );
    assert.equal((call.init.headers as Record<string, string>)['xi-api-key'], 'xi_test');
    assert.deepEqual(JSON.parse(call.init.body as string), { text: 'Geopolitical shock detected.', model_id: 'eleven_flash_v2_5' });
  });

  it('throws TtsError on 4xx', async () => {
    const { fn } = mockFetch(() => new Response('quota', { status: 429 }));
    await assert.rejects(new ElevenLabsTts({ apiKey: 'k', fetch: fn }).synthesize('x'), (e: TtsError) => e.status === 429);
  });
});

describe('OpenAiTts', () => {
  it('requests pcm and resamples 24 kHz to 16 kHz', async () => {
    const { fn, calls } = mockFetch(() => new Response(new Uint8Array(Buffer.alloc(24000 * 2))));
    const out = await new OpenAiTts({ apiKey: 'sk', fetch: fn }).synthesize('hello');
    assert.equal(out.length, 16000 * 2);
    const body = JSON.parse(calls[0]!.init.body as string);
    assert.equal(body.response_format, 'pcm');
    assert.equal(body.model, 'gpt-4o-mini-tts');
    assert.equal(calls[0]!.url, 'https://api.openai.com/v1/audio/speech');
  });
});

describe('createTts', () => {
  const base = { ELEVENLABS_VOICE_ID: 'v', ELEVENLABS_MODEL_ID: 'm' };
  it('prefers ElevenLabs, then OpenAI, then the tone fake', () => {
    assert.ok(createTts({ ...base, ELEVENLABS_API_KEY: 'a', OPENAI_API_KEY: 'b' }) instanceof ElevenLabsTts);
    assert.ok(createTts({ ...base, ELEVENLABS_API_KEY: undefined, OPENAI_API_KEY: 'b' }) instanceof OpenAiTts);
    assert.ok(createTts({ ...base, ELEVENLABS_API_KEY: undefined, OPENAI_API_KEY: undefined }) instanceof ToneTts);
  });
});
