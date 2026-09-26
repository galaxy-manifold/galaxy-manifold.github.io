// Per-dimension UI configuration: colormap, direction, grand-tour membership, number format
// and color-normalization range (physical units).
//
// Astronomical color convention: red = old / red / quenched / dense, blue = star-forming /
// gas-rich / young. The diverging `redshift` map is centered (cream) on the physically
// meaningful transition where there is one (green valley, Dn4000 ≈ 1.6, Σ★ ≈ 3×10⁸ …).
// Dimensions missing from this table (e.g. future `learned` embeddings) get DEFAULT_DIM
// and a quantile-based range.

import { valueFromQuantiles } from '../math/stats.js';

export const DEFAULT_DIM = { cmap: 'sunset', reverse: false, tour: false, decimals: 2, range: null };

export const DIM_CONFIG = {
  logM:     { cmap: 'sunset',   reverse: false, tour: true,  decimals: 2, range: [9.0, 11.5] },
  logSFR:   { cmap: 'redshift', reverse: true,  tour: false, decimals: 2, range: [-2.0, 1.2] },
  logsSFR:  { cmap: 'redshift', reverse: true,  tour: true,  decimals: 2, range: [-12.3, -9.7] },
  D4000:    { cmap: 'redshift', reverse: false, tour: true,  decimals: 2, range: [1.15, 2.05] },
  HdA:      { cmap: 'redshift', reverse: true,  tour: false, decimals: 1, range: [-2.5, 6.5] },
  gr:       { cmap: 'redshift', reverse: false, tour: false,  decimals: 3, range: [0.35, 1.0] },
  OH:       { cmap: 'ember',    reverse: false, tour: false,  decimals: 2, range: [8.5, 9.2] },
  OH_PP04:  { cmap: 'ember',    reverse: false, tour: false, decimals: 2, range: [8.3, 8.95] },
  logR50:   { cmap: 'sunset',   reverse: false, tour: true,  decimals: 2, range: [0.0, 1.1] },
  C:        { cmap: 'redshift', reverse: false, tour: true,  decimals: 2, range: [1.9, 3.3] },
  logSigma: { cmap: 'redshift', reverse: false, tour: false, decimals: 2, range: [7.6, 9.4] },
  ba:       { cmap: 'sunset',   reverse: false, tour: false, decimals: 2, range: [0.2, 1.0] },
  pEl:      { cmap: 'redshift', reverse: false, tour: true, decimals: 2, range: [0.0, 1.0] },
  logSigV:  { cmap: 'redshift', reverse: false, tour: false,  decimals: 2, range: [1.7, 2.5] },
  mu50:     { cmap: 'sunset',   reverse: true,  tour: true, decimals: 1, range: [19.0, 23.0] },
  logfHI:   { cmap: 'redshift', reverse: true,  tour: false, decimals: 2, range: [-1.8, 0.8] },
  logMh:    { cmap: 'redshift', reverse: false, tour: false,  decimals: 2, range: [11.3, 14.3] },
  N2Ha:     { cmap: 'ember',    reverse: false, tour: false, decimals: 2, range: [-1.0, 0.2] },
  O3Hb:     { cmap: 'sunset',   reverse: false, tour: false, decimals: 2, range: [-1.0, 0.9] },
  z:        { cmap: 'redshift', reverse: false, tour: false, decimals: 3, range: [0.02, 0.2] },
  AV:       { cmap: 'ember',    reverse: false, tour: false, decimals: 2, range: [0.0, 1.6] },
  HaHb:     { cmap: 'ember',    reverse: false, tour: false, decimals: 3, range: [0.46, 0.8] },
};

/** Default grand-tour set (§14), in canonical order. */
// Only near-complete dims (>=96% valid): during a tour every set member carries weight > 0.12,
// so one sparse dim (e.g. OH, 22% valid) would fade most of the sample out (§10 fade rule).
export const TOUR_DEFAULT = ['logM', 'logsSFR', 'D4000', 'logR50', 'C', 'mu50', 'pEl'];

/** Config for a dimension key, merged over DEFAULT_DIM. */
export function dimConfig(key) {
  return { ...DEFAULT_DIM, ...(DIM_CONFIG[key] || {}) };
}

/** Tour-default keys present in the dataset (falls back to the first 6 dims). */
export function defaultTourSet(dims) {
  const have = new Set(dims.map((d) => d.key));
  const keys = TOUR_DEFAULT.filter((k) => have.has(k));
  return keys.length >= 2 ? keys : dims.slice(0, 6).map((d) => d.key);
}

/**
 * Color-normalization range [lo, hi] in physical units for a DimSpec. Uses the configured
 * range when it overlaps the data's 1–99% range, otherwise the 2–98% quantiles.
 */
export function colorRange(spec) {
  const cfg = dimConfig(spec.key);
  const q = spec.quantiles;
  const qlo = q && q.length > 2 ? valueFromQuantiles(q, 2) : spec.min;
  const qhi = q && q.length > 2 ? valueFromQuantiles(q, 98) : spec.max;
  if (cfg.range && cfg.range[1] > cfg.range[0]) {
    const lo1 = q && q.length > 2 ? valueFromQuantiles(q, 1) : spec.min;
    const hi1 = q && q.length > 2 ? valueFromQuantiles(q, 99) : spec.max;
    const overlap = Math.min(cfg.range[1], hi1) - Math.max(cfg.range[0], lo1);
    if (overlap > 0.25 * (cfg.range[1] - cfg.range[0])) return cfg.range.slice();
  }
  return qhi > qlo ? [qlo, qhi] : [spec.min, spec.max];
}

const MINUS = '−';

/** Format a physical value of dimension `key` (unicode minus, per-dim decimals). */
export function formatValue(key, x, { decimals, unit = false, spec } = {}) {
  if (!(x === x)) return '–';
  const d = decimals ?? dimConfig(key).decimals;
  const s = Math.abs(x).toFixed(d);
  const neg = x < 0 && Number(s) !== 0;
  const u = unit && spec && spec.unit ? ` ${spec.unit}` : '';
  return (neg ? MINUS : '') + s + u;
}
