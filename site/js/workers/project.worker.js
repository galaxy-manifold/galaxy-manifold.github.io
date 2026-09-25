// Module worker: holds a copy of the raw columns and projects the full sample for the
// ProjectionCache (view/projection.js) after each settle, plus the picking grid.
//
// in:  {type:'init', n, D, ua, ub} then {type:'column', d, col} × D and {type:'cats', s, col} × 4
//      {type:'project', id, F, fade, zDim, zlo, zhi, masks, G}
//      {type:'exposure', id, F, fade, zDim, zlo, zhi, masks, cam, sizeDev, dpr}
// out: {type:'ready'} · {type:'projected', id, X, Y, vis, grid, ms} (buffers transferred)
//      {type:'exposure', id, ref, ms}
//      {type:'error', id, message}

import { projectRange, buildGrid, makeHist, histAdd, refFromHist } from './kernel.js';

let ctx = null;
let visf = null;
let ex = null;   // scratch for exposure estimates
const PREFIX = 65536;
const CHUNK = 65536;

/** Exposure ref for frame/filters/camera: prefix rows first, more rows if few are in view. */
function exposure(m) {
  const n = ctx.n;
  if (!ex) ex = { X: new Float32Array(n), Y: new Float32Array(n), vis: new Uint8Array(n), visf: new Float32Array(n), hist: null };
  const H = makeHist(m.cam, ex.hist);
  ex.hist = H.hist;
  let inView = 0, rows = 0;
  for (let i0 = 0; i0 < n; i0 += CHUNK) {
    const i1 = Math.min(n, i0 + CHUNK);
    projectRange(ctx, m, ex, i0, i1);
    inView += histAdd(H, m.cam, ex.X, ex.Y, ex.visf, i0, i1);
    rows = i1;
    if (rows >= PREFIX && inView >= 2000) break;
  }
  return refFromHist(H, inView, rows, n, m.sizeDev, m.dpr);
}

self.onmessage = (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'init') {
      ctx = { n: m.n, D: m.D, raw: m.raw || new Array(m.D).fill(null), ua: m.ua, ub: m.ub, cats: m.cats || [null, null, null, null] };
      visf = new Float32Array(m.n);
      ex = null;
      self.postMessage({ type: 'ready' });
      return;
    }
    if (m.type === 'column') {
      ctx.raw[m.d] = m.col;
      return;
    }
    if (m.type === 'cats') {
      ctx.cats[m.s] = m.col;
      return;
    }
    if (m.type === 'exposure') {
      const t0 = performance.now();
      const ref = exposure(m);
      self.postMessage({ type: 'exposure', id: m.id, ref, ms: performance.now() - t0 });
      return;
    }
    if (m.type === 'project') {
      const t0 = performance.now();
      const n = ctx.n;
      const out = { X: new Float32Array(n), Y: new Float32Array(n), vis: new Uint8Array(n), visf };
      projectRange(ctx, m, out, 0, n);
      const grid = buildGrid(out.X, out.Y, out.vis, n, m.G || 256);
      const ms = performance.now() - t0;
      self.postMessage(
        { type: 'projected', id: m.id, X: out.X, Y: out.Y, vis: out.vis, grid, ms },
        [out.X.buffer, out.Y.buffer, out.vis.buffer, grid.start.buffer, grid.items.buffer],
      );
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m && m.id, message: String(err && err.message || err) });
  }
};
