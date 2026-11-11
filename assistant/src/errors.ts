import { synthesize, type TtsKeys } from './audio.js';

/**
 * Spoken error messages, so a software failure never sounds like broken hardware.
 * Every clip is synthesized once at startup and kept in memory: the "voice service failed"
 * message must still play when the voice service is the thing that is down.
 */

export type ErrorKind = 'stt' | 'claude' | 'tts' | 'token' | 'server';

const HARDWARE_OK = 'Your pod hardware is fine.';

export const ERROR_TEXT: Record<ErrorKind, string> = {
  stt: `Software error. My speech to text service failed, so I couldn't hear what you said. ${HARDWARE_OK}`,
  claude: `Software error. I couldn't get an answer from Claude. ${HARDWARE_OK}`,
  tts: `Software error. My voice service failed, so I can't read the answer out. ${HARDWARE_OK}`,
  token: `Software error. The pod's device token doesn't match the server. ${HARDWARE_OK}`,
  server: `Software error on the server. ${HARDWARE_OK}`,
};

export class ErrorVoice {
  private readonly clips = new Map<ErrorKind, Buffer>();

  constructor(private readonly tts: TtsKeys) {}

  /** Synthesize every clip now. Returns the kinds that failed (they are retried live later). */
  async prepare(): Promise<ErrorKind[]> {
    const failed: ErrorKind[] = [];
    await Promise.all(
      (Object.keys(ERROR_TEXT) as ErrorKind[]).map(async (kind) => {
        try {
          this.clips.set(kind, await synthesize(ERROR_TEXT[kind], this.tts));
        } catch {
          failed.push(kind);
        }
      }),
    );
    return failed;
  }

  /** The clip for this error, or null when it was never synthesized and the voice service is down now. */
  async clip(kind: ErrorKind): Promise<Buffer | null> {
    const cached = this.clips.get(kind);
    if (cached) return cached;
    try {
      const pcm = await synthesize(ERROR_TEXT[kind], this.tts);
      this.clips.set(kind, pcm);
      return pcm;
    } catch {
      return null;
    }
  }
}
