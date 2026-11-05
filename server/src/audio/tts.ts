/** Output format the device plays straight into I2S. */
export const OUTPUT_SAMPLE_RATE = 16000;

export interface TextToSpeech {
  /** Returns raw PCM s16le mono at OUTPUT_SAMPLE_RATE, no header. */
  synthesize(text: string): Promise<Buffer>;
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

// TODO(tts): ElevenLabs eleven_flash_v2_5 with output_format=pcm_16000 returns raw 16 kHz PCM,
// which is exactly what the device wants (no resampling).
// Endpoint: POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=pcm_16000
// Header: xi-api-key: ELEVENLABS_API_KEY
//
// export class ElevenLabsTts implements TextToSpeech {
//   constructor(private readonly apiKey: string, private readonly voiceId: string) {}
//   async synthesize(text: string): Promise<Buffer> {
//     const url = `https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}?output_format=pcm_16000`;
//     const res = await fetch(url, {
//       method: 'POST',
//       headers: { 'xi-api-key': this.apiKey, 'content-type': 'application/json' },
//       body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5' }),
//     });
//     if (!res.ok) throw new Error(`elevenlabs ${res.status}`);
//     return Buffer.from(await res.arrayBuffer());
//   }
// }
//
// Fallback: OpenAI gpt-4o-mini-tts response_format=pcm is 24 kHz, so it needs resampling to 16 kHz.
