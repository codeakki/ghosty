import { memo, useEffect, useRef, type RefObject } from 'react';
import type { DeviceMode } from './machine';
import type { LevelSource } from './useDevice';

/**
 * The ghost orb. Stacked layers animated with transform/opacity only (compositor-friendly).
 * The live audio level (mic while listening, TTS while speaking) is written to `--level` from rAF,
 * so React never re-renders per frame. Decorative: the state is always in the text label next to it.
 */
export const Orb = memo(function Orb({ mode, levelRef, localSpeech }: { mode: DeviceMode; levelRef: RefObject<LevelSource>; localSpeech: boolean }) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const metered = mode === 'listening' || mode === 'speaking' || mode === 'alert';
    if (reduced || !metered) {
      el.style.setProperty('--level', '0');
      return;
    }
    let raf = 0;
    let smooth = 0;
    const frame = () => {
      const read = levelRef.current;
      const target = read ? read() : 0;
      // Fast attack, slow release: reads as a voice, not a strobe.
      smooth = target > smooth ? smooth + (target - smooth) * 0.5 : smooth + (target - smooth) * 0.12;
      el.style.setProperty('--level', smooth.toFixed(3));
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      el.style.setProperty('--level', '0');
    };
  }, [mode, levelRef]);

  return (
    <div ref={root} className="orb" data-mode={mode} data-local-speech={localSpeech ? 'true' : undefined} aria-hidden="true">
      <div className="orb-ripple" />
      <div className="orb-ripple orb-ripple-2" />
      <div className="orb-ripple orb-ripple-3" />
      <div className="orb-halo" />
      <div className="orb-halo orb-halo-alert" />
      <div className="orb-orbit" />
      <div className="orb-breathe">
        <div className="orb-core">
          {/* State colours cross-fade: each tint is a full layer whose opacity changes (no gradient repaint jumps). */}
          <div className="orb-tint orb-tint-think" />
          <div className="orb-tint orb-tint-alert" />
          <div className="orb-tint orb-tint-off" />
          <div className="orb-sheen" />
          <div className="orb-face">
            <span className="orb-eye" />
            <span className="orb-eye" />
          </div>
        </div>
      </div>
    </div>
  );
});
