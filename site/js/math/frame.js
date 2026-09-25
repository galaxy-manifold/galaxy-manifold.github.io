// Projection math (DESIGN.md §10). Pure functions, no DOM, unit-tested in
// site/tests/frame.test.mjs.
//
// A frame F is a D×2 matrix with orthonormal columns in standardized u-space, stored
// column-major as Float64Array(2D): [px_0..px_{D-1}, py_0..py_{D-1}].
// Projected coordinates of a galaxy with standardized vector u: X = px·u, Y = py·u.
//
// `dims` arguments are arrays of DimSpec-like objects with {key, label, unit, center, scale}
// in canonical (frame) order.

import {
  EPS, clamp, smoothstep, dot, norm, svd2Signed, rodrigues, wrapAngle, gauss, eigSym2,
} from './linalg.js';

export const FADE_WIDTH = 0.12;   // w_d at which a missing dimension hides a point
export const VIS_MIN = 0.01;      // points below this visibility are discarded
export const MAX_TARGET_R2 = 0.995;
export const LABEL_MIN_WEIGHT = 0.08;
export const LIT_ALIGN_LO = 0.90;
export const LIT_ALIGN_HI = 0.985;

// ---------------------------------------------------------------------------------------
// basics
// ---------------------------------------------------------------------------------------

export function frameDim(F) {
  return F.length >> 1;
}

export function makeFrame(D) {
  return new Float64Array(2 * D);
}

/** Frame with x = e_i and y = e_j. */
export function basisFrame(D, i, j) {
  const F = makeFrame(D);
  F[i] = 1;
  F[D + j] = 1;
  return F;
}

export function copyFrame(F, out) {
  if (!out || out.length !== F.length) out = new Float64Array(F.length);
  out.set(F);
  return out;
}

/** View of column c (0 = x, 1 = y). */
export function column(F, c) {
  const D = F.length >> 1;
  return F.subarray(c * D, c * D + D);
}

export function orthonormalityError(F) {
  const D = F.length >> 1;
  const xx = dot(F, F, D, 0, 0);
  const yy = dot(F, F, D, D, D);
  const xy = dot(F, F, D, 0, D);
  return Math.max(Math.abs(xx - 1), Math.abs(yy - 1), Math.abs(xy));
}

export function isOrthonormal(F, tol = 1e-9) {
  return orthonormalityError(F) <= tol;
}

/** Index of the basis vector least represented in the unit vector x (for fallbacks). */
function leastAligned(x, D, off, exclude = -1) {
  let best = -1, bv = Infinity;
  for (let i = 0; i < D; i++) {
    if (i === exclude) continue;
    const v = Math.abs(x[off + i]);
    if (v < bv) { bv = v; best = i; }
  }
  return best;
}

/**
 * Gram–Schmidt (x first, then y against x), in place by default. Two passes on y for
 * accuracy. Degenerate columns are replaced by a basis direction so the result is always
 * a valid frame.
 */
export function orthonormalize(F, out = F) {
  const D = F.length >> 1;
  if (out !== F) out.set(F);
  let nx = norm(out, D, 0);
  if (!(nx > EPS)) {
    out.fill(0, 0, D);
    const k = leastAligned(out, D, D);
    out[k >= 0 ? k : 0] = 1;
    nx = 1;
  }
  for (let i = 0; i < D; i++) out[i] /= nx;
  for (let pass = 0; pass < 2; pass++) {
    const d = dot(out, out, D, 0, D);
    for (let i = 0; i < D; i++) out[D + i] -= d * out[i];
  }
  let ny = norm(out, D, D);
  if (!(ny > 1e-9)) {
    const k = leastAligned(out, D, 0);
    for (let i = 0; i < D; i++) out[D + i] = (i === k ? 1 : 0) - out[k] * out[i];
    ny = norm(out, D, D);
  }
  for (let i = 0; i < D; i++) out[D + i] /= ny;
  return out;
}

/**
 * Symmetric re-orthonormalization by polar decomposition: F (FᵀF)^(-1/2), the closest
 * orthonormal frame to F. Falls back to Gram–Schmidt for (near) rank-deficient input.
 */
export function polarOrthonormalize(F, out = F) {
  const D = F.length >> 1;
  const a = dot(F, F, D, 0, 0), b = dot(F, F, D, 0, D), c = dot(F, F, D, D, D);
  const { l1, l2, vx, vy } = eigSym2(a, b, c);
  if (!(l2 > 1e-10 * Math.max(1, l1))) return orthonormalize(F, out);
  // S^-1/2 = V diag(l^-1/2) Vᵀ with V = [[vx, -vy], [vy, vx]]
  const i1 = 1 / Math.sqrt(l1), i2 = 1 / Math.sqrt(l2);
  const s00 = vx * vx * i1 + vy * vy * i2;
  const s01 = vx * vy * (i1 - i2);
  const s11 = vy * vy * i1 + vx * vx * i2;
  const res = out === F ? new Float64Array(F.length) : out;
  for (let i = 0; i < D; i++) {
    const x = F[i], y = F[D + i];
    res[i] = x * s00 + y * s01;
    res[D + i] = x * s01 + y * s11;
  }
  if (res !== out) out.set(res);
  return orthonormalize(out, out);   // polish residual rounding
}

/**
 * Uniform random 2-frame restricted to the span of the dims in `indices` (Gaussian matrix +
 * Gram–Schmidt). If fewer than 2 indices are given, all dims are used.
 */
export function randomFrame(D, indices, rng = Math.random) {
  const idx = indices && indices.length >= 2 ? indices : [...Array(D).keys()];
  const F = makeFrame(D);
  for (const i of idx) {
    F[i] = gauss(rng);
    F[D + i] = gauss(rng);
  }
  return orthonormalize(F);
}

/** Per-dimension in-view weight w_d = sqrt(px_d² + py_d²). */
export function dimWeights(F, out) {
  const D = F.length >> 1;
  if (!out) out = new Float64Array(D);
  for (let i = 0; i < D; i++) out[i] = Math.hypot(F[i], F[D + i]);
  return out;
}

/** Missing-value fade factors f_d = clamp(1 − w_d / 0.12, 0, 1). */
export function fadeFactors(F, out, width = FADE_WIDTH) {
  const D = F.length >> 1;
  if (!out) out = new Float32Array(D);
  for (let i = 0; i < D; i++) out[i] = clamp(1 - Math.hypot(F[i], F[D + i]) / width, 0, 1);
  return out;
}

/** Visibility of a point given a bitmask of its missing dims and the fade factors. */
export function visibility(missingMask, fade) {
  let v = 1;
  let m = missingMask >>> 0;
  while (m) {
    const b = 31 - Math.clz32(m);
    v *= fade[b] === undefined ? 1 : fade[b];
    m &= ~(1 << b);
  }
  return v;
}

// ---------------------------------------------------------------------------------------
// physical combos <-> frame columns
// ---------------------------------------------------------------------------------------

function findDim(dims, key) {
  for (let i = 0; i < dims.length; i++) if (dims[i].key === key) return i;
  return -1;
}

/**
 * Physical combo {key: κ} → unit u-space vector v̂ (v_d = κ_d·scale_d, normalized).
 * Returns {v, norm, offset = Σ κ_d c_d, terms} or null if the combo is empty/unknown.
 */
export function comboVector(combo, dims) {
  const D = dims.length;
  const v = new Float64Array(D);
  let offset = 0, terms = 0;
  for (const key in combo || {}) {
    const kappa = +combo[key];
    const i = findDim(dims, key);
    if (i < 0 || !Number.isFinite(kappa) || kappa === 0) continue;
    v[i] += kappa * dims[i].scale;
    offset += kappa * dims[i].center;
    terms++;
  }
  const n = norm(v);
  if (!(n > EPS)) return null;
  for (let i = 0; i < D; i++) v[i] /= n;
  return { v, norm: n, offset, terms };
}

/**
 * Frame from physical combos: x first, then Gram–Schmidt y against x.
 * Returns {F, degenerate:false} or {F:null, degenerate:true} when y ∥ x (or a combo is empty).
 */
export function frameFromCombos(x, y, dims) {
  const D = dims.length;
  const cx = comboVector(x, dims);
  const cy = comboVector(y, dims);
  if (!cx || !cy) return { F: null, degenerate: true };
  const F = makeFrame(D);
  F.set(cx.v, 0);
  F.set(cy.v, D);
  for (let pass = 0; pass < 2; pass++) {
    const d = dot(F, F, D, 0, D);
    for (let i = 0; i < D; i++) F[D + i] -= d * F[i];
  }
  const ny = norm(F, D, D);
  if (!(ny > 1e-6)) return { F: null, degenerate: true };
  for (let i = 0; i < D; i++) F[D + i] /= ny;
  return { F, degenerate: false };
}

/**
 * Frame column c as a physical combo {key: κ} that reproduces the column direction exactly
 * (orientation included): κ_d = k_d / |k_r| with k_d = p_d / scale_d, r = argmax |p_d|.
 * Terms with |p_d| < minWeight are dropped (default keeps everything non-negligible).
 */
export function columnCombo(F, c, dims, { minWeight = 1e-7 } = {}) {
  const D = F.length >> 1;
  const off = c * D;
  let r = -1, best = -1;
  for (let i = 0; i < D; i++) {
    const a = Math.abs(F[off + i]);
    if (a > best) { best = a; r = i; }
  }
  const out = {};
  if (r < 0 || !(best > EPS)) return out;
  const kr = Math.abs(F[off + r] / dims[r].scale);
  for (let i = 0; i < D; i++) {
    const p = F[off + i];
    if (Math.abs(p) < minWeight) continue;
    out[dims[i].key] = p / dims[i].scale / kr;
  }
  return out;
}

/** Both frame columns as physical combos: {x, y}. */
export function frameToCombos(F, dims, opts) {
  return { x: columnCombo(F, 0, dims, opts), y: columnCombo(F, 1, dims, opts) };
}

// ---------------------------------------------------------------------------------------
// physical axis labels and ticks
// ---------------------------------------------------------------------------------------

/**
 * Physical-axis description of frame column c (§10):
 *   k_d = p_d / scale_d, r = argmax|p_d|, κ_d = k_d / k_r (κ_r = 1),
 *   A = Σ κ_d x_d = (X + Σ k_d c_d) / k_r,  X = k_r A − Σ k_d c_d.
 * Returns {col, ref, refKey, kr, kappa, offset, terms:[{index,key,kappa,weight}], single}.
 */
export function axisInfo(F, c, dims, { minLabelWeight = LABEL_MIN_WEIGHT } = {}) {
  const D = F.length >> 1;
  const off = c * D;
  let r = 0, best = -1;
  for (let i = 0; i < D; i++) {
    const a = Math.abs(F[off + i]);
    if (a > best) { best = a; r = i; }
  }
  if (!(best > EPS)) return null;
  const kr = F[off + r] / dims[r].scale;
  const kappa = new Float64Array(D);
  let offset = 0;
  const terms = [];
  for (let i = 0; i < D; i++) {
    const p = F[off + i];
    const k = p / dims[i].scale;
    kappa[i] = k / kr;
    offset += k * dims[i].center;
    if (Math.abs(p) >= minLabelWeight) terms.push({ index: i, key: dims[i].key, kappa: kappa[i], weight: Math.abs(p) });
  }
  terms.sort((a, b) => (a.index === r ? -1 : b.index === r ? 1 : b.weight - a.weight));
  return { col: c, ref: r, refKey: dims[r].key, kr, kappa, offset, terms, single: terms.length === 1 };
}

/** Physical axis value A at projected coordinate X. */
export function axisValue(info, X) {
  return (X + info.offset) / info.kr;
}

/** Projected coordinate X of physical axis value A (tick position). */
export function axisPosition(info, A) {
  return info.kr * A - info.offset;
}

const MINUS = '−';

/** Format a number with a unicode minus. */
export function fmtNum(x, decimals) {
  const s = Math.abs(x).toFixed(decimals);
  const neg = x < 0 && Number(s) !== 0;
  return (neg ? MINUS : '') + s;
}

/** Axis title, e.g. "log M★ − 0.32 log SFR" or "log M★ [M☉]" for a single term. */
export function axisLabel(info, dims, { decimals = 2 } = {}) {
  if (!info || !info.terms.length) return '';
  let s = '';
  info.terms.forEach((t, n) => {
    const lab = dims[t.index].label;
    if (n === 0) {
      s = lab;
      return;
    }
    const mag = Math.abs(t.kappa).toFixed(decimals);
    const coef = mag === (1).toFixed(decimals) ? '' : mag + ' ';
    s += (t.kappa < 0 ? ` ${MINUS} ` : ' + ') + coef + lab;
  });
  if (info.single) {
    const u = dims[info.ref].unit;
    if (u) s += ` [${u}]`;
  }
  return s;
}

/** 1-2-5 "nice" step nearest (in log space) to a raw spacing. */
export function niceStep(raw) {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m < Math.SQRT2 ? 1 : m < Math.sqrt(10) ? 2 : m < Math.sqrt(50) ? 5 : 10) * p;
}

export function stepDecimals(step) {
  return clamp(Math.ceil(-Math.log10(step) - 1e-9), 0, 8);
}

/**
 * Ticks in physical units over the projected range [X0, X1]:
 * [{X, A, text}] sorted by X, with ~`count` ticks at 1-2-5 steps.
 */
export function axisTicks(info, X0, X1, { count = 6 } = {}) {
  if (!info) return [];
  const a0 = axisValue(info, X0), a1 = axisValue(info, X1);
  const lo = Math.min(a0, a1), hi = Math.max(a0, a1);
  if (!(hi > lo)) return [];
  const step = niceStep((hi - lo) / Math.max(1, count));
  const dec = stepDecimals(step);
  const i0 = Math.ceil(lo / step - 1e-9), i1 = Math.floor(hi / step + 1e-9);
  const out = [];
  for (let i = i0; i <= i1 && out.length < 200; i++) {
    const A = i * step;
    out.push({ X: axisPosition(info, A), A, text: fmtNum(A, dec) });
  }
  out.sort((p, q) => p.X - q.X);
  return out;
}

// ---------------------------------------------------------------------------------------
// alignment of native (literature / preset) axes with the frame
// ---------------------------------------------------------------------------------------

/** |v̂·p_c| for combo (or unit vector) against frame column c. */
export function alignment(combo, F, c, dims) {
  const v = combo instanceof Float64Array ? combo : comboVector(combo, dims)?.v;
  if (!v) return 0;
  const D = F.length >> 1;
  return Math.abs(dot(v, F, D, 0, c * D));
}

/** Signed v̂·p_c (negative when the axis is flipped). */
export function signedAlignment(combo, F, c, dims) {
  const v = combo instanceof Float64Array ? combo : comboVector(combo, dims)?.v;
  if (!v) return 0;
  const D = F.length >> 1;
  return dot(v, F, D, 0, c * D);
}

/** Literature visibility: smoothstep(0.90, 0.985, min(align_x, align_y)). */
export function literatureOpacity(xCombo, yCombo, F, dims) {
  const ax = alignment(xCombo, F, 0, dims);
  const ay = alignment(yCombo, F, 1, dims);
  return smoothstep(LIT_ALIGN_LO, LIT_ALIGN_HI, Math.min(ax, ay));
}

/**
 * How closely the frame matches the frame built from (x, y) combos (orientation-aware):
 * min(v̂x·px, v̂y'·py), where v̂y' is y Gram–Schmidt'ed against x. 1 = identical view.
 */
export function viewAlignment(xCombo, yCombo, F, dims) {
  const T = frameFromCombos(xCombo, yCombo, dims).F;
  if (!T) return 0;
  const D = F.length >> 1;
  return Math.min(dot(T, F, D, 0, 0), dot(T, F, D, D, D));
}

/**
 * Mapping from a native plane (A_x along xCombo, A_y along yCombo, physical units) into the
 * current frame's projected coordinates. Native coordinate X_n = (A_x − Σκ_d c_d)/|v_x|
 * (§10); the native point is placed in span(v̂x, v̂y) and projected with F, so curves turn
 * and mirror correctly as the frame moves.
 * Returns {ax, ay, opacity, toFrame(Ax, Ay) → [X, Y], toNative(Ax, Ay) → [Xn, Yn]} or null.
 */
export function nativeMap(xCombo, yCombo, F, dims) {
  const cx = comboVector(xCombo, dims), cy = comboVector(yCombo, dims);
  if (!cx || !cy) return null;
  const D = F.length >> 1;
  const g = dot(cx.v, cy.v, D);
  const det = 1 - g * g;
  if (!(det > 1e-9)) return null;
  const pxx = dot(F, cx.v, D, 0, 0), pxy = dot(F, cy.v, D, 0, 0);
  const pyx = dot(F, cx.v, D, D, 0), pyy = dot(F, cy.v, D, D, 0);
  const ax = Math.abs(pxx), ay = Math.abs(pyy);
  const toNative = (Ax, Ay) => [(Ax - cx.offset) / cx.norm, (Ay - cy.offset) / cy.norm];
  const toFrame = (Ax, Ay) => {
    const xn = (Ax - cx.offset) / cx.norm, yn = (Ay - cy.offset) / cy.norm;
    // u = a v̂x + b v̂y with v̂x·u = xn, v̂y·u = yn
    const a = (xn - g * yn) / det, b = (yn - g * xn) / det;
    return [pxx * a + pxy * b, pyx * a + pyy * b];
  };
  return { ax, ay, opacity: smoothstep(LIT_ALIGN_LO, LIT_ALIGN_HI, Math.min(ax, ay)), toFrame, toNative };
}

// ---------------------------------------------------------------------------------------
// manual tour (Cook & Buja 1997)
// ---------------------------------------------------------------------------------------

/** Unit vector orthogonal to the frame plane, preferring basis dims in `prefer`. */
function outOfPlaneDirection(F, exclude, prefer) {
  const D = F.length >> 1;
  const m = new Float64Array(D);
  const residual = (k) => {
    const a = F[k], b = F[D + k];
    for (let i = 0; i < D; i++) m[i] = -a * F[i] - b * F[D + i];
    m[k] += 1;
    return norm(m);
  };
  const tryList = [];
  if (Array.isArray(prefer)) {
    for (const k of prefer) if (Number.isInteger(k) && k !== exclude && k >= 0 && k < D) tryList.push(k);
  } else if (Number.isInteger(prefer) && prefer !== exclude && prefer >= 0 && prefer < D) {
    tryList.push(prefer);
  }
  for (const k of tryList) {
    const r = residual(k);
    if (r > 0.5) {
      for (let i = 0; i < D; i++) m[i] /= r;
      return m;
    }
  }
  // otherwise the basis direction with the largest out-of-plane residual (lowest index wins)
  let bestK = -1, bestR = -1;
  for (let k = 0; k < D; k++) {
    if (k === exclude) continue;
    const r2 = 1 - F[k] * F[k] - F[D + k] * F[D + k];
    if (r2 > bestR + 1e-12) { bestR = r2; bestK = k; }
  }
  const r = residual(bestK);
  for (let i = 0; i < D; i++) m[i] /= r;
  return m;
}

/**
 * Manual rotation: move dim j's projection (px_j, py_j) to the target (a′, b′), clamped to
 * a′² + b′² ≤ 0.995, by the minimal rotation within span(f1, f2, e_j) (Cook & Buja 1997).
 * If e_j already lies in the plane and the target is on the rim, rotates in-plane.
 * Options: prefer (dim index or array of indices) = out-of-plane direction to use when e_j
 * lies in the plane and the target is inside the rim.
 * Returns a new orthonormal frame.
 */
export function manualRotate(F, j, target, { prefer, maxR2 = MAX_TARGET_R2 } = {}) {
  const D = F.length >> 1;
  let ta = +target[0], tb = +target[1];
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return copyFrame(F);
  let r2 = ta * ta + tb * tb;
  const onRim = r2 >= maxR2 - 1e-12;
  if (r2 > maxR2) {
    const s = Math.sqrt(maxR2 / r2);
    ta *= s;
    tb *= s;
    r2 = maxR2;
  }
  const tc = Math.sqrt(Math.max(0, 1 - r2));
  const a = F[j], b = F[D + j];
  const m = new Float64Array(D);
  for (let i = 0; i < D; i++) m[i] = -a * F[i] - b * F[D + i];
  m[j] += 1;
  let c = norm(m);
  const out = new Float64Array(2 * D);
  if (c < 1e-7) {
    if (onRim) {
      // e_j lies in the plane and the target is on the rim: rotate in-plane (§10 step 1)
      const d = Math.atan2(tb, ta) - Math.atan2(b, a);
      const cs = Math.cos(d), sn = Math.sin(d);
      for (let i = 0; i < D; i++) {
        out[i] = cs * F[i] - sn * F[D + i];
        out[D + i] = sn * F[i] + cs * F[D + i];
      }
      return orthonormalize(out);
    }
    // target inside the rim: tilt out of the plane toward a preferred dimension
    m.set(outOfPlaneDirection(F, j, prefer));
    c = 0;
  } else {
    for (let i = 0; i < D; i++) m[i] /= c;
  }
  const sn = Math.hypot(a, b, c);
  const s = [a / sn, b / sn, c / sn];
  const R = rodrigues(s, [ta, tb, tc]);
  for (let i = 0; i < D; i++) {
    const f1 = F[i], f2 = F[D + i], mm = m[i];
    out[i] = R[0] * f1 + R[1] * f2 + R[2] * mm;
    out[D + i] = R[3] * f1 + R[4] * f2 + R[5] * mm;
  }
  return orthonormalize(out);
}

// ---------------------------------------------------------------------------------------
// geodesic interpolation (Buja et al. 2005)
// ---------------------------------------------------------------------------------------

/** Principal angles (unsigned, in [0, π/2]) between the planes of Fa and Fb. */
export function principalAngles(Fa, Fb) {
  const D = Fa.length >> 1;
  const m00 = dot(Fa, Fb, D, 0, 0), m01 = dot(Fa, Fb, D, 0, D);
  const m10 = dot(Fa, Fb, D, D, 0), m11 = dot(Fa, Fb, D, D, D);
  const { s1, s2 } = svd2Signed(m00, m01, m10, m11);
  return [Math.acos(clamp(s1, -1, 1)), Math.acos(clamp(Math.abs(s2), -1, 1))];
}

/** Grassmann distance sqrt(θ1² + θ2²) between the planes of two frames. */
export function frameDistance(Fa, Fb) {
  const [a, b] = principalAngles(Fa, Fb);
  return Math.hypot(a, b);
}

/**
 * Geodesic path from Fa to Fb. Principal directions come from the signed SVD of FaᵀFb
 * (both outer factors proper rotations), so the path preserves orientation: when the
 * in-plane map would be a reflection, one principal angle exceeds 90° instead (an axis
 * swap animates as a flip about the diagonal). F(0) = Fa and F(1) = Fb exactly; F(t) is
 * orthonormal throughout.
 * Options: noSpin — drop the in-plane rotation (grand-tour legs); the endpoint is then
 *   Gb·Uᵀ, same plane as Fb. prefer — dim indices to flip through when a principal angle
 *   is ~180° (the path direction is otherwise arbitrary).
 * Returns {at(t, out?) → Float64Array, angles:[θ1, θ2], spin: ψ, dist, target}.
 */
export function geodesic(Fa, Fb, { noSpin = false, prefer } = {}) {
  const D = Fa.length >> 1;
  const m00 = dot(Fa, Fb, D, 0, 0), m01 = dot(Fa, Fb, D, 0, D);
  const m10 = dot(Fa, Fb, D, D, 0), m11 = dot(Fa, Fb, D, D, D);
  const { s1, s2, theta, phi } = svd2Signed(m00, m01, m10, m11);
  const cu = Math.cos(phi), su = Math.sin(phi);      // U = Rot(phi)
  const cv = Math.cos(-theta), sv = Math.sin(-theta); // V = Rot(-theta)
  // Ga = Fa U, Gb = Fb V (columns)
  const Ga1 = new Float64Array(D), Ga2 = new Float64Array(D);
  const Gb1 = new Float64Array(D), Gb2 = new Float64Array(D);
  for (let i = 0; i < D; i++) {
    const xa = Fa[i], ya = Fa[D + i], xb = Fb[i], yb = Fb[D + i];
    Ga1[i] = cu * xa + su * ya;
    Ga2[i] = -su * xa + cu * ya;
    Gb1[i] = cv * xb + sv * yb;
    Gb2[i] = -sv * xb + cv * yb;
  }
  const c1 = clamp(s1, -1, 1), c2 = clamp(s2, -1, 1);
  const th1 = Math.acos(c1), th2 = Math.acos(c2);
  const N1 = new Float64Array(D), N2 = new Float64Array(D);
  const makeN = (N, Gb, Ga, cth, th, other, otherOk) => {
    for (let i = 0; i < D; i++) N[i] = Gb[i] - cth * Ga[i];
    // exact orthogonality against Ga1, Ga2 (and the other N)
    const prj = (w) => { const d = dot(N, w, D); for (let i = 0; i < D; i++) N[i] -= d * w[i]; };
    prj(Ga1); prj(Ga2);
    if (otherOk) prj(other);
    let r = norm(N, D);
    if (r > 1e-7 && Math.sin(th) > 1e-7) {
      for (let i = 0; i < D; i++) N[i] /= r;
      return true;
    }
    if (th < Math.PI / 2) { N.fill(0); return false; }   // θ≈0: direction irrelevant
    // θ≈π: choose any direction orthogonal to both planes (and the other N)
    const cands = [];
    if (Array.isArray(prefer)) cands.push(...prefer);
    for (let k = 0; k < D; k++) cands.push(k);
    for (const k of cands) {
      if (k < 0 || k >= D) continue;
      N.fill(0);
      N[k] = 1;
      prj(Ga1); prj(Ga2);
      const w1 = Fb.subarray(0, D), w2 = Fb.subarray(D, 2 * D);
      prj(w1); prj(w2);
      if (otherOk) prj(other);
      r = norm(N, D);
      if (r > 0.3) {
        for (let i = 0; i < D; i++) N[i] /= r;
        return true;
      }
    }
    N.fill(0);
    return false;
  };
  const ok1 = makeN(N1, Gb1, Ga1, c1, th1, N2, false);
  makeN(N2, Gb2, Ga2, c2, th2, N1, ok1);
  const psi = noSpin ? 0 : wrapAngle(theta + phi);
  // endpoint
  let target;
  if (noSpin) {
    target = new Float64Array(2 * D);
    for (let i = 0; i < D; i++) {
      // Gb Uᵀ: col0 = Gb1 U00 + Gb2 U01, col1 = Gb1 U10 + Gb2 U11
      target[i] = Gb1[i] * cu - Gb2[i] * su;
      target[D + i] = Gb1[i] * su + Gb2[i] * cu;
    }
    orthonormalize(target);
  } else {
    target = copyFrame(Fb);
  }
  const start = copyFrame(Fa);
  const at = (t, out) => {
    if (!out || out.length !== 2 * D) out = new Float64Array(2 * D);
    if (!(t > 0)) { out.set(start); return out; }
    if (t >= 1) { out.set(target); return out; }
    const a1 = t * th1, a2 = t * th2;
    const k1c = Math.cos(a1), k1s = Math.sin(a1), k2c = Math.cos(a2), k2s = Math.sin(a2);
    // W = Rot(tψ) Uᵀ
    const rc = Math.cos(t * psi), rs = Math.sin(t * psi);
    // Uᵀ = [[cu, su], [-su, cu]]
    const w00 = rc * cu - rs * -su, w01 = rc * su - rs * cu;
    const w10 = rs * cu + rc * -su, w11 = rs * su + rc * cu;
    for (let i = 0; i < D; i++) {
      const g1 = k1c * Ga1[i] + k1s * N1[i];
      const g2 = k2c * Ga2[i] + k2s * N2[i];
      out[i] = g1 * w00 + g2 * w10;
      out[D + i] = g1 * w01 + g2 * w11;
    }
    return orthonormalize(out);
  };
  return { at, angles: [th1, th2], spin: psi, dist: Math.hypot(th1, th2), target };
}

/**
 * Linear blend + polar re-orthonormalization (the §10 fallback). Kept for reference and
 * tests; `geodesic` never needs it because it handles orientation via the signed SVD.
 */
export function blendFrames(Fa, Fb, t, out) {
  const n = Fa.length;
  if (!out) out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = (1 - t) * Fa[i] + t * Fb[i];
  return polarOrthonormalize(out, out);
}
