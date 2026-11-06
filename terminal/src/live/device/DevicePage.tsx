import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent } from 'react';
import type { Alert } from '../../api/types';
import type { LiveApi } from '../useLive';
import { coinName, formatConfidencePct, legText } from '../words';
import { modeLabel, type DeviceState } from './machine';
import { Orb } from './Orb';
import { useDevice, voiceReadiness } from './useDevice';

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(t.tagName);
}

function buttonLabel(s: DeviceState): string {
  switch (s.mode) {
    case 'idle':
      return 'Hold to Talk';
    case 'listening':
      return 'Release to Send';
    case 'thinking':
      return 'Thinking…';
    case 'speaking':
      return 'Tap to Stop';
    case 'alert':
      return 'Tap to Confirm';
    case 'offline':
      return 'Trading Paused';
  }
}

/**
 * The pod, as a page. One orb, one label, one big button. Works full screen on a phone (/device) and as the
 * left half of the split view.
 */
export function DevicePage({ api, full = false }: { api: LiveApi; full?: boolean }) {
  const { device, levelRef, localSpeech, press, release, sendText, notNow, dismissNote } = useDevice(api);
  const labels = api.feed.labels;
  const voice = voiceReadiness(api.state.providers.data?.providers);
  const [typing, setTyping] = useState(false);
  const showType = typing || voice.ready === false;
  const inputRef = useRef<HTMLInputElement>(null);

  // Space bar = hold to talk (desktop), ignored while typing in a field.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || isTypingTarget(e.target)) return;
      e.preventDefault();
      press();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || isTypingTarget(e.target)) return;
      e.preventDefault();
      release();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [press, release]);

  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      press();
    },
    [press],
  );
  // Keyboard on the focused button: Enter/Space behave like the physical button.
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLButtonElement>) => {
      if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
        e.preventDefault();
        e.stopPropagation();
        press();
      }
    },
    [press],
  );
  const onKeyUp = useCallback(
    (e: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        release();
      }
    },
    [release],
  );

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const input = inputRef.current;
    if (!input) return;
    void sendText(input.value);
    input.value = '';
  };

  const disabled = device.mode === 'thinking' || device.mode === 'offline';
  const alert = device.alert;

  return (
    <section className={`lv-device${full ? ' lv-device-full' : ''}`} aria-labelledby="device-title" data-mode={device.mode}>
      <h2 id="device-title" className="lv-sr-only">
        Ghosty device
      </h2>
      <div className="lv-device-stage">
        <Orb mode={device.mode} levelRef={levelRef} localSpeech={localSpeech} />
        <p className="lv-device-state" aria-live="polite">
          {modeLabel(device)}
        </p>
      </div>

      {/* One fixed-height slot for the trade card or the caption: nothing below it moves when an alert arrives. */}
      <div className="lv-device-info">
        {alert && device.mode === 'alert' ? (
          <AlertCard alert={alert} labels={labels} />
        ) : (
          <figure className="lv-caption" aria-live="polite">
            {device.caption ? (
              <>
                <figcaption className="lv-caption-label">
                  Ghosty said{localSpeech ? <span className="lv-caption-local"> · read aloud by your browser</span> : null}
                </figcaption>
                <blockquote className="lv-caption-text">“{device.caption}”</blockquote>
              </>
            ) : (
              <figcaption className="lv-caption-label lv-caption-empty">
                {device.mode === 'offline'
                  ? 'Ghosty will not trade while the 0G brain is unreachable.'
                  : 'Ask about the market, or wait. Ghosty pings you when a headline matters.'}
              </figcaption>
            )}
          </figure>
        )}
      </div>

      <div className="lv-device-controls">
        <button
          type="button"
          className="lv-talk"
          data-mode={device.mode}
          disabled={disabled}
          onPointerDown={onPointerDown}
          onPointerUp={release}
          onPointerCancel={release}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onContextMenu={(e) => e.preventDefault()}
          aria-describedby="talk-hint"
        >
          <span className="lv-talk-dot" aria-hidden="true" />
          {buttonLabel(device)}
        </button>
        {/* One reserved slot: the hint normally, "Not Now" while an alert waits. Nothing below moves. */}
        <div className="lv-device-secondary">
          {device.mode === 'alert' ? (
            <button type="button" className="lv-btn-quiet" onClick={notNow} aria-describedby="talk-hint">
              Not Now
            </button>
          ) : null}
          <p id="talk-hint" className={device.mode === 'alert' ? 'lv-sr-only' : 'lv-talk-hint'}>
            {device.mode === 'alert'
              ? 'Tap confirms the trade, hold to talk instead.'
              : device.mode === 'offline'
                ? 'Talk comes back when the 0G brain does'
                : 'Press, talk, let go'}
            {device.mode === 'alert' || device.mode === 'offline' ? null : <span className="lv-kbd-hint"> · or hold Space</span>}
          </p>
        </div>
      </div>

      <div className="lv-note-slot">
        {device.note ? (
          <p className={`lv-note lv-note-${device.note.tone}`} role={device.note.tone === 'warn' ? 'alert' : 'status'}>
            <span aria-hidden="true">{device.note.tone === 'warn' ? '!' : 'i'}</span>
            <span className="lv-note-text">{device.note.text}</span>
            <button type="button" className="lv-icon-btn" onClick={dismissNote} aria-label="Dismiss note">
              <span aria-hidden="true">×</span>
            </button>
          </p>
        ) : voice.ready === false ? (
          <p className="lv-note lv-note-calm" role="status" title={voice.missingEnv.length > 0 ? `Server needs ${voice.missingEnv.join(' + ')}` : undefined}>
            <span aria-hidden="true">i</span>
            <span className="lv-note-text">Voice isn’t set up on the server yet — type instead.</span>
          </p>
        ) : null}
      </div>

      {showType ? (
        <form className="lv-type" onSubmit={onSubmit}>
          <label htmlFor="device-text" className="lv-sr-only">
            Ask Ghosty
          </label>
          <input
            ref={inputRef}
            id="device-text"
            name="ghosty-question"
            className="lv-input"
            type="text"
            autoComplete="off"
            enterKeyHint="send"
            placeholder="What’s moving gold?…"
            disabled={device.mode === 'thinking' || device.mode === 'offline'}
          />
          <button type="submit" className="lv-btn" disabled={device.mode === 'thinking' || device.mode === 'offline'}>
            Ask
          </button>
        </form>
      ) : (
        <button type="button" className="lv-link-btn" onClick={() => setTyping(true)}>
          Type Instead
        </button>
      )}
    </section>
  );
}

function AlertCard({ alert, labels }: { alert: Alert; labels: Record<string, string> }) {
  const leg = alert.actions[0];
  return (
    <div className="lv-alert" role="alert">
      <p className="lv-alert-kicker">
        <span aria-hidden="true">●</span> Pending trade · confidence {formatConfidencePct(alert.confidence)}
      </p>
      <p className="lv-alert-leg">{leg ? legText(leg, labels) : 'No trade attached'}</p>
      {alert.actions.length > 1 ? (
        <p className="lv-alert-more">+ {alert.actions.slice(1).map((a) => `${a.side} ${coinName(a.coin, labels)}`).join(', ')}</p>
      ) : null}
      {alert.headline ? <p className="lv-alert-headline">On: {alert.headline}</p> : null}
    </div>
  );
}
