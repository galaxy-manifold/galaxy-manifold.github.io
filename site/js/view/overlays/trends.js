// Trends (§15): running median of Y in bins of X with its 16–84 % band, over a visible
// subsample (≤ 60k rows after each settle, ≤ 15k rows at ≤ 10 Hz while the view moves), bins
// with ≥ 30 points. With a continuous colour variable the sample is split into 4 quantile
// groups of that variable, drawn as median lines in the colormap (the overall band stays as a
// faint dotted envelope); with a categorical colour, one median line per class with ≥ 200
// points. With a selection, the selected galaxies get their own median line (warm, dashed).
// Segments resting on few galaxies are drawn fainter (≥ 30 points is the floor, full
// strength from ~150), so the ends of a line read as less certain. Lines live in projected
// data coordinates, so pan/zoom are exact every frame; between estimates the drawn curves ease
// toward the newest one (τ ≈ 70 ms) instead of jumping.

import { runningQuantiles } from '../../math/stats.js';
import { smoothstep } from '../../math/linalg.js';
import { sampleColormapHex } from '../../gl/colormaps.js';
import { SELECTION_COLOR } from '../../config/style.js';
import { quantileGroups, groupIndex } from './geom.js';
import { COLORS, rgba } from './draw.js';

export const TREND = {
  settleMax: 60000,
  motionMax: 15000,
  motionMs: 100,       // ≤ 10 Hz
  minCount: 30,
  minClass: 200,
  groups: 4,
  visMin: 128,         // proj.vis (0..255): visibility > 0.5
  binPx: 30,           // target bin width on screen
  tau: 0.07,           // easing time constant (s)
  firmLo: 30,          // bin count drawn at the faintest level …
  firmHi: 150,         // … and from which a segment is drawn at full strength
  faint: 0.32,         // alpha of the faintest level
};

const GROUP_T = [0.06, 0.36, 0.64, 0.94];

/** Light 1-2-1 smoothing of a binned curve (display only); NaN bins stay NaN, ends use themselves. */
export function smooth121(v) {
  const n = v.length;
  const out = new Float64Array(n);
  for (let b = 0; b < n; b++) {
    const c = v[b];
    if (!(c === c)) { out[b] = NaN; continue; }
    const l = b > 0 && v[b - 1] === v[b - 1] ? v[b - 1] : c;
    const r = b + 1 < n && v[b + 1] === v[b + 1] ? v[b + 1] : c;
    out[b] = 0.25 * l + 0.5 * c + 0.25 * r;
  }
  return out;
}

/**
 * Per-bin strength in [faint, 1] from bin counts: faint at firmLo, full at firmHi (counts are
 * multiplied by `scale` first, so a small live sample reads like the settled one).
 */
export function firmness(count, { scale = 1, lo = TREND.firmLo, hi = TREND.firmHi, faint = TREND.faint } = {}) {
  const out = new Float64Array(count.length);
  for (let b = 0; b < count.length; b++) out[b] = faint + (1 - faint) * smoothstep(lo, hi, count[b] * scale);
  return out;
}

/**
 * Runs of a binned polyline with one strength level each: [{from, to, level}] over the valid
 * bins (to inclusive; a segment k→k+1 has strength min(fa_k, fa_{k+1}), quantised to `levels`).
 */
export function strengthRuns(vals, fa, levels = 4) {
  const n = vals.length;
  const runs = [];
  let cur = null;
  for (let k = 0; k + 1 < n; k++) {
    const a = vals[k], b = vals[k + 1];
    if (!(a === a) || !(b === b)) { cur = null; continue; }
    const s = Math.min(fa[k], fa[k + 1]);
    const level = Math.round(s * levels) / levels;
    if (cur && cur.level === level && cur.to === k) cur.to = k + 1;
    else {
      cur = { from: k, to: k + 1, level };
      runs.push(cur);
    }
  }
  return runs;
}

function qs(sorted, q) {
  const n = sorted.length;
  if (!n) return NaN;
  const h = (n - 1) * q, i = Math.floor(h);
  return i + 1 < n ? sorted[i] + (h - i) * (sorted[i + 1] - sorted[i]) : sorted[n - 1];
}

/**
 * Pure: trend curves for n sample points. xs, ys (projected), cv (colour values, NaN = none)
 * or cc (class codes), colour descriptor cs = {mode, ci}; sel (optional 0/1 flags) adds the
 * selection's median. Returns {mode, bins, x0, x1, centers, lo, mid, hi, cnt, fa,
 * groups: [{id, color, mid, cnt, fa, n}], sel: null | {mid, cnt, fa, n}, n}.
 */
export function computeTrends(xs, ys, n, { cv = null, cc = null, sel = null, cs = { mode: 'none' }, bins, x0, x1, minCount = TREND.minCount, minClass = TREND.minClass, groups = TREND.groups, scale = 1 } = {}) {
  const X = xs.subarray(0, n), Y = ys.subarray(0, n);
  const range = [x0, x1];
  const all = runningQuantiles(X, Y, { bins, range, minCount, q: [0.16, 0.5, 0.84] });
  const out = {
    mode: cs.mode, bins, x0, x1, centers: all.centers,
    lo: smooth121(all.q[0]), mid: smooth121(all.q[1]), hi: smooth121(all.q[2]),
    cnt: all.count, fa: firmness(all.count, { scale }), groups: [], sel: null, n,
  };
  const mask = new Uint8Array(n);
  const line = (id, color, extra = {}) => {
    const r = runningQuantiles(X, Y, { bins, range, minCount, q: [0.5], mask });
    return { id, color, mid: smooth121(r.q[0]), cnt: r.count, fa: firmness(r.count, { scale }), ...extra };
  };
  if (cs.mode === 'continuous' && cv) {
    const vals = cv.subarray(0, n);
    const { edges, medians } = quantileGroups(vals, groups);
    const gi = new Int8Array(n);
    for (let i = 0; i < n; i++) gi[i] = groupIndex(vals[i], edges);
    const ci = cs.ci;
    for (let g = 0; g < groups; g++) {
      let m = 0;
      for (let i = 0; i < n; i++) { const on = gi[i] === g; mask[i] = on ? 1 : 0; if (on) m++; }
      if (m < minCount * 2) continue;
      // quartile groups sit at fixed, well-separated positions of the colormap (the group
      // medians crowd the colormap's neutral middle and would be hard to tell apart)
      const t = GROUP_T[g] ?? (g + 0.5) / groups;
      out.groups.push(line(`q${g}`, sampleColormapHex(ci.cmap, t, ci.reverse), { n: m, value: medians[g] }));
    }
  } else if (cs.mode === 'categorical' && cc) {
    const counts = new Int32Array(256);
    for (let i = 0; i < n; i++) counts[cc[i]]++;
    for (const e of cs.ci.spec.codes) {
      if (counts[e.code] < minClass) continue;
      for (let i = 0; i < n; i++) mask[i] = cc[i] === e.code ? 1 : 0;
      out.groups.push(line(`c${e.code}`, cs.ci.hex[e.code] || COLORS.cream, { n: counts[e.code], code: e.code }));
    }
  }
  if (sel) {
    let m = 0;
    for (let i = 0; i < n; i++) { mask[i] = sel[i] ? 1 : 0; m += mask[i]; }
    if (m >= minCount * 2) {
      // a selection is often patchy in other projections: show its median only where it
      // rests on ≥ 2 × minCount galaxies, so the line breaks instead of bridging gaps
      const s = line('sel', SELECTION_COLOR, { n: m });
      for (let b = 0; b < bins; b++) if (s.cnt[b] < 2 * minCount) s.mid[b] = NaN;
      if (s.mid.some((v) => v === v)) out.sel = s;
    }
  }
  return out;
}

function sameShape(a, b) {
  if (!a || !b || a.bins !== b.bins || a.mode !== b.mode || a.groups.length !== b.groups.length || !a.sel !== !b.sel) return false;
  for (let g = 0; g < a.groups.length; g++) if (a.groups[g].id !== b.groups[g].id) return false;
  return true;
}

function cloneLine(l) {
  return l && { ...l, mid: Float64Array.from(l.mid), fa: Float64Array.from(l.fa) };
}

function cloneTrend(t) {
  return {
    ...t,
    centers: Float64Array.from(t.centers), lo: Float64Array.from(t.lo), mid: Float64Array.from(t.mid), hi: Float64Array.from(t.hi),
    fa: Float64Array.from(t.fa),
    groups: t.groups.map(cloneLine),
    sel: cloneLine(t.sel),
  };
}

/** Ease array a toward b by k; NaNs snap. Returns the largest remaining |difference|. */
function easeArray(a, b, k) {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (!(x === x) || !(y === y)) { a[i] = y; continue; }
    const v = x + (y - x) * k;
    a[i] = v;
    const d = Math.abs(y - v);
    if (d > m) m = d;
  }
  return m;
}

export function createTrends(app, ov) {
  const data = app.data;
  let target = null;
  let display = null;
  let lastMotion = 0;
  let motionTimer = 0;
  let cand = null, selCand = null;
  let motionOut = null, selOut = null;
  let buf = null;
  let settledK = 0;
  const timing = { settleMs: 0, motionMs: 0, motionMax: 0 };

  const enabled = () => app.store.get().overlays.trends !== false;

  function colorSetup() {
    const ci = app.colorInfo();
    if (ci.mode === 'continuous') {
      const d = data.dims[ci.dim];
      return { mode: 'continuous', ci, raw: data.raw[d.index], min: d.min, step: d.step };
    }
    if (ci.mode === 'categorical') return { mode: 'categorical', ci, codes: data.cats[ci.cat] };
    return { mode: 'none', ci };
  }

  function buffers(k) {
    if (!buf || buf.xs.length < k) buf = { xs: new Float64Array(k), ys: new Float64Array(k), cv: new Float64Array(k), cc: new Uint8Array(k), sel: new Uint8Array(k) };
    return buf;
  }

  function colorOf(cs, i, b, m) {
    if (cs.mode === 'continuous') {
      const v = cs.raw ? cs.raw[i] : 0;
      b.cv[m] = v === 0 ? NaN : cs.min + (v - 1) * cs.step;
    } else if (cs.mode === 'categorical') b.cc[m] = cs.codes ? cs.codes[i] : 0;
  }

  function binsFor(x0, x1, count) {
    const px = (x1 - x0) * app.camera.scaleX;
    let B = Math.round(px / TREND.binPx);
    B = Math.min(B, Math.floor(count / 60));
    return Math.max(6, Math.min(40, B));
  }

  function rangeFor(sortedX) {
    let x0 = qs(sortedX, 0.005), x1 = qs(sortedX, 0.995);
    const [vx0, vx1] = app.camera.viewBounds();
    const pad = 0.04 * (vx1 - vx0);
    x0 = Math.max(x0, vx0 - pad);
    x1 = Math.min(x1, vx1 + pad);
    return x1 > x0 ? [x0, x1] : null;
  }

  function setTarget(t) {
    target = t;
    if (!t) display = null;
    else if (!sameShape(display, t)) display = cloneTrend(t);
    ov.invalidate();
  }

  const selMask = () => {
    const s = app.store.get().selection;
    return s && s.mask && s.mask.length === data.n ? s.mask : null;
  };

  /** Full estimate from the settled projection cache (≤ 60k rows, plus ≤ 60k selected). */
  function computeSettled() {
    const proj = app.proj;
    if (!enabled() || !data.loaded || proj.stale || !proj.X) return false;
    const t0 = performance.now();
    const { X, Y, vis } = proj;
    const n = data.n;
    const pre = new Float64Array(20000);
    let m = 0;
    for (let i = 0; i < n && m < pre.length; i++) if (vis[i] >= TREND.visMin) pre[m++] = X[i];
    if (m < 2 * TREND.minCount) { setTarget(null); return true; }
    const range = rangeFor(pre.subarray(0, m).sort());
    if (!range) { setTarget(null); return true; }
    const [x0, x1] = range;
    const cs = colorSetup();
    const sm = selMask();
    const b = buffers(2 * TREND.settleMax);
    let k = 0, ks = 0;
    // the uniform visible sample (the row order is a random permutation) …
    for (let i = 0; i < n && k < TREND.settleMax; i++) {
      if (vis[i] < TREND.visMin) continue;
      const x = X[i];
      if (!(x >= x0 && x <= x1)) continue;
      b.xs[k] = x;
      b.ys[k] = Y[i];
      b.sel[k] = 0;
      colorOf(cs, i, b, k);
      k++;
    }
    const kAll = k;
    // … plus up to 60k selected galaxies for the selection's own median (flagged; they do
    // not enter the other lines)
    if (sm) {
      for (let i = 0; i < n && ks < TREND.settleMax; i++) {
        if (!sm[i] || vis[i] < TREND.visMin) continue;
        const x = X[i];
        if (!(x >= x0 && x <= x1)) continue;
        b.xs[k] = x;
        b.ys[k] = Y[i];
        b.sel[k] = 1;
        k++;
        ks++;
      }
    }
    if (kAll < 2 * TREND.minCount) { setTarget(null); return true; }
    const bins = binsFor(x0, x1, kAll);
    const t = computeTrends(b.xs, b.ys, kAll, { cv: b.cv, cc: b.cc, cs, bins, x0, x1 });
    if (ks) {
      const s = computeTrends(b.xs.subarray(kAll), b.ys.subarray(kAll), ks, { sel: b.sel.subarray(kAll), bins, x0, x1 });
      t.sel = s.sel;
    }
    settledK = kAll;
    setTarget(t);
    timing.settleMs = performance.now() - t0;
    return true;
  }

  function activeDims() {
    const w = app.dimWeights();
    const active = [];
    for (let d = 0; d < data.D; d++) if (w[d] >= 0.06) active.push(d);
    return active;
  }

  /** First ≤ max rows (optionally only selected ones) that have every active dim. */
  function candidates(active, max, mask = null) {
    const rows = new Int32Array(max);
    let m = 0;
    const cols = active.map((d) => data.raw[d]);
    for (let i = 0; i < data.n && m < rows.length; i++) {
      if (mask && !mask[i]) continue;
      let ok = true;
      for (let a = 0; a < cols.length; a++) if (cols[a][i] === 0) { ok = false; break; }
      if (ok) rows[m++] = i;
    }
    return rows.subarray(0, m);
  }

  /** Live estimate during motion (≤ 15k rows projected with the current frame). */
  function computeMotion() {
    motionTimer = 0;
    if (!enabled() || !data.loaded) return;
    const t0 = performance.now();
    lastMotion = t0;
    const active = activeDims();
    const fp = app.filterParams();
    const key = active.join(',');
    if (!cand || cand.key !== key || cand.fp !== fp) cand = { key, fp, rows: candidates(active, TREND.motionMax) };
    const sm = selMask();
    if (!sm) selCand = null;
    else if (!selCand || selCand.key !== key || selCand.mask !== sm) selCand = { key, mask: sm, rows: candidates(active, TREND.motionMax, sm) };
    const rows = cand.rows;
    if (rows.length < 2 * TREND.minCount) { setTarget(null); return; }
    const r = app.proj.projectSample(rows, app.frame, { out: motionOut && motionOut.X.length >= rows.length ? motionOut : undefined });
    motionOut = r;
    const cs = colorSetup();
    const b = buffers(2 * TREND.motionMax);
    let k = 0;
    for (let j = 0; j < rows.length; j++) {
      if (!(r.vis[j] > 0.5)) continue;
      b.xs[k] = r.X[j];
      b.ys[k] = r.Y[j];
      colorOf(cs, rows[j], b, k);
      k++;
    }
    if (k < 2 * TREND.minCount) { setTarget(null); return; }
    const range = rangeFor(Float64Array.from(b.xs.subarray(0, k)).sort());
    if (!range) { setTarget(null); return; }
    const [x0, x1] = range;
    const bins = binsFor(x0, x1, k);
    // strength as the settled estimate would show it (a smaller sample, same population)
    const scale = settledK > k ? settledK / k : 1;
    const t = computeTrends(b.xs, b.ys, k, { cv: b.cv, cc: b.cc, cs, bins, x0, x1, scale });
    if (selCand && selCand.rows.length >= 2 * TREND.minCount) {
      const rs = app.proj.projectSample(selCand.rows, app.frame, { out: selOut && selOut.X.length >= selCand.rows.length ? selOut : undefined });
      selOut = rs;
      let ks = 0;
      for (let j = 0; j < selCand.rows.length; j++) {
        if (!(rs.vis[j] > 0.5)) continue;
        b.xs[k + ks] = rs.X[j];
        b.ys[k + ks] = rs.Y[j];
        b.sel[k + ks] = 1;
        ks++;
      }
      if (ks) t.sel = computeTrends(b.xs.subarray(k), b.ys.subarray(k), ks, { sel: b.sel.subarray(k), bins, x0, x1 }).sel;
    }
    setTarget(t);
    const ms = performance.now() - t0;
    timing.motionMs = timing.motionMs ? 0.8 * timing.motionMs + 0.2 * ms : ms;
    timing.motionMax = Math.max(timing.motionMax, ms);
  }

  function scheduleMotion() {
    if (!enabled() || motionTimer) return;
    const wait = Math.max(0, TREND.motionMs - (performance.now() - lastMotion));
    motionTimer = setTimeout(computeMotion, wait);
  }

  /** Advance the easing; returns true while still converging. */
  function step(dt) {
    if (!target || !display) return false;
    if (!sameShape(display, target)) {
      display = cloneTrend(target);
      return false;
    }
    const k = 1 - Math.exp(-Math.max(dt, 1 / 120) / TREND.tau);
    let m = easeArray(display.centers, target.centers, k);
    m = Math.max(m, easeArray(display.lo, target.lo, k), easeArray(display.mid, target.mid, k), easeArray(display.hi, target.hi, k));
    easeArray(display.fa, target.fa, k);
    const lines = (a, b) => {
      a.color = b.color;
      m = Math.max(m, easeArray(a.mid, b.mid, k));
      easeArray(a.fa, b.fa, k);
    };
    display.groups.forEach((g, i) => lines(g, target.groups[i]));
    if (display.sel) lines(display.sel, target.sel);
    return m > 1e-4;
  }

  const sx = new Float64Array(64), sy2 = new Float64Array(64);

  function draw(g, now, dt) {
    if (!enabled() || !display) return false;
    const converging = step(dt);
    const t = display;
    const cam = app.camera;
    const W = cam.width, H = cam.height;
    const kx = cam.scaleX, ky = cam.scaleY, cx = cam.cx, cy = cam.cy;
    const B = t.bins;
    const X2S = (X) => W / 2 + (X - cx) * kx;
    const Y2S = (Y) => H / 2 - (Y - cy) * ky;
    const s = app.store.get();
    const alpha = (s.mode === 'mosaic' ? 0.7 : 1) * (s.selection ? 0.75 : 1);
    const grouped = t.groups.length > 0;
    for (let b = 0; b < B; b++) sx[b] = X2S(t.centers[b]);
    g.save();
    g.lineJoin = 'round';
    g.lineCap = 'round';
    // band (16–84 %): dotted edges over contiguous valid runs (no fill: the overlay canvas
    // cannot blend with the glow beneath it, so a fill would only muddy it). Grouped lines
    // carry the story, so the envelope is fainter then.
    const bandA = (grouped ? 0.3 : 0.55) * alpha;
    let b = 0;
    while (b < B) {
      while (b < B && !(t.lo[b] === t.lo[b] && t.hi[b] === t.hi[b])) b++;
      const s0 = b;
      while (b < B && t.lo[b] === t.lo[b] && t.hi[b] === t.hi[b]) b++;
      if (b - s0 < 2) continue;
      g.beginPath();
      for (let k = s0; k < b; k++) { const y = Y2S(t.hi[k]); if (k === s0) g.moveTo(sx[k], y); else g.lineTo(sx[k], y); }
      g.moveTo(sx[s0], Y2S(t.lo[s0]));
      for (let k = s0 + 1; k < b; k++) g.lineTo(sx[k], Y2S(t.lo[k]));
      // a faint dark rail under the dots keeps the envelope readable over bright glow
      g.setLineDash([]);
      g.lineWidth = 2.6;
      g.strokeStyle = rgba(COLORS.bg, 0.6 * bandA);
      g.stroke();
      g.setLineDash([1.5, 3]);
      g.lineWidth = 1.2;
      g.strokeStyle = rgba(COLORS.cream, bandA);
      g.stroke();
      g.setLineDash([]);
    }
    const line = (vals, fa, color, width, a0 = 1, dash = null) => {
      for (let k = 0; k < B; k++) sy2[k] = vals[k] === vals[k] ? Y2S(vals[k]) : NaN;
      const runs = strengthRuns(vals, fa);
      if (!runs.length) return;
      for (const pass of [0, 1]) {
        for (const r of runs) {
          g.beginPath();
          g.moveTo(sx[r.from], sy2[r.from]);
          for (let k = r.from + 1; k <= r.to; k++) g.lineTo(sx[k], sy2[k]);
          if (pass === 0) {
            g.setLineDash([]);
            g.strokeStyle = rgba(COLORS.bg, 0.5 * alpha * a0 * r.level);
            g.lineWidth = width + 2.4;
          } else {
            if (dash) g.setLineDash(dash);
            g.strokeStyle = rgba(color, 0.96 * alpha * a0 * r.level);
            g.lineWidth = width;
          }
          g.stroke();
        }
      }
      g.setLineDash([]);
    };
    if (grouped) for (const gr of t.groups) line(gr.mid, gr.fa, gr.color, 1.8);
    else line(t.mid, t.fa, COLORS.cream, 1.9);
    if (t.sel) line(t.sel.mid, t.sel.fa, SELECTION_COLOR, 2.2, 1 / alpha, [7, 3.5]);
    g.restore();
    return converging;
  }

  return {
    draw,
    computeSettled,
    scheduleMotion,
    timing,
    get result() { return target; },
    clear() { target = null; display = null; cand = null; selCand = null; },
    invalidateCandidates() { cand = null; selCand = null; },
  };
}
