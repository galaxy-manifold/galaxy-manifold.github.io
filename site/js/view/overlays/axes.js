// Axis rulers (§15): hairline rulers along the bottom and left edges of the stage, physical
// ticks at 1-2-5 steps in the combined axis units (§10), and live formula titles such as
// "log M★ − 0.32 log SFR →" (bottom right) and "↑ 12+log(O/H)" (top left). Dimension names
// in the titles are tinted with their group color; unicode super/subscripts are drawn as
// real raised/lowered text (text.js), and a multi-term label gets parentheses when it has a
// coefficient ("− 1.02 (12+log(O/H))"). The rulers stop at the inspector drawer when it is
// open. They are also drop zones for rail tokens (zoneAt / highlight) and show the tighten
// "scan" while the pursuit runs. Everything here is O(D + ticks) per frame.

import * as fm from '../../math/frame.js';
import { GROUP_COLORS } from '../../config/style.js';
import { minorTicks } from './geom.js';
import { scriptRuns, layoutRuns, needsParens } from './text.js';
import { COLORS, rgba, snap, monoFont } from './draw.js';

export const RULER = { left: 44, bottom: 30 };   // baselines, CSS px from the left / bottom edge
const MAX_TERMS = 6;
const TITLE_PX = 11;

/** Major and minor tick positions (projected coordinate X) for an axisInfo over [X0, X1]. */
export function rulerTicks(info, X0, X1, count) {
  if (!info) return { major: [], minor: [], step: 0 };
  const a0 = fm.axisValue(info, X0), a1 = fm.axisValue(info, X1);
  const lo = Math.min(a0, a1), hi = Math.max(a0, a1);
  if (!(hi > lo) || !Number.isFinite(lo) || !Number.isFinite(hi)) return { major: [], minor: [], step: 0 };
  const step = fm.niceStep((hi - lo) / Math.max(1, count));
  const dec = fm.stepDecimals(step);
  const major = [];
  const i0 = Math.ceil(lo / step - 1e-9), i1 = Math.floor(hi / step + 1e-9);
  for (let i = i0; i <= i1 && major.length < 60; i++) {
    const A = i * step;
    major.push({ X: fm.axisPosition(info, A), A, text: fm.fmtNum(A, dec) });
  }
  const minor = minorTicks(lo, hi, step, 300).map((A) => fm.axisPosition(info, A));
  return { major, minor, step };
}

/**
 * Title as colored segments: [{text, color, alpha}] (text may hold unicode scripts). Terms
 * after the first are signed; a label with a top-level + or − is parenthesized there.
 */
export function titleSegments(info, dims, { arrow = '', maxTerms = MAX_TERMS } = {}) {
  if (!info || !info.terms.length) return [];
  const segs = [];
  const terms = info.terms.slice(0, maxTerms);
  terms.forEach((t, n) => {
    const d = dims[t.index];
    let label = d.label;
    if (n > 0) {
      const mag = Math.abs(t.kappa).toFixed(2);
      const coef = mag === '1.00' ? '' : `${mag} `;
      segs.push({ text: `${t.kappa < 0 ? ' − ' : ' + '}${coef}`, color: COLORS.cream, alpha: 0.7 });
      if (needsParens(label)) label = `(${label})`;
    }
    segs.push({ text: label, color: GROUP_COLORS[d.group] || COLORS.cream2, alpha: 0.95, key: d.key });
  });
  if (info.terms.length > maxTerms) segs.push({ text: ' …', color: COLORS.cream, alpha: 0.6 });
  if (info.single && dims[info.ref].unit) segs.push({ text: ` [${dims[info.ref].unit}]`, color: COLORS.cream2, alpha: 0.85 });
  if (arrow === 'right') segs.push({ text: '  →', color: COLORS.cream2, alpha: 0.7 });
  if (arrow === 'up') segs.unshift({ text: '↑  ', color: COLORS.cream2, alpha: 0.7 });
  return segs;
}

export function createAxes(app, ov) {
  const dims = app.data.dims;
  let highlight = null;
  let scanT0 = 0;
  let flash = null;
  const layoutCache = new Map();
  let cacheFonts = -1;
  const titleBoxes = { x: null, y: null };   // last drawn title rects (labels keep clear of them)

  function layout() {
    const W = app.camera.width, H = app.camera.height;
    const free = ov.free();
    return { W, H, xBase: H - RULER.bottom, yBase: RULER.left, xEnd: free.r };
  }

  /** Cached run layout of a text at px (invalidated when web fonts finish loading). */
  function textLayout(g, text, px) {
    if (cacheFonts !== ov.fontsVersion) {
      layoutCache.clear();
      cacheFonts = ov.fontsVersion;
    }
    const key = `${px}|${text}`;
    let L = layoutCache.get(key);
    if (!L) {
      L = layoutRuns(scriptRuns(text), px, (t, size) => {
        g.font = monoFont(size);
        return g.measureText(t).width;
      });
      if (layoutCache.size > 800) layoutCache.clear();
      layoutCache.set(key, L);
    }
    return L;
  }

  function measureSegments(g, segs, px) {
    let total = 0;
    for (const s of segs) total += textLayout(g, s.text, px).width;
    return total;
  }

  /** Draw segments with baseline y; align 'left' starts at x, 'right' ends at x. A dark halo
   *  keeps the title legible over dense glow. */
  function drawSegments(g, segs, x, y, align, px = TITLE_PX) {
    const total = measureSegments(g, segs, px);
    const x0 = align === 'right' ? x - total : x;
    g.lineJoin = 'round';
    g.lineWidth = 3;
    g.strokeStyle = rgba(COLORS.bg, 0.72);
    for (const pass of [0, 1]) {
      let cx = x0;
      for (const s of segs) {
        const L = textLayout(g, s.text, px);
        if (pass) g.fillStyle = rgba(s.color, s.alpha);
        for (const r of L.runs) {
          g.font = monoFont(r.size);
          if (pass) g.fillText(r.text, cx + r.x, y + r.dy);
          else g.strokeText(r.text, cx + r.x, y + r.dy);
        }
        cx += L.width;
      }
    }
    return total;
  }

  /** Fit a title into maxW by dropping trailing terms (keeps the unit / arrow). */
  function fitTitle(g, info, arrow, maxW) {
    let terms = Math.min(MAX_TERMS, info.terms.length);
    let segs = titleSegments(info, dims, { arrow, maxTerms: terms });
    while (terms > 1 && measureSegments(g, segs, TITLE_PX) > maxW) {
      terms--;
      segs = titleSegments(info, dims, { arrow, maxTerms: terms });
    }
    return segs;
  }

  const blocked = (x, y) => {
    for (const r of ov.avoid) if (x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]) return true;
    return false;
  };

  function draw(g, now) {
    const cam = app.camera, dpr = cam.dpr;
    const { W, H, xBase, yBase, xEnd } = layout();
    if (W < 40 || H < 40 || xEnd - yBase < 40) return;
    const F = app.frame;
    const ix = fm.axisInfo(F, 0, dims), iy = fm.axisInfo(F, 1, dims);
    const cream = COLORS.cream, orange = COLORS.orange;
    g.textBaseline = 'alphabetic';

    // soft backdrops so ticks stay legible over the glow
    let gr = g.createLinearGradient(0, H - 60, 0, H);
    gr.addColorStop(0, rgba(COLORS.bg, 0));
    gr.addColorStop(1, rgba(COLORS.bg, 0.78));
    g.fillStyle = gr;
    g.fillRect(0, H - 60, xEnd, 60);
    gr = g.createLinearGradient(0, 0, 72, 0);
    gr.addColorStop(0, rgba(COLORS.bg, 0.78));
    gr.addColorStop(1, rgba(COLORS.bg, 0));
    g.fillStyle = gr;
    g.fillRect(0, 0, 72, H);

    if (highlight) {
      g.fillStyle = rgba(orange, 0.1);
      if (highlight === 'x') g.fillRect(yBase, xBase - 22, xEnd - yBase, H - xBase + 22);
      else g.fillRect(0, 0, yBase + 22, xBase);
    }

    g.lineWidth = 1;
    g.lineCap = 'butt';
    // ------------------------------------------------ bottom ruler (x)
    const by = snap(xBase, dpr);
    g.strokeStyle = highlight === 'x' ? rgba(orange, 0.95) : rgba(cream, 0.3);
    g.beginPath();
    g.moveTo(yBase, by);
    g.lineTo(xEnd, by);
    g.stroke();
    if (ix) {
      const X0 = cam.toData(yBase, 0)[0], X1 = cam.toData(xEnd, 0)[0];
      const t = rulerTicks(ix, X0, X1, Math.max(3, Math.round((xEnd - yBase) / 105)));
      g.beginPath();
      for (const X of t.minor) {
        const sx = snap(cam.toScreen(X, 0)[0], dpr);
        if (sx < yBase + 3 || sx > xEnd - 1 || blocked(sx, by + 2)) continue;
        g.moveTo(sx, by);
        g.lineTo(sx, by + 3);
      }
      g.strokeStyle = rgba(cream, 0.2);
      g.stroke();
      g.beginPath();
      const labels = [];
      for (const tk of t.major) {
        const sx = snap(cam.toScreen(tk.X, 0)[0], dpr);
        if (sx < yBase + 3 || sx > xEnd - 1 || blocked(sx, by + 3)) continue;
        g.moveTo(sx, by);
        g.lineTo(sx, by + 6);
        labels.push([sx, tk.text]);
      }
      g.strokeStyle = rgba(cream, 0.52);
      g.stroke();
      g.font = monoFont(10);
      g.textAlign = 'center';
      g.fillStyle = rgba(cream, 0.64);
      for (const [sx, text] of labels) {
        const hw = g.measureText(text).width / 2;
        if (sx - hw < yBase + 2 || sx + hw > xEnd - 4 || blocked(sx, H - 14)) continue;
        g.fillText(text, sx, H - 10);
      }
      g.textAlign = 'left';
      const segs = fitTitle(g, ix, 'right', Math.max(80, xEnd - yBase - 40));
      const w = drawSegments(g, segs, xEnd - 14, xBase - 9, 'right');
      titleBoxes.x = { x: xEnd - 14 - w, y: xBase - 22, w, h: 17 };
    } else titleBoxes.x = null;

    // ------------------------------------------------ left ruler (y)
    const bx = snap(yBase, dpr);
    g.strokeStyle = highlight === 'y' ? rgba(orange, 0.95) : rgba(cream, 0.3);
    g.beginPath();
    g.moveTo(bx, 0);
    g.lineTo(bx, xBase);
    g.stroke();
    if (iy) {
      const Y1 = cam.toData(0, 0)[1], Y0 = cam.toData(0, xBase)[1];
      const t = rulerTicks(iy, Y0, Y1, Math.max(3, Math.round(xBase / 72)));
      g.beginPath();
      for (const Y of t.minor) {
        const sy = snap(cam.toScreen(0, Y)[1], dpr);
        if (sy < 1 || sy > xBase - 3 || blocked(bx - 2, sy)) continue;
        g.moveTo(bx - 3, sy);
        g.lineTo(bx, sy);
      }
      g.strokeStyle = rgba(cream, 0.2);
      g.stroke();
      g.beginPath();
      const labels = [];
      for (const tk of t.major) {
        const sy = snap(cam.toScreen(0, tk.X)[1], dpr);
        if (sy < 1 || sy > xBase - 3 || blocked(bx - 3, sy)) continue;
        g.moveTo(bx - 6, sy);
        g.lineTo(bx, sy);
        labels.push([sy, tk.text]);
      }
      g.strokeStyle = rgba(cream, 0.52);
      g.stroke();
      g.font = monoFont(10);
      g.textAlign = 'right';
      g.textBaseline = 'middle';
      g.fillStyle = rgba(cream, 0.64);
      for (const [sy, text] of labels) {
        if (sy < 26 || sy > xBase - 8 || blocked(yBase - 20, sy)) continue;
        g.fillText(text, yBase - 9, sy + 0.5);
      }
      g.textAlign = 'left';
      g.textBaseline = 'alphabetic';
      const segs = fitTitle(g, iy, 'up', Math.max(80, xEnd - yBase - 24));
      const w = drawSegments(g, segs, yBase + 9, 17, 'left');
      titleBoxes.y = { x: yBase + 9, y: 4, w, h: 17 };
    } else titleBoxes.y = null;

    // ------------------------------------------------ tighten scan and result read-out
    if (scanT0) {
      const t = (now - scanT0) / 1000;
      const span = xEnd - yBase;
      const pos = yBase + span * (0.5 - 0.5 * Math.cos(t * 2.4));
      const gg = g.createLinearGradient(pos - 90, 0, pos + 90, 0);
      gg.addColorStop(0, rgba(orange, 0));
      gg.addColorStop(0.5, rgba(orange, 0.95));
      gg.addColorStop(1, rgba(orange, 0));
      g.strokeStyle = gg;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(Math.max(yBase, pos - 90), by);
      g.lineTo(Math.min(xEnd, pos + 90), by);
      g.stroke();
      g.lineWidth = 1;
      ov.invalidate();
    }
    if (flash) {
      const age = now - flash.t0;
      const a = age < 250 ? age / 250 : Math.max(0, 1 - (age - flash.dur + 900) / 900);
      if (age > flash.dur) flash = null;
      else {
        g.font = monoFont(10);
        g.textAlign = 'right';
        g.fillStyle = rgba(orange, 0.95 * Math.min(1, a));
        g.fillText(flash.text, xEnd - 14, xBase - 26);
        g.textAlign = 'left';
        ov.invalidate();
      }
    }
  }

  /** 'x' | 'y' | null for a point in stage CSS px. */
  function zoneAt(sx, sy) {
    const { W, H, xBase, yBase, xEnd } = layout();
    if (!(sx >= 0 && sy >= 0 && sx <= Math.min(W, xEnd) && sy <= H)) return null;
    if (sy >= xBase - 22 && sx >= yBase - 4) return 'x';
    if (sx <= yBase + 22 && sy <= xBase + 4) return 'y';
    return null;
  }

  /** Drop-zone rectangles in stage CSS px. */
  function zones() {
    const { H, xBase, yBase, xEnd } = layout();
    return {
      x: { left: yBase, top: xBase - 22, width: xEnd - yBase, height: H - xBase + 22 },
      y: { left: 0, top: 0, width: yBase + 22, height: xBase },
    };
  }

  return {
    draw,
    zoneAt,
    zones,
    layout,
    /** Rects [{x, y, w, h}] of the axis titles as last drawn (stage CSS px). */
    titleRects: () => [titleBoxes.x, titleBoxes.y].filter(Boolean),
    get highlight() { return highlight; },
    setHighlight(axis) {
      const h = axis === 'x' || axis === 'y' ? axis : null;
      if (h !== highlight) {
        highlight = h;
        ov.invalidate();
      }
    },
    scan(on) {
      scanT0 = on ? performance.now() : 0;
      ov.invalidate();
    },
    flash(text, dur = 5200) {
      flash = text ? { text, t0: performance.now(), dur } : null;
      ov.invalidate();
    },
  };
}
