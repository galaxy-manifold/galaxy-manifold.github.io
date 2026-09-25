// Pure helpers for the overlays (no DOM, no app): polygon hit-testing for the lasso, polyline
// evaluation for literature offsets, 1-D label spreading, minor ticks, quantile groups for
// trends and the "most typical galaxy per cell" choice for the mosaic.
// Unit-tested in site/tests/overlays.test.mjs.

// ------------------------------------------------------------------ polygons (lasso)

/** Signed area of a polygon given as a flat [x0, y0, x1, y1, …] array (closed implicitly). */
export function polygonArea(poly) {
  const n = poly.length >> 1;
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) a += poly[2 * j] * poly[2 * i + 1] - poly[2 * i] * poly[2 * j + 1];
  return a / 2;
}

/** [x0, x1, y0, y1] bounds of a flat polygon. */
export function polygonBounds(poly) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i + 1 < poly.length; i += 2) {
    const x = poly[i], y = poly[i + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return [x0, x1, y0, y1];
}

/** Reference even–odd point-in-polygon test (O(vertices)). */
export function pointInPolygon(poly, x, y) {
  const n = poly.length >> 1;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[2 * i], yi = poly[2 * i + 1], xj = poly[2 * j], yj = poly[2 * j + 1];
    if ((yi > y) !== (yj > y) && x < xj + ((y - yj) * (xi - xj)) / (yi - yj)) inside = !inside;
  }
  return inside;
}

/**
 * Scanline index of a polygon for fast even–odd tests of many points (O(log k) each).
 * Each horizontal band of height `step` is tested at its center line, so answers can differ
 * from the exact test only within step/2 (vertically) of an edge.
 * Returns {bounds: [x0, x1, y0, y1], contains(x, y)}.
 */
export function polygonIndex(poly, step = 0.5) {
  const n = poly.length >> 1;
  const bounds = polygonBounds(poly);
  const [x0, x1, y0, y1] = bounds;
  if (n < 3 || !(x1 > x0) || !(y1 > y0)) return { bounds, contains: () => false };
  const S = Math.max(1, Math.ceil((y1 - y0) / step));
  const rows = Array.from({ length: S }, () => []);
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xa = poly[2 * j], ya = poly[2 * j + 1], xb = poly[2 * i], yb = poly[2 * i + 1];
    if (ya === yb) continue;
    const lo = Math.min(ya, yb), hi = Math.max(ya, yb);
    // scanline s sits at y = y0 + (s + ½)·step; an edge counts when lo ≤ y < hi
    const s0 = Math.max(0, Math.ceil((lo - y0) / step - 0.5));
    const s1 = Math.min(S - 1, Math.ceil((hi - y0) / step - 0.5) - 1);
    const k = (xb - xa) / (yb - ya);
    for (let s = s0; s <= s1; s++) rows[s].push(xa + (y0 + (s + 0.5) * step - ya) * k);
  }
  const sorted = rows.map((r) => Float64Array.from(r).sort());
  return {
    bounds,
    contains(x, y) {
      if (!(x >= x0 && x <= x1 && y >= y0 && y <= y1)) return false;
      let s = Math.floor((y - y0) / step);
      if (s >= S) s = S - 1;
      const r = sorted[s];
      let lo = 0, hi = r.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (r[mid] < x) lo = mid + 1;
        else hi = mid;
      }
      return (lo & 1) === 1;
    },
  };
}

// ------------------------------------------------------------------ polylines (literature)

/**
 * Evaluate a polyline y(x) given as [[x, y], …] (any order; sorted internally). Returns a
 * function x → y by linear interpolation, NaN outside the x range or for non-finite x.
 */
export function polylineFunction(points) {
  const pts = (points || []).filter((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  pts.sort((a, b) => a[0] - b[0]);
  const n = pts.length;
  const xs = Float64Array.from(pts, (p) => p[0]);
  const ys = Float64Array.from(pts, (p) => p[1]);
  return (x) => {
    if (!(n >= 2) || !(x >= xs[0] && x <= xs[n - 1])) return n === 1 && x === xs[0] ? ys[0] : NaN;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= x) lo = mid;
      else hi = mid;
    }
    const dx = xs[hi] - xs[lo];
    return dx > 0 ? ys[lo] + ((x - xs[lo]) / dx) * (ys[hi] - ys[lo]) : ys[lo];
  };
}

// ------------------------------------------------------------------ native planes (literature)

/**
 * Projection of a native plane (unit u-space vectors of the relation's x and y combos, from
 * frame.comboVector) into frame F — the same mapping as frame.nativeMap, without allocation
 * per point: {pxx, pxy, pyx, pyy, ax, ay, g, det, toFrame(Ax, Ay, dy = 0) → [X, Y]}.
 * ax/ay are the alignments |v̂x·px|, |v̂y·py|; det = 1 − (v̂x·v̂y)². Returns null if the two
 * combos are parallel.
 */
export function nativeAxes(cx, cy, F) {
  const D = F.length >> 1;
  const vx = cx.v, vy = cy.v;
  let pxx = 0, pxy = 0, pyx = 0, pyy = 0, g = 0;
  for (let d = 0; d < D; d++) {
    const a = F[d], b = F[D + d];
    pxx += a * vx[d];
    pxy += a * vy[d];
    pyx += b * vx[d];
    pyy += b * vy[d];
    g += vx[d] * vy[d];
  }
  const det = 1 - g * g;
  if (!(det > 1e-9)) return null;
  return {
    pxx, pxy, pyx, pyy, g, det, ax: Math.abs(pxx), ay: Math.abs(pyy),
    toFrame(Ax, Ay, dy = 0) {
      const xn = (Ax - cx.offset) / cx.norm, yn = (Ay + dy - cy.offset) / cy.norm;
      const a = (xn - g * yn) / det, b = (yn - g * xn) / det;
      return [pxx * a + pxy * b, pyx * a + pyy * b];
    },
  };
}

// ------------------------------------------------------------------ labels & ticks

/**
 * Positions p_k for preferred positions pref_k *in the given order*, with p_{k+1} − p_k ≥ gap,
 * minimizing Σ (p_k − pref_k)² (isotonic regression of pref_k − k·gap by pool-adjacent-
 * violators), then shifted into [lo, hi] as a block when it fits (else started at lo).
 */
export function spreadOrdered(pref, gap, lo = -Infinity, hi = Infinity) {
  const n = pref.length;
  if (!n) return [];
  // blocks of pooled values: [sum, count]
  const sum = [], cnt = [];
  for (let k = 0; k < n; k++) {
    sum.push(pref[k] - k * gap);
    cnt.push(1);
    while (sum.length > 1 && sum[sum.length - 2] / cnt[cnt.length - 2] > sum[sum.length - 1] / cnt[cnt.length - 1]) {
      sum[sum.length - 2] += sum.pop();
      cnt[cnt.length - 2] += cnt.pop();
    }
  }
  const out = new Array(n);
  let k = 0;
  for (let b = 0; b < sum.length; b++) {
    const q = sum[b] / cnt[b];
    for (let j = 0; j < cnt[b]; j++, k++) out[k] = q + k * gap;
  }
  const span = out[n - 1] - out[0];
  let shift = 0;
  if (out[0] < lo) shift = lo - out[0];
  if (out[n - 1] + shift > hi) shift = hi - out[n - 1];
  if (out[0] + shift < lo && span > hi - lo) shift = lo - out[0];
  for (let j = 0; j < n; j++) out[j] += shift;
  return out;
}

/**
 * Spread 1-D positions so that sorted neighbors are at least `gap` apart (least squares,
 * order kept), staying inside [lo, hi] when there is room. Returns a new array in the input
 * order.
 */
export function spreadPositions(pos, gap, lo = -Infinity, hi = Infinity) {
  const n = pos.length;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => pos[a] - pos[b]);
  const p = spreadOrdered(order.map((i) => pos[i]), gap, lo, hi);
  const out = new Array(n);
  order.forEach((i, k) => { out[i] = p[k]; });
  return out;
}

/**
 * Candidate top-left positions [x, y, far] for a label box (w × h) at a curve end (ax, ay) with
 * the curve's direction (dx, dy) there, best first. At a true end the first choice is just past
 * it along the curve; where the curve leaves the plot the label sits inside, beside the curve.
 * A second, farther ring (far = true, drawn with a leader) follows for crowded spots.
 */
export function labelCandidates({ ax, ay, dx = 1, dy = 0, w, h, trueEnd = true }, gap = 5) {
  const ring = (gp, far) => {
    if (!trueEnd) {
      const out = [];
      let nx = -dy, ny = dx;
      if (ny > 0) { nx = -nx; ny = -ny; }   // the upper side first
      for (const t of [w / 2 + gp, w + 3 * gp]) {
        for (const side of [1, -1]) {
          const cx = ax - dx * t + side * nx * (h / 2 + gp), cy = ay - dy * t + side * ny * (h / 2 + gp);
          out.push([cx - w / 2, cy - h / 2, far]);
        }
      }
      return out;
    }
    const vertical = Math.abs(dy) > 0.92;
    const right = [
      [ax + gp, ay - h / 2 + 4 * dy, far],    // past the end
      [ax + 2, ay - h - gp, far],             // above right
      [ax + 2, ay + gp, far],                 // below right
    ];
    const left = [
      [ax - w - gp, ay - h / 2 + 4 * dy, far],
      [ax - w - 2, ay - h - gp, far],
      [ax - w - 2, ay + gp, far],
    ];
    const above = [ax - w / 2, ay - h - gp - 2, far], below = [ax - w / 2, ay + gp + 2, far];
    if (vertical) return dy < 0 ? [above, right[1], left[1], below, ...right, ...left] : [below, right[2], left[2], above, ...right, ...left];
    return dx >= 0 ? [...right, above, below, ...left] : [...left, above, below, ...right];
  };
  return [...ring(gap, false), ...ring(gap + h + 8, true)];
}

/**
 * Greedy label placement. items: [{ax, ay, dx, dy, w, h, trueEnd}] in priority order;
 * obstacles: flat [x, y, weight, …] (curve vertices, curve ends) that labels should not
 * cover. Each label takes the cheapest in-bounds candidate (labelCandidates) scored by
 * overlap with labels placed before it (1000 each), covered obstacle weight and a small
 * preference for earlier (and near) candidates; with no candidate in bounds, the first one is
 * clamped into bounds (fallback: true). `blocked` rects [{x, y, w, h}] (e.g. axis titles) count
 * like placed labels. Returns [{x, y, far, fallback}] (far: draw a leader to the anchor).
 */
export function chooseLabelBoxes(items, obstacles, bounds, { pad = 2, blocked = [] } = {}) {
  const placed = blocked.slice();
  const out = [];
  for (const it of items) {
    const cands = labelCandidates(it);
    let best = null, bestScore = Infinity;
    cands.forEach(([x, y, far], ci) => {
      if (x < bounds.l || y < bounds.t || x + it.w > bounds.r || y + it.h > bounds.b) return;
      let score = 3 * ci + (far ? 40 : 0);
      for (const p of placed) if (x < p.x + p.w + 2 && p.x < x + it.w + 2 && y < p.y + p.h + 1 && p.y < y + it.h + 1) score += 1000;
      for (let k = 0; k + 2 < obstacles.length; k += 3) {
        const px = obstacles[k], py = obstacles[k + 1];
        if (px >= x - pad && px <= x + it.w + pad && py >= y - pad && py <= y + it.h + pad) score += obstacles[k + 2];
      }
      if (score < bestScore) { bestScore = score; best = { x, y, far: !!far, fallback: false }; }
    });
    if (!best) {
      const [x, y] = cands[0];
      best = { x: Math.max(bounds.l, Math.min(bounds.r - it.w, x)), y: Math.max(bounds.t, Math.min(bounds.b - it.h, y)), far: true, fallback: true };
    }
    placed.push({ x: best.x, y: best.y, w: it.w, h: it.h });
    out.push(best);
  }
  return out;
}

/** Minor-tick spacing for a 1-2-5 major step (1 → /5, 2 → /4, 5 → /5). */
export function minorStep(step) {
  if (!(step > 0) || !Number.isFinite(step)) return 0;
  const p = Math.pow(10, Math.floor(Math.log10(step) + 1e-9));
  const m = Math.round(step / p);
  return m === 2 ? step / 4 : step / 5;
}

/** Minor tick values in [lo, hi] that are not majors (multiples of `step`). */
export function minorTicks(lo, hi, step, max = 400) {
  const ms = minorStep(step);
  if (!(ms > 0) || !(hi > lo)) return [];
  const out = [];
  const i0 = Math.ceil(lo / ms - 1e-9), i1 = Math.floor(hi / ms + 1e-9);
  const per = Math.round(step / ms);
  for (let i = i0; i <= i1 && out.length < max; i++) {
    if (((i % per) + per) % per === 0) continue;
    out.push(i * ms);
  }
  return out;
}

// ------------------------------------------------------------------ groups (trends)

/** Quantile-type-7 of an ascending array. */
function qsorted(s, q) {
  const n = s.length;
  if (!n) return NaN;
  const h = (n - 1) * q;
  const i = Math.floor(h);
  return i + 1 < n ? s[i] + (h - i) * (s[i + 1] - s[i]) : s[n - 1];
}

/**
 * Inner edges of `groups` equal-count groups of the finite values (length groups − 1), plus
 * the median of each group: {edges, medians}. Values equal to an edge go to the upper group.
 */
export function quantileGroups(values, groups = 4) {
  const s = Float64Array.from(values).filter((v) => v === v).sort();
  const edges = new Float64Array(Math.max(0, groups - 1));
  const medians = new Float64Array(groups);
  for (let g = 1; g < groups; g++) edges[g - 1] = qsorted(s, g / groups);
  for (let g = 0; g < groups; g++) medians[g] = qsorted(s, (g + 0.5) / groups);
  return { edges, medians };
}

/** Group index of v for inner edges (−1 for NaN). */
export function groupIndex(v, edges) {
  if (!(v === v)) return -1;
  let g = 0;
  while (g < edges.length && v >= edges[g]) g++;
  return g;
}

// ------------------------------------------------------------------ mosaic

/**
 * Most typical candidate per cell (§15): for each cell, the candidate whose standardized
 * vector is closest to the mean vector of the cell's candidates. Distance is the mean squared
 * difference over the dims valid for both (NaN = missing), so candidates with fewer valid
 * dims are not favored. All candidates count toward the mean; only `eligible` ones (when
 * given) can be chosen.
 *   cellOf: Int32Array(K) cell id per candidate (−1 = none) · U: Float32Array(K·D), NaN missing
 * Returns Map(cellId → candidate index). Ties go to the lower index.
 */
export function typicalPerCell(cellOf, U, D, eligible = null) {
  const K = cellOf.length;
  const members = new Map();
  for (let k = 0; k < K; k++) {
    const c = cellOf[k];
    if (c < 0) continue;
    let m = members.get(c);
    if (!m) members.set(c, (m = []));
    m.push(k);
  }
  const mean = new Float64Array(D), cnt = new Int32Array(D);
  const out = new Map();
  for (const [c, list] of members) {
    if (eligible && !list.some((k) => eligible[k])) continue;
    mean.fill(0);
    cnt.fill(0);
    for (const k of list) {
      const o = k * D;
      for (let d = 0; d < D; d++) {
        const u = U[o + d];
        if (u === u) { mean[d] += u; cnt[d]++; }
      }
    }
    for (let d = 0; d < D; d++) mean[d] = cnt[d] ? mean[d] / cnt[d] : NaN;
    let best = -1, bd = Infinity;
    for (const k of list) {
      if (eligible && !eligible[k]) continue;
      const o = k * D;
      let s = 0, m = 0;
      for (let d = 0; d < D; d++) {
        const u = U[o + d], mu = mean[d];
        if (u === u && mu === mu) { const e = u - mu; s += e * e; m++; }
      }
      const dist = m ? s / m : Infinity;
      if (dist < bd || best < 0) { bd = dist; best = k; }
    }
    if (best >= 0) out.set(c, best);
  }
  return out;
}

/** Stagger delays (ms) for tiles by distance from a center, capped at maxMs. */
export function staggerDelay(dx, dy, cell, perCell = 18, maxMs = 420) {
  return Math.min(maxMs, (Math.hypot(dx, dy) / Math.max(1, cell)) * perCell);
}
