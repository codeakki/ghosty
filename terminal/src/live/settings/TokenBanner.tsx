/** Calm, fixed-height band under the header after a 401. Says what to do; never shows the token. */
export function TokenBanner({ onSettings }: { onSettings: () => void }) {
  return (
    <div className="lv-token-banner" role="status">
      <span className="lv-token-banner-dot" aria-hidden="true" />
      <p className="lv-token-banner-text">Add your device token to talk to Ghosty</p>
      <button type="button" className="lv-token-banner-btn" onClick={onSettings} aria-haspopup="dialog">
        Settings
      </button>
    </div>
  );
}
