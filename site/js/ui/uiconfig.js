// UI-only configuration: rail group order, category token names, legend chip glyphs, the
// color-cycle order for the `C` key, and small helpers that read the app config.

import { groupColor } from '../config/style.js';

/** Rail group order (DESIGN.md §3.1); unknown groups follow in manifest order. */
export const GROUP_ORDER = ['stars', 'sf', 'chem', 'struct', 'kin', 'gas', 'env', 'lines', 'obs', 'learned'];

export const GROUP_NAMES = {
  stars: 'stellar populations',
  sf: 'star formation',
  chem: 'gas-phase metallicity',
  struct: 'structure',
  kin: 'kinematics',
  gas: 'cold gas',
  env: 'environment',
  lines: 'emission lines',
  obs: 'observation',
  learned: 'learned embedding',
};

/** Rail / dial label of a category. */
export const CAT_TOKEN = { bpt: 'BPT', env: 'ENV', morph: 'GZ' };

/**
 * Legend chip glyphs. `hollow` = low-S/N variant of a class (drawn as a ring swatch, same
 * label); the full class name is in the tooltip.
 */
export const CAT_CHIPS = {
  bpt: { 1: { t: 'SF' }, 2: { t: 'SF', hollow: true }, 3: { t: 'Comp' }, 4: { t: 'Sy' }, 5: { t: 'LIN' }, 6: { t: 'LIN', hollow: true }, 7: { t: '?' } },
  env: { 1: { t: 'iso' }, 2: { t: 'cen' }, 3: { t: 'sat' } },
  morph: { 1: { t: 'E' }, 2: { t: 'S' }, 3: { t: '?' } },
};

export function catToken(spec) {
  return CAT_TOKEN[spec.key] || String(spec.label || spec.key).slice(0, 4).toUpperCase();
}

export function chipFor(spec, code) {
  const c = CAT_CHIPS[spec.key]?.[code];
  if (c) return c;
  const e = spec.codes.find((x) => x.code === code);
  return { t: e ? String(e.label).slice(0, 4) : String(code) };
}

/** Color-cycle order for the `C` key (keys missing from the data are skipped). */
export const COLOR_CYCLE = [
  'logSFR', 'logsSFR', 'D4000', 'gr', 'OH', 'OH_PP04', 'logM', 'logR50', 'C', 'logSigma', 'pEl',
  'logSigV', 'HdA', 'logMh', 'logfHI', 'z', 'cat:bpt', 'cat:env', 'cat:morph', null,
];

export function dimColor(d) {
  return groupColor(d.group);
}

/** Order the dims into rail groups: [{group, color, dims:[DimSpec]}]. */
export function groupedDims(dims) {
  const by = new Map();
  for (const d of dims) {
    if (!by.has(d.group)) by.set(d.group, []);
    by.get(d.group).push(d);
  }
  const keys = [...by.keys()].sort((a, b) => {
    const ia = GROUP_ORDER.indexOf(a), ib = GROUP_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return keys.map((g) => ({ group: g, color: groupColor(g), dims: by.get(g) }));
}

/** Physical-unit label, e.g. "log M★ [M☉]". */
export function dimTitle(d) {
  return d.unit ? `${d.label} [${d.unit}]` : d.label;
}

/** Class counts {code: n} of a category from the raw manifest (the loader drops `n`). */
export function catCounts(data, key) {
  const raw = (data.manifest.categories || []).find((c) => c.key === key);
  const out = {};
  if (raw && Array.isArray(raw.codes)) for (const e of raw.codes) if (e && e.code != null) out[e.code] = e.n || 0;
  return out;
}

/** Number of galaxies without a class for a category (code 0). */
export function catMissing(data, key) {
  const raw = (data.manifest.categories || []).find((c) => c.key === key);
  return raw?.nmissing || 0;
}

/** Split a manifest `short` like "f_HI" into ["f", "HI"] (the part after "_" is a subscript). */
export function shortParts(short) {
  const s = String(short || '');
  const i = s.indexOf('_');
  if (i <= 0 || i === s.length - 1) return [s, ''];
  return [s.slice(0, i), s.slice(i + 1)];
}

/** Children for an HTML label: text plus an optional <sub>. */
export function shortKids(short) {
  const [a, b] = shortParts(short);
  if (!b) return [a];
  const sub = document.createElement('sub');
  sub.textContent = b;
  return [a, sub];
}

/** Plain-text form for aria labels and tooltips ("f HI"). */
export function shortText(short) {
  const [a, b] = shortParts(short);
  return b ? `${a} ${b}` : a;
}
