// Colormaps (§3.4) → lookup tables. Control points are interpolated in OKLab so steps are
// perceptually even; the GPU gets one 256-texel row per map in an RGBA8 texture. The same
// sampling is exported for the UI (colorbars, legends).

import { COLORMAPS, COLORMAP_NAMES, hexToRgb01 } from '../config/style.js';

const toLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

export function rgbToOklab([r, g, b]) {
  r = toLin(r); g = toLin(g); b = toLin(b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

export function oklabToRgb([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  return [r, g, bb].map((c) => Math.min(1, Math.max(0, toSrgb(Math.min(1, Math.max(0, c))))));
}

const labCache = new Map();
function controlLab(name) {
  let c = labCache.get(name);
  if (!c) {
    c = (COLORMAPS[name] || COLORMAPS.sunset).map((h) => rgbToOklab(hexToRgb01(h)));
    labCache.set(name, c);
  }
  return c;
}

/** Color of map `name` at t ∈ [0, 1] as sRGB [r, g, b] in 0..1. */
export function sampleColormap(name, t, reverse = false) {
  const pts = controlLab(name);
  let u = Math.min(1, Math.max(0, reverse ? 1 - t : t)) * (pts.length - 1);
  const i = Math.min(pts.length - 2, Math.floor(u));
  u -= i;
  const a = pts[i], b = pts[i + 1];
  return oklabToRgb([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]);
}

export function sampleColormapHex(name, t, reverse = false) {
  return '#' + sampleColormap(name, t, reverse).map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('');
}

/** CSS gradient for a colorbar. */
export function colormapCSS(name, { reverse = false, direction = '90deg', steps = 11 } = {}) {
  const stops = [];
  for (let k = 0; k < steps; k++) {
    const t = k / (steps - 1);
    stops.push(`${sampleColormapHex(name, t, reverse)} ${(t * 100).toFixed(1)}%`);
  }
  return `linear-gradient(${direction}, ${stops.join(', ')})`;
}

export const LUT_SIZE = 256;

/** Row index of a colormap in the LUT texture (unknown names → sunset). */
export function colormapRow(name) {
  const i = COLORMAP_NAMES.indexOf(name);
  return i < 0 ? COLORMAP_NAMES.indexOf('sunset') : i;
}

/** RGBA8 LUT data: one LUT_SIZE-texel row per colormap in COLORMAP_NAMES order. */
export function buildLUT() {
  const rows = COLORMAP_NAMES.length;
  const data = new Uint8Array(LUT_SIZE * rows * 4);
  COLORMAP_NAMES.forEach((name, r) => {
    for (let k = 0; k < LUT_SIZE; k++) {
      const [R, G, B] = sampleColormap(name, k / (LUT_SIZE - 1));
      const o = (r * LUT_SIZE + k) * 4;
      data[o] = Math.round(R * 255);
      data[o + 1] = Math.round(G * 255);
      data[o + 2] = Math.round(B * 255);
      data[o + 3] = 255;
    }
  });
  return { data, width: LUT_SIZE, rows };
}
