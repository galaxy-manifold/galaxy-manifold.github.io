// Overlays (DESIGN.md §15): axis rulers, trends, literature relations, the lasso tool, the
// mosaic and projection-pursuit "tighten". Everything is drawn on the core's #overlay canvas
// (axes, trends, literature, lasso) and #tiles canvas (mosaic) in sync with the glow: the
// 'render' event redraws them, so per-frame work is only mapping cached curves through the
// camera. Heavy work (≤ 60k-row trends, fitOffset medians, full re-tiles) happens on 'settle';
// during motion trends refresh at ≤ 10 Hz from ≤ 15k rows and the mosaic at ≤ 4 Hz.
//
// Public API (installed on the app):
//   app.pursuit = { tighten(opts) → Promise<result|false>, cancel(), busy, last }   (tighten.js;
//                   emits 'pursuit' {phase: 'start'|'done'|'cancel', result})
//   app.overlays = {
//     axisZoneAt(x, y, {client}) → 'x' | 'y' | null   ruler drop zone under a point (stage CSS
//                                                      px, or client px with {client: true})
//     axisZones() → {x: rect, y: rect}                 drop-zone rectangles (stage CSS px)
//     highlightAxis('x' | 'y' | null)                  show a ruler as the drop target
//     dropDim(key, 'x' | 'y') → Promise                put a dimension on an axis (animated)
//     literature: {ready, status ('loading'|'ready'|'missing'), relations, visible() →
//                  [{id, label, opacity, dy}], labelBoxes()},
//     trends: {result, timing}, lasso: {active, selectPolygon(screenPoly, 'new'|'add'|'sub')},
//     mosaic: {available, tiles, grid, tileAt(sx, sy), stats()}, axes: {titleRects(), …},
//     redraw(), stats() → {overlayMs, overlayMax, cover, mosaic, literature, trends}
//   }
// The rulers, titles and labels keep to the part of the stage not covered by the inspector
// drawer (#inspector.open), which is tracked through its open/close transition.
// HTML5 drag-and-drop onto the rulers also works directly: a drag whose dataTransfer carries
// a dimension key as 'application/x-galaxy-dim', 'text/x-galaxy-dim' or 'text/plain' is
// accepted over a ruler and dropped with dropDim. UI elements mounted in #stage-ui that
// touch the rulers (e.g. the compass) are kept clear of tick labels; mark others with
// data-ov-avoid to be avoided too.

import { createAxes, RULER } from './axes.js';
import { createTrends } from './trends.js';
import { createLiterature } from './literature.js';
import { createLasso } from './lasso.js';
import { createMosaic } from './mosaic.js';
import { createTighten } from './tighten.js';
import { beginCanvas, MONO } from './draw.js';

const DIM_TYPES = ['application/x-galaxy-dim', 'text/x-galaxy-dim', 'text/x-dim', 'text/plain'];

export function initOverlays(app) {
  const { stage, stageUI, overlay: canvas } = app.layers;
  if (!canvas || !stage) return null;
  const ctx = canvas.getContext('2d');
  const data = app.data;

  const layer = document.createElement('div');
  layer.className = 'ov-layer';
  layer.setAttribute('aria-hidden', 'false');
  if (stageUI) stageUI.prepend(layer);
  else stage.appendChild(layer);

  let raf = 0, dirty = true, lastDraw = 0;
  const timing = { overlayMs: 0, overlayMax: 0 };

  const ov = {
    layer,
    avoid: [],
    fontsVersion: 0,
    cover: { r: 0, b: 0 },   // CSS px of the stage covered by the inspector (side drawer / bottom sheet)
    invalidate() {
      dirty = true;
      if (!raf) raf = requestAnimationFrame(onFrame);
    },
    /** Stage area not covered by the inspector drawer (CSS px). */
    free() {
      const W = app.camera.width, H = app.camera.height;
      return { l: 0, t: 0, r: Math.max(0, W - ov.cover.r), b: Math.max(0, H - ov.cover.b) };
    },
    /** Plot area inside the rulers and outside the drawer: curves, labels and tiles live here. */
    plotRect() {
      const H = app.camera.height;
      const f = ov.free();
      return { l: RULER.left, t: 0, r: f.r, b: Math.min(f.b, H - RULER.bottom) };
    },
  };

  const axes = createAxes(app, ov);
  // label placement keeps clear of the axis titles (when drawn) and of stage UI on the rulers
  ov.blockedRects = () => {
    const out = app.store.get().overlays.axes !== false ? axes.titleRects() : [];
    for (const r of ov.avoid) out.push({ x: r[0], y: r[1], w: r[2] - r[0], h: r[3] - r[1] });
    return out;
  };
  const literature = createLiterature(app, ov);
  const lasso = createLasso(app, ov);
  const trends = createTrends(app, ov);
  const mosaic = createMosaic(app, ov);
  const pursuit = createTighten(app, ov, axes);
  app.pursuit = pursuit;

  function drawOverlay(now) {
    dirty = false;
    const t0 = performance.now();
    const dt = lastDraw ? Math.min(0.1, Math.max(0, (now - lastDraw) / 1000)) : 1 / 60;
    lastDraw = now;
    const cam = app.camera;
    beginCanvas(ctx, canvas, cam.dpr);
    if (!data.loaded) return;
    const s = app.store.get();
    let more = false;
    const plot = ov.plotRect();
    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.l, plot.t, plot.r - plot.l, plot.b - plot.t);
    ctx.clip();
    if (s.overlays.trends !== false) more = trends.draw(ctx, now, dt) || more;
    ctx.restore();
    literature.draw(ctx, now);
    lasso.draw(ctx, now);
    if (s.overlays.axes !== false) axes.draw(ctx, now);
    if (more) ov.invalidate();
    const ms = performance.now() - t0;
    timing.overlayMs = timing.overlayMs ? 0.9 * timing.overlayMs + 0.1 * ms : ms;
    timing.overlayMax = Math.max(timing.overlayMax, ms);
  }

  function onFrame(now) {
    raf = 0;
    if (dirty) drawOverlay(now);
  }

  // ------------------------------------------------------------------ events
  const settled = () => !app.proj.stale && !app.isMoving();

  app.events.on('render', () => {
    const now = performance.now();
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    drawOverlay(now);
    mosaic.draw(now);
  });

  app.events.on('settle', () => {
    trends.computeSettled();
    mosaic.retile(false);
    refreshAvoid();
    ov.invalidate();
  });

  app.events.on('frame', (p) => {
    if (p && p.animating) {
      trends.scheduleMotion();
      mosaic.scheduleMotion();
    }
  });

  // pans and zooms: the mosaic grid is anchored in data space, so zooming changes the cell
  // size in data units; re-tile at ≤ 4 Hz meanwhile (loaded images only), fully on settle
  app.events.on('camera', () => mosaic.cameraMoved());

  app.events.on('state', ({ changed, state }) => {
    if (changed.includes('color') || changed.includes('selection')) {
      if (settled()) trends.computeSettled();
      else trends.scheduleMotion();
    }
    if (changed.includes('filters')) trends.invalidateCandidates();
    if (changed.includes('overlays') && state.overlays.trends !== false && !trends.result && settled()) trends.computeSettled();
    if (changed.includes('mode') || changed.includes('mosaic')) {
      mosaic.retile(!settled());
      mosaic.invalidate();
    }
    if (changed.includes('selection') || changed.includes('inspected')) mosaic.invalidate();
    ov.invalidate();
  });

  app.events.on('resize', () => {
    measureCover();
    ov.invalidate();
    mosaic.invalidate();
  });

  // ------------------------------------------------------------------ inspector drawer
  // The drawer slides over the stage (right side; bottom sheet below 760 px). Rulers, titles
  // and labels keep to the uncovered part, so follow its open/close transition closely.
  const insp = document.getElementById('inspector');
  let coverPoll = 0;
  function measureCover() {
    if (!insp) return false;
    const sr = stage.getBoundingClientRect();
    const r = insp.getBoundingClientRect();
    let cr = 0, cb = 0;
    if (r.width > 0 && r.height > 0 && getComputedStyle(insp).visibility !== 'hidden') {
      const ox = Math.min(sr.right, r.right) - Math.max(sr.left, r.left);
      const oy = Math.min(sr.bottom, r.bottom) - Math.max(sr.top, r.top);
      if (ox > 2 && oy > 2) {
        if (r.left > sr.left + 0.3 * sr.width && oy > 0.5 * sr.height) cr = Math.round(sr.right - r.left);
        else if (r.top > sr.top + 0.2 * sr.height && ox > 0.5 * sr.width) cb = Math.round(sr.bottom - r.top);
      }
    }
    if (cr === ov.cover.r && cb === ov.cover.b) return false;
    ov.cover = { r: Math.max(0, cr), b: Math.max(0, cb) };
    ov.invalidate();
    mosaic.invalidate();
    return true;
  }
  function followCover(ms = 700) {
    const t0 = performance.now();
    cancelAnimationFrame(coverPoll);
    const step = () => {
      measureCover();
      coverPoll = performance.now() - t0 < ms ? requestAnimationFrame(step) : 0;
    };
    coverPoll = requestAnimationFrame(step);
  }
  if (insp) {
    if (typeof MutationObserver === 'function') {
      new MutationObserver(() => followCover()).observe(insp, { attributes: true, attributeFilter: ['class', 'style', 'data-open', 'hidden'] });
    }
    insp.addEventListener('transitionend', () => measureCover());
    measureCover();
  }

  app.events.on('thumb', (k) => mosaic.onThumb(k));

  const onReady = () => {
    mosaic.init();
    if (settled()) trends.computeSettled();
    refreshAvoid();
    ov.invalidate();
  };
  if (data.loaded) onReady();
  else app.events.on('data:ready', onReady);

  if (document.fonts && document.fonts.load) {
    const fontsLoaded = () => {
      ov.fontsVersion++;
      ov.invalidate();
    };
    Promise.all([document.fonts.load(`10px ${MONO}`), document.fonts.load(`700 11px ${MONO}`)])
      .then(fontsLoaded)
      .catch(() => {});
    document.fonts.addEventListener?.('loadingdone', fontsLoaded);
  }

  // ------------------------------------------------------------------ UI elements to keep clear
  function refreshAvoid() {
    if (!stageUI) return;
    const sr = stage.getBoundingClientRect();
    const W = sr.width, H = sr.height;
    const out = [];
    for (const el of stageUI.children) {
      if (el === layer) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 24 || r.height < 24 || r.width * r.height > 0.5 * W * H) continue;
      const cs = getComputedStyle(el);
      const shown = cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.05;
      if (!shown && !el.hasAttribute('data-ov-avoid')) continue;
      const x0 = r.left - sr.left, y0 = r.top - sr.top, x1 = x0 + r.width, y1 = y0 + r.height;
      if (y1 < H - 64 && x0 > 76) continue;   // not touching a ruler band
      out.push([x0 - 4, y0 - 4, x1 + 4, y1 + 4]);
    }
    ov.avoid = out;
  }

  // ------------------------------------------------------------------ rulers as drop zones
  function axisZoneAt(x, y, { client = false } = {}) {
    if (client) {
      const r = stage.getBoundingClientRect();
      x -= r.left;
      y -= r.top;
    }
    return axes.zoneAt(x, y);
  }

  function dropDim(key, axis) {
    if (data.dimIndex(key) < 0 || (axis !== 'x' && axis !== 'y')) return Promise.resolve(false);
    axes.setHighlight(null);
    return app.actions.setAxes({ [axis]: { [key]: 1 } });
  }

  const hasDimType = (e) => {
    const types = e.dataTransfer ? Array.from(e.dataTransfer.types || []) : [];
    return types.some((t) => DIM_TYPES.includes(t));
  };
  stage.addEventListener('dragover', (e) => {
    if (!hasDimType(e)) return;
    const z = axisZoneAt(e.clientX, e.clientY, { client: true });
    axes.setHighlight(z);
    if (z) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    }
  });
  stage.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget || !stage.contains(e.relatedTarget)) axes.setHighlight(null);
  });
  stage.addEventListener('drop', (e) => {
    const z = axisZoneAt(e.clientX, e.clientY, { client: true });
    axes.setHighlight(null);
    if (!z || e.defaultPrevented || !e.dataTransfer) return;
    let key = '';
    for (const t of DIM_TYPES) {
      key = (e.dataTransfer.getData(t) || '').trim();
      if (key) break;
    }
    key = key.replace(/^dim:/, '');
    if (data.dimIndex(key) < 0) return;
    e.preventDefault();
    dropDim(key, z);
  });

  const api = {
    axisZoneAt,
    axisZones: () => axes.zones(),
    highlightAxis: (axis) => axes.setHighlight(axis),
    dropDim,
    axes,
    literature,
    trends,
    lasso,
    mosaic,
    redraw() {
      ov.invalidate();
      mosaic.invalidate();
    },
    stats() {
      const t = trends.result;
      return {
        ...timing,
        cover: { ...ov.cover },
        mosaic: mosaic.stats(),
        literature: literature.visible(),
        trends: t ? { bins: t.bins, groups: t.groups.length, n: t.n, sel: t.sel ? t.sel.n : 0, ...trends.timing } : null,
      };
    },
  };
  app.overlays = api;
  return api;
}
