import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { describeError, type GhostyClient } from '../api/client';
import type { DecisionEntry } from '../api/types';
import { base64ToArrayBuffer, MAX_RECORD_MS, MicRecorder, playPcm } from '../lib/audio';
import { formatSignal, shortId } from '../lib/format';
import { CopyButton } from './ui';

type Phase = 'idle' | 'starting' | 'recording' | 'thinking' | 'playing';

interface Reply {
  via: 'voice' | 'text';
  requestId: string;
  signal: string;
  latencyMs: number;
  transcript: string | null;
  audioBytes: number;
  sampleRate: number;
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(t.tagName) || t.closest('dialog') !== null;
}

/**
 * The pod, in a browser: hold to talk (button or space bar) → 16 kHz WAV → POST /voice → play the PCM reply.
 * Same wire format as the ESP32, so it exercises the real server path.
 */
export function PodDock(props: {
  client: GhostyClient;
  lastDecision: DecisionEntry | null;
  safeStop: boolean;
  onLog: (level: 'ui' | 'error', summary: string) => void;
}) {
  const { client, onLog } = props;
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState<Reply | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [text, setText] = useState('');
  const recorder = useRef<MicRecorder | null>(null);
  const lastAudio = useRef<{ pcm: ArrayBuffer; rate: number } | null>(null);
  const startedAt = useRef(0);
  const phaseRef = useRef<Phase>('idle');
  const [hasAudio, setHasAudio] = useState(false);
  const setPhaseBoth = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  }, []);

  const play = useCallback(async (pcm: ArrayBuffer, rate: number) => {
    lastAudio.current = { pcm, rate };
    setHasAudio(true);
    setPhaseBoth('playing');
    try {
      await playPcm(pcm, rate);
    } finally {
      setPhaseBoth('idle');
    }
  }, [setPhaseBoth]);

  const start = useCallback(async () => {
    if (phaseRef.current !== 'idle') return;
    setError(null);
    if (!MicRecorder.supported()) {
      setError('No microphone API here. Open the terminal on http://localhost or HTTPS, or type instead.');
      return;
    }
    const rec = new MicRecorder();
    recorder.current = rec;
    setPhaseBoth('starting');
    try {
      await rec.start();
      if (recorder.current !== rec) return;
      startedAt.current = performance.now();
      setElapsed(0);
      setPhaseBoth('recording');
    } catch (err) {
      recorder.current = null;
      setPhaseBoth('idle');
      setError(`Microphone blocked: ${(err as Error).message}. Allow the mic, or type instead.`);
    }
  }, [setPhaseBoth]);

  const stop = useCallback(async () => {
    const rec = recorder.current;
    recorder.current = null;
    if (!rec) return;
    if (phaseRef.current === 'starting') {
      rec.stop();
      setPhaseBoth('idle');
      setError('Mic was not ready yet. Allow the permission prompt, then hold again.');
      return;
    }
    const wav = rec.stop();
    if (!wav) {
      setPhaseBoth('idle');
      setError('Too short. Hold a little longer while you speak.');
      return;
    }
    setPhaseBoth('thinking');
    onLog('ui', `POST /voice ${wav.byteLength} B WAV (16 kHz mono)`);
    const r = await client.voice(wav);
    if (!r.ok) {
      setPhaseBoth('idle');
      const msg = describeError(r);
      setError(msg);
      onLog('error', `POST /voice → ${r.status || 'network'} ${msg}`);
      return;
    }
    setReply({
      via: 'voice',
      requestId: r.data.requestId,
      signal: r.data.signal,
      latencyMs: r.data.latencyMs,
      transcript: null,
      audioBytes: r.data.pcm.byteLength,
      sampleRate: r.data.sampleRate,
    });
    onLog('ui', `/voice 200 in ${r.data.latencyMs} ms · ${r.data.signal} · req ${shortId(r.data.requestId)}`);
    await play(r.data.pcm, r.data.sampleRate);
  }, [client, onLog, play, setPhaseBoth]);

  // Recording timer + hard stop at MAX_RECORD_MS, like the pod's PSRAM limit.
  useEffect(() => {
    if (phase !== 'recording') return;
    const id = setInterval(() => {
      const ms = performance.now() - startedAt.current;
      setElapsed(ms);
      if (ms >= MAX_RECORD_MS) void stop();
    }, 100);
    return () => clearInterval(id);
  }, [phase, stop]);

  // Space bar anywhere (outside inputs and buttons) is the pod button held down.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || isTypingTarget(e.target)) return;
      e.preventDefault();
      void start();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || isTypingTarget(e.target)) return;
      e.preventDefault();
      void stop();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [start, stop]);

  const onTalkKey = (e: ReactKeyboardEvent<HTMLButtonElement>, isDown: boolean) => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    if (isDown && !e.repeat) void start();
    if (!isDown) void stop();
  };

  const sendText = async (e: FormEvent) => {
    e.preventDefault();
    const q = text.trim();
    if (phase !== 'idle') return;
    if (!q) {
      setError('Type a question first, then press Ask.');
      return;
    }
    setError(null);
    setPhaseBoth('thinking');
    onLog('ui', `POST /voice/text "${q}"`);
    const t0 = performance.now();
    const r = await client.voiceText(q);
    const latencyMs = Math.round(performance.now() - t0);
    if (!r.ok) {
      setPhaseBoth('idle');
      const msg = describeError(r);
      setError(msg);
      onLog('error', `POST /voice/text → ${r.status || 'network'} ${msg}`);
      return;
    }
    setText('');
    setReply({
      via: 'text',
      requestId: r.data.requestId,
      signal: r.data.signal,
      latencyMs,
      transcript: r.data.transcript,
      audioBytes: r.data.audioBytes,
      sampleRate: r.data.sampleRate,
    });
    onLog('ui', `/voice/text 200 in ${latencyMs} ms · ${r.data.signal} · req ${shortId(r.data.requestId)}`);
    await play(base64ToArrayBuffer(r.data.audioBase64), r.data.sampleRate);
  };

  // The server keeps the transcript on the decision; match it by request id.
  const transcript =
    reply?.transcript ?? (reply && props.lastDecision?.requestId === reply.requestId ? props.lastDecision.transcript : null);

  const talkLabel =
    phase === 'recording'
      ? `Recording ${(elapsed / 1000).toFixed(1)} s · release to send`
      : phase === 'starting'
        ? 'Opening mic…'
        : phase === 'thinking'
          ? 'Thinking…'
          : phase === 'playing'
            ? 'Speaking…'
            : 'Hold to Talk';

  return (
    <section className="pod" aria-labelledby="pod-title">
      <header className="pod-head">
        <h2 id="pod-title" className="panel-title">
          Virtual pod
        </h2>
        <span className="muted small">Hold the button or the space bar, speak, release</span>
      </header>
      <div className="pod-body">
        <button
          type="button"
          className={`talk talk-${phase}`}
          onPointerDown={(e) => {
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            void start();
          }}
          onPointerUp={() => void stop()}
          onPointerCancel={() => void stop()}
          onKeyDown={(e) => onTalkKey(e, true)}
          onKeyUp={(e) => onTalkKey(e, false)}
          disabled={props.safeStop || phase === 'thinking' || phase === 'playing'}
          aria-describedby="pod-status"
        >
          <span className="talk-ring" aria-hidden="true" />
          <span className="talk-label">{talkLabel}</span>
          {phase === 'recording' ? (
            <span className="talk-meter" aria-hidden="true">
              <span style={{ width: `${Math.min(100, (elapsed / MAX_RECORD_MS) * 100)}%` }} />
            </span>
          ) : null}
        </button>

        <div className="pod-side">
          <form className="pod-text" onSubmit={sendText}>
            <label className="sr-only" htmlFor="pod-text-input">
              Type a question instead of speaking
            </label>
            <input
              id="pod-text-input"
              name="question"
              autoComplete="off"
              placeholder="Or type: what's my exposure?…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={2000}
            />
            <button type="submit" className="btn" disabled={phase !== 'idle' || props.safeStop}>
              Ask
            </button>
          </form>

          <p id="pod-status" className={`pod-status ${error ? 'outcome-bad' : ''}`} aria-live="polite">
            {props.safeStop
              ? 'Brain offline: the pod blinks red and plays nothing (safe-stop).'
              : (error ?? (phase === 'idle' && !reply ? 'Ready. Replies play through your speakers as 16\u00a0kHz PCM.' : ''))}
          </p>

          {reply ? (
            <dl className="pod-reply">
              <div>
                <dt>Transcript</dt>
                <dd>{transcript ? `“${transcript}”` : transcript === '' ? '(empty: STT heard nothing)' : '…'}</dd>
              </div>
              <div>
                <dt>Signal</dt>
                <dd>{formatSignal(reply.signal)}</dd>
              </div>
              <div>
                <dt>Request</dt>
                <dd className="mono">
                  {shortId(reply.requestId, 10, 6)} <CopyButton value={reply.requestId} label="request id" />
                </dd>
              </div>
              <div>
                <dt>Latency</dt>
                <dd className="num">
                  {reply.latencyMs} ms · {(reply.audioBytes / 2 / reply.sampleRate).toFixed(1)} s audio
                </dd>
              </div>
            </dl>
          ) : null}
          {hasAudio && phase === 'idle' ? (
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                const a = lastAudio.current;
                if (a) void play(a.pcm, a.rate);
              }}
            >
              ↻ Replay Last Answer
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
