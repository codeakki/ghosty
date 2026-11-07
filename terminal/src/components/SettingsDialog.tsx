import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { normalizeBaseUrl, type ClientSettings } from '../api/client';

/**
 * Server URL + device token, kept in localStorage. Native <dialog> gives focus trapping and Escape for free.
 * With `guest` (Live view, GUEST_ACCESS on the server), a primary "Try Ghosty as a guest" gets a question-only pass.
 */
export function SettingsDialog(props: {
  settings: ClientSettings;
  onSave: (s: ClientSettings) => void;
  onClose: () => void;
  guest?: { onGuest: () => void; busy: boolean; note: string | null; label: string | null; can: string; cannot: string };
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [baseUrl, setBaseUrl] = useState(props.settings.baseUrl);
  // A guest pass is not something to edit by hand: the field starts empty for an owner token.
  const [token, setToken] = useState(props.settings.scope === 'guest' ? '' : props.settings.deviceToken);
  const [showToken, setShowToken] = useState(false);
  const id = useId();
  const { onClose } = props;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    const close = () => onClose();
    dialog.addEventListener('close', close);
    return () => dialog.removeEventListener('close', close);
  }, [onClose]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const base = normalizeBaseUrl(baseUrl);
    // Keep a guest pass when no owner token was typed; a typed token always replaces it (owner scope).
    if (!token.trim() && props.settings.scope === 'guest') return props.onSave({ ...props.settings, baseUrl: base });
    props.onSave({ baseUrl: base, deviceToken: token.trim() });
  };

  return (
    <dialog ref={ref} className="dialog" aria-labelledby={`${id}-title`}>
      <form onSubmit={submit} className="dialog-form">
        <h2 id={`${id}-title`} className="dialog-title">
          Settings
        </h2>
        {props.guest ? (
          <div className="field guest-pass">
            <span className="field-label">Guest pass</span>
            {props.guest.label ? <span className="guest-pass-status">{props.guest.label}</span> : null}
            <span className="field-help">
              {props.guest.can} {props.guest.cannot}
            </span>
            <button type="button" className="btn btn-primary" onClick={props.guest.onGuest} disabled={props.guest.busy} aria-busy={props.guest.busy}>
              {props.guest.busy ? 'Starting…' : props.guest.label ? 'Get a fresh guest pass' : 'Try Ghosty as a guest'}
            </button>
            {props.guest.note ? (
              <span className="field-help guest-pass-note" role="status">
                {props.guest.note}
              </span>
            ) : null}
          </div>
        ) : null}
        <label className="field">
          <span className="field-label">Server URL</span>
          <input
            name="server-url"
            type="url"
            inputMode="url"
            autoComplete="url"
            spellCheck={false}
            placeholder="Same origin (leave empty)…"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <span className="field-help">
            Empty uses this page's origin (the dev proxy or the Ghosty server). Another origin needs CORS on the server.
          </span>
        </label>
        <label className="field">
          <span className="field-label">{props.guest ? 'I have a device token' : 'Device token'}</span>
          <span className="field-row">
            <input
              name="device-token"
              type={showToken ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              placeholder="Only if DEVICE_TOKEN is set…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <button type="button" className="btn btn-ghost" onClick={() => setShowToken((v) => !v)} aria-pressed={showToken}>
              {showToken ? 'Hide' : 'Show'}
            </button>
          </span>
          <span className="field-help">Sent as X-Device-Token, like the pod. Stored in this browser only.</span>
        </label>
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={() => ref.current?.close()}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            Save &amp; Reconnect
          </button>
        </div>
      </form>
    </dialog>
  );
}
