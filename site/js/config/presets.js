// Canonical views (DESIGN.md §14, plus `mzr2` from the literature agent's recommendation in §19).
// Axes are physical combos {key: coefficient}; x is built
// first and y is Gram–Schmidt'ed against it. `color` is a dim key, 'cat:<key>' or null.
// `filter.cats` holds bitmasks over category codes 0..7 (bit c set = code c shown); a preset
// resets every category it does not mention to "all". `literature` lists relation ids from
// literature.json (ids that do not exist are ignored; relations also carry `view` = preset id).

/** Bitmask over category codes. */
export const codes = (...cs) => cs.reduce((m, c) => m | (1 << c), 0);
export const ALL_CODES = 0xff;

export const PRESETS = [
  { id: 'mzr', code: 'MZR', name: 'Mass–metallicity relation (T04)',
    x: { logM: 1 }, y: { OH: 1 }, color: 'logSFR', filter: null, literature: ['T04'] },
  { id: 'mzr2', code: 'MZRᴾ', name: 'Mass–metallicity relation (PP04 O3N2)',
    x: { logM: 1 }, y: { OH_PP04: 1 }, color: 'logSFR', filter: null, literature: ['KE08', 'AM13', 'C20'] },
  { id: 'fmr', code: 'FMR', name: 'Fundamental metallicity relation (PP04 O3N2)',
    x: { logM: 1, logSFR: -0.32 }, y: { OH_PP04: 1 }, color: 'logSFR', filter: null, literature: ['M10'] },
  { id: 'sfms', code: 'SFMS', name: 'Star-forming main sequence',
    x: { logM: 1 }, y: { logSFR: 1 }, color: 'D4000', filter: null, literature: ['RP15', 'S14', 'S16', 'Q11'] },
  { id: 'ssfr', code: 'sSFR', name: 'Specific SFR vs stellar mass',
    x: { logM: 1 }, y: { logsSFR: 1 }, color: 'cat:env', filter: null, literature: ['RP15s', 'Q11s'] },
  { id: 'cmr', code: 'CMR', name: 'Colour–mass relation',
    x: { logM: 1 }, y: { gr: 1 }, color: 'logsSFR', filter: null, literature: [] },
  { id: 'size', code: 'R–M', name: 'Mass–size relation',
    x: { logM: 1 }, y: { logR50: 1 }, color: 'C', filter: null, literature: ['S03L', 'S03E'] },
  { id: 'sigma', code: 'Σ★', name: 'Stellar surface density vs sSFR',
    x: { logSigma: 1 }, y: { logsSFR: 1 }, color: 'logM', filter: null, literature: ['K03S', 'Q11d'] },
  { id: 'fp', code: 'FP', name: 'Fundamental plane, edge-on (ellipticals)',
    x: { logSigV: 1.49, mu50: 0.30 }, y: { logR50: 1 }, color: 'D4000',
    filter: { cats: { morph: codes(1) } }, literature: ['B03'] },
  { id: 'bpt', code: 'BPT', name: 'BPT diagram',
    x: { N2Ha: 1 }, y: { O3Hb: 1 }, color: 'cat:bpt', filter: null, literature: ['K03', 'K01', 'S07'] },
  { id: 'shmr', code: 'SHMR', name: 'Stellar-to-halo mass relation (centrals)',
    x: { logMh: 1 }, y: { logM: 1 }, color: 'logsSFR',
    filter: { cats: { env: codes(1, 2) } }, literature: ['Mo13', 'B13'] },
  { id: 'env', code: 'ENV', name: 'Halo mass vs sSFR',
    x: { logMh: 1 }, y: { logsSFR: 1 }, color: 'cat:env', filter: null, literature: ['Q11e'] },
  { id: 'hi', code: 'H I', name: 'H I gas fraction vs stellar mass',
    x: { logM: 1 }, y: { logfHI: 1 }, color: 'logsSFR', filter: null, literature: ['C18', 'H12'] },
  { id: 'd4k', code: 'D4k', name: 'Dₙ4000 vs HδA',
    x: { D4000: 1 }, y: { HdA: 1 }, color: 'logsSFR', filter: null, literature: [] },
];

export const DEFAULT_PRESET = 'mzr';

export function presetById(id) {
  return PRESETS.find((p) => p.id === id) || null;
}

/** Presets whose axes only use dims present in the dataset. */
export function availablePresets(dims) {
  const have = new Set(dims.map((d) => d.key));
  return PRESETS.filter((p) => [...Object.keys(p.x), ...Object.keys(p.y)].every((k) => have.has(k)));
}
