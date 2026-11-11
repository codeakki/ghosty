import { GUEST_CANNOT } from './tokenPrompt';

/**
 * Calm, fixed-height band under the header. Never shows the token.
 *  - `need`: a guarded route answered 401 (or a guest pass is on offer and no token is set).
 *  - `guest`: this browser holds a guest pass; says what it allows and when it ends.
 */
export function TokenBanner(props: {
  onSettings: () => void;
  /** The server offers guest passes (GET /access). */
  guestAccess: boolean;
  onGuest: () => void;
  guestBusy: boolean;
  /** Inline, calm problem from the last guest-pass request (limit reached, switched off). */
  guestNote: string | null;
  /** Set while a guest pass is in use: "Guest · questions only · expires in 24 h". */
  guestLabel: string | null;
}) {
  if (props.guestLabel) {
    return (
      <div className="lv-token-banner" role="status" data-kind="guest">
        <p className="lv-token-banner-text" title={GUEST_CANNOT}>
          {props.guestLabel}
        </p>
        <button type="button" className="lv-token-banner-btn" onClick={props.onSettings} aria-haspopup="dialog">
          I have a device token
        </button>
      </div>
    );
  }
  return (
    <div className="lv-token-banner" role="status">
      <p className="lv-token-banner-text">
        {props.guestNote ?? (props.guestAccess ? 'Ask Ghosty anything as a guest. Trading stays with the owner.' : 'Add your device token to talk to Ghosty')}
      </p>
      {props.guestAccess ? (
        <button type="button" className="lv-token-banner-btn lv-token-banner-primary" onClick={props.onGuest} disabled={props.guestBusy} aria-busy={props.guestBusy}>
          {props.guestBusy ? 'Starting…' : 'Try Ghosty as a guest'}
        </button>
      ) : null}
      <button type="button" className="lv-token-banner-btn" onClick={props.onSettings} aria-haspopup="dialog">
        {props.guestAccess ? 'I have a device token' : 'Settings'}
      </button>
    </div>
  );
}
