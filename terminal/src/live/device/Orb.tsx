import { memo, useEffect, useId, useRef, type RefObject } from 'react';
import { GHOST_BODY_PATH, GHOST_EYES, GHOST_HEM_Y, GHOST_SQUARE_VIEWBOX } from '../brand/ghost';
import type { DeviceMode } from './machine';
import type { LevelSource } from './useDevice';
import './orb.css';

/**
 * The Device "orb" is the Ghosty ghost. Layers are animated with transform/opacity only (compositor-friendly) inside a
 * fixed square box, so no state ever shifts the layout. The live audio level (mic while listening, reply audio or the
 * pod's envelope while speaking) is written to `--level` from rAF, so React never re-renders per frame.
 *   idle      still: no float, no glow, no blink (nothing is happening, so nothing moves)
 *   listening ghost-shaped rings that follow the mic level
 *   thinking  a cooler tint, eyes looking side to side
 *   speaking  body pulse driven by --level, the hem sways
 *   alert     amber tint, amber ghost-shaped ripples
 *   offline   dimmed grey, eyes shut to short lines
 * Decorative: the state is always in the text label next to it.
 */
export const Orb = memo(function Orb({
  mode,
  levelRef,
  localSpeech,
  mirroring = false,
}: {
  mode: DeviceMode;
  levelRef: RefObject<LevelSource>;
  localSpeech: boolean;
  /** The orb is following the physical pod (SSE `pod`); the page shows the standby light next to it. */
  mirroring?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  // SVG ids must be unique per page (the orb can render next to the nav mark); strip useId's colons for url(#…).
  const uid = `ghost${useId().replace(/[^a-zA-Z0-9]/g, '')}`;

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

  // The body is painted twice from the same path: above the hem and the hem itself, so the hem can sway alone.
  // State colours cross-fade: each tint is a full layer whose opacity changes (no gradient repaint jumps).
  const paint = (
    <>
      <path d={GHOST_BODY_PATH} fill={`url(#${uid}-base)`} />
      <path className="orb-tint orb-tint-think" d={GHOST_BODY_PATH} fill={`url(#${uid}-think)`} />
      <path className="orb-tint orb-tint-alert" d={GHOST_BODY_PATH} fill={`url(#${uid}-alert)`} />
      <path className="orb-tint orb-tint-off" d={GHOST_BODY_PATH} fill={`url(#${uid}-off)`} />
    </>
  );
  const ring = (className: string) => (
    <svg className={`orb-ring ${className}`} viewBox={GHOST_SQUARE_VIEWBOX} aria-hidden="true" focusable="false">
      <path d={GHOST_BODY_PATH} fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  );

  return (
    <div
      ref={root}
      className="orb"
      data-mode={mode}
      data-local-speech={localSpeech ? 'true' : undefined}
      data-mirroring={mirroring ? 'true' : undefined}
      aria-hidden="true"
    >
      {ring('orb-ripple')}
      {ring('orb-ripple orb-ripple-2')}
      {ring('orb-ripple orb-ripple-3')}
      {ring('orb-listen')}
      {ring('orb-listen orb-listen-2')}
      <div className="orb-float">
        <div className="orb-pulse">
          <svg className="orb-ghost" viewBox={GHOST_SQUARE_VIEWBOX} focusable="false">
            <defs>
              <radialGradient id={`${uid}-base`} cx="0.36" cy="0.28" r="0.9">
                <stop offset="0" className="orb-stop-hi" />
                <stop offset="0.38" className="orb-stop-core" />
                <stop offset="1" className="orb-stop-deep" />
              </radialGradient>
              <radialGradient id={`${uid}-think`} cx="0.36" cy="0.28" r="0.9">
                <stop offset="0" stopColor="#f2f6f8" />
                <stop offset="0.38" stopColor="#bcd0d6" />
                <stop offset="1" stopColor="#334452" />
              </radialGradient>
              <radialGradient id={`${uid}-alert`} cx="0.36" cy="0.28" r="0.9">
                <stop offset="0" stopColor="#fff6e3" />
                <stop offset="0.38" stopColor="#f9cf7c" />
                <stop offset="1" stopColor="#8a5208" />
              </radialGradient>
              <radialGradient id={`${uid}-off`} cx="0.36" cy="0.28" r="0.9">
                <stop offset="0" stopColor="#b5bdc8" />
                <stop offset="0.38" stopColor="#6b7584" />
                <stop offset="1" stopColor="#2a313b" />
              </radialGradient>
              <clipPath id={`${uid}-body`}>
                <path d={GHOST_BODY_PATH} />
              </clipPath>
              <clipPath id={`${uid}-top`}>
                <rect x="-20" y="0" width="240" height={GHOST_HEM_Y + 1} />
              </clipPath>
              <clipPath id={`${uid}-hem`}>
                <rect x="-20" y={GHOST_HEM_Y} width="240" height={220 - GHOST_HEM_Y} />
              </clipPath>
            </defs>
            <g clipPath={`url(#${uid}-top)`}>{paint}</g>
            <g className="orb-hem">
              <g clipPath={`url(#${uid}-hem)`}>{paint}</g>
            </g>
            <g clipPath={`url(#${uid}-body)`}>
              <ellipse className="orb-sheen" cx="72" cy="58" rx="30" ry="16" />
            </g>
            <g className="orb-eyes">
              {GHOST_EYES.map((e) => (
                <ellipse key={e.cx} className="orb-eye" cx={e.cx} cy={e.cy} rx={e.rx} ry={e.ry} />
              ))}
            </g>
          </svg>
        </div>
      </div>
    </div>
  );
});
