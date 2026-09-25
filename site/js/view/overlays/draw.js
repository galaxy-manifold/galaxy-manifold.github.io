// Canvas-2D drawing helpers shared by the overlays: colours with alpha, device-pixel snapping
// for crisp hairlines, fonts, and polylines broken at NaN.

import { COLORS, FONTS, hexToRgb } from '../../config/style.js';

export { COLORS };
export const MONO = FONTS.mono;
export const UI = FONTS.ui;

const rgbCache = new Map();

/** 'rgba(r,g,b,a)' for a hex colour. */
export function rgba(hex, a) {
  let c = rgbCache.get(hex);
  if (!c) {
    c = hexToRgb(hex).join(',');
    rgbCache.set(hex, c);
  }
  return `rgba(${c},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}

/** Snap a coordinate so a line of width w CSS px covers whole device pixels. */
export function snap(v, dpr, w = 1) {
  const wd = w * dpr;
  return (Math.round(v * dpr - wd / 2) + wd / 2) / dpr;
}

export function monoFont(px, weight = 400) {
  return `${weight} ${px}px ${MONO}`;
}

/** Reset the transform to CSS px for the given canvas and clear it. */
export function beginCanvas(ctx, canvas, dpr) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/**
 * Trace a polyline through screen points (sx[k], sy[k]) into the current path, starting a
 * new sub-path after every NaN. Returns the number of drawn segments.
 */
export function tracePolyline(ctx, sx, sy, n) {
  let pen = false, segs = 0;
  for (let k = 0; k < n; k++) {
    const x = sx[k], y = sy[k];
    if (!(x === x) || !(y === y)) { pen = false; continue; }
    if (pen) { ctx.lineTo(x, y); segs++; } else { ctx.moveTo(x, y); pen = true; }
  }
  return segs;
}

/** Dash pattern for a literature/trend style name. */
export function dashFor(style) {
  if (style === 'dashed') return [6, 4];
  if (style === 'dotted') return [0.5, 3.5];
  return [];
}
