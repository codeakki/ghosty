/**
 * Pod audio: WAV in (16-bit mono, 16 kHz), raw PCM s16le mono 16 kHz out.
 * Speech to text: Groq Whisper. Text to speech: ElevenLabs, else OpenAI.
 */

export const OUTPUT_SAMPLE_RATE = 16000;

export interface WavAudio {
  sampleRate: number;
  pcm: Buffer;
}

/** Parse the pod's WAV. Accepts a streamed header whose sizes are wrong or zero. */
export function parseWav(buf: Buffer): WavAudio {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const declared = buf.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = Math.min(start + declared, buf.length);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(start + 2);
      sampleRate = buf.readUInt32LE(start + 4);
      bits = buf.readUInt16LE(start + 14);
    } else if (id === 'data') {
      if (bits !== 16 || channels !== 1) throw new Error(`expected 16-bit mono, got ${bits}-bit ${channels}ch`);
      return { sampleRate, pcm: buf.subarray(start, declared === 0 ? buf.length : end) };
    }
    offset = end + (declared % 2);
  }
  throw new Error('missing data chunk');
}

export function encodeWav(pcm: Buffer, sampleRate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Linear resampler for s16le mono. Fine for speech on a small speaker. */
export function resamplePcm16(pcm: Buffer, fromRate: number, toRate: number): Buffer {
  const n = Math.floor(pcm.length / 2);
  if (fromRate === toRate || n === 0) return Buffer.from(pcm.subarray(0, n * 2));
  const outN = Math.max(1, Math.round((n * toRate) / fromRate));
  const out = Buffer.alloc(outN * 2);
  const step = fromRate / toRate;
  for (let i = 0; i < outN; i++) {
    const pos = i * step;
    const i0 = Math.min(Math.floor(pos), n - 1);
    const i1 = Math.min(i0 + 1, n - 1);
    const a = pcm.readInt16LE(i0 * 2);
    const b = pcm.readInt16LE(i1 * 2);
    out.writeInt16LE(Math.round(a + (b - a) * (pos - Math.floor(pos))), i * 2);
  }
  return out;
}

// "Ghosty" plus what Whisper often writes instead, in Latin and Devanagari script.
const WAKE_WORD = /\b(gh?o(?:a)?sh?t(?:y|ie|ee|i)|ghost[- ]?e|ghostly)\b/i;
const WAKE_WORD_DEVANAGARI = /[गघ]ो[सश]्?टी/;
export const hasWakeWord = (text: string) => WAKE_WORD.test(text) || WAKE_WORD_DEVANAGARI.test(text);

/** True when the utterance is only the wake word ("Ghosty", "Ghosty?", "Hey Ghosty."). */
export function isOnlyWakeWord(text: string): boolean {
  const rest = text
    .replace(WAKE_WORD, '')
    .replace(WAKE_WORD_DEVANAGARI, '')
    .replace(/\b(hey|hi|hello|ok|okay)\b/gi, '')
    .replace(/[\s\p{P}]+/gu, '');
  return hasWakeWord(text) && rest.length === 0;
}

async function readError(provider: string, res: Response): Promise<Error> {
  const detail = (await res.text().catch(() => '')).slice(0, 200);
  return new Error(`${provider} ${res.status}: ${detail}`);
}

/** One retry on a network failure (connect timeout, reset): a Wi-Fi hiccup should not cost the turn. */
/** `language`: ISO-639-1 hint ("en"), or undefined to let Whisper guess (it guesses wrong on short clips). */
export async function transcribe(audio: WavAudio, groqKey: string, language?: string): Promise<string> {
  try {
    return await transcribeOnce(audio, groqKey, language);
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;  // fetch throws TypeError for network errors only
    return transcribeOnce(audio, groqKey, language);
  }
}

async function transcribeOnce(audio: WavAudio, groqKey: string, language?: string): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(encodeWav(audio.pcm, audio.sampleRate))], { type: 'audio/wav' }), 'pod.wav');
  form.append('model', 'whisper-large-v3-turbo');
  form.append('response_format', 'json');
  form.append('temperature', '0');
  // Spelling hint: without it Whisper writes the wake word as "Goshty".
  form.append('prompt', 'Ghosty');
  if (language) form.append('language', language);
  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${groqKey}` },
    body: form,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw await readError('groq stt', res);
  const json = (await res.json()) as { text?: string };
  return (json.text ?? '').trim();
}

export interface TtsKeys {
  elevenLabsKey?: string;
  elevenLabsVoiceId?: string;
  openAiKey?: string;
}

/** Text to raw PCM s16le mono 16 kHz, the format the pod plays straight into I2S. */
export async function synthesize(text: string, keys: TtsKeys): Promise<Buffer> {
  if (keys.elevenLabsKey) {
    const voice = encodeURIComponent(keys.elevenLabsVoiceId || 'JBFqnCBsd6RMkjVDRZzb');
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}/stream?output_format=pcm_16000`, {
      method: 'POST',
      headers: { 'xi-api-key': keys.elevenLabsKey, 'content-type': 'application/json', accept: 'audio/pcm' },
      body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5' }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) throw await readError('elevenlabs tts', res);
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.subarray(0, buf.length - (buf.length % 2));
  }
  if (keys.openAiKey) {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { authorization: `Bearer ${keys.openAiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'marin', input: text, response_format: 'pcm' }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) throw await readError('openai tts', res);
    // OpenAI pcm is 24 kHz.
    return resamplePcm16(Buffer.from(await res.arrayBuffer()), 24000, OUTPUT_SAMPLE_RATE);
  }
  throw new Error('no text-to-speech key: set ELEVENLABS_API_KEY or OPENAI_API_KEY');
}
