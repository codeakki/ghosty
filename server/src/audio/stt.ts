import type { WavAudio } from './wav.js';

export interface Transcript {
  text: string;
  /** Which provider produced it, for the episode log. */
  provider: string;
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

// TODO(stt): Groq whisper-large-v3-turbo (OpenAI-compatible, cheapest, ~$0.04/h).
// Endpoint: POST https://api.groq.com/openai/v1/audio/transcriptions (multipart: file, model)
// Package option: `openai` with baseURL https://api.groq.com/openai/v1 (not installed yet, tracked as an issue).
//
// export class GroqStt implements SpeechToText {
//   constructor(private readonly apiKey: string, private readonly model = 'whisper-large-v3-turbo') {}
//   async transcribe(audio: WavAudio): Promise<Transcript> {
//     const form = new FormData();
//     form.append('file', new Blob([encodeWav(audio.pcm, { sampleRate: audio.sampleRate })], { type: 'audio/wav' }), 'ptt.wav');
//     form.append('model', this.model);
//     const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
//       method: 'POST',
//       headers: { authorization: `Bearer ${this.apiKey}` },
//       body: form,
//     });
//     if (!res.ok) throw new Error(`groq stt ${res.status}`);
//     const json = (await res.json()) as { text: string };
//     return { text: json.text, provider: 'groq' };
//   }
// }
//
// Alternative for 0G sponsor points: 0G Compute catalogue has Whisper Large v3; whether the Router
// exposes /audio/transcriptions is UNVERIFIED (see docs/research/0g.md).
