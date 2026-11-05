import type { Config } from '../config.js';
import { resamplePcm16 } from './resample.js';

/** Output format the device plays straight into I2S. */
export const OUTPUT_SAMPLE_RATE = 16000;

export interface TextToSpeech {
  /** Returns raw PCM s16le mono at OUTPUT_SAMPLE_RATE, no header. */
  synthesize(text: string): Promise<Buffer>;
}

export class TtsError extends Error {
  override name = 'TtsError';
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/**
 * Fake TTS: ignores the text and returns a sine tone so the device audibly works day one.
 * Default 0.5 s at 440 Hz → 8000 samples → 16000 bytes.
 */
export class ToneTts implements TextToSpeech {
  constructor(
    private readonly frequencyHz = 440,
    private readonly durationSec = 0.5,
    private readonly amplitude = 0.3,
  ) {}

  async synthesize(_text: string): Promise<Buffer> {
    return sineTone(this.frequencyHz, this.durationSec, this.amplitude);
  }
}

/** Generate a sine tone as s16le PCM with a 10 ms fade in/out to avoid speaker clicks. */
export function sineTone(frequencyHz: number, durationSec: number, amplitude = 0.3, sampleRate = OUTPUT_SAMPLE_RATE): Buffer {
  const samples = Math.round(durationSec * sampleRate);
  const fade = Math.min(Math.round(0.01 * sampleRate), Math.floor(samples / 2));
  const out = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    let gain = amplitude;
    if (i < fade) gain *= i / fade;
    else if (i >= samples - fade) gain *= (samples - 1 - i) / fade;
    const v = Math.round(Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate) * gain * 32767);
    out.writeInt16LE(v, i * 2);
  }
  return out;
}

/** Drop a trailing odd byte so the buffer is whole 16-bit samples. */
function wholeSamples(buf: Buffer): Buffer {
  return buf.length % 2 === 0 ? buf : buf.subarray(0, buf.length - 1);
}

async function readBody(res: Response): Promise<Buffer> {
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const chunks: Buffer[] = [];
  for await (const chunk of res.body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function failure(provider: string, res: Response): Promise<TtsError> {
  const detail = (await res.text().catch(() => '')).slice(0, 200);
  return new TtsError(`${provider} tts ${res.status}: ${detail}`, res.status);
}

export const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io/v1';
/** "George", the voice id used in the ElevenLabs API reference examples. */
export const ELEVENLABS_DEFAULT_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb';
export const ELEVENLABS_DEFAULT_MODEL = 'eleven_flash_v2_5';
export const TTS_TIMEOUT_MS = 20_000;

export interface ElevenLabsTtsOptions {
  apiKey: string;
  voiceId?: string;
  modelId?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * ElevenLabs streaming TTS: POST /v1/text-to-speech/{voice_id}/stream?output_format=pcm_16000.
 * pcm_16000 is raw s16le mono at 16 kHz, exactly the device format, so no resampling.
 */
export class ElevenLabsTts implements TextToSpeech {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ElevenLabsTtsOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async synthesize(text: string): Promise<Buffer> {
    const voiceId = encodeURIComponent(this.opts.voiceId ?? ELEVENLABS_DEFAULT_VOICE_ID);
    const url = `${this.opts.baseUrl ?? ELEVENLABS_BASE_URL}/text-to-speech/${voiceId}/stream?output_format=pcm_${OUTPUT_SAMPLE_RATE}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'xi-api-key': this.opts.apiKey, 'content-type': 'application/json', accept: 'audio/pcm' },
        body: JSON.stringify({ text, model_id: this.opts.modelId ?? ELEVENLABS_DEFAULT_MODEL }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? TTS_TIMEOUT_MS),
      });
    } catch (err) {
      throw new TtsError(`elevenlabs tts request failed: ${(err as Error).message}`);
    }
    if (!res.ok) throw await failure('elevenlabs', res);
    return wholeSamples(await readBody(res));
  }
}

export const OPENAI_SPEECH_URL = 'https://api.openai.com/v1/audio/speech';
export const OPENAI_TTS_MODEL = 'gpt-4o-mini-tts';
export const OPENAI_TTS_VOICE = 'marin';
/** OpenAI documents response_format=pcm as 24 kHz, 16-bit signed little-endian, mono, no header. */
export const OPENAI_PCM_SAMPLE_RATE = 24000;

export interface OpenAiTtsOptions {
  apiKey: string;
  model?: string;
  voice?: string;
  url?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Fallback TTS: OpenAI /v1/audio/speech pcm (24 kHz) resampled to 16 kHz. */
export class OpenAiTts implements TextToSpeech {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: OpenAiTtsOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async synthesize(text: string): Promise<Buffer> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.opts.url ?? OPENAI_SPEECH_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.opts.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.opts.model ?? OPENAI_TTS_MODEL,
          voice: this.opts.voice ?? OPENAI_TTS_VOICE,
          input: text,
          response_format: 'pcm',
        }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? TTS_TIMEOUT_MS),
      });
    } catch (err) {
      throw new TtsError(`openai tts request failed: ${(err as Error).message}`);
    }
    if (!res.ok) throw await failure('openai', res);
    return resamplePcm16(await readBody(res), OPENAI_PCM_SAMPLE_RATE, OUTPUT_SAMPLE_RATE);
  }
}

/** ElevenLabs when ELEVENLABS_API_KEY is set, else OpenAI when OPENAI_API_KEY is set, else the tone fake. */
export function createTts(
  config: Pick<Config, 'ELEVENLABS_API_KEY' | 'ELEVENLABS_VOICE_ID' | 'ELEVENLABS_MODEL_ID' | 'OPENAI_API_KEY'>,
): TextToSpeech {
  if (config.ELEVENLABS_API_KEY) {
    return new ElevenLabsTts({
      apiKey: config.ELEVENLABS_API_KEY,
      voiceId: config.ELEVENLABS_VOICE_ID,
      modelId: config.ELEVENLABS_MODEL_ID,
    });
  }
  if (config.OPENAI_API_KEY) return new OpenAiTts({ apiKey: config.OPENAI_API_KEY });
  return new ToneTts();
}
