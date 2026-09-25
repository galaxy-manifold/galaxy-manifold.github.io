// Literature relations (§9, §10, §15). Loaded from <data base>/literature.json (a missing or
// malformed file just means no curves). Each relation is drawn in its native plane
// (A_x = Σ κ x along its x combo, A_y along its y combo) mapped into the current frame, with
// opacity smoothstep(0.90, 0.985, min(align_x, align_y)), so curves appear only when the view
// matches their native axes and mirror/turn correctly as the frame moves. Mustard strokes
// (solid / dashed / dotted), translucent hatched bands, small open circles on measured nodes,
// and a tiny label at the curve end (with a swatch of its line style) whose hover shows the
// name and citation (click opens ADS). Each label takes the free spot around its curve end
// that covers the fewest curves and other ends (geom.chooseLabelBoxes), with a hairline leader
// if it had to be pushed away. fitOffset relations are shifted in y by the
// median residual of the visible galaxies inside the relation's range (computed once per
// filter state, never per frame while the view moves).

import * as fm from '../../math/frame.js';
import { dot, smoothstep } from '../../math/linalg.js';
import { polylineFunction, nativeAxes, chooseLabelBoxes } from './geom.js';
import { COLORS, rgba, dashFor, monoFont } from './draw.js';

const LABEL_H = 14;
const SWATCH_W = 13;      // CSS px, incl. the gap to the text (keep in sync with overlays.css)
const OFFSET_ROWS = 20000;

function flatPoints(points) {
  const out = [];
  for (const p of points || []) if (p && Number.isFinite(+p[0]) && Number.isFinite(+p[1])) out.push(+p[0], +p[1]);
  return Float64Array.from(out);
}

const SVGNS = 'http://www.w3.org/2000/svg';

/** Inline SVG swatch of a line style (solid / dashed / dotted). */
function swatch(style) {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'ov-sw');
  svg.setAttribute('viewBox', '0 0 10 6');
  svg.setAttribute('aria-hidden', 'true');
  const ln = document.createElementNS(SVGNS, 'line');
  ln.setAttribute('x1', style === 'dotted' ? '1' : '0');
  ln.setAttribute('x2', style === 'dotted' ? '9.5' : '10');
  ln.setAttribute('y1', '3');
  ln.setAttribute('y2', '3');
  if (style === 'dashed') ln.setAttribute('stroke-dasharray', '4 2.2');
  if (style === 'dotted') {
    ln.setAttribute('stroke-dasharray', '0.1 2.6');
    ln.setAttribute('stroke-linecap', 'round');
    ln.setAttribute('stroke-width', '1.7');
  }
  svg.appendChild(ln);
  return svg;
}

export function createLiterature(app, ov) {
  const data = app.data, dims = data.dims, D = data.D;
  let rels = [];
  let status = 'loading';
  const offsets = new Map();
  let lastFilters = null, filterKey = '';
  let staleOffsets = false;
  let hovered = null;
  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });
  const measureCtx = document.createElement('canvas').getContext('2d');
  let hatch = null, hatchDpr = 0;

  const tip = document.createElement('div');
  tip.className = 'ov-tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  ov.layer.appendChild(tip);

  const enabled = () => app.store.get().overlays.literature !== false;

  function makeLabel(rel, text, style) {
    const a = document.createElement('a');
    a.className = 'ov-lit';
    a.dataset.id = rel.id;
    a.appendChild(swatch(style));
    const t = document.createElement('span');
    t.textContent = text;
    a.appendChild(t);
    if (rel.url) {
      a.href = rel.url;
      a.target = '_blank';
      a.rel = 'noopener';
    }
    a.setAttribute('aria-label', [rel.name, rel.cite].filter(Boolean).join(' — '));
    a.style.visibility = 'hidden';
    a.addEventListener('pointerenter', () => showTip(rel, a));
    a.addEventListener('pointerleave', () => hideTip(rel));
    a.addEventListener('focus', () => showTip(rel, a));
    a.addEventListener('blur', () => hideTip(rel));
    ov.layer.appendChild(a);
    measureCtx.font = monoFont(9);
    const w = Math.ceil(measureCtx.measureText(text).width + 6 + SWATCH_W);
    return { el: a, text, style, w, last: '', pos: null };
  }

  function showTip(rel, el) {
    hovered = { rel, el };
    app.interaction?.clearHover?.();   // the galaxy hover card would sit on top of the citation
    tip.replaceChildren();
    const n = document.createElement('div');
    n.className = 'ov-tip-name';
    n.textContent = rel.name || rel.label;
    tip.appendChild(n);
    if (rel.cite) {
      const c = document.createElement('div');
      c.className = 'ov-tip-cite';
      c.textContent = rel.cite;
      tip.appendChild(c);
    }
    if (rel.fitOffset && Number.isFinite(rel.dy) && rel.dy !== 0) {
      const o = document.createElement('div');
      o.className = 'ov-tip-off';
      o.textContent = `Δy ${fm.fmtNum(rel.dy, 3)} · zero point fitted to the data`;
      tip.appendChild(o);
    }
    tip.hidden = false;
    placeTip();
  }

  function hideTip(rel) {
    if (!hovered || hovered.rel !== rel) return;
    hovered = null;
    tip.hidden = true;
  }

  function placeTip() {
    if (!hovered || tip.hidden) return;
    const lab = [...hovered.rel.labels.values()].find((L) => L.el === hovered.el);
    const p = lab && lab.pos;
    if (!p) return;
    const free = ov.free();
    const tw = tip.offsetWidth || 220, th = tip.offsetHeight || 40;
    let x = p.x + p.w / 2 - tw / 2;
    x = Math.max(8, Math.min(free.r - tw - 8, x));
    let y = p.y - th - 8;
    if (y < 6) y = p.y + LABEL_H + 8;
    y = Math.max(6, Math.min(free.b - th - 6, y));
    tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  function normalize(json) {
    const list = Array.isArray(json && json.relations) ? json.relations : [];
    const out = [];
    const seen = new Set();
    for (const r of list) {
      try {
        if (!r || !r.id || seen.has(r.id) || !r.x || !r.y || typeof r.x !== 'object' || typeof r.y !== 'object') continue;
        const keys = [...Object.keys(r.x), ...Object.keys(r.y)];
        if (!keys.length || !keys.every((k) => data.dimIndex(k) >= 0)) continue;
        const cx = fm.comboVector(r.x, dims), cy = fm.comboVector(r.y, dims);
        if (!cx || !cy) continue;
        const g = dot(cx.v, cy.v, D);
        const det = 1 - g * g;
        if (!(det > 1e-9)) continue;
        const curves = (Array.isArray(r.curves) ? r.curves : []).map((c, i) => ({
          id: c && c.id != null ? String(c.id) : String(i),
          label: c && c.label ? String(c.label) : null,
          style: c && ['solid', 'dashed', 'dotted'].includes(c.style) ? c.style : 'solid',
          pts: flatPoints(c && c.points),
          nodes: flatPoints(c && c.nodes),
        })).filter((c) => c.pts.length >= 4);
        let band = null;
        if (Array.isArray(r.band) && r.band.length >= 2) {
          const b = [];
          for (const t of r.band) if (t && [t[0], t[1], t[2]].every((v) => Number.isFinite(+v))) b.push(+t[0], +t[1], +t[2]);
          if (b.length >= 6) band = Float64Array.from(b);
        }
        if (!curves.length && !band) continue;
        const range = Array.isArray(r.range) && r.range.length === 2 && r.range.every((v) => Number.isFinite(+v))
          ? [Math.min(+r.range[0], +r.range[1]), Math.max(+r.range[0], +r.range[1])] : [-Infinity, Infinity];
        const rel = {
          id: String(r.id),
          label: String(r.label || r.id).slice(0, 8),
          name: r.name ? String(r.name) : '',
          cite: r.cite ? String(r.cite) : '',
          url: typeof r.url === 'string' && /^https?:\/\//.test(r.url) ? r.url : '',
          view: r.view || null,
          kind: r.kind || 'fit',
          x: r.x, y: r.y, cx, cy, g, det, curves, band, range,
          fitOffset: !!r.fitOffset && curves.length > 0,
          fn: r.fitOffset && curves.length ? polylineFunction((r.curves.find((c) => c && c.points) || {}).points) : null,
          xt: Object.entries(r.x).map(([k, c]) => [data.dimIndex(k), +c]),
          yt: Object.entries(r.y).map(([k, c]) => [data.dimIndex(k), +c]),
          opacity: 0,
          dy: 0,
          labels: new Map(),
        };
        // the first curve carries the relation's label; other curves only their own labels
        curves.forEach((c, i) => {
          const text = i === 0 ? rel.label : c.label;
          if (text) rel.labels.set(c.id, makeLabel(rel, text, c.style));
        });
        seen.add(rel.id);
        out.push(rel);
      } catch (e) {
        console.warn('skipping malformed literature relation', r && r.id, e);
      }
    }
    return out;
  }

  async function load() {
    try {
      const res = await fetch(`${data.base}/literature.json`, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      rels = normalize(await res.json());
      status = 'ready';
    } catch (e) {
      console.warn('literature relations unavailable:', e.message || e);
      rels = [];
      status = 'missing';
    }
    resolveReady(rels);
    ov.invalidate();
  }

  // ------------------------------------------------------------------ fitOffset
  function currentFilterKey() {
    const f = app.store.get().filters;
    if (f !== lastFilters) {
      lastFilters = f;
      filterKey = JSON.stringify(f);
    }
    return filterKey;
  }

  /** Median residual (data − curve) in y of galaxies passing the filters inside the range. */
  function computeOffset(rel) {
    if (!data.loaded || !rel.fn) return null;
    const fp = app.filterParams();
    const n = data.n;
    const z = fp.z, zc = z ? data.raw[z.dim] : null, zd = z ? data.dims[z.dim] : null;
    const catCols = [];
    for (const c of data.categories) {
      if (c.slot < 0 || !data.cats[c.key]) continue;
      const m = fp.masks[c.slot] >>> 0;
      if ((m & 0xff) !== 0xff) catCols.push([data.cats[c.key], m]);
    }
    const [r0, r1] = rel.range;
    const res = new Float64Array(OFFSET_ROWS);
    let m = 0;
    const phys = (d, v) => dims[d].min + (v - 1) * dims[d].step;
    for (let i = 0; i < n && m < res.length; i++) {
      if (zc) {
        const v = zc[i];
        if (v === 0) continue;
        const u = v * zd.ua + zd.ub;
        if (u < z.lo || u > z.hi) continue;
      }
      let pass = true;
      for (const [col, mk] of catCols) if (((mk >>> col[i]) & 1) === 0) { pass = false; break; }
      if (!pass) continue;
      let Ax = 0, Ay = 0, ok = true;
      for (const [d, c] of rel.xt) { const v = data.raw[d][i]; if (v === 0) { ok = false; break; } Ax += c * phys(d, v); }
      if (!ok || Ax < r0 || Ax > r1) continue;
      for (const [d, c] of rel.yt) { const v = data.raw[d][i]; if (v === 0) { ok = false; break; } Ay += c * phys(d, v); }
      if (!ok) continue;
      const yc = rel.fn(Ax);
      if (yc === yc) res[m++] = Ay - yc;
    }
    if (m < 50) return { dy: 0, n: m };
    const s = res.subarray(0, m).sort();
    return { dy: m & 1 ? s[(m - 1) >> 1] : 0.5 * (s[m / 2 - 1] + s[m / 2]), n: m };
  }

  /** Offset for the current filters; while the view moves a previous value is reused. */
  function offsetFor(rel) {
    if (!rel.fitOffset) return 0;
    const key = currentFilterKey();
    const o = offsets.get(rel.id);
    if (o && o.key === key) return o.dy;
    if (o && app.isMoving()) {
      staleOffsets = true;
      return o.dy;
    }
    const r = computeOffset(rel);
    if (!r) return o ? o.dy : null;
    offsets.set(rel.id, { key, dy: r.dy, n: r.n });
    return r.dy;
  }

  // ------------------------------------------------------------------ drawing
  let bx = new Float64Array(256), by = new Float64Array(256);
  function ensure(k) {
    if (bx.length < k) { bx = new Float64Array(k); by = new Float64Array(k); }
  }

  function hideLabel(L) {
    if (L.last !== 'hidden') {
      L.el.style.visibility = 'hidden';
      L.last = 'hidden';
    }
    L.pos = null;
  }

  function hideRel(rel) {
    for (const L of rel.labels.values()) hideLabel(L);
    if (hovered && hovered.rel === rel) hideTip(rel);
  }

  /** Diagonal hatch pattern (device-pixel sharp) for bands. */
  function hatchPattern(g, dpr) {
    if (hatch && hatchDpr === dpr) return hatch;
    const s = Math.round(7 * dpr);
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const h = c.getContext('2d');
    h.strokeStyle = COLORS.mustard;
    h.lineWidth = Math.max(1, 0.8 * dpr);
    h.beginPath();
    for (const o of [-s, 0, s]) {
      h.moveTo(o, s);
      h.lineTo(o + s, 0);
    }
    h.stroke();
    hatch = g.createPattern(c, 'repeat');
    if (hatch && hatch.setTransform && typeof DOMMatrix === 'function') hatch.setTransform(new DOMMatrix().scale(1 / dpr));
    hatchDpr = dpr;
    return hatch;
  }

  function draw(g) {
    if (!rels.length) return;
    if (!enabled() || !data.loaded) {
      for (const r of rels) hideRel(r);
      return;
    }
    const F = app.frame;
    const cam = app.camera;
    const W = cam.width, H = cam.height, kx = cam.scaleX, ky = cam.scaleY, ccx = cam.cx, ccy = cam.cy;
    const plot = ov.plotRect();
    const mosaic = app.store.get().mode === 'mosaic';
    const labels = [];
    const obstacles = [];   // [x, y, weight, …]: curve vertices and curve ends, for label placement
    const inside = (x, y) => x >= plot.l + 4 && x <= plot.r - 4 && y >= plot.t + 4 && y <= plot.b - 4;
    g.save();
    g.beginPath();
    g.rect(plot.l, plot.t, plot.r - plot.l, plot.b - plot.t);
    g.clip();
    g.lineJoin = 'round';
    for (const rel of rels) {
      const na = nativeAxes(rel.cx, rel.cy, F);
      if (!na) { rel.opacity = 0; hideRel(rel); continue; }
      const { pxx, pxy, pyx, pyy } = na;
      const op = smoothstep(fm.LIT_ALIGN_LO, fm.LIT_ALIGN_HI, Math.min(na.ax, na.ay));
      rel.opacity = op;
      if (op < 0.004) { hideRel(rel); continue; }
      const dy = offsetFor(rel);
      if (dy == null) { hideRel(rel); continue; }
      rel.dy = dy;
      const { cx, cy, g: gg, det } = rel;
      const toS = (Ax, Ay, k) => {
        const xn = (Ax - cx.offset) / cx.norm, yn = (Ay + dy - cy.offset) / cy.norm;
        const a = (xn - gg * yn) / det, b = (yn - gg * xn) / det;
        bx[k] = W / 2 + (pxx * a + pxy * b - ccx) * kx;
        by[k] = H / 2 - (pyx * a + pyy * b - ccy) * ky;
      };
      const alpha = op * (mosaic ? 0.85 : 1);
      // band: translucent hatch plus dotted edges
      if (rel.band) {
        const m = rel.band.length / 3;
        ensure(2 * m);
        for (let k = 0; k < m; k++) toS(rel.band[3 * k], rel.band[3 * k + 2], k);
        for (let k = 0; k < m; k++) toS(rel.band[3 * (m - 1 - k)], rel.band[3 * (m - 1 - k) + 1], m + k);
        g.beginPath();
        g.moveTo(bx[0], by[0]);
        for (let k = 1; k < 2 * m; k++) g.lineTo(bx[k], by[k]);
        g.closePath();
        const pat = mosaic ? null : hatchPattern(g, cam.dpr);   // a hatch over tiles is noise
        if (pat) {
          g.globalAlpha = 0.3 * alpha;
          g.fillStyle = pat;
          g.fill();
          g.globalAlpha = 1;
        }
        g.setLineDash([1.5, 3]);
        g.lineCap = 'round';
        g.lineWidth = 1.2;
        g.strokeStyle = rgba(COLORS.mustard, 0.7 * alpha);
        g.beginPath();
        for (let k = 0; k < m; k++) g.lineTo(bx[k], by[k]);
        g.moveTo(bx[m], by[m]);
        for (let k = m + 1; k < 2 * m; k++) g.lineTo(bx[k], by[k]);
        g.stroke();
        g.setLineDash([]);
      }
      for (const c of rel.curves) {
        const m = c.pts.length / 2;
        ensure(m);
        for (let k = 0; k < m; k++) toS(c.pts[2 * k], c.pts[2 * k + 1], k);
        g.beginPath();
        g.moveTo(bx[0], by[0]);
        for (let k = 1; k < m; k++) g.lineTo(bx[k], by[k]);
        g.setLineDash([]);
        g.lineCap = 'round';
        g.strokeStyle = rgba(COLORS.bg, 0.5 * alpha);
        g.lineWidth = 3.6;
        g.stroke();
        g.setLineDash(dashFor(c.style));
        g.strokeStyle = rgba(COLORS.mustard, 0.95 * alpha);
        g.lineWidth = c.style === 'dotted' ? 2 : 1.5;
        g.stroke();
        g.setLineDash([]);
        if (alpha > 0.2) {
          for (let k = 0; k < m; k++) if (inside(bx[k], by[k])) obstacles.push(bx[k], by[k], 6);
          for (const k of [0, m - 1]) if (inside(bx[k], by[k])) obstacles.push(bx[k], by[k], 80);
        }
        const L = rel.labels.get(c.id);
        if (L) {
          // anchor: the right-most end of the visible part of the curve
          let first = -1, last = -1;
          for (let k = 0; k < m; k++) {
            if (inside(bx[k], by[k])) {
              if (first < 0) first = k;
              last = k;
            }
          }
          if (first < 0) hideLabel(L);
          else {
            const e = bx[last] >= bx[first] ? last : first;
            const nb = e === last ? Math.max(0, e - 1) : Math.min(m - 1, e + 1);
            let dx = bx[e] - bx[nb], dyy = by[e] - by[nb];
            const len = Math.hypot(dx, dyy) || 1;
            dx /= len;
            dyy /= len;
            const trueEnd = e === 0 || e === m - 1;
            labels.push({ L, rel, x: bx[e], y: by[e], dx, dy: dyy, alpha, trueEnd });
          }
        }
        if (c.nodes.length) {
          const nn = c.nodes.length / 2;
          ensure(nn);
          for (let k = 0; k < nn; k++) toS(c.nodes[2 * k], c.nodes[2 * k + 1], k);
          g.lineWidth = 1.2;
          g.strokeStyle = rgba(COLORS.mustard, 0.95 * alpha);
          g.fillStyle = rgba(COLORS.bg, 0.9 * alpha);
          for (let k = 0; k < nn; k++) {
            g.beginPath();
            g.arc(bx[k], by[k], 2.4, 0, 2 * Math.PI);
            g.fill();
            g.stroke();
          }
        }
      }
    }
    g.restore();
    placeLabels(g, labels, plot, obstacles);
  }

  function placeLabels(g, labels, plot, obstacles) {
    // stronger relations (more opaque) choose first
    const order = labels.map((_, i) => i).sort((a, b) => labels[b].alpha - labels[a].alpha || a - b);
    const items = order.map((i) => {
      const it = labels[i];
      return { ax: it.x, ay: it.y, dx: it.dx, dy: it.dy, w: it.L.w, h: LABEL_H, trueEnd: it.trueEnd };
    });
    const bounds = { l: plot.l + 2, r: plot.r - 2, t: plot.t + 2, b: plot.b - 2 };
    const blocked = ov.blockedRects ? ov.blockedRects() : [];
    const pos = chooseLabelBoxes(items, obstacles, bounds, { blocked });
    const shown = new Set();
    g.save();
    g.lineWidth = 1;
    order.forEach((li, j) => {
      const it = labels[li];
      const { L, alpha } = it;
      const { x, y, far } = pos[j];
      shown.add(L);
      L.pos = { x, y, w: L.w };
      // leader from the curve end when the label could not sit right next to it
      const qx = Math.max(x, Math.min(x + L.w, it.x)), qy = Math.max(y, Math.min(y + LABEL_H, it.y));
      if (far && Math.hypot(qx - it.x, qy - it.y) > 8) {
        g.strokeStyle = rgba(COLORS.mustard, 0.55 * alpha);
        g.beginPath();
        g.moveTo(it.x, it.y);
        g.lineTo(qx, qy);
        g.stroke();
      }
      const key = `${Math.round(x * 2)}|${Math.round(y * 2)}|${alpha.toFixed(2)}`;
      if (L.last !== key) {
        L.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
        L.el.style.opacity = String(Math.min(1, alpha * 1.1).toFixed(3));
        L.el.style.visibility = 'visible';
        L.el.style.pointerEvents = alpha > 0.35 ? 'auto' : 'none';
        L.last = key;
      }
    });
    g.restore();
    for (const rel of rels) {
      for (const L of rel.labels.values()) if (!shown.has(L) && L.last !== 'hidden') hideLabel(L);
      if (hovered && hovered.rel === rel && ![...rel.labels.values()].some((L) => shown.has(L))) hideTip(rel);
    }
    if (hovered) placeTip();
  }

  // recompute stale fitOffsets once the view rests
  app.events.on('settle', () => {
    if (staleOffsets) {
      staleOffsets = false;
      ov.invalidate();
    }
  });

  load();

  return {
    draw,
    ready,
    get status() { return status; },
    get relations() { return rels; },
    /** Relations currently drawn: [{id, label, opacity, dy}]. */
    visible() {
      return rels.filter((r) => r.opacity > 0.004).map((r) => ({ id: r.id, label: r.label, opacity: r.opacity, dy: r.dy || 0 }));
    },
    /** Label boxes currently shown (stage CSS px): [{id, text, x, y, w}]. */
    labelBoxes() {
      const out = [];
      for (const r of rels) for (const L of r.labels.values()) if (L.pos) out.push({ id: r.id, text: L.text, ...L.pos });
      return out;
    },
    resetOffsets() { offsets.clear(); },
  };
}
