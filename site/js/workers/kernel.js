// Full-sample projection kernel (pure; used by project.worker.js and by the time-sliced
// main-thread fallback in view/projection.js).
//
// ctx:  {n, D, raw: Uint16Array[D], ua: Float64Array(D), ub: Float64Array(D), cats: Uint8Array[4]|null}
//       u = v * ua[d] + ub[d] for raw value v ≥ 1; v = 0 is missing.
// req:  {F: Float64Array(2D), fade: Float32Array(D), zDim, zlo, zhi (u; zDim < 0 = off),
//        masks: Uint32Array(4) (visible-code bitmask per category slot)}
// out:  {X: Float32Array(n), Y: Float32Array(n), vis: Uint8Array(n), visf: Float32Array(n)}
//       vis = round(255 · visibility) including filters; 0 = hidden (visibility < 0.01).

export const VIS_MIN = 0.01;

/** Project rows [i0, i1). Column-major over the dims that are in view. */
export function projectRange(ctx, req, out, i0, i1) {
  const { D, raw, ua, ub } = ctx;
  const { F, fade } = req;
  const FD = F.length >> 1;
  const { X, Y, vis, visf } = out;
  for (let i = i0; i < i1; i++) { X[i] = 0; Y[i] = 0; visf[i] = 1; }
  for (let d = 0; d < Math.min(D, FD); d++) {
    const px = F[d], py = F[FD + d];
    if (px === 0 && py === 0) continue;
    const col = raw[d];
    if (!col) continue;
    const a = ua[d], b = ub[d], f = fade[d];
    for (let i = i0; i < i1; i++) {
      const v = col[i];
      if (v !== 0) {
        const u = v * a + b;
        X[i] += px * u;
        Y[i] += py * u;
      } else if (f < 1) {
        visf[i] *= f;
      }
    }
  }
  const zd = req.zDim;
  if (zd >= 0 && raw[zd]) {
    const col = raw[zd], a = ua[zd], b = ub[zd], lo = req.zlo, hi = req.zhi;
    for (let i = i0; i < i1; i++) {
      const v = col[i];
      if (v === 0) { visf[i] = 0; continue; }
      const u = v * a + b;
      if (u < lo || u > hi) visf[i] = 0;
    }
  }
  const masks = req.masks;
  if (masks && ctx.cats) {
    for (let s = 0; s < 4; s++) {
      const m = masks[s] >>> 0;
      const c = ctx.cats[s];
      if (!c || (m & 0xff) === 0xff) continue;
      for (let i = i0; i < i1; i++) {
        const code = c[i];
        if (((m >>> (code > 31 ? 31 : code)) & 1) === 0) visf[i] = 0;
      }
    }
  }
  for (let i = i0; i < i1; i++) {
    const f = visf[i];
    vis[i] = f < VIS_MIN ? 0 : Math.max(1, Math.round(255 * f));
  }
}

/**
 * Uniform grid over the visible points for picking. Bounds are the 0.1–99.9% range of a
 * subsample (outliers are clamped into edge cells; queries still check exact distances).
 * Returns {x0, y0, cw, ch, G, start: Uint32Array(G*G+1), items: Uint32Array(nvis)}.
 */
export function buildGrid(X, Y, vis, n, G = 256) {
  const it = buildGridSteps(X, Y, vis, n, G);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}

/** buildGrid as an iterator that yields every `chunk` rows (time-sliced callers). */
export function* buildGridSteps(X, Y, vis, n, G = 256, chunk = 65536) {
  let nvis = 0;
  const step = Math.max(1, Math.floor(n / 20000));
  const xs = [], ys = [];
  for (let i = 0; i < n; i++) {
    if (vis[i] === 0) continue;
    nvis++;
    if (i % step === 0) { xs.push(X[i]); ys.push(Y[i]); }
    if (i % chunk === chunk - 1) yield;
  }
  if (!nvis) return { x0: 0, y0: 0, cw: 1, ch: 1, G, start: new Uint32Array(G * G + 1), items: new Uint32Array(0), nvis: 0 };
  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);
  const q = (a, p) => a[Math.min(a.length - 1, Math.max(0, Math.round(p * (a.length - 1))))];
  let x0 = q(xs, 0.001), x1 = q(xs, 0.999), y0 = q(ys, 0.001), y1 = q(ys, 0.999);
  if (!(x1 > x0)) { x0 -= 0.5; x1 += 0.5; }
  if (!(y1 > y0)) { y0 -= 0.5; y1 += 0.5; }
  const cw = (x1 - x0) / G, ch = (y1 - y0) / G;
  const cell = (i) => {
    let cx = Math.floor((X[i] - x0) / cw), cy = Math.floor((Y[i] - y0) / ch);
    cx = cx < 0 ? 0 : cx >= G ? G - 1 : cx;
    cy = cy < 0 ? 0 : cy >= G ? G - 1 : cy;
    return cy * G + cx;
  };
  const start = new Uint32Array(G * G + 1);
  for (let i = 0; i < n; i++) {
    if (vis[i] !== 0) start[cell(i) + 1]++;
    if (i % chunk === chunk - 1) yield;
  }
  for (let c = 0; c < G * G; c++) start[c + 1] += start[c];
  const fill = start.slice(0, G * G);
  const items = new Uint32Array(nvis);
  for (let i = 0; i < n; i++) {
    if (vis[i] !== 0) items[fill[cell(i)]++] = i;
    if (i % chunk === chunk - 1) yield;
  }
  return { x0, y0, cw, ch, G, start, items, nvis };
}

// ------------------------------------------------------------------ automatic exposure (§11)

export const EXPOSURE_K = 0.6;     // ref = K × p95 occupied-bin density × sprite integral
export const EXPOSURE_BIN = 8;     // CSS px

/** Integral of the (1 − r²)² sprite kernel of diameter s device px: π (s/2)² / 3. */
export function spriteIntegral(sizeDev) {
  const R = Math.max(0.5, sizeDev / 2);
  return (Math.PI * R * R) / 3;
}

/** Screen-space histogram helper: {gx, gy, hist} sized for cam (reuses `prev` if possible). */
export function makeHist(cam, prev) {
  const gx = Math.max(1, Math.ceil(cam.width / EXPOSURE_BIN)), gy = Math.max(1, Math.ceil(cam.height / EXPOSURE_BIN));
  const hist = prev && prev.length >= gx * gy ? prev : new Float32Array(gx * gy);
  hist.fill(0, 0, gx * gy);
  return { gx, gy, hist };
}

/** Add rows [i0, i1) with visibility V (0..1) to the histogram; returns the number in view. */
export function histAdd(H, cam, X, Y, V, i0, i1) {
  const { gx, hist } = H;
  const w = cam.width, h = cam.height, kx = cam.scale, ky = cam.scale * (cam.aspect || 1);
  const b = EXPOSURE_BIN;
  let inView = 0;
  for (let i = i0; i < i1; i++) {
    const v = V[i];
    if (!(v > 0)) continue;
    const sx = w / 2 + (X[i] - cam.cx) * kx;
    const sy = h / 2 - (Y[i] - cam.cy) * ky;
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
    hist[Math.floor(sy / b) * gx + Math.floor(sx / b)] += v;
    inView++;
  }
  return inView;
}

/** Occupied-bin values of a gx×gy histogram, sorted ascending. */
function occupied(hist, gx, gy) {
  const occ = new Float32Array(gx * gy);
  let k = 0;
  for (let c = 0; c < gx * gy; c++) if (hist[c] > 0) occ[k++] = hist[c];
  return occ.subarray(0, k).sort();
}

function quantileF(s, q) {
  const h = q * (s.length - 1);
  const j = Math.floor(h);
  return j + 1 < s.length ? s[j] + (h - j) * (s[j + 1] - s[j]) : s[s.length - 1];
}

/**
 * Exposure ref from a filled histogram built from `rowsUsed` of `n` rows (null if too few).
 * Bins are merged 2×2 (8 → 16 → 32 CSS px) while the median occupied bin holds < 10
 * galaxies, so Poisson noise of a sparse subsample does not inflate the 95th percentile.
 */
export function refFromHist(H, inView, rowsUsed, n, sizeDev, dpr) {
  if (inView < 40) return null;
  let { gx, gy, hist } = H;
  let bin = EXPOSURE_BIN;
  let s = occupied(hist, gx, gy);
  for (let level = 0; level < 2 && s.length && quantileF(s, 0.5) < 10; level++) {
    const nx = Math.ceil(gx / 2), ny = Math.ceil(gy / 2);
    const h2 = new Float32Array(nx * ny);
    for (let y = 0; y < gy; y++) for (let x = 0; x < gx; x++) h2[(y >> 1) * nx + (x >> 1)] += hist[y * gx + x];
    hist = h2;
    gx = nx;
    gy = ny;
    bin *= 2;
    s = occupied(hist, gx, gy);
  }
  if (!s.length) return null;
  const p95 = quantileF(s, 0.95);
  const b = bin * dpr;
  const density = (p95 * (n / rowsUsed)) / (b * b);
  return Math.max(1e-6, density * spriteIntegral(sizeDev) * EXPOSURE_K);
}
