// The `app` object (DESIGN.md §12): wires data, store, events, renderer, camera, projection
// cache, thumbnails and interaction, and exposes the actions used by the UI and overlays.
// See js/API.md for the contract as implemented.

import { Emitter } from './events.js';
import { Store } from './state.js';
import { Dataset, loadColumns, loadMeta } from './data/loader.js';
import { ThumbCache } from './data/thumbs.js';
import { Renderer, spriteSizeDev } from './gl/renderer.js';
import { Camera, easeView, fitParams } from './view/camera.js';
import { ProjectionCache } from './view/projection.js';
import { Interaction } from './view/interaction.js';
import * as fm from './math/frame.js';
import { setCosmology } from './math/cosmo.js';
import { PRESETS, presetById, availablePresets, DEFAULT_PRESET, ALL_CODES } from './config/presets.js';
import { DIM_CONFIG, dimConfig, defaultTourSet, colorRange, formatValue, TOUR_DEFAULT } from './config/dims.js';
import * as style from './config/style.js';

const { MOTION, CATEGORY_COLORS, NEUTRAL, hexToRgb01 } = style;
const SETTLE_MS = 150;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * Create the app shell. The manifest must be loaded; columns are loaded by app.load().
 * opts: {manifest, base, root (document)}.
 */
export function createApp({ manifest, base = 'data', root = document } = {}) {
  const events = new Emitter();
  const data = new Dataset(manifest, base);
  const D = data.D;
  if (manifest.cosmology) setCosmology(manifest.cosmology);

  const layers = {
    stage: root.getElementById('stage'),
    gl: root.getElementById('gl'),
    tiles: root.getElementById('tiles'),
    overlay: root.getElementById('overlay'),
    stageUI: root.getElementById('stage-ui'),
  };

  const reduced = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  const motionScale = () => (reduced.matches ? MOTION.reducedScale : 1);

  const presets = availablePresets(data.dims);
  const defaultPresetId = presets.find((p) => p.id === DEFAULT_PRESET)?.id || presets[0]?.id || null;
  const catMasksAll = Object.fromEntries(data.categories.map((c) => [c.key, ALL_CODES]));

  const config = {
    presets,
    allPresets: PRESETS,
    defaultPreset: defaultPresetId,
    dims: { table: DIM_CONFIG, get: dimConfig, colorRange, format: formatValue, tourDefault: TOUR_DEFAULT },
    style,
    splash: { auto: true },
  };

  const store = new Store({
    presetId: null,
    color: null,
    mode: 'glow',
    overlays: { trends: true, literature: true, axes: true },
    filters: { z: null, cats: { ...catMasksAll }, needColor: false },
    tour: { playing: false, set: defaultTourSet(data.dims), speed: 1 },
    render: { gain: 1, pointSize: 2, bloom: 0.3 },
    tool: 'pan',
    selection: null,
    inspected: null,
    mosaic: { cell: 56, scale: 'fit' },
  });

  function presetFrame(id) {
    const p = typeof id === 'string' ? presetById(id) : id;
    if (!p) return null;
    return fm.frameFromCombos(p.x, p.y, data.dims).F;
  }

  const frame = new Float64Array(2 * D);
  frame.set(presetFrame(defaultPresetId) || fm.basisFrame(D, 0, Math.min(1, D - 1)));
  const scratchF = new Float64Array(2 * D);

  // ------------------------------------------------------------------ core objects
  const app = {
    data, store, events, config, layers, frame,
    renderer: null, camera: null, proj: null, thumbs: null, interaction: null,
    actions: {},
    pursuit: { tighten: () => false },   // replaced by the overlays agent
    frameVersion: 0,
    webgl: false,
    started: false,
    timing: {},
    stats: { fps: 0, drawMs: 0, tickMs: 0, tickMax: 0 },
    motion: { reduced: () => reduced.matches, scale: motionScale },
  };

  let viewTouched = false;
  let pendingFit = true;
  let firstPaint = false;
  const camera = new Camera({
    onChange: (why) => {
      if (why === 'resize') return;
      if (why === 'set' && !data.loaded) pendingFit = false;
      if ((why === 'zoom' || why === 'pan') && tour.active) tour.userCamera = true;
      exposure.dirty = true;
      markMotion();
      events.emit('camera');
      requestRender();
    },
  });
  const renderer = new Renderer(layers.gl, {
    onLost: () => {
      layers.stage.classList.add('gl-lost');
      console.warn('WebGL context lost; waiting for restore');
      events.emit('context', { lost: true });
    },
    onRestored: () => {
      layers.stage.classList.remove('gl-lost');
      events.emit('context', { lost: false });
      requestRender();
    },
  });
  app.webgl = renderer.init();
  const proj = new ProjectionCache({ camera, onError: (m) => console.warn(m) });
  const thumbs = new ThumbCache(data, (name, k) => events.emit(name, k));
  Object.assign(app, { renderer, camera, proj, thumbs });
  const interaction = new Interaction(app, layers.stage);
  app.interaction = interaction;

  // ------------------------------------------------------------------ derived render params
  let colorCache = null;
  function colorParams(c = store.get().color) {
    if (!c) return { mode: 'none', key: null };
    if (c.startsWith('cat:')) {
      const spec = data.catSpec(c.slice(4));
      if (!spec || spec.slot < 0) return { mode: 'none', key: null };
      const colors = Array.from({ length: 8 }, () => hexToRgb01(NEUTRAL));
      const hex = Array(8).fill(NEUTRAL);
      for (const e of spec.codes) {
        hex[e.code] = CATEGORY_COLORS[spec.key]?.[e.code] || e.color || NEUTRAL;
        colors[e.code] = hexToRgb01(hex[e.code]);
      }
      return { mode: 'categorical', key: c, cat: spec.key, slot: spec.slot, colors, hex, spec };
    }
    const d = data.dim(c);
    if (!d) return { mode: 'none', key: null };
    const cfg = dimConfig(d.key);
    const range = colorRange(d);
    let lo = (range[0] - d.center) / d.scale, hi = (range[1] - d.center) / d.scale;
    if (cfg.reverse) [lo, hi] = [hi, lo];
    return { mode: 'continuous', key: c, dim: d.index, lo, hi, cmap: cfg.cmap, reverse: cfg.reverse, range, spec: d };
  }
  function colorP() {
    const c = store.get().color;
    if (!colorCache || colorCache.key !== c) colorCache = { key: c, p: colorParams(c) };
    return colorCache.p;
  }

  let filterCache = null;
  /**
   * Renderer/projection filter description for a filters state and color key (default:
   * current). `needColor` hides galaxies without a value of the color variable: a
   * continuous color sets `need` (its dim index), a categorical one drops code 0 from its mask.
   */
  function filterParams(f, color) {
    const s = store.get();
    const cur = s.filters;
    const ckey = color !== undefined ? color : s.color;
    const own = !f && color === undefined;
    const ck = cur.needColor ? ckey : null;   // the color only matters with needColor on
    if (own && filterCache && filterCache.src === cur && filterCache.color === ck) return filterCache.p;
    const src = f || cur;
    const zi = data.dimIndex('z');
    let z = null;
    if (src.z && zi >= 0) {
      const d = data.dims[zi];
      z = { dim: zi, lo: (src.z[0] - d.center) / d.scale, hi: (src.z[1] - d.center) / d.scale };
    }
    const masks = [0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff];
    for (const c of data.categories) {
      if (c.slot >= 0 && src.cats && src.cats[c.key] != null) masks[c.slot] = (src.cats[c.key] & 0xff) >>> 0;
    }
    let need = -1;
    if (src.needColor && ckey) {
      if (ckey.startsWith('cat:')) {
        const spec = data.catSpec(ckey.slice(4));
        if (spec && spec.slot >= 0) masks[spec.slot] = (masks[spec.slot] & ~1) >>> 0;
      } else need = data.dimIndex(ckey);
    }
    const p = { z, masks, need };
    if (own) filterCache = { src: cur, color: ck, p };
    return p;
  }

  function pointSizeDev(dpr = renderer.dpr) {
    return spriteSizeDev(store.get().render.pointSize, dpr, renderer.caps?.maxPointSize || 64);
  }

  function renderParams() {
    const s = store.get();
    return {
      frame: app.frame,
      camera: camera.params(),
      color: colorP(),
      filters: filterParams(),
      pointSize: s.render.pointSize,
      gain: s.render.gain,
      ref: exposure.ref,
      dim: s.mode === 'mosaic' ? (s.render.mosaicDim ?? 0.35) : (s.render.dim ?? 1),
      selection: !!s.selection,
      bloom: s.render.bloom,
    };
  }

  // ------------------------------------------------------------------ exposure (auto 'ref')
  const exposure = { ref: 1, target: 0, t: 0, dirty: true, init: false, inflight: false };
  function updateExposure(now, dt, moving) {
    if (!exposure.init) {
      // first paint: synchronous estimate so the very first frame is exposed correctly
      const r = proj.estimateRef(app.frame, camera.params(), filterParams(), pointSizeDev(), renderer.dpr);
      exposure.ref = exposure.target = r || 1;
      exposure.init = true;
      exposure.dirty = false;
      exposure.t = now;
      return false;
    }
    if (exposure.dirty && !exposure.inflight && (!moving || now - exposure.t > 80)) {
      // off the main thread when the worker is up (≤ ~12 Hz while moving)
      exposure.t = now;
      exposure.dirty = moving;
      exposure.inflight = true;
      proj.requestRef(app.frame, camera.params(), filterParams(), pointSizeDev(), renderer.dpr).then((r) => {
        exposure.inflight = false;
        if (r && Math.abs(Math.log(r / exposure.target)) > 0.004) {
          exposure.target = r;
          requestRender();
        } else if (exposure.dirty && !isAnimating()) requestRender();
      });
    }
    const lr = Math.log(exposure.ref), lt = Math.log(exposure.target);
    if (Math.abs(lt - lr) < 0.004) {
      exposure.ref = exposure.target;
      return false;
    }
    exposure.ref = Math.exp(lr + (lt - lr) * (1 - Math.exp(-Math.max(dt, 1 / 60) / 0.15)));
    return true;   // still converging: keep drawing
  }

  // ------------------------------------------------------------------ motion & settle
  let lastMotion = 0;
  let settleTimer = 0;
  let settleSeq = 0;
  let lastFrameAnimating = false;
  let frameAnim = null;
  const tour = { active: false, v: 0, leg: null, progress: 0, dist: 1, userCamera: false, legs: 0 };

  function isAnimating() {
    return !!frameAnim || tour.active || camera.animating;
  }

  app.isMoving = () => isAnimating() || performance.now() - lastMotion < SETTLE_MS || proj.stale;

  function markMotion() {
    lastMotion = performance.now();
    scheduleSettle();
  }

  function scheduleSettle(delay = SETTLE_MS + 10) {
    if (!settleTimer) settleTimer = setTimeout(checkSettle, delay);
  }

  function checkSettle() {
    settleTimer = 0;
    if (!data.loaded) return;
    const idle = performance.now() - lastMotion;
    if (isAnimating() || idle < SETTLE_MS) {
      scheduleSettle(Math.max(20, SETTLE_MS + 10 - idle));
      return;
    }
    const seq = ++settleSeq;
    const finish = () => {
      if (lastFrameAnimating) {
        lastFrameAnimating = false;
        events.emit('frame', { animating: false });
      }
      events.emit('settle');
      interaction.refreshHover();
    };
    if (!proj.stale) {
      finish();
      return;
    }
    proj.refresh(app.frame, filterParams()).then((res) => {
      if (seq !== settleSeq || isAnimating() || performance.now() - lastMotion < SETTLE_MS) return;
      if (!res.current) {
        scheduleSettle();
        return;
      }
      app.timing.lastProjMs = res.ms;
      exposure.dirty = true;
      requestRender();
      finish();
    });
  }

  /** Install a new frame (every animation step goes through here). */
  function applyFrame(F, animating) {
    if (F !== app.frame) app.frame.set(F);
    app.frameVersion++;
    proj.markStale();
    exposure.dirty = true;
    lastFrameAnimating = animating;
    if (animating) interaction.clearHover();
    events.emit('frame', { animating });
    markMotion();
    needDraw = true;
  }

  function animateFrame(G, duration) {
    const dur = firstPaint ? duration * motionScale() : 0;
    if (frameAnim) {
      frameAnim.resolve();
      frameAnim = null;
    }
    if (!(dur > 0)) {
      applyFrame(G, false);
      requestRender();
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      frameAnim = {
        geo: fm.geodesic(app.frame, G, { prefer: tourIndices() }),
        t0: performance.now(),
        duration: dur,
        ease: easeView,
        resolve: () => resolve(true),
      };
      markMotion();
      schedule();
    });
  }

  // ------------------------------------------------------------------ grand tour
  function tourIndices() {
    return store.get().tour.set.map((k) => data.dimIndex(k)).filter((i) => i >= 0);
  }

  function newLeg() {
    const idx = tourIndices();
    const target = fm.randomFrame(D, idx, Math.random);
    tour.leg = fm.geodesic(app.frame, target, { noSpin: true, prefer: idx });
    tour.progress = 0;
    tour.dist = Math.max(tour.leg.dist, 1e-3);
    // keep the visible data centered: ease an isotropic fit toward the leg's end frame
    // (skipped once the user has zoomed or panned during this tour)
    if (!tour.userCamera && data.loaded) {
      const legMs = (1000 * tour.dist) / (MOTION.tourRadPerSec * Math.max(0.2, store.get().tour.speed));
      // the first leg reaches aspect 1 quickly so rotations read as rigid from the start
      const ms = tour.legs === 0 ? Math.min(1200, legMs) : Math.min(legMs, 9000);
      camera.fitBounds(proj.estimateBounds(tour.leg.target, filterParams()), { iso: true, pad: 0.1, duration: ms * motionScale() });
    }
    tour.legs++;
  }

  function startTour() {
    if (frameAnim) {
      frameAnim.resolve();
      frameAnim = null;
    }
    viewTouched = true;
    if (!tour.active) {
      tour.active = true;
      tour.userCamera = false;
      tour.legs = 0;
      tour.v = reduced.matches ? store.get().tour.speed : 0;
      newLeg();   // also eases the camera to an isotropic fit (rotations read as rigid)
    }
    schedule();
  }

  function stopTourNow() {
    tour.active = false;
    tour.v = 0;
    tour.leg = null;
    if (store.get().tour.playing) store.set({ tour: { playing: false } }, { source: 'app' });
  }

  function advanceTour(dt) {
    const s = store.get().tour;
    const target = s.playing ? s.speed : 0;
    const k = reduced.matches ? 1 : 1 - Math.exp(-dt / 0.22);
    tour.v += (target - tour.v) * k;
    if (!s.playing && tour.v < 0.03) {
      tour.active = false;
      tour.v = 0;
      tour.leg = null;
      applyFrame(app.frame, false);
      return false;
    }
    if (!tour.leg) newLeg();
    tour.progress += dt * MOTION.tourRadPerSec * tour.v;
    const t = tour.progress / tour.dist;
    applyFrame(tour.leg.at(Math.min(1, t), scratchF), true);
    if (t >= 1) newLeg();
    return true;
  }

  // ------------------------------------------------------------------ render loop
  let raf = 0;
  let needDraw = false;
  let lastTick = performance.now();
  let fpsCount = 0, fpsT0 = performance.now();

  function schedule() {
    if (!raf) raf = requestAnimationFrame(tick);
  }

  function requestRender() {
    needDraw = true;
    schedule();
  }
  app.requestRender = requestRender;

  function tick(now) {
    raf = 0;
    const tickStart = performance.now();
    const dt = Math.min(0.1, Math.max(0, (now - lastTick) / 1000));
    lastTick = now;
    let moving = false;
    if (frameAnim) {
      const t = (now - frameAnim.t0) / frameAnim.duration;
      if (t >= 1) {
        const a = frameAnim;
        frameAnim = null;
        applyFrame(a.geo.at(1, scratchF), false);
        a.resolve();
      } else {
        applyFrame(frameAnim.geo.at(frameAnim.ease(t), scratchF), true);
        moving = true;
      }
    } else if (tour.active) {
      moving = advanceTour(dt) || moving;
    }
    if (camera.update(now)) moving = true;
    let converging = false;
    if (needDraw || moving) converging = draw(now, dt, moving);
    if (moving || converging || isAnimating()) schedule();
    // main-thread JS cost of this frame (smoothed); GPU work is not included
    const ms = performance.now() - tickStart;
    app.stats.tickMs = app.stats.tickMs ? 0.9 * app.stats.tickMs + 0.1 * ms : ms;
    app.stats.tickMax = Math.max(app.stats.tickMax || 0, ms);
  }

  function draw(now, dt, moving) {
    needDraw = false;
    if (!data.loaded || !renderer.ready) return false;
    const converging = updateExposure(now, dt, moving);
    const t0 = performance.now();
    const ok = renderer.render(renderParams());
    app.stats.drawMs = performance.now() - t0;
    if (ok) {
      fpsCount++;
      if (now - fpsT0 > 1000) {
        app.stats.fps = (fpsCount * 1000) / (now - fpsT0);
        fpsCount = 0;
        fpsT0 = now;
      }
      if (!firstPaint) {
        firstPaint = true;
        app.timing.firstPaint = performance.now() - (app.timing.t0 || 0);
      }
    }
    events.emit('render');
    return converging;
  }

  // ------------------------------------------------------------------ store reactions
  store.subscribe((s, changed, source, prev) => {
    for (const k of changed) {
      if (k === 'color') {
        colorCache = null;
        // with needColor on, a new color variable is also a new filter
        if (s.filters.needColor && !changed.includes('filters')) {
          filterCache = null;
          proj.filters = filterParams();
          proj.markStale();
          exposure.dirty = true;
          markMotion();
        }
      } else if (k === 'filters') {
        filterCache = null;
        proj.filters = filterParams();   // default for overlay calls that omit filters
        proj.markStale();
        exposure.dirty = true;
        markMotion();
      } else if (k === 'render') exposure.dirty = true;
      else if (k === 'tool') interaction.setTool(s.tool);
      else if (k === 'tour') {
        if (s.tour.playing && !prev.tour.playing) startTour();
        else if (!s.tour.playing && prev.tour.playing && tour.active) schedule();   // decelerate
        if (tour.active && s.tour.set !== prev.tour.set) newLeg();
      }
    }
    requestRender();
    events.emit('state', { changed, state: s, source });
  });

  // ------------------------------------------------------------------ actions
  function validColor(v) {
    if (v == null) return true;
    if (typeof v !== 'string') return false;
    if (v.startsWith('cat:')) return !!data.catSpec(v.slice(4));
    return data.dimIndex(v) >= 0;
  }

  function leastAlignedTourDim(v) {
    let best = -1, bv = Infinity;
    for (const i of [...tourIndices(), ...data.dims.map((d) => d.index)]) {
      if (Math.abs(v[i]) < bv - 1e-12) {
        bv = Math.abs(v[i]);
        best = i;
      }
    }
    return best;
  }

  const actions = {
    setFrame(F, { duration = 0 } = {}) {
      if (!F || F.length !== 2 * D) return Promise.resolve(false);
      const G = fm.orthonormalize(Float64Array.from(F));
      viewTouched = true;
      stopTourNow();
      store.set({ presetId: null });
      return animateFrame(G, duration);
    },

    setAxes({ x, y } = {}, { duration = MOTION.viewMs, fit = true, keepPreset = false } = {}) {
      const cur = fm.frameToCombos(app.frame, data.dims);
      let res = fm.frameFromCombos(x || cur.x, y || cur.y, data.dims);
      if (res.degenerate && x && !y) res = fm.frameFromCombos(x, cur.x, data.dims);   // swap axes
      if (res.degenerate && y && !x) res = fm.frameFromCombos(cur.y, y, data.dims);
      if (res.degenerate) {
        const cx = fm.comboVector(x || cur.x, data.dims);
        if (!cx) return Promise.resolve(false);
        const k = leastAlignedTourDim(cx.v);
        res = fm.frameFromCombos(x || cur.x, { [data.dims[k].key]: 1 }, data.dims);
      }
      if (!res.F) return Promise.resolve(false);
      viewTouched = true;
      stopTourNow();
      if (!keepPreset) store.set({ presetId: null });
      if (fit) {
        if (data.loaded) {
          camera.fitBounds(proj.estimateBounds(res.F, filterParams()), { duration: firstPaint ? duration * motionScale() : 0 });
        } else pendingFit = true;
      }
      return animateFrame(res.F, duration);
    },

    applyPreset(id, { duration = MOTION.viewMs } = {}) {
      const p = presetById(id);
      if (!p || !presets.includes(p)) return Promise.resolve(false);
      const cats = { ...catMasksAll };
      for (const [k, m] of Object.entries(p.filter?.cats || {})) if (k in cats) cats[k] = m;
      const color = validColor(p.color) ? p.color : store.get().color;
      store.set({ presetId: id, color, filters: { cats } });
      return actions.setAxes({ x: p.x, y: p.y }, { duration, fit: true, keepPreset: true });
    },

    rotateDim(key, target) {
      const j = data.dimIndex(key);
      if (j < 0 || !target) return false;
      viewTouched = true;
      stopTourNow();
      if (frameAnim) {
        frameAnim.resolve();
        frameAnim = null;
      }
      const w = fm.dimWeights(app.frame);
      const prefer = tourIndices().filter((i) => i !== j && w[i] < 0.05);
      applyFrame(fm.manualRotate(app.frame, j, target, { prefer }), true);
      requestRender();
      return true;
    },

    setColor(v) {
      if (!validColor(v)) return false;
      store.set({ color: v ?? null });
      return true;
    },

    setMode(m) {
      if (m !== 'glow' && m !== 'mosaic') return false;
      store.set({ mode: m });
      return true;
    },

    setFilter(patch = {}) {
      const next = {};
      if ('z' in patch) {
        const z = patch.z;
        next.z = z && Number.isFinite(+z[0]) && Number.isFinite(+z[1]) && +z[1] > +z[0] ? [+z[0], +z[1]] : null;
      }
      if (patch.cats) {
        const cats = {};
        for (const [k, m] of Object.entries(patch.cats)) if (data.catSpec(k)) cats[k] = (m >>> 0) & 0xff;
        next.cats = cats;
      }
      if ('needColor' in patch) next.needColor = !!patch.needColor;
      store.set({ filters: next });
    },

    tour: {
      play() { store.set({ tour: { playing: true } }); },
      pause() { store.set({ tour: { playing: false } }); },
      toggle() { store.set({ tour: { playing: !store.get().tour.playing } }); },
      setSet(keys) {
        const k = [...new Set(keys || [])].filter((key) => data.dimIndex(key) >= 0);
        if (k.length < 2) return false;
        store.set({ tour: { set: k } });
        return true;
      },
      setSpeed(v) {
        if (!Number.isFinite(+v)) return;
        store.set({ tour: { speed: clamp(+v, 0.05, 5) } });
      },
    },

    fit({ duration = MOTION.fitMs } = {}) {
      if (!data.loaded) {
        pendingFit = true;
        return;
      }
      camera.fitBounds(proj.estimateBounds(app.frame, filterParams()), { duration: firstPaint ? duration * motionScale() : 0 });
    },

    resetView() {
      actions.setFilter({ z: null, needColor: false });
      return actions.applyPreset(store.get().presetId || defaultPresetId);
    },

    select(mask) {
      let sel = null;
      if (mask && mask.length === data.n) {
        let count = 0;
        for (let i = 0; i < mask.length; i++) if (mask[i]) count++;
        if (count) sel = { mask, count };
      }
      renderer.setSelection(sel ? sel.mask : null);
      store.set({ selection: sel });
      events.emit('select', { count: sel ? sel.count : 0 });
      requestRender();
    },

    inspect(index) {
      const v = Number.isInteger(index) && index >= 0 && index < data.n ? index : null;
      store.set({ inspected: v });
      events.emit('inspect', { index: v });
    },

    setTool(name) {
      store.set({ tool: typeof name === 'string' ? name : 'pan' });
    },

    setOverlay(name, on) {
      store.set({ overlays: { [name]: !!on } });
    },

    setRender(patch = {}) {
      const r = {};
      if (patch.gain != null && Number.isFinite(+patch.gain)) r.gain = clamp(+patch.gain, 0.05, 20);
      if (patch.pointSize != null && Number.isFinite(+patch.pointSize)) r.pointSize = clamp(+patch.pointSize, 0.5, 8);
      if (patch.bloom != null && Number.isFinite(+patch.bloom)) r.bloom = clamp(+patch.bloom, 0, 1);
      if (patch.dim != null && Number.isFinite(+patch.dim)) r.dim = clamp(+patch.dim, 0, 1);
      if (patch.mosaicDim != null && Number.isFinite(+patch.mosaicDim)) r.mosaicDim = clamp(+patch.mosaicDim, 0, 1);
      store.set({ render: r });
    },

    setMosaic(patch = {}) {
      const m = {};
      if (patch.cell != null && Number.isFinite(+patch.cell)) m.cell = clamp(Math.round(+patch.cell), 16, 256);
      if (patch.scale === 'fit' || patch.scale === 'true') m.scale = patch.scale;
      store.set({ mosaic: m });
    },
  };
  app.actions = actions;

  // ------------------------------------------------------------------ helpers for UI/overlays
  app.presetFrame = presetFrame;
  app.presetAlignment = (id) => {
    const p = presetById(id);
    return p ? fm.viewAlignment(p.x, p.y, app.frame, data.dims) : 0;
  };
  app.currentCombos = (opts) => fm.frameToCombos(app.frame, data.dims, opts);
  app.axisInfo = (col) => fm.axisInfo(app.frame, col, data.dims);
  app.colorInfo = () => colorP();
  app.filterParams = filterParams;
  app.colorParams = colorParams;
  app.dimWeights = () => fm.dimWeights(app.frame);

  /** Offscreen preview of a preset id (its color and filters) or of a frame. */
  app.preview = (idOrFrame, { width = 112, height = 72, dpr, background = null, canvas, color, filters } = {}) => {
    if (!data.loaded || !renderer.ready) return null;
    let F, cp, fp;
    if (typeof idOrFrame === 'string') {
      const p = presetById(idOrFrame);
      F = p && presetFrame(p);
      if (!F) return null;
      const ckey = color !== undefined ? color : p.color;
      cp = colorParams(ckey);
      const cats = { ...catMasksAll };
      for (const [k, m] of Object.entries(p.filter?.cats || {})) if (k in cats) cats[k] = m;
      const f = store.get().filters;
      fp = filterParams({ z: f.z, cats, needColor: f.needColor }, ckey);
    } else {
      F = idOrFrame;
      if (!F || F.length !== 2 * D) return null;
      cp = colorParams(color !== undefined ? color : store.get().color);
      fp = filters || color !== undefined ? filterParams(filters, color) : filterParams();
    }
    const r = Math.min(2, Math.max(1, dpr || renderer.dpr || 1));
    const cam = { ...fitParams(proj.estimateBounds(F, fp), width, height, { pad: 0.08 }), width, height };
    const ps = 1.25;
    const count = Math.min(data.n, 200000);
    const ref = (proj.estimateRef(F, cam, fp, spriteSizeDev(ps, r), r) || 1) * (count / data.n);
    return renderer.renderPreview(F, { camera: cam, color: cp, filters: fp, pointSize: ps, gain: 1, ref, selection: false, bloom: 0, count }, { width, height, dpr: r, background, canvas });
  };

  // ------------------------------------------------------------------ sizing
  let size = { w: 0, h: 0, dpr: 0 };
  function measure() {
    const r = layers.stage.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    if (w === size.w && h === size.h && dpr === size.dpr) return;
    size = { w, h, dpr };
    renderer.resize(w, h, dpr);
    for (const c of [layers.tiles, layers.overlay]) {
      if (!c) continue;
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    camera.resize(w, h, dpr);
    exposure.dirty = true;
    events.emit('resize', { width: w, height: h, dpr });
    requestRender();
  }
  app.measure = measure;
  if (typeof ResizeObserver === 'function') new ResizeObserver(measure).observe(layers.stage);
  window.addEventListener('resize', measure);
  let dprQuery = null;
  const watchDpr = () => {
    dprQuery?.removeEventListener?.('change', onDpr);
    dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    dprQuery.addEventListener?.('change', onDpr);
  };
  function onDpr() {
    measure();
    watchDpr();
  }
  if (typeof matchMedia === 'function') watchDpr();
  measure();

  // ------------------------------------------------------------------ loading & start
  function nextRender() {
    return new Promise((resolve) => {
      let timer = 0;
      const off = events.once('render', () => {
        clearTimeout(timer);
        resolve();
      });
      timer = setTimeout(() => {
        off();
        resolve();
      }, 2500);
      requestRender();
    });
  }

  function hideSplash() {
    const el = document.getElementById('splash');
    if (!el) return;
    el.classList.add('done');
    setTimeout(() => { el.hidden = true; }, 800);
  }

  /** Load columns, upload, prepare the first view, paint; emits 'data:ready'. */
  app.load = async ({ onProgress } = {}) => {
    app.timing.t0 = app.timing.t0 || performance.now();
    const t0 = performance.now();
    await loadColumns(data, {
      onProgress: (p) => {
        events.emit('load:progress', { ...p, phase: 'columns' });
        onProgress?.(p);
      },
    });
    app.timing.columns = performance.now() - t0;
    events.emit('load:progress', { fraction: 1, phase: 'upload' });
    const t1 = performance.now();
    const dims = await Renderer.interleave(data);
    renderer.setData(data, { dims });
    proj.init(data);
    proj.filters = filterParams();
    app.timing.upload = performance.now() - t1;
    measure();
    if (!viewTouched && defaultPresetId) {
      // first-load arrival: start from a random frame of the tour set, colored like the target
      const start = fm.randomFrame(D, tourIndices(), Math.random);
      app.frame.set(start);
      app.frameVersion++;
      const p = presetById(defaultPresetId);
      store.set({ color: validColor(p.color) ? p.color : null });
      pendingFit = true;
    }
    if (pendingFit) {
      camera.fitBounds(proj.estimateBounds(app.frame, filterParams()), { duration: 0 });
      pendingFit = false;
    }
    exposure.dirty = true;
    await nextRender();
    app.timing.ready = performance.now() - app.timing.t0;
    events.emit('data:ready');
    if (config.splash.auto) hideSplash();
    markMotion();
    loadMeta(data).then(() => events.emit('data:meta'));
    return app;
  };

  /** Start: animated arrival into the default preset unless a view was already set. */
  app.start = () => {
    if (app.started) return;
    app.started = true;
    if (!viewTouched && defaultPresetId) actions.applyPreset(defaultPresetId, { duration: MOTION.arrivalMs });
    requestRender();
  };

  app.hideSplash = hideSplash;
  return app;
}
