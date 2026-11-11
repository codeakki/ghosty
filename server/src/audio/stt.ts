import type { Config } from '../config.js';
import { isTestMode } from '../mode.js';
import { NotConfiguredStt } from '../notConfigured.js';
import { encodeWav, type WavAudio } from './wav.js';

export interface Transcript {
  text: string;
  /** Which provider produced it, for the episode log. */
  provider: string;
  /** Detected language as the provider reports it (Groq verbose_json gives e.g. "English"). */
  language?: string;
  /** Audio duration in ms: provider-reported when available, else computed from the PCM length. */
  durationMs?: number;
}

export interface SpeechToText {
  transcribe(audio: WavAudio): Promise<Transcript>;
}

/** Deterministic fake: ignores the audio and returns a fixed push-to-talk question. */
export class FakeStt implements SpeechToText {
  constructor(private readonly text = 'Ghosty, what is moving the market right now?') {}

  async transcribe(_audio: WavAudio): Promise<Transcript> {
    return { text: this.text, provider: 'fake' };
  }
}

export const GROQ_STT_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
export const GROQ_DEFAULT_MODEL = 'whisper-large-v3-turbo';
export const STT_TIMEOUT_MS = 15_000;

export class SttError extends Error {
  override name = 'SttError';
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface GroqSttOptions {
  apiKey: string;
  model?: string;
  url?: string;
  timeoutMs?: number;
  /** ISO-639-1 hint; Groq says it improves accuracy and latency. Omit to auto-detect. */
  language?: string;
  fetch?: typeof fetch;
}

function pcmDurationMs(audio: WavAudio): number {
  const bytesPerSecond = audio.sampleRate * audio.channels * (audio.bitsPerSample / 8);
  return bytesPerSecond > 0 ? Math.round((audio.pcm.length / bytesPerSecond) * 1000) : 0;
}

/**
 * Groq Whisper over the OpenAI-compatible endpoint. Multipart: file (WAV), model, response_format.
 * Docs: https://console.groq.com/docs/speech-to-text (25 MB direct-upload cap on the free tier).
 */
export class GroqStt implements SpeechToText {
  private readonly model: string;
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: GroqSttOptions) {
    this.model = opts.model ?? GROQ_DEFAULT_MODEL;
    this.url = opts.url ?? GROQ_STT_URL;
    this.timeoutMs = opts.timeoutMs ?? STT_TIMEOUT_MS;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async transcribe(audio: WavAudio): Promise<Transcript> {
    const wav = encodeWav(audio.pcm, {
      sampleRate: audio.sampleRate,
      channels: audio.channels,
      bitsPerSample: audio.bitsPerSample,
    });
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'ptt.wav');
    form.append('model', this.model);
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0');
    // Spelling hint: without it Whisper writes the wake word as "Goshty" or in Devanagari.
    form.append('prompt', 'Ghosty');
    if (this.opts.language) form.append('language', this.opts.language);

    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.opts.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new SttError(`groq stt request failed: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new SttError(`groq stt ${res.status}: ${detail}`, res.status);
    }
    const json = (await res.json()) as { text?: unknown; language?: unknown; duration?: unknown };
    if (typeof json.text !== 'string') throw new SttError('groq stt: response has no text');
    return {
      text: json.text.trim(),
      provider: `groq:${this.model}`,
      language: typeof json.language === 'string' ? json.language : undefined,
      durationMs: typeof json.duration === 'number' ? Math.round(json.duration * 1000) : pcmDurationMs(audio),
    };
  }
}

// TODO(stt/0g): ZeroGStt via the 0G Compute Router (Whisper Large v3 is in the 0G catalogue).
// Whether the Router exposes /audio/transcriptions is UNVERIFIED and owned by the 0G branch.
// If it does, it is the same multipart call as GroqStt pointed at OG_ROUTER_URL with OG_API_KEY:
//
// export class ZeroGStt extends GroqStt {
//   constructor(routerUrl: string, apiKey: string) {
//     super({ apiKey, url: `${routerUrl}/audio/transcriptions`, model: 'whisper-large-v3' });
//   }
// }

/** Real Groq STT when GROQ_API_KEY is set; otherwise the fake in test mode, NotConfiguredStt in live mode. */
export function createStt(config: Pick<Config, 'GROQ_API_KEY' | 'GROQ_STT_MODEL'> & Partial<Pick<Config, 'GHOSTY_MODE' | 'STT_LANGUAGE'>>): SpeechToText {
  if (config.GROQ_API_KEY)
    return new GroqStt({ apiKey: config.GROQ_API_KEY, model: config.GROQ_STT_MODEL, ...(config.STT_LANGUAGE ? { language: config.STT_LANGUAGE } : {}) });
  return isTestMode(config) ? new FakeStt() : new NotConfiguredStt();
}
