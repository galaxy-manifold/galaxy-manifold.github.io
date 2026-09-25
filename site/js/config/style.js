// Visual design constants (DESIGN.md §3, §7). CSS mirrors these as custom properties in
// css/tokens.css; JS code (canvas/WebGL drawing) reads them from here.

export const COLORS = {
  bg: '#0b0e13',
  bg2: '#11161f',
  bg3: '#18202c',
  line: '#273142',
  cream: '#efe6d2',
  cream2: '#b8af9a',
  cream3: '#7a7465',
  orange: '#e8743b',
  mustard: '#e2b23a',
  teal: '#3aa6a0',
  sky: '#6fa8dc',
  coral: '#de5b52',
  olive: '#a3b35b',
  plum: '#b07aa1',
};

/** Dimension group → color (rail tokens, compass spokes). */
export const GROUP_COLORS = {
  stars: COLORS.orange,
  sf: COLORS.sky,
  chem: COLORS.mustard,
  struct: COLORS.teal,
  kin: COLORS.coral,
  gas: '#8fd0e8',
  env: COLORS.plum,
  lines: COLORS.olive,
  obs: COLORS.cream3,
  learned: COLORS.cream,
};

export function groupColor(group) {
  return GROUP_COLORS[group] || COLORS.cream2;
}

/** Category code → color (§7). Code 0 (missing) renders as the neutral cream. */
export const CATEGORY_COLORS = {
  bpt: { 1: '#6fa8dc', 2: '#9cc3e4', 3: '#3aa6a0', 4: '#de5b52', 5: '#e8743b', 6: '#e2b23a', 7: '#7a7465' },
  env: { 1: '#efe6d2', 2: '#e2b23a', 3: '#b07aa1' },
  morph: { 1: '#de5b52', 2: '#6fa8dc', 3: '#7a7465' },
};

/** Neutral color for pixels/galaxies without color information. */
export const NEUTRAL = COLORS.cream;

/** Selection highlight ("warm cream/orange lift"). */
export const SELECTION_COLOR = '#f2b27a';

/**
 * Colormap control points (§3.4). All keep L* ≳ 45 so sparse points stay visible on --bg.
 * `redshift` is diverging: red = old / red / quenched (direction set per dim via `reverse`).
 */
export const COLORMAPS = {
  redshift: ['#3e7cc4', '#6fb1d9', '#e9e1c9', '#ee8a4c', '#d8433b'],
  sunset: ['#5a6fd6', '#9a6cc8', '#d8699c', '#f08a5d', '#f6c85f'],
  ember: ['#56708f', '#3aa6a0', '#a7c957', '#e2b23a', '#e8743b'],
};
export const COLORMAP_NAMES = Object.keys(COLORMAPS);

/** Motion (§3.3). */
export const MOTION = {
  ease: [0.65, 0, 0.35, 1],   // cubic-bezier for view changes
  viewMs: 1100,               // default setAxes / preset duration
  fitMs: 600,
  arrivalMs: 2600,            // first-load arrival into SFMS
  uiMs: 200,
  reducedScale: 0.3,          // durations × this under prefers-reduced-motion
  tourRadPerSec: 0.35,        // grand-tour angular speed at speed = 1
};

export const FONTS = {
  display: "'Michroma', 'Eurostile', 'Microgramma', sans-serif",
  ui: "'Jost', 'Futura', 'Century Gothic', sans-serif",
  mono: "'Space Mono', ui-monospace, 'SFMono-Regular', Menlo, monospace",
};

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const v = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function hexToRgb01(hex) {
  return hexToRgb(hex).map((c) => c / 255);
}
