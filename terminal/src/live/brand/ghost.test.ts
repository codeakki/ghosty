import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Orb } from '../device/Orb';
import type { DeviceMode } from '../device/machine';
import { GHOST_BODY_PATH, GHOST_EYES } from './ghost';
import { GhostMark } from './GhostMark';
import faviconSvg from '../../../public/favicon.svg?raw';

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
const levelRef = { current: () => 0 };

function orb(mode: DeviceMode, extra: { localSpeech?: boolean; mirroring?: boolean } = {}): string {
  return renderToStaticMarkup(createElement(Orb, { mode, levelRef, localSpeech: extra.localSpeech ?? false, mirroring: extra.mirroring }));
}

describe('Ghosty ghost: one shared shape', () => {
  it('the nav/landing mark draws the brand body once with two eyes', () => {
    const html = renderToStaticMarkup(createElement(GhostMark, { size: 26, className: 'lv-mark' }));
    expect(count(html, `d="${GHOST_BODY_PATH}"`)).toBe(1);
    expect(count(html, '<ellipse')).toBe(GHOST_EYES.length);
    expect(html).toContain('class="ghost-mark lv-mark"');
    expect(html).toContain('width="26"');
    expect(html).toContain('aria-hidden="true"');
  });

  it('the Device orb is the ghost (no round core), with every state layer and the eyes', () => {
    const html = orb('idle');
    expect(html).toContain(`d="${GHOST_BODY_PATH}"`);
    expect(html).not.toContain('orb-core');
    // No glow layers: depth comes from the ghost's own shading, not a halo or a shimmer sweep.
    expect(html).not.toContain('orb-halo');
    expect(html).not.toContain('orb-shimmer');
    for (const layer of ['orb-ripple', 'orb-listen', 'orb-float', 'orb-pulse', 'orb-hem', 'orb-tint-think', 'orb-tint-alert', 'orb-tint-off']) {
      expect(html).toContain(layer);
    }
    expect(count(html, 'class="orb-eye"')).toBe(2);
  });

  it('exposes the mode, local speech and pod mirroring as data attributes for CSS', () => {
    for (const mode of ['idle', 'listening', 'thinking', 'speaking', 'alert', 'offline'] as const) {
      expect(orb(mode)).toContain(`data-mode="${mode}"`);
    }
    expect(orb('speaking', { localSpeech: true })).toContain('data-local-speech="true"');
    expect(orb('speaking', { mirroring: true })).toContain('data-mirroring="true"');
    expect(orb('speaking')).not.toContain('data-mirroring');
  });

  it('two orbs on one page never share SVG ids', () => {
    const ids = (html: string) => [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    const page = renderToStaticMarkup(
      createElement('div', null, createElement(Orb, { mode: 'idle', levelRef, localSpeech: false }), createElement(Orb, { mode: 'idle', levelRef, localSpeech: false })),
    );
    const all = ids(page);
    expect(all.length).toBeGreaterThan(0);
    expect(new Set(all).size).toBe(all.length);
  });

  it('the favicon draws the same ghost', () => {
    const svg = faviconSvg;
    expect(svg).toContain(`d="${GHOST_BODY_PATH}"`);
    for (const e of GHOST_EYES) expect(svg).toContain(`cx="${e.cx}" cy="${e.cy}" rx="${e.rx}" ry="${e.ry}"`);
  });
});
