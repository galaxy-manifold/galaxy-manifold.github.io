// ProjectionCache (§12.1): the CPU-side view of the projection.
//
// After each settle, X, Y (Float32Array n, projected u) and vis (Uint8Array n, 0–255 including
// filters) are valid for the current frame; `stale` is true while they are not. The full
// projection runs in a module worker (or time-sliced on the main thread as a fallback), so the
// main thread never does O(n) work per animation frame.
//
// Also: pick(), sampleVisible(), projectRow(), projectSample() (live, any frame) and
// estimates from a fixed prefix subsample (rows 0..M−1 are a uniform random subsample):
// projectPrefix(), estimateBounds() (fit), estimateRef() (automatic exposure).

import { projectRange, buildGridSteps, VIS_MIN, makeHist, histAdd, refFromHist } from '../workers/kernel.js';
import { fadeFactors } from '../math/frame.js';
import { quantileSorted } from '../math/stats.js';

const PREFIX_MAX = 65536;
const GRID = 256;

/** Filter description shared with the renderer: {z: null|{dim, lo, hi} (u), masks: [4], need}. */
function reqFilters(filters) {
  const z = filters && filters.z;
  const masks = new Uint32Array(4).fill(0xffffffff);
  if (filters && filters.masks) for (let s = 0; s < 4; s++) if (filters.masks[s] != null) masks[s] = filters.masks[s] >>> 0;
  const needDim = filters && filters.need >= 0 ? filters.need : -1;
  return { zDim: z && z.dim >= 0 ? z.dim : -1, zlo: z ? z.lo : 0, zhi: z ? z.hi : 0, masks, needDim };
}

function filtersKey(f) {
  return f ? `${f.z ? `${f.z.dim}:${f.z.lo}:${f.z.hi}` : '-'}|${f.masks ? Array.from(f.masks).join(',') : '-'}|${f.need >= 0 ? f.need : '-'}` : '';
}

export class ProjectionCache {
  constructor({ camera, onError } = {}) {
    this.camera = camera;
    this.onError = onError || ((e) => console.warn(e));
    this.data = null;
    this.n = 0;
    this.X = null;
    this.Y = null;
    this.vis = null;
    this.grid = null;
    this.version = 0;
    this.stale = true;
    this.ms = 0;
    this.worker = null;
    this.mode = 'none';
    this._reqId = 0;
    this._pending = new Map();
    this._changeSeq = 0;
    this._exId = 0;
    this._exPending = new Map();
    this.exposureMs = 0;
    this.filters = null;
  }

  /** Attach a loaded Dataset: builds the prefix sample and starts the worker. */
  init(data) {
    this.data = data;
    this.n = data.n;
    this.D = data.D;
    const ua = Float64Array.from(data.dims, (d) => d.ua);
    const ub = Float64Array.from(data.dims, (d) => d.ub);
    const cats = [null, null, null, null];
    for (const c of data.categories) if (c.slot >= 0 && data.cats[c.key]) cats[c.slot] = data.cats[c.key];
    this.ctx = { n: this.n, D: this.D, raw: data.raw.slice(), ua, ub, cats };
    this._buildPrefix();
    this._startWorker();
  }

  _startWorker() {
    try {
      const w = new Worker(new URL('../workers/project.worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => this._onMessage(e.data);
      w.onerror = (e) => {
        e.preventDefault?.();
        this.onError(`projection worker unavailable (${e.message || 'error'}); using the main thread`);
        this._useFallback();
      };
      // one column per message keeps each structured clone (~1.3 MB) short
      w.postMessage({ type: 'init', n: this.n, D: this.D, ua: this.ctx.ua, ub: this.ctx.ub });
      this.ctx.raw.forEach((col, d) => w.postMessage({ type: 'column', d, col }));
      this.ctx.cats.forEach((col, s) => w.postMessage({ type: 'cats', s, col }));
      this.worker = w;
      this.mode = 'worker';
    } catch (e) {
      this._useFallback();
    }
  }

  _useFallback() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
    this.mode = 'sliced';
    for (const r of this._exPending.values()) r(null);
    this._exPending.clear();
    for (const p of this._pending.values()) this._runSliced(p.req);
  }

  /** Mark X/Y/vis as out of date (frame or filters changed). */
  markStale() {
    this.stale = true;
    this._changeSeq++;
  }

  /**
   * Recompute X/Y/vis/grid for frame F and filters. Resolves {id, ms, current} where
   * `current` is true if nothing changed since the request (the cache is then fresh).
   */
  refresh(F, filters) {
    const id = ++this._reqId;
    const seq = this._changeSeq;
    const req = { id, F: Float64Array.from(F), fade: fadeFactors(F), ...reqFilters(filters), G: GRID };
    this.filters = filters;
    return new Promise((resolve) => {
      this._pending.set(id, { req, resolve, seq });
      if (this.worker) this.worker.postMessage({ type: 'project', ...req });
      else this._runSliced(req);
    });
  }

  _onMessage(m) {
    if (m.type === 'exposure') {
      const r = this._exPending.get(m.id);
      if (r) {
        this._exPending.delete(m.id);
        this.exposureMs = m.ms;
        r(m.ref);
      }
      return;
    }
    if (m.type === 'error') {
      this.onError(`projection failed: ${m.message}`);
      this._useFallback();
      return;
    }
    if (m.type !== 'projected') return;
    const p = this._pending.get(m.id);
    if (!p) return;
    // resolve (as superseded) anything older than this result
    for (const [id, q] of this._pending) {
      if (id < m.id) {
        q.resolve({ id, superseded: true, current: false });
        this._pending.delete(id);
      }
    }
    this._pending.delete(m.id);
    const newest = m.id === this._reqId;
    if (newest) {
      this.X = m.X;
      this.Y = m.Y;
      this.vis = m.vis;
      this.grid = m.grid;
      this.ms = m.ms;
      this.F = p.req.F;
      this.version++;
      if (p.seq === this._changeSeq) this.stale = false;
    }
    p.resolve({ id: m.id, ms: m.ms, current: newest && !this.stale, superseded: !newest });
  }

  _runSliced(req) {
    const n = this.n;
    const out = { X: new Float32Array(n), Y: new Float32Array(n), vis: new Uint8Array(n), visf: this._visf || (this._visf = new Float32Array(n)) };
    let i = 0;
    const t0 = performance.now();
    let busy = 0;
    const step = () => {
      if (!this._pending.has(req.id) || req.id !== this._reqId) {
        // superseded: let the newest request win
        const p = this._pending.get(req.id);
        if (p) { p.resolve({ id: req.id, superseded: true, current: false }); this._pending.delete(req.id); }
        return;
      }
      const s0 = performance.now();
      while (i < n && performance.now() - s0 < 8) {
        const i1 = Math.min(n, i + 32768);
        projectRange(this.ctx, req, out, i, i1);
        i = i1;
      }
      busy += performance.now() - s0;
      if (i < n) { setTimeout(step, 0); return; }
      gridIt = buildGridSteps(out.X, out.Y, out.vis, n, req.G, 32768);
      setTimeout(gridStep, 0);
    };
    let gridIt = null;
    const gridStep = () => {
      if (!this._pending.has(req.id) || req.id !== this._reqId) return step();   // superseded
      const s0 = performance.now();
      let r;
      do r = gridIt.next(); while (!r.done && performance.now() - s0 < 8);
      busy += performance.now() - s0;
      if (!r.done) { setTimeout(gridStep, 0); return; }
      this._onMessage({ type: 'projected', id: req.id, X: out.X, Y: out.Y, vis: out.vis, grid: r.value, ms: busy, wall: performance.now() - t0 });
    };
    setTimeout(step, 0);
  }

  // ------------------------------------------------------------------ queries on the cache

  /** Nearest visible galaxy within rPx CSS px of (sx, sy), or −1 (also −1 while stale). */
  pick(sx, sy, rPx = 10, { thumbsOnly = false, minVis = 1 } = {}) {
    if (this.stale || !this.X || !this.grid) return -1;
    const cam = this.camera;
    const [qx, qy] = cam.toData(sx, sy);
    const kx = cam.scale, ky = cam.scale * (cam.aspect || 1);   // CSS px per u along x / y
    const rx = rPx / kx, ry = rPx / ky;
    let bd = rPx * rPx, best = -1;
    const { X, Y, vis } = this;
    if (thumbsOnly) {
      const rows = this.data.thumbRows;
      for (let k = 0; k < rows.length; k++) {
        const i = rows[k];
        if (vis[i] < minVis) continue;
        const dx = (X[i] - qx) * kx, dy = (Y[i] - qy) * ky, d2 = dx * dx + dy * dy;
        if (d2 < bd) { bd = d2; best = i; }
      }
      return best;
    }
    const g = this.grid;
    const G = g.G;
    const clampc = (c) => (c < 0 ? 0 : c >= G ? G - 1 : c);
    const x0 = clampc(Math.floor((qx - rx - g.x0) / g.cw)), x1 = clampc(Math.floor((qx + rx - g.x0) / g.cw));
    const y0 = clampc(Math.floor((qy - ry - g.y0) / g.ch)), y1 = clampc(Math.floor((qy + ry - g.y0) / g.ch));
    const { start, items } = g;
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const c = cy * G + cx;
        for (let k = start[c], e = start[c + 1]; k < e; k++) {
          const i = items[k];
          const dx = (X[i] - qx) * kx, dy = (Y[i] - qy) * ky, d2 = dx * dx + dy * dy;
          if (d2 < bd && vis[i] >= minVis) { bd = d2; best = i; }
        }
      }
    }
    return best;
  }

  /**
   * Up to k visible rows in the fixed random row order (so the result is a uniform random
   * subsample of the visible galaxies). opts: minVis (1..255, default 1), inView (bool).
   */
  sampleVisible(k, { minVis = 1, inView = false } = {}) {
    if (!this.vis) return new Int32Array(0);
    const { X, Y, vis, n } = this;
    const out = new Int32Array(Math.min(k, n));
    let m = 0;
    let b = null;
    if (inView) b = this.camera.viewBounds();
    for (let i = 0; i < n && m < out.length; i++) {
      if (vis[i] < minVis) continue;
      if (b) {
        const x = X[i], y = Y[i];
        if (x < b[0] || x > b[1] || y < b[2] || y > b[3]) continue;
      }
      out[m++] = i;
    }
    return out.slice(0, m);
  }

  /** Projected [X, Y] of row i with frame F (default: the frame of the cache). */
  projectRow(i, F = this.F) {
    if (!F || !this.ctx) return [NaN, NaN];
    const { D, raw, ua, ub } = this.ctx;
    const FD = F.length >> 1;
    let X = 0, Y = 0;
    for (let d = 0; d < Math.min(D, FD); d++) {
      const px = F[d], py = F[FD + d];
      if (px === 0 && py === 0) continue;
      const v = raw[d][i];
      if (v === 0) continue;
      const u = v * ua[d] + ub[d];
      X += px * u;
      Y += py * u;
    }
    return [X, Y];
  }

  /**
   * Live projection of arbitrary rows with frame F: {X, Y, vis} (Float32Array, vis in 0..1
   * including the missing-dim fade and filters). Cost O(rows × dims in view).
   */
  projectSample(rows, F, { filters = this.filters, out } = {}) {
    const k = rows.length;
    const res = out && out.X && out.X.length >= k ? out : { X: new Float32Array(k), Y: new Float32Array(k), vis: new Float32Array(k) };
    if (!this.ctx || !F) return res;
    const { D, raw, ua, ub, cats } = this.ctx;
    const FD = F.length >> 1;
    const fade = fadeFactors(F);
    const act = [];
    for (let d = 0; d < Math.min(D, FD); d++) if (F[d] !== 0 || F[FD + d] !== 0) act.push(d);
    const f = reqFilters(filters);
    for (let j = 0; j < k; j++) {
      const i = rows[j];
      let X = 0, Y = 0, v = 1;
      for (let a = 0; a < act.length; a++) {
        const d = act[a];
        const r = raw[d][i];
        if (r !== 0) {
          const u = r * ua[d] + ub[d];
          X += F[d] * u;
          Y += F[FD + d] * u;
        } else v *= fade[d];
      }
      if (f.zDim >= 0) {
        const r = raw[f.zDim][i];
        const u = r * ua[f.zDim] + ub[f.zDim];
        if (r === 0 || u < f.zlo || u > f.zhi) v = 0;
      }
      if (f.needDim >= 0 && raw[f.needDim][i] === 0) v = 0;
      for (let s = 0; s < 4; s++) {
        const m = f.masks[s];
        if ((m & 0xff) === 0xff || !cats[s]) continue;
        if (((m >>> cats[s][i]) & 1) === 0) v = 0;
      }
      res.X[j] = X;
      res.Y[j] = Y;
      res.vis[j] = v < VIS_MIN ? 0 : v;
    }
    return res;
  }

  // ------------------------------------------------------------------ prefix-sample estimates

  _buildPrefix() {
    const M = Math.min(this.n, PREFIX_MAX);
    const D = this.D;
    const { raw, ua, ub } = this.ctx;
    const U = new Float32Array(M * D);
    const miss = new Uint32Array(M);
    for (let d = 0; d < D; d++) {
      const col = raw[d];
      const a = ua[d], b = ub[d], bit = 1 << d;
      for (let i = 0; i < M; i++) {
        const v = col[i];
        if (v !== 0) U[i * D + d] = v * a + b;
        else miss[i] |= bit;
      }
    }
    this.prefix = { M, U, miss, X: new Float32Array(M), Y: new Float32Array(M), V: new Float32Array(M), key: '' };
  }

  /**
   * Project the prefix subsample (rows 0..M−1) with frame F and filters.
   * Returns {M, X, Y, V} — shared buffers, valid until the next call with another frame.
   */
  projectPrefix(F, filters = this.filters) {
    const P = this.prefix;
    if (!P) return null;
    const key = `${Array.prototype.join.call(F, ',')}#${filtersKey(filters)}`;
    if (P.key === key) return P;
    const { M, U, miss, X, Y, V } = P;
    const D = this.D;
    const FD = F.length >> 1;
    const fade = fadeFactors(F);
    const act = [];
    let fadeMask = 0;
    for (let d = 0; d < Math.min(D, FD); d++) {
      if (F[d] !== 0 || F[FD + d] !== 0) act.push(d);
      if (fade[d] < 1) fadeMask |= 1 << d;
    }
    const nA = act.length;
    const px = act.map((d) => F[d]), py = act.map((d) => F[FD + d]);
    const f = reqFilters(filters);
    const cats = this.ctx.cats;
    for (let i = 0; i < M; i++) {
      const o = i * D;
      let x = 0, y = 0;
      for (let a = 0; a < nA; a++) {
        const u = U[o + act[a]];
        x += px[a] * u;
        y += py[a] * u;
      }
      let v = 1;
      let m = miss[i] & fadeMask;
      while (m) {
        const b = 31 - Math.clz32(m);
        v *= fade[b];
        m &= ~(1 << b);
      }
      if (f.zDim >= 0) {
        const u = U[o + f.zDim];
        if ((miss[i] >>> f.zDim) & 1 || u < f.zlo || u > f.zhi) v = 0;
      }
      if (f.needDim >= 0 && (miss[i] >>> f.needDim) & 1) v = 0;
      for (let s = 0; s < 4; s++) {
        const mk = f.masks[s];
        if ((mk & 0xff) === 0xff || !cats[s]) continue;
        if (((mk >>> cats[s][i]) & 1) === 0) v = 0;
      }
      X[i] = x;
      Y[i] = y;
      V[i] = v < VIS_MIN ? 0 : v;
    }
    P.key = key;
    return P;
  }

  /** Robust bounds [x0, x1, y0, y1] of the visible prefix sample under frame F. */
  estimateBounds(F, filters = this.filters, { qlo = 0.005, qhi = 0.995, minVis = 0.3 } = {}) {
    const P = this.projectPrefix(F, filters);
    if (!P) return [-3, 3, -3, 3];
    const xs = new Float64Array(P.M), ys = new Float64Array(P.M);
    let k = 0;
    for (let i = 0; i < P.M; i++) {
      if (P.V[i] < minVis) continue;
      xs[k] = P.X[i];
      ys[k] = P.Y[i];
      k++;
    }
    if (k < 20) return [-3, 3, -3, 3];
    const sx = xs.subarray(0, k).sort(), sy = ys.subarray(0, k).sort();
    return [quantileSorted(sx, qlo), quantileSorted(sx, qhi), quantileSorted(sy, qlo), quantileSorted(sy, qhi)];
  }

  /**
   * Automatic exposure reference (§11): ~95th percentile of the occupied-bin density of the
   * visible galaxies on screen, in points per device px², times the sprite integral.
   * cam: {cx, cy, scale, aspect, width, height}; sizeDev: sprite diameter in device px.
   * Synchronous (prefix sample, O(65k)); returns null when too few galaxies are in view.
   */
  estimateRef(F, cam, filters = this.filters, sizeDev = 4, dpr = 1) {
    const P = this.projectPrefix(F, filters);
    if (!P) return null;
    const H = makeHist(cam, this._hist);
    this._hist = H.hist;
    let inView = histAdd(H, cam, P.X, P.Y, P.V, 0, P.M);
    let rows = P.M;
    if (inView < 400 && !this.stale && this.X && P.M < this.n) {
      // zoomed in: continue with the settled full projection (same frame) past the prefix
      const { X, Y, vis } = this;
      const V = this._vtmp || (this._vtmp = new Float32Array(this.n));
      let i = P.M;
      while (i < this.n && inView < 20000) {
        const i1 = Math.min(this.n, i + 16384);
        for (let j = i; j < i1; j++) V[j] = vis[j] / 255;
        inView += histAdd(H, cam, X, Y, V, i, i1);
        i = i1;
      }
      rows = i;
    }
    return refFromHist(H, inView, rows, this.n, sizeDev, dpr);
  }

  /**
   * Same estimate computed off the main thread when a worker is available (scans more rows
   * when few prefix galaxies are in view). Resolves to the ref or null.
   */
  requestRef(F, cam, filters = this.filters, sizeDev = 4, dpr = 1) {
    if (!this.worker || !this.ctx) return Promise.resolve(this.estimateRef(F, cam, filters, sizeDev, dpr));
    const id = ++this._exId;
    const msg = {
      type: 'exposure', id, F: Float64Array.from(F), fade: fadeFactors(F), ...reqFilters(filters),
      cam: { cx: cam.cx, cy: cam.cy, scale: cam.scale, aspect: cam.aspect || 1, width: cam.width, height: cam.height },
      sizeDev, dpr,
    };
    return new Promise((resolve) => {
      this._exPending.set(id, resolve);
      this.worker.postMessage(msg);
    });
  }

  destroy() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
  }
}
