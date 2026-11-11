import { useCallback, useEffect, useReducer, useRef } from 'react';
import { describeError } from '../../api/client';
import type { ApiFailure, ProviderStatus } from '../../api/types';
import { base64ToArrayBuffer, chime, MAX_RECORD_MS, MicRecorder, playPcmMetered, readLevel } from '../../lib/audio';
import type { LiveApi } from '../useLive';
import { deviceReducer, initialDevice, type DeviceState } from './machine';

/** A press shorter than this during an alert is a tap (= confirm); longer is hold-to-talk. */
export const TAP_MS = 350;
const ALERT_POLL_MS = 10_000;

export type LevelSource = (() => number) | null;

export interface VoiceReadiness {
  ready: boolean | null;
  missingEnv: string[];
}

/** Voice needs STT (Groq) and TTS (ElevenLabs, or the OpenAI fallback). Null while provider status is unknown. */
export function voiceReadiness(providers: ProviderStatus[] | null | undefined): VoiceReadiness {
  if (!providers) return { ready: null, missingEnv: [] };
  const byId = new Map(providers.map((p) => [p.id, p]));
  const stt = byId.get('groq');
  const tts = byId.get('elevenlabs');
  const ttsFallback = byId.get('openai-tts');
  if (!stt && !tts) return { ready: null, missingEnv: [] };
  const sttOk = stt?.state === 'live' || stt?.state === 'degraded';
  const ttsOk = tts?.state === 'live' || tts?.state === 'degraded' || ttsFallback?.state === 'live';
  const missingEnv = [...(sttOk ? [] : (stt?.missingEnv ?? [])), ...(ttsOk ? [] : (tts?.missingEnv ?? []))];
  return { ready: sttOk && ttsOk, missingEnv };
}

/** Plain words for a failed turn. Env var names stay out of primary text (the feed's Setup notice lists them). */
function failureNote(r: ApiFailure, what: 'voice' | 'text' | 'button'): NonNullable<DeviceState['note']> {
  if (r.kind === 'not_configured') {
    const voice = r.provider === 'groq' || r.provider === 'elevenlabs' || r.missingEnv?.some((e) => /GROQ|ELEVENLABS/.test(e));
    if (what === 'voice' && voice) return { tone: 'warn', text: 'Voice isn’t set up on the server yet — type instead.' };
    return { tone: 'warn', text: 'Ghosty can’t decide yet — the server isn’t fully set up. See Setup in the feed.' };
  }
  if (r.kind === 'brain_offline') return { tone: 'warn', text: 'The 0G brain is unreachable, so Ghosty is paused.' };
  if (r.kind === 'unauthorized') {
    if (r.code === 'guest_expired') return { tone: 'info', text: 'Your guest pass expired. Get a new one in Settings.' };
    return { tone: 'warn', text: 'This device isn’t allowed yet: add your device token or try Ghosty as a guest.' };
  }
  // Guest limits and refusals are calm information, not errors.
  if (r.kind === 'guest') return { tone: 'info', text: describeError(r) };
  return { tone: 'warn', text: describeError(r) };
}

/** Button outcomes come back as sentences; keep env var names out of them. */
function plainOutcome(message: string): string {
  return /[A-Z0-9]{2,}_[A-Z0-9_]+/.test(message) ? 'Trading isn’t set up on the server yet.' : message;
}

function vibrate(pattern: number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // Not supported (desktop, iOS): the orb and chime still signal the alert.
  }
}

/** Read text the server sent, with the browser's own voice. Only for server text that came without audio. */
function speakLocally(text: string, onEnd: () => void): boolean {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
  if (!synth || !text) return false;
  try {
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.02;
    u.onend = onEnd;
    u.onerror = onEnd;
    synth.speak(u);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs the pod: mic → /voice → playback, text turns, alerts (SSE + /alerts/next), confirm/cancel.
 * State transitions live in machine.ts; this hook only does the side effects and feeds results back.
 */
export function useDevice(api: LiveApi) {
  const { state, client, actions, live } = api;
  const [device, send] = useReducer(deviceReducer, initialDevice);
  const recorder = useRef<MicRecorder | null>(null);
  const levelRef = useRef<LevelSource>(null);
  const stopPlayback = useRef<(() => void) | null>(null);
  const pressAt = useRef<number | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const maxTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const deviceRef = useRef(device);
  const lastDecisionRef = useRef(state.snapshot?.lastDecision ?? null);
  const [localSpeech, setLocalSpeech] = useReducer((_: boolean, v: boolean) => v, false);

  useEffect(() => {
    deviceRef.current = device;
  }, [device]);
  useEffect(() => {
    lastDecisionRef.current = state.snapshot?.lastDecision ?? null;
  }, [state.snapshot?.lastDecision]);

  // ---- Offline: server gone or safe-stop (0G brain unreachable) -----------------------------------------
  const safeStop = state.snapshot?.safeStop === true || state.health?.safeStop === true;
  const offline = state.serverReachable === false || safeStop;
  useEffect(() => {
    send({ type: 'OFFLINE', offline });
  }, [offline]);

  // ---- Alerts: SSE (via the terminal banner) ----------------------------------------------------------------
  const banner = state.banner;
  useEffect(() => {
    if (banner && banner.status !== 'acked') send({ type: 'ALERT', alert: banner });
  }, [banner]);
  // Acked elsewhere (another tab, the physical pod): drop it here too.
  const alerts = state.snapshot?.alerts;
  useEffect(() => {
    const current = deviceRef.current.alert;
    if (!current || !alerts) return;
    const server = alerts.find((a) => a.id === current.id);
    if (server?.status === 'acked') send({ type: 'ALERT_CLEARED', id: current.id });
  }, [alerts]);

  // ---- Alerts: GET /alerts/next once on open, then as a backup while the event stream is down -------------
  const connection = state.connection;
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      if (deviceRef.current.alert) return;
      const r = await client.alertsNext();
      if (alive && r.ok && r.data.alert) send({ type: 'ALERT', alert: r.data.alert });
    };
    void poll();
    if (connection === 'open') return () => {
      alive = false;
    };
    const t = setInterval(poll, ALERT_POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [client, connection]);

  // ---- Announce a new alert once: chime, buzz, read it out ---------------------------------------------------
  useEffect(() => {
    const a = device.alert;
    if (device.mode !== 'alert' || !a || device.announced === a.id) return;
    send({ type: 'ANNOUNCED', id: a.id });
    chime();
    vibrate([60, 80, 60]);
    // Alerts carry text only; the browser reads the server's words (a local fallback, labelled in the UI).
    const t = setTimeout(() => {
      if (speakLocally(a.text, () => setLocalSpeech(false))) setLocalSpeech(true);
    }, 700);
    return () => clearTimeout(t);
  }, [device.mode, device.alert, device.announced]);

  // ---- Playback --------------------------------------------------------------------------------------------
  const play = useCallback((pcm: ArrayBuffer, rate: number) => {
    const p = playPcmMetered(pcm, rate);
    stopPlayback.current = p.stop;
    if (p.analyser) {
      const buf = new Float32Array(p.analyser.fftSize);
      const an = p.analyser;
      levelRef.current = () => readLevel(an, buf);
    }
    void p.done.then(() => {
      levelRef.current = null;
      stopPlayback.current = null;
      send({ type: 'SPEECH_END' });
    });
  }, []);

  // ---- Voice turn ------------------------------------------------------------------------------------------
  const finishRecording = useCallback(async () => {
    clearTimeout(maxTimer.current);
    const rec = recorder.current;
    recorder.current = null;
    levelRef.current = null;
    const wav = rec?.stop() ?? null;
    send({ type: 'RELEASE', hasAudio: wav !== null });
    if (!wav) return;
    const r = await live.voice(wav);
    if (!r.ok) {
      send({ type: 'FAIL', note: failureNote(r, 'voice') });
      return;
    }
    const d = lastDecisionRef.current;
    const caption = d && d.requestId === r.data.requestId ? d.rationale : null;
    send({ type: 'REPLY', caption, hasAudio: r.data.pcm.byteLength > 0 });
    if (r.data.pcm.byteLength > 0) play(r.data.pcm, r.data.sampleRate);
  }, [live, play]);

  const startRecording = useCallback(async () => {
    if (!MicRecorder.supported()) {
      send({ type: 'PRESS' });
      send({ type: 'FAIL', note: { tone: 'warn', text: 'This browser has no microphone access. Type instead.' } });
      return;
    }
    window.speechSynthesis?.cancel();
    send({ type: 'PRESS' });
    const rec = new MicRecorder();
    recorder.current = rec;
    try {
      await rec.start();
    } catch {
      recorder.current = null;
      send({ type: 'FAIL', note: { tone: 'warn', text: 'Microphone blocked. Allow it in the address bar, or type instead.' } });
      return;
    }
    if (rec.analyser) {
      const an = rec.analyser;
      const buf = new Float32Array(an.fftSize);
      levelRef.current = () => readLevel(an, buf);
    }
    // The pod caps a turn at 10 s; so does this one.
    maxTimer.current = setTimeout(() => void finishRecording(), MAX_RECORD_MS);
  }, [finishRecording]);

  // ---- Confirm / cancel ------------------------------------------------------------------------------------
  const decide = useCallback(
    async (action: 'confirm' | 'cancel') => {
      const a = deviceRef.current.alert;
      if (!a) return;
      window.speechSynthesis?.cancel();
      send({ type: action === 'confirm' ? 'CONFIRM' : 'CANCEL' });
      const outcome = await actions.pressButton(action);
      // The alert is answered either way: ack it so the pod queue moves on.
      void actions.ackAlert(a.id);
      send({
        type: 'BUTTON_DONE',
        caption: null,
        note: outcome.ok ? { tone: 'info', text: outcome.message } : { tone: 'warn', text: plainOutcome(outcome.message) },
      });
    },
    [actions],
  );

  // ---- The one button --------------------------------------------------------------------------------------
  const press = useCallback(() => {
    const s = deviceRef.current;
    if (pressAt.current !== null) return;
    if (s.mode === 'idle') {
      pressAt.current = Date.now();
      void startRecording();
    } else if (s.mode === 'alert') {
      // Tap = confirm, hold = talk. Decide when the hold threshold passes.
      pressAt.current = Date.now();
      holdTimer.current = setTimeout(() => void startRecording(), TAP_MS);
    } else if (s.mode === 'speaking') {
      stopPlayback.current?.();
    }
  }, [startRecording]);

  const release = useCallback(() => {
    const started = pressAt.current;
    pressAt.current = null;
    if (started === null) return;
    clearTimeout(holdTimer.current);
    if (recorder.current) {
      void finishRecording();
      return;
    }
    if (deviceRef.current.mode === 'alert' && Date.now() - started < TAP_MS) void decide('confirm');
  }, [decide, finishRecording]);

  // ---- Text turn -------------------------------------------------------------------------------------------
  const sendText = useCallback(
    async (text: string) => {
      const t = text.trim();
      if (!t) return;
      send({ type: 'SUBMIT_TEXT' });
      const r = await live.voiceText(t);
      if (!r.ok) {
        send({ type: 'FAIL', note: failureNote(r, 'text') });
        return;
      }
      const hasAudio = r.data.audioBytes > 0 && r.data.audioBase64 !== '';
      const note = r.data.tts?.error
        ? { tone: 'info' as const, text: 'Spoken replies aren’t set up yet — showing text.' }
        : undefined;
      send({ type: 'REPLY', caption: r.data.rationale || null, hasAudio, note });
      if (hasAudio) play(base64ToArrayBuffer(r.data.audioBase64), r.data.sampleRate);
    },
    [live, play],
  );

  // Stop everything on unmount.
  useEffect(
    () => () => {
      clearTimeout(holdTimer.current);
      clearTimeout(maxTimer.current);
      recorder.current?.stop();
      stopPlayback.current?.();
      window.speechSynthesis?.cancel();
    },
    [],
  );

  const dismissNote = useCallback(() => send({ type: 'DISMISS_NOTE' }), []);
  const notNow = useCallback(() => void decide('cancel'), [decide]);

  return { device, levelRef, localSpeech, press, release, sendText, notNow, dismissNote };
}

