// Small dense linear-algebra helpers used by the frame math (pure, no DOM).
// Conventions: vectors are Float64Array (or plain arrays); 2x2 and 3x3 matrices are
// row-major flat arrays.

export const EPS = 1e-12;

export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Dot product of n entries of a (from offset ao) and b (from offset bo). */
export function dot(a, b, n = a.length, ao = 0, bo = 0) {
  let s = 0;
  for (let i = 0; i < n; i++) s += a[ao + i] * b[bo + i];
  return s;
}

export function norm(a, n = a.length, ao = 0) {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const v = a[ao + i];
    s += v * v;
  }
  return Math.sqrt(s);
}

/** Normalize n entries of v in place (from offset o). Returns the previous norm. */
export function normalizeInPlace(v, n = v.length, o = 0) {
  const r = norm(v, n, o);
  if (r > EPS) for (let i = 0; i < n; i++) v[o + i] /= r;
  return r;
}

/** y[yo..] -= alpha * x[xo..] */
export function axpy(alpha, x, y, n, xo = 0, yo = 0) {
  for (let i = 0; i < n; i++) y[yo + i] += alpha * x[xo + i];
}

/** Wrap an angle to (-pi, pi]. */
export function wrapAngle(a) {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
}

/**
 * Signed 2x2 SVD (Blinn's closed form): M = Rot(phi) · diag(s1, s2) · Rot(theta),
 * with s1 >= |s2| >= 0 and sign(s2) = sign(det M). Rot(a) = [[cos a, -sin a], [sin a, cos a]].
 * Both outer factors are proper rotations, so orientation lives in the sign of s2.
 */
export function svd2Signed(m00, m01, m10, m11) {
  const E = (m00 + m11) / 2;
  const F = (m00 - m11) / 2;
  const G = (m10 + m01) / 2;
  const H = (m10 - m01) / 2;
  const Q = Math.hypot(E, H);
  const R = Math.hypot(F, G);
  const a1 = Math.atan2(G, F);
  const a2 = Math.atan2(H, E);
  return {
    s1: Q + R,
    s2: Q - R,
    theta: (a2 - a1) / 2,
    phi: (a2 + a1) / 2,
  };
}

/** 2x2 rotation matrix, row-major. */
export function rot2(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [c, -s, s, c];
}

/** Eigen-decomposition of the symmetric 2x2 [[a, b], [b, c]]: {l1, l2, vx, vy} (v = eigvec of l1). */
export function eigSym2(a, b, c) {
  const tr = a + c;
  const det = a * c - b * b;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc;
  const l2 = tr / 2 - disc;
  let vx, vy;
  if (Math.abs(b) > EPS) {
    vx = l1 - c;
    vy = b;
  } else if (a >= c) {
    vx = 1;
    vy = 0;
  } else {
    vx = 0;
    vy = 1;
  }
  const r = Math.hypot(vx, vy);
  return { l1, l2, vx: vx / r, vy: vy / r };
}

export function cross3(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/**
 * Minimal rotation R in SO(3) (Rodrigues) that maps unit vector s onto unit vector t.
 * Returns a row-major Float64Array(9).
 */
export function rodrigues(s, t) {
  const R = new Float64Array(9);
  const k = cross3(s, t);
  const sn = Math.hypot(k[0], k[1], k[2]);
  const c = s[0] * t[0] + s[1] * t[1] + s[2] * t[2];
  if (sn < 1e-12) {
    if (c > 0) {
      R[0] = R[4] = R[8] = 1;
      return R;
    }
    // antiparallel: rotate by pi about any axis perpendicular to s
    let ax = Math.abs(s[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const p = cross3(s, ax);
    const pn = Math.hypot(p[0], p[1], p[2]);
    ax = [p[0] / pn, p[1] / pn, p[2] / pn];
    // R = 2 a a^T - I
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) R[3 * i + j] = 2 * ax[i] * ax[j] - (i === j ? 1 : 0);
    return R;
  }
  const kx = k[0] / sn, ky = k[1] / sn, kz = k[2] / sn;
  const ang = Math.atan2(sn, c);
  const sa = Math.sin(ang), ca = 1 - Math.cos(ang);
  // R = I + sin(a) K + (1 - cos a) K^2
  R[0] = 1 + ca * (-ky * ky - kz * kz);
  R[1] = -sa * kz + ca * kx * ky;
  R[2] = sa * ky + ca * kx * kz;
  R[3] = sa * kz + ca * kx * ky;
  R[4] = 1 + ca * (-kx * kx - kz * kz);
  R[5] = -sa * kx + ca * ky * kz;
  R[6] = -sa * ky + ca * kx * kz;
  R[7] = sa * kx + ca * ky * kz;
  R[8] = 1 + ca * (-kx * kx - ky * ky);
  return R;
}

/** Apply row-major 3x3 R to vector v. */
export function mat3vec(R, v) {
  return [
    R[0] * v[0] + R[1] * v[1] + R[2] * v[2],
    R[3] * v[0] + R[4] * v[1] + R[5] * v[2],
    R[6] * v[0] + R[7] * v[1] + R[8] * v[2],
  ];
}

/** Seeded PRNG (mulberry32). Returns a function producing floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal deviate from a uniform rng (Box-Muller). */
export function gauss(rng = Math.random) {
  let u = 0;
  while (u <= 1e-300) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
