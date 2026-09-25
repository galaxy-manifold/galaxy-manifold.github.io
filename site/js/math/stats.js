// Small statistics helpers (pure): quantiles, robust scatter, running medians, 2-D histograms,
// manifest-quantile lookups. Missing values are NaN and are skipped everywhere.

/** Linear-interpolated quantile (type 7) of an ascending-sorted array-like. */
export function quantileSorted(sorted, q, lo = 0, hi = sorted.length) {
  const n = hi - lo;
  if (n <= 0) return NaN;
  if (n === 1) return sorted[lo];
  const h = (n - 1) * Math.min(1, Math.max(0, q));
  const i = Math.floor(h);
  const f = h - i;
  const a = sorted[lo + i];
  return i + 1 < n ? a + f * (sorted[lo + i + 1] - a) : a;
}

/** Finite values of `values` (optionally only indices where mask[i]) as a sorted Float64Array. */
export function sortedFinite(values, mask) {
  const out = new Float64Array(values.length);
  let k = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === v && v !== Infinity && v !== -Infinity && (!mask || mask[i])) out[k++] = v;
  }
  return out.subarray(0, k).sort();
}

/** Quantiles qs (array) of the finite values. */
export function quantiles(values, qs, mask) {
  const s = sortedFinite(values, mask);
  return qs.map((q) => quantileSorted(s, q));
}

export function median(values) {
  return quantileSorted(sortedFinite(values), 0.5);
}

/** Robust scatter 1.4826 · MAD of the finite values. */
export function robustScatter(values) {
  const s = sortedFinite(values);
  if (!s.length) return NaN;
  const m = quantileSorted(s, 0.5);
  const d = new Float64Array(s.length);
  for (let i = 0; i < s.length; i++) d[i] = Math.abs(s[i] - m);
  d.sort();
  return 1.4826 * quantileSorted(d, 0.5);
}

/**
 * Percentile (0–100) of value x given a manifest quantile table (101 ascending values,
 * 0th..100th percentile). Linear inside each percentile; flat runs map to their midpoint.
 */
export function percentileFromQuantiles(qtab, x) {
  const n = qtab ? qtab.length : 0;
  if (n < 2 || !(x === x)) return NaN;
  const step = 100 / (n - 1);
  if (x <= qtab[0]) return 0;
  if (x >= qtab[n - 1]) return 100;
  // first index with qtab[i] >= x
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (qtab[mid] < x) lo = mid; else hi = mid;
  }
  // handle a flat run of equal quantiles
  if (qtab[hi] === x) {
    let j = hi;
    while (j + 1 < n && qtab[j + 1] === x) j++;
    return ((hi + j) / 2) * step;
  }
  const a = qtab[lo], b = qtab[hi];
  return (lo + (b > a ? (x - a) / (b - a) : 0.5)) * step;
}

/** Value at percentile p (0–100) from a manifest quantile table. */
export function valueFromQuantiles(qtab, p) {
  const n = qtab ? qtab.length : 0;
  if (n < 2) return NaN;
  const h = (Math.min(100, Math.max(0, p)) / 100) * (n - 1);
  const i = Math.floor(h);
  const f = h - i;
  return i + 1 < n ? qtab[i] + f * (qtab[i + 1] - qtab[i]) : qtab[n - 1];
}

/**
 * Running quantiles of y in bins of x.
 * opts: bins (24), range [x0, x1] (default: 1st–99th percentile of x), minCount (30),
 *       q (quantile levels, default [0.16, 0.5, 0.84]), mask (optional include flags).
 * Returns {edges, centers, count, q: [Float64Array per level]} (NaN where count < minCount).
 */
export function runningQuantiles(xs, ys, opts = {}) {
  const { bins = 24, minCount = 30, q = [0.16, 0.5, 0.84], mask } = opts;
  const n = Math.min(xs.length, ys.length);
  let range = opts.range;
  if (!range) {
    const s = sortedFinite(xs, mask);
    range = [quantileSorted(s, 0.01), quantileSorted(s, 0.99)];
  }
  const [x0, x1] = range;
  const edges = new Float64Array(bins + 1);
  const centers = new Float64Array(bins);
  for (let b = 0; b <= bins; b++) edges[b] = x0 + ((x1 - x0) * b) / bins;
  for (let b = 0; b < bins; b++) centers[b] = 0.5 * (edges[b] + edges[b + 1]);
  const count = new Int32Array(bins);
  const bin = new Int32Array(n);
  const w = bins / (x1 - x0);
  for (let i = 0; i < n; i++) {
    const x = xs[i], y = ys[i];
    if (!(x === x) || !(y === y) || (mask && !mask[i]) || x < x0 || x > x1) { bin[i] = -1; continue; }
    let b = Math.floor((x - x0) * w);
    if (b >= bins) b = bins - 1;
    bin[i] = b;
    count[b]++;
  }
  const start = new Int32Array(bins + 1);
  for (let b = 0; b < bins; b++) start[b + 1] = start[b] + count[b];
  const fill = start.slice(0, bins);
  const vals = new Float64Array(start[bins]);
  for (let i = 0; i < n; i++) if (bin[i] >= 0) vals[fill[bin[i]]++] = ys[i];
  const out = q.map(() => new Float64Array(bins).fill(NaN));
  for (let b = 0; b < bins; b++) {
    if (count[b] < minCount) continue;
    const sub = vals.subarray(start[b], start[b + 1]).sort();
    for (let k = 0; k < q.length; k++) out[k][b] = quantileSorted(sub, q[k]);
  }
  return { edges, centers, count, q: out };
}

/**
 * 2-D histogram. opts: nx, ny, x0, x1, y0, y1, weights (optional), out (Float32Array nx*ny).
 * Row-major with index iy*nx + ix; points outside are skipped.
 */
export function hist2d(xs, ys, opts) {
  const { nx, ny, x0, x1, y0, y1, weights } = opts;
  const out = opts.out && opts.out.length === nx * ny ? opts.out.fill(0) : new Float32Array(nx * ny);
  const sx = nx / (x1 - x0), sy = ny / (y1 - y0);
  const n = Math.min(xs.length, ys.length);
  for (let i = 0; i < n; i++) {
    const ix = Math.floor((xs[i] - x0) * sx), iy = Math.floor((ys[i] - y0) * sy);
    if (ix < 0 || iy < 0 || ix >= nx || iy >= ny) continue;
    out[iy * nx + ix] += weights ? weights[i] : 1;
  }
  return out;
}

/** Mean and standard deviation of the finite values. */
export function meanStd(values) {
  let s = 0, s2 = 0, k = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === v) { s += v; s2 += v * v; k++; }
  }
  if (!k) return [NaN, NaN];
  const m = s / k;
  return [m, Math.sqrt(Math.max(0, s2 / k - m * m))];
}
