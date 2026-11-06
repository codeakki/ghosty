import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { normalizeBaseUrl, type ClientSettings } from '../api/client';

/** Server URL + device token, kept in localStorage. Native <dialog> gives focus trapping and Escape for free. */
export function SettingsDialog(props: { settings: ClientSettings; onSave: (s: ClientSettings) => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [baseUrl, setBaseUrl] = useState(props.settings.baseUrl);
  const [token, setToken] = useState(props.settings.deviceToken);
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
    props.onSave({ baseUrl: normalizeBaseUrl(baseUrl), deviceToken: token.trim() });
  };

  return (
    <dialog ref={ref} className="dialog" aria-labelledby={`${id}-title`}>
      <form onSubmit={submit} className="dialog-form">
        <h2 id={`${id}-title`} className="dialog-title">
          Settings
        </h2>
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
          <span className="field-label">Device token</span>
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
