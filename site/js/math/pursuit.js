// Projection pursuit "tighten" (DESIGN.md §15). Keep the y direction fixed and search the x
// direction, within the span of at most five dimensions, that minimizes the robust scatter
// (1.4826·MAD) of y about its running median in x. Pure functions, no DOM; the search is a
// generator so the caller can time-slice it (see js/view/overlays/tighten.js).
// Unit-tested in site/tests/overlays.test.mjs.

// ------------------------------------------------------------------ order statistics

/**
 * Hoare quickselect: reorders a[lo..hi] (inclusive) so that a[k] holds the k-th smallest value,
 * everything before it is ≤ and everything after it is ≥. Returns a[k]. No NaNs allowed.
 */
export function quickselect(a, k, lo = 0, hi = a.length - 1) {
  while (hi > lo) {
    const mid = (lo + hi) >> 1;
    let t;
    if (a[mid] < a[lo]) { t = a[mid]; a[mid] = a[lo]; a[lo] = t; }
    if (a[hi] < a[lo]) { t = a[hi]; a[hi] = a[lo]; a[lo] = t; }
    if (a[hi] < a[mid]) { t = a[hi]; a[hi] = a[mid]; a[mid] = t; }
    const pivot = a[mid];
    let i = lo, j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) {
        t = a[i]; a[i] = a[j]; a[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return a[k];
  }
  return a[k];
}

/** Median of a[lo..hi) (reorders that range). Even counts average the two middle values. */
export function medianRange(a, lo, hi) {
  const n = hi - lo;
  if (n <= 0) return NaN;
  const k = lo + ((n - 1) >> 1);
  const m1 = quickselect(a, k, lo, hi - 1);
  if (n & 1) return m1;
  let m2 = Infinity;
  for (let i = k + 1; i < hi; i++) if (a[i] < m2) m2 = a[i];
  return 0.5 * (m1 + m2);
}

function grow(s, n, bins) {
  if (!s.tmp || s.tmp.length < n) {
    s.tmp = new Float64Array(n);
    s.vals = new Float64Array(n);
    s.res = new Float64Array(n);
    s.bin = new Int32Array(n);
  }
  if (!s.cnt || s.cnt.length < bins + 1) {
    s.cnt = new Int32Array(bins + 1);
    s.start = new Int32Array(bins + 1);
    s.fill = new Int32Array(bins + 1);
    s.curve = new Float64Array(bins + 1);
  }
}

/**
 * Robust scatter of Y about its running median in X.
 * Bins: `bins` equal-width bins over the [qlo, qhi] quantile range of X (points outside are
 * ignored), a bin's median counts when it holds ≥ minCount points, and the running median is
 * the piecewise-linear curve through the bin centers (flat past the end bins, interpolated
 * over sparse bins). The scatter is 1.4826 × MAD of the residuals, which is invariant to the
 * scale and sign of X.
 * opts.residuals (Float64Array n, optional) receives Y − curve (NaN for ignored points).
 * Returns {sigma, used, validBins, x0, x1} (sigma NaN when there are too few points).
 */
export function runningScatter(X, Y, n, opts = {}, s = {}) {
  const { bins = 24, minCount = 30, qlo = 0.01, qhi = 0.99, residuals = null } = opts;
  const bad = { sigma: NaN, used: 0, validBins: 0, x0: NaN, x1: NaN };
  if (residuals) residuals.fill(NaN, 0, n);
  if (!(n >= 2 * minCount) || bins < 2) return bad;
  grow(s, n, bins);
  const { tmp, vals, res, bin, cnt, start, fill, curve } = s;
  for (let i = 0; i < n; i++) tmp[i] = X[i];
  const x0 = quickselect(tmp, Math.floor(qlo * (n - 1)), 0, n - 1);
  const x1 = quickselect(tmp, Math.ceil(qhi * (n - 1)), 0, n - 1);
  if (!(x1 > x0)) return bad;
  const w = bins / (x1 - x0);
  cnt.fill(0, 0, bins);
  for (let i = 0; i < n; i++) {
    const x = X[i];
    if (!(x >= x0 && x <= x1)) { bin[i] = -1; continue; }
    let b = Math.floor((x - x0) * w);
    if (b >= bins) b = bins - 1;
    bin[i] = b;
    cnt[b]++;
  }
  start[0] = 0;
  for (let b = 0; b < bins; b++) start[b + 1] = start[b] + cnt[b];
  for (let b = 0; b < bins; b++) fill[b] = start[b];
  for (let i = 0; i < n; i++) {
    const b = bin[i];
    if (b >= 0) vals[fill[b]++] = Y[i];
  }
  let first = -1, last = -1, valid = 0;
  for (let b = 0; b < bins; b++) {
    if (cnt[b] >= minCount) {
      curve[b] = medianRange(vals, start[b], start[b + 1]);
      if (first < 0) first = b;
      last = b;
      valid++;
    } else curve[b] = NaN;
  }
  if (valid < 2) return bad;
  for (let b = 0; b < first; b++) curve[b] = curve[first];
  for (let b = last + 1; b < bins; b++) curve[b] = curve[last];
  for (let b = first + 1; b < last; b++) {
    if (curve[b] === curve[b]) continue;
    let e = b + 1;
    while (!(curve[e] === curve[e])) e++;
    const a = curve[b - 1], c = curve[e];
    for (let k = b; k < e; k++) curve[k] = a + ((c - a) * (k - b + 1)) / (e - b + 1);
    b = e;
  }
  let m = 0;
  for (let i = 0; i < n; i++) {
    if (bin[i] < 0) continue;
    const t = (X[i] - x0) * w - 0.5;
    const b0 = Math.floor(t);
    let c;
    if (b0 < 0) c = curve[0];
    else if (b0 >= bins - 1) c = curve[bins - 1];
    else c = curve[b0] + (t - b0) * (curve[b0 + 1] - curve[b0]);
    const r = Y[i] - c;
    res[m++] = r;
    if (residuals) residuals[i] = r;
  }
  const mr = medianRange(res, 0, m);
  for (let j = 0; j < m; j++) res[j] = Math.abs(res[j] - mr);
  const mad = medianRange(res, 0, m);
  return { sigma: 1.4826 * mad, used: m, validBins: valid, x0, x1 };
}

// ------------------------------------------------------------------ small regression helpers

/** Pearson correlation of a and b over the first n entries where both are finite. */
export function pearson(a, b, n = Math.min(a.length, b.length)) {
  let k = 0, sa = 0, sb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i];
    if (x === x && y === y) { k++; sa += x; sb += y; }
  }
  if (k < 3) return NaN;
  const ma = sa / k, mb = sb / k;
  let saa = 0, sbb = 0, sab = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i];
    if (x === x && y === y) {
      const da = x - ma, db = y - mb;
      saa += da * da;
      sbb += db * db;
      sab += da * db;
    }
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}

/** Solve the small dense system A x = b (row-major n×n) by Gaussian elimination; null if singular. */
export function solveSmall(A, b, n) {
  const M = Float64Array.from(A), v = Float64Array.from(b);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r * n + c]) > Math.abs(M[p * n + c])) p = r;
    if (!(Math.abs(M[p * n + c]) > 1e-12)) return null;
    if (p !== c) {
      for (let k = 0; k < n; k++) { const t = M[c * n + k]; M[c * n + k] = M[p * n + k]; M[p * n + k] = t; }
      const t = v[c]; v[c] = v[p]; v[p] = t;
    }
    for (let r = c + 1; r < n; r++) {
      const f = M[r * n + c] / M[c * n + c];
      if (!f) continue;
      for (let k = c; k < n; k++) M[r * n + k] -= f * M[c * n + k];
      v[r] -= f * v[c];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = v[r];
    for (let k = r + 1; k < n; k++) s -= M[r * n + k] * x[k];
    x[r] = s / M[r * n + r];
  }
  return x;
}

/**
 * R² of the least-squares fit y ≈ c0 + Σ c_j cols_j over rows where y and all cols are finite.
 * Returns 0 for no columns and NaN when there are too few rows.
 */
export function rSquared(y, cols, n = y.length) {
  const p = cols.length + 1;
  if (p === 1) return 0;
  const A = new Float64Array(p * p), b = new Float64Array(p);
  const row = new Float64Array(p);
  let k = 0, sy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const v = y[i];
    if (!(v === v)) continue;
    row[0] = 1;
    let ok = true;
    for (let j = 1; j < p; j++) {
      const u = cols[j - 1][i];
      if (!(u === u)) { ok = false; break; }
      row[j] = u;
    }
    if (!ok) continue;
    k++;
    sy += v;
    syy += v * v;
    for (let r = 0; r < p; r++) {
      b[r] += row[r] * v;
      for (let c = 0; c < p; c++) A[r * p + c] += row[r] * row[c];
    }
  }
  if (k < p + 2) return NaN;
  const coef = solveSmall(A, b, p);
  if (!coef) return 1;   // exactly collinear columns
  const sst = syy - (sy * sy) / k;
  if (!(sst > 0)) return 1;
  let ssr = 0;   // explained sum of squares = coefᵀ b − (Σy)²/k
  for (let r = 0; r < p; r++) ssr += coef[r] * b[r];
  ssr -= (sy * sy) / k;
  return Math.min(1, Math.max(0, ssr / sst));
}

// ------------------------------------------------------------------ Nelder–Mead

/**
 * Nelder–Mead minimization as a generator (yields after the initial simplex and after every
 * iteration; the return value is {x, f, evals, iters}). Non-finite objective values count
 * as +∞. opts: step (number or per-coordinate array), maxEvals, tolX, tolF.
 */
export function* nelderMead(f, x0, { step = 0.25, maxEvals = 300, tolX = 1e-4, tolF = 1e-7 } = {}) {
  const n = x0.length;
  let evals = 0;
  const F = (x) => {
    evals++;
    const v = f(x);
    return v === v ? v : Infinity;
  };
  if (n === 0) return { x: new Float64Array(0), f: F(new Float64Array(0)), evals, iters: 0 };
  const steps = Array.isArray(step) || ArrayBuffer.isView(step) ? step : new Array(n).fill(step);
  let P = [Float64Array.from(x0)];
  for (let i = 0; i < n; i++) {
    const p = Float64Array.from(x0);
    p[i] += steps[i] || 0.25;
    P.push(p);
  }
  let fv = P.map(F);
  yield;
  const cen = new Float64Array(n);
  const pt = (base, dir, t) => {
    const o = new Float64Array(n);
    for (let j = 0; j < n; j++) o[j] = base[j] + t * (dir[j] - base[j]);
    return o;
  };
  let iters = 0;
  while (evals < maxEvals) {
    const order = fv.map((v, i) => i).sort((a, b) => fv[a] - fv[b]);
    P = order.map((i) => P[i]);
    fv = order.map((i) => fv[i]);
    let dx = 0;
    for (let i = 1; i <= n; i++) for (let j = 0; j < n; j++) dx = Math.max(dx, Math.abs(P[i][j] - P[0][j]));
    const df = fv[n] - fv[0];
    if (dx <= tolX || (df <= tolF * (Math.abs(fv[0]) + 1e-12) && dx <= 10 * tolX)) break;
    cen.fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) cen[j] += P[i][j] / n;
    const worst = P[n];
    const xr = pt(cen, worst, -1);
    const fr = F(xr);
    if (fr < fv[0]) {
      const xe = pt(cen, worst, -2);
      const fe = F(xe);
      if (fe < fr) { P[n] = xe; fv[n] = fe; } else { P[n] = xr; fv[n] = fr; }
    } else if (fr < fv[n - 1]) {
      P[n] = xr;
      fv[n] = fr;
    } else {
      const outside = fr < fv[n];
      const xc = outside ? pt(cen, xr, 0.5) : pt(cen, worst, 0.5);
      const fc = F(xc);
      if (fc < Math.min(fr, fv[n])) {
        P[n] = xc;
        fv[n] = fc;
      } else {
        for (let i = 1; i <= n; i++) {
          P[i] = pt(P[0], P[i], 0.5);
          fv[i] = F(P[i]);
        }
      }
    }
    iters++;
    yield;
  }
  let b = 0;
  for (let i = 1; i < fv.length; i++) if (fv[i] < fv[b]) b = i;
  return { x: P[b], f: fv[b], evals, iters };
}

/** Run a generator to completion synchronously and return its value (tests, workers). */
export function runSync(gen) {
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
  }
}

// ------------------------------------------------------------------ the tighten search

/**
 * 1-D minimization of f(a) on [lo, hi]: a coarse grid with spacing `step`, then golden-section
 * refinement around the best grid point. Generator (yields every few evaluations); returns
 * [a, f(a)]. Keeps a = `keep` (e.g. 0) when nothing beats f(keep).
 */
export function* scan1d(f, lo, hi, step, { keep = 0, fKeep = f(keep), iters = 12, every = 4 } = {}) {
  let ba = keep, bf = fKeep, k = 0;
  for (let a = lo; a <= hi + 1e-9; a += step) {
    const v = f(a);
    if (v < bf) { bf = v; ba = a; }
    if (++k % every === 0) yield;
  }
  const r = (Math.sqrt(5) - 1) / 2;
  let a0 = ba - step, a1 = ba + step;
  let c = a1 - r * (a1 - a0), d = a0 + r * (a1 - a0);
  let fc = f(c), fd = f(d);
  for (let i = 0; i < iters; i++) {
    if (fc < fd) { a1 = d; d = c; fd = fc; c = a1 - r * (a1 - a0); fc = f(c); }
    else { a0 = c; c = d; fc = fd; d = a0 + r * (a1 - a0); fd = f(d); }
    if (++k % every === 0) yield;
  }
  if (fc < bf) { bf = fc; ba = c; }
  if (fd < bf) { bf = fd; ba = d; }
  return [ba, bf];
}

/**
 * Search the x direction that tightens y (§15), as forward-stepwise projection pursuit.
 *   p.Y: Float64Array(N)           projected y of the sample rows
 *   p.cols: [{key, u: Float64Array(N) (NaN = missing), w0, current}]
 *           candidate x dims in u-space; `current` ones are in the current x (weight w0)
 *   p.ref: index of the reference column (current, largest |w0|); its coefficient is fixed at 1
 *   p.allowed(chosenIdx[], j) → bool   optional veto (e.g. definitional identities with y)
 * Options: maxDims 5 · bins 24 · minCount 30 · minGain 0.03 (a dim is added only if it cuts
 *   the scatter by ≥ 3 %) · minCoverage 0.8 (of the base rows must have the dim, so adding it
 *   does not quietly change the sample) · maxR2 0.9 (collinearity with the chosen dims) ·
 *   maxScan 8 (candidates screened per round, pre-ranked by |corr| with the residual of y about
 *   its running median in the current x) · scanRows 10000 · grid [−4, 4] step 0.5 (u-space
 *   coefficient relative to the reference) · pruneTol 0.004 · minRows 400.
 * Each round screens the candidates with a 1-D search on its coefficient, adds the best one
 * if it gains enough, and re-optimizes all free coefficients jointly with Nelder–Mead. At the
 * end, dims whose removal barely matters are pruned and the rest is refined.
 * Returns {chosen: [col index] (ref first), coef: Float64Array (u-space, ref = 1), sigma0 (the
 * starting direction on the final rows), sigma, n, evals, ranked, trace: [{key, gain}] (dims
 * in the order they were added), screen: [{j, key, a, gain}] (first round: each candidate's
 * best single coefficient and gain on its own)}.
 */
export function* tightenSearch(p) {
  const {
    Y, cols, ref, allowed = null,
    maxDims = 5, bins = 24, minCount = 30, minGain = 0.03, minCoverage = 0.8, maxR2 = 0.9,
    maxScan = 8, scanRows = 10000, grid = [-4, 4, 0.5], pruneTol = 0.004, minRows = 400,
  } = p;
  const N = Y.length;
  const current = cols.map((c, j) => j).filter((j) => cols[j].current && j !== ref);
  current.unshift(ref);
  const isValid = (j, i) => { const u = cols[j].u[i]; return u === u; };
  const baseIdx = [];
  for (let i = 0; i < N; i++) {
    if (!(Y[i] === Y[i])) continue;
    if (current.every((j) => isValid(j, i))) baseIdx.push(i);
  }
  const nb = baseIdx.length;
  const w0r = cols[ref].w0 || 1;
  const coef = new Map(current.map((j) => [j, cols[j].w0 / w0r]));
  coef.set(ref, 1);
  const scratch = {};
  let evals = 0;

  /** Objective on the base rows valid for every col in `list` (at most `cap` rows). */
  function problem(list, cap = Infinity) {
    const rows = [];
    for (let k = 0; k < nb && rows.length < cap; k++) {
      const i = baseIdx[k];
      if (list.every((j) => isValid(j, i))) rows.push(i);
    }
    const n = rows.length;
    const U = list.map((j) => Float64Array.from(rows, (i) => cols[j].u[i]));
    const Yp = Float64Array.from(rows, (i) => Y[i]);
    const Xs = new Float64Array(n);
    const f = (w) => {
      evals++;
      for (let k = 0; k < n; k++) {
        let x = 0;
        for (let q = 0; q < U.length; q++) x += w[q] * U[q][k];
        Xs[k] = x;
      }
      return runningScatter(Xs, Yp, n, { bins, minCount }, scratch).sigma;
    };
    return { n, f, U };
  }

  // pre-rank candidates by |corr| with the residual of y about its running median in x
  const base = problem(current);
  const Xb = new Float64Array(base.n);
  for (let k = 0; k < base.n; k++) {
    let x = 0;
    current.forEach((j, q) => { x += coef.get(j) * base.U[q][k]; });
    Xb[k] = x;
  }
  const Yb = Float64Array.from(baseIdx, (i) => Y[i]);
  const resid = new Float64Array(nb);
  const sigmaBase = runningScatter(Xb, Yb, nb, { bins, minCount, residuals: resid }, scratch).sigma;
  yield;
  const ranked = [];
  const tmp = new Float64Array(nb);
  for (let j = 0; j < cols.length; j++) {
    if (current.includes(j)) continue;
    let valid = 0;
    for (let k = 0; k < nb; k++) {
      const u = cols[j].u[baseIdx[k]];
      tmp[k] = u;
      if (u === u) valid++;
    }
    if (valid < minCoverage * nb) continue;
    const r = pearson(tmp, resid, nb);
    if (r === r) ranked.push({ j, key: cols[j].key, score: Math.abs(r) });
  }
  ranked.sort((a, b) => b.score - a.score);
  const screen = ranked.slice(0, maxScan);
  yield;

  const chosen = current.slice(0, maxDims);
  const trace = [];
  const screen1 = [];   // first round: best single-dim coefficient and gain of every candidate
  const [glo, ghi, gstep] = grid;
  let round = 0;
  while (chosen.length < maxDims) {
    let best = null;
    round++;
    for (const c of screen) {
      if (chosen.includes(c.j)) continue;
      if (allowed && !allowed(chosen, c.j)) continue;
      const list = [...chosen, c.j];
      let joint = 0;
      for (let k = 0; k < nb; k++) if (list.every((j) => isValid(j, baseIdx[k]))) joint++;
      if (joint < Math.max(minRows, minCoverage * nb)) continue;
      if (chosen.length > 0 && !(rSquared(cols[c.j].u, chosen.map((j) => cols[j].u), N) <= maxR2)) continue;
      const P = problem(list, scanRows);
      if (P.n < minRows) continue;
      const w = list.map((j) => (j === c.j ? 0 : coef.get(j)));
      const q = w.length - 1;
      const f1 = (a) => { w[q] = a; return P.f(w); };
      const f0 = f1(0);
      const [a, fa] = yield* scan1d(f1, glo, ghi, gstep, { keep: 0, fKeep: f0 });
      const gain = f0 > 0 ? 1 - fa / f0 : 0;
      if (round === 1) screen1.push({ j: c.j, key: cols[c.j].key, a, gain, sigma0: f0, sigma: fa });
      if (!best || gain > best.gain) best = { j: c.j, a, gain };
      yield;
    }
    if (!best || !(best.gain >= minGain)) break;
    chosen.push(best.j);
    coef.set(best.j, best.a);
    trace.push({ key: cols[best.j].key, gain: best.gain });
    // joint refinement of every free coefficient
    const P = problem(chosen);
    const free = chosen.filter((j) => j !== ref);
    if (free.length > 1 && P.n >= minRows) {
      const fw = (x) => P.f(chosen.map((j) => (j === ref ? 1 : x[free.indexOf(j)])));
      const x0 = Float64Array.from(free, (j) => coef.get(j));
      const nm = yield* nelderMead(fw, x0, { step: 0.2, maxEvals: 40 + 40 * free.length, tolX: 2e-3 });
      if (nm.f < fw(x0)) free.forEach((j, t) => coef.set(j, nm.x[t]));
    }
  }
  yield;

  // final rows, starting scatter, joint polish (incl. current non-reference dims), pruning
  let P = problem(chosen);
  if (P.n < minRows) {
    chosen.length = current.length;
    P = problem(chosen);
  }
  const start = chosen.map((j) => (current.includes(j) ? cols[j].w0 / w0r : 0));
  start[0] = 1;
  const sigma0 = P.f(start);
  let free = chosen.filter((j) => j !== ref);
  const fAll = (x) => P.f(chosen.map((j) => (j === ref ? 1 : x[free.indexOf(j)])));
  let x = Float64Array.from(free, (j) => coef.get(j));
  let fx = free.length ? fAll(x) : sigma0;
  if (free.length) {
    const nm = yield* nelderMead(fAll, x, { step: 0.15, maxEvals: 40 + 40 * free.length, tolX: 1e-3 });
    if (nm.f < fx) { x = Float64Array.from(nm.x); fx = nm.f; }
    // prune: drop dims (smallest |coef|·sd first) whose removal costs < pruneTol
    const sd = free.map((j) => {
      const u = P.U[chosen.indexOf(j)];
      let s = 0, s2 = 0;
      for (let k = 0; k < u.length; k++) { s += u[k]; s2 += u[k] * u[k]; }
      const m = s / Math.max(1, u.length);
      return Math.sqrt(Math.max(0, s2 / Math.max(1, u.length) - m * m));
    });
    const order = free.map((_, t) => t).sort((a, b) => Math.abs(x[a]) * sd[a] - Math.abs(x[b]) * sd[b]);
    for (const t of order) {
      const trial = Float64Array.from(x);
      trial[t] = 0;
      const ft = fAll(trial);
      if (ft <= fx * (1 + pruneTol)) { x = trial; fx = ft; }
    }
    yield;
  }
  const outChosen = [ref], outCoef = [1];
  free.forEach((j, t) => { if (x[t] !== 0) { outChosen.push(j); outCoef.push(x[t]); } });
  // a pure sign/scale-free improvement check against the starting direction
  if (!(fx < sigma0)) {
    return { chosen: current.slice(), coef: Float64Array.from(current, (j) => (j === ref ? 1 : cols[j].w0 / w0r)), sigma0, sigma: sigma0, sigmaBase, n: P.n, evals, ranked, trace, screen: screen1 };
  }
  return { chosen: outChosen, coef: Float64Array.from(outCoef), sigma0, sigma: fx, sigmaBase, n: P.n, evals, ranked, trace, screen: screen1 };
}
