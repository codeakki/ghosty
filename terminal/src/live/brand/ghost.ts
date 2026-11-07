/**
 * The Ghosty ghost, from the brand logo (docs/brand/ghosty-logo*.png). The ONLY copy of the shape: the header mark,
 * the landing page and the Device orb all draw from these constants (public/favicon.svg is checked against them).
 */

/** Body: dome head, straight sides, a five-scallop wavy hem. Native drawing box 200 × 220. */
export const GHOST_BODY_PATH =
  'M 30 108 C 30 58, 63 24, 100 24 C 137 24, 170 58, 170 108 L 170 186 Q 159 201 147 186 Q 135 171 123 186 Q 111 201 99 186 Q 87 171 75 186 Q 63 201 51 186 Q 41 174 30 186 Z';

/** Two tall oval eyes. */
export const GHOST_EYES = [
  { cx: 80, cy: 104, rx: 9.5, ry: 14 },
  { cx: 120, cy: 104, rx: 9.5, ry: 14 },
] as const;

/** Where the straight sides end and the scalloped hem begins (y in the drawing box). */
export const GHOST_HEM_Y = 176;

/** Square viewBox centred on the ghost, for square slots (orb, favicon, nav mark). */
export const GHOST_SQUARE_VIEWBOX = '-10 0 220 220';

/** Tight square box for small marks (nav, landing, favicon): the ghost fills it edge to edge. */
export const GHOST_MARK_VIEWBOX = '6 18 188 188';
