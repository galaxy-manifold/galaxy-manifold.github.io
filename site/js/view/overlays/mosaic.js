// Mosaic (§15) on the #tiles canvas. The plane is cut into square cells (default 56 CSS px),
// anchored in projected data coordinates so tiles ride along with pans and zooms. Each cell
// shows its most typical thumbnail galaxy: among the thumbnail galaxies that project into the
// cell with visibility > 0.5, the one closest (mean squared difference over the dims valid for
// both, full u-space) to the mean vector of the cell's candidates. A cell gets a tile only if
// it holds ≥ 3 galaxies of the first-100k-row subsample. Tiles have 1 px gaps and 2 px
// corners, fade in with a slight radial stagger, and can be drawn at true physical scale
// (crop″ × kpc/″(z) relative to a 50 kpc cell, clipped). While the view moves the mosaic
// re-tiles at ≤ 4 Hz drawing already-loaded images only: a cell whose typical galaxy is still
// loading shows its most typical loaded candidate (or an empty frame) while the image is
// queued, center first, so a tour fills in as it turns (pans and zooms re-tile only once the
// grid has drifted: zoom beyond ±35 % or the view leaving the tiled area); after a settle it
// re-tiles fully and loads what is missing. Clicking a tile inspects its
// galaxy. Without thumbnails (manifest.thumbs null) the dense cells show as empty, translucent
// contact-sheet frames over the dimmed glow.

import { typicalPerCell, staggerDelay } from './geom.js';
import { kpcPerArcsec } from '../../math/cosmo.js';
import { COLORS, rgba, beginCanvas } from './draw.js';

export const MOSAIC = {
  densityRows: 100000,
  densityMin: 3,
  motionRows: 30000,
  motionMs: 250,       // ≤ 4 Hz
  visMin: 128,
  fadeMs: 300,
  motionFadeMs: 140,
  modeMs: 260,
  trueKpc: 50,
  maxCells: 40000,
};

export function createMosaic(app, ov) {
  const data = app.data, thumbs = app.thumbs;
  const canvas = app.layers.tiles;
  const g = canvas ? canvas.getContext('2d') : null;
  const D = data.D;
  let K = 0, U = null, frac = null, thumbRows32 = null, prefixRows = null;
  let tiles = new Map(), byK = new Map();
  let grid = null;
  let modeAlpha = 0, lastDraw = 0;
  let lastMotion = 0, motionTimer = 0;
  let raf = 0, arrivals = 0;
  let hoverKey = null;
  let pointer = null;   // last pointer position over the stage (CSS px), for hover after re-tiles
  let bufP = null, bufT = null;
  let ready = false;

  const mode = () => app.store.get().mode;

  function init() {
    K = thumbs.available ? data.thumbRows.length : 0;
    if (K) {
      U = new Float32Array(K * D);
      frac = new Float32Array(K).fill(NaN);
      thumbRows32 = Int32Array.from(data.thumbRows);
      const zi = data.dimIndex('z');
      for (let k = 0; k < K; k++) {
        const r = data.thumbRows[k];
        for (let d = 0; d < D; d++) {
          const v = data.raw[d][r];
          U[k * D + d] = v === 0 ? NaN : v * data.dims[d].ua + data.dims[d].ub;
        }
        const z = zi >= 0 ? data.value(r, zi) : NaN;
        const crop = thumbs.crop(k);
        if (crop > 0 && z > 0) frac[k] = (crop * kpcPerArcsec(z)) / MOSAIC.trueKpc;
      }
    }
    prefixRows = new Int32Array(Math.min(data.n, MOSAIC.motionRows));
    for (let i = 0; i < prefixRows.length; i++) prefixRows[i] = i;
    ready = true;
  }

  function cellKey(ix, iy) {
    return `${ix},${iy}`;
  }

  /** Re-tile. motion = true uses a live projection of subsamples and loaded images only. */
  function retile(motion = false) {
    if (!g || !ready || mode() !== 'mosaic') return;
    const t0 = performance.now();
    retileInner(motion);
    const ms = performance.now() - t0;
    timing.retileMs = timing.retileMs ? 0.8 * timing.retileMs + 0.2 * ms : ms;
    timing.retileMax = Math.max(timing.retileMax, ms);
  }

  function retileInner(motion) {
    const proj = app.proj;
    // the settled projection is exact while only the camera moves; a stale one (rotation)
    // means projecting subsamples live with the current frame
    const live = proj.stale || !proj.X;
    if (live) motion = true;
    const s = app.store.get();
    const cam = app.camera;
    const cell = s.mosaic.cell;
    const cw = cell / cam.scaleX, ch = cell / cam.scaleY;
    const [vx0, vx1, vy0, vy1] = cam.viewBounds();
    const ix0 = Math.floor(vx0 / cw) - 1, iy0 = Math.floor(vy0 / ch) - 1;
    const nx = Math.floor(vx1 / cw) + 2 - ix0, ny = Math.floor(vy1 / ch) + 2 - iy0;
    if (!(nx > 0 && ny > 0) || nx * ny > MOSAIC.maxCells) {
      tiles = new Map();
      byK = new Map();
      grid = null;
      invalidate();
      return;
    }
    const cellOf = (X, Y) => {
      const ix = Math.floor(X / cw) - ix0, iy = Math.floor(Y / ch) - iy0;
      return ix < 0 || iy < 0 || ix >= nx || iy >= ny ? -1 : iy * nx + ix;
    };
    // density of the first-100k-row subsample
    const dens = new Uint16Array(nx * ny);
    let thr = MOSAIC.densityMin;
    if (!live) {
      const { X, Y, vis } = proj;
      const M = Math.min(data.n, MOSAIC.densityRows);
      for (let i = 0; i < M; i++) {
        if (vis[i] < MOSAIC.visMin) continue;
        const c = cellOf(X[i], Y[i]);
        if (c >= 0 && dens[c] < 65535) dens[c]++;
      }
    } else {
      bufP = proj.projectSample(prefixRows, app.frame, { out: bufP || undefined });
      for (let j = 0; j < prefixRows.length; j++) {
        if (!(bufP.vis[j] > 0.5)) continue;
        const c = cellOf(bufP.X[j], bufP.Y[j]);
        if (c >= 0 && dens[c] < 65535) dens[c]++;
      }
      thr = Math.max(1, Math.round((MOSAIC.densityMin * prefixRows.length) / Math.min(data.n, MOSAIC.densityRows)));
    }
    const now = performance.now();
    const next = new Map(), nextByK = new Map();
    const want = [];   // typical galaxies whose images are not loaded yet
    const reduced = !!app.motion?.reduced?.();
    const fade = (motion ? MOSAIC.motionFadeMs : MOSAIC.fadeMs) * (reduced ? 0.3 : 1);
    // thumbnails on screen right now (they do not fade in again after the re-tile)
    const shownNow = new Set();
    for (const t of tiles.values()) if (t.k >= 0 && t.t0 != null && t.t0 <= now && thumbs.isLoaded(t.k)) shownNow.add(t.k);
    const sameGrid = grid && Math.abs(grid.cw - cw) < 1e-9 * Math.abs(cw) && Math.abs(grid.ch - ch) < 1e-9 * Math.abs(ch);
    const center = (ix, iy) => [((ix + 0.5) * cw - cam.cx) * cam.scaleX, ((iy + 0.5) * ch - cam.cy) * cam.scaleY];
    if (K) {
      const cellK = new Int32Array(K).fill(-1);
      if (!live) {
        const { X, Y, vis } = proj;
        for (let k = 0; k < K; k++) {
          const r = thumbRows32[k];
          if (vis[r] < MOSAIC.visMin) continue;
          const c = cellOf(X[r], Y[r]);
          if (c >= 0 && dens[c] >= thr) cellK[k] = c;
        }
      } else {
        bufT = proj.projectSample(thumbRows32, app.frame, { out: bufT || undefined });
        for (let k = 0; k < K; k++) {
          if (!(bufT.vis[k] > 0.5)) continue;
          const c = cellOf(bufT.X[k], bufT.Y[k]);
          if (c >= 0 && dens[c] >= thr) cellK[k] = c;
        }
      }
      // the most typical candidate per cell; while moving, a cell whose typical galaxy is not
      // loaded yet shows the most typical *loaded* one meanwhile (its image is queued)
      const typical = typicalPerCell(cellK, U, D);
      let typicalLoaded = null;
      if (motion) {
        const eligible = new Uint8Array(K);
        for (let k = 0; k < K; k++) if (cellK[k] >= 0 && thumbs.isLoaded(k)) eligible[k] = 1;
        typicalLoaded = typicalPerCell(cellK, U, D, eligible);
      }
      for (const [c, k0] of typical) {
        const ix = ix0 + (c % nx), iy = iy0 + Math.floor(c / nx);
        const key = cellKey(ix, iy);
        let k = k0;
        if (!thumbs.isLoaded(k0)) {
          want.push({ k: k0, ix, iy });
          if (typicalLoaded && typicalLoaded.has(c)) k = typicalLoaded.get(c);
        }
        const old = tiles.get(key);
        let t;
        if (old && old.k === k && sameGrid) t = old;
        else {
          // t0: start of the fade-in (null until the image is loaded); an image already on
          // screen keeps showing, the others fade in with a slight radial stagger
          const [dx, dy] = center(ix, iy);
          let t0 = null;
          if (thumbs.isLoaded(k)) t0 = shownNow.has(k) ? now - fade : now + (motion || reduced ? 0 : staggerDelay(dx, dy, cell, 16));
          t = { key, k, row: data.thumbRows[k], ix, iy, t0, fade };
        }
        next.set(key, t);
        nextByK.set(k, t);
      }
    } else {
      for (let c = 0; c < dens.length; c++) {
        if (dens[c] < thr) continue;
        const ix = ix0 + (c % nx), iy = iy0 + Math.floor(c / nx);
        const key = cellKey(ix, iy);
        next.set(key, { key, k: -1, row: -1, ix, iy, t0: null, fade });
      }
    }
    tiles = next;
    byK = nextByK;
    grid = { cw, ch, cell, ix0, iy0, nx, ny, bounds: [vx0, vx1, vy0, vy1] };
    if (pointer) hoverKey = hoverKeyAt(pointer.sx, pointer.sy);
    if (K && want.length) {
      // load what is missing, center first (≤ 16 in flight; a newer re-tile replaces the queue)
      thumbs.cancelQueued();
      want.sort((a, b) => Math.hypot(...center(a.ix, a.iy)) - Math.hypot(...center(b.ix, b.iy)));
      thumbs.prefetch(want.slice(0, motion ? 96 : want.length).map((t) => t.k));
    }
    invalidate();
  }

  function scheduleMotion() {
    if (mode() !== 'mosaic' || motionTimer) return;
    const wait = Math.max(0, MOSAIC.motionMs - (performance.now() - lastMotion));
    motionTimer = setTimeout(() => {
      motionTimer = 0;
      lastMotion = performance.now();
      retile(true);
    }, wait);
  }

  /** A pan/zoom: re-tile (≤ 4 Hz) only when the grid no longer fits the view. */
  function cameraMoved() {
    if (mode() !== 'mosaic' || !grid) return;
    const cam = app.camera;
    const px = grid.cw * cam.scaleX;
    const zoomed = Math.abs(Math.log(px / grid.cell)) > Math.log(1.35);
    const [vx0, vx1, vy0, vy1] = cam.viewBounds();
    const [gx0, gx1, gy0, gy1] = grid.bounds;
    const mx = 0.5 * grid.cw, my = 0.5 * grid.ch;
    const outside = vx0 < gx0 - mx || vx1 > gx1 + mx || vy0 < gy0 - my || vy1 > gy1 + my;
    if (zoomed || outside) scheduleMotion();
  }

  function onThumb(k) {
    const t = byK.get(k);
    if (!t || t.t0 != null) return;
    t.t0 = performance.now() + (app.motion?.reduced?.() ? 0 : (arrivals++ % 6) * 14);
    invalidate();
  }

  function tileAt(sx, sy) {
    if (!grid) return null;
    const [X, Y] = app.camera.toData(sx, sy);
    return tiles.get(cellKey(Math.floor(X / grid.cw), Math.floor(Y / grid.ch))) || null;
  }

  function roundRect(x, y, w, h, r) {
    g.beginPath();
    if (g.roundRect && r > 0.2) g.roundRect(x, y, w, h, r);
    else g.rect(x, y, w, h);
  }

  const timing = { ms: 0, max: 0, retileMs: 0, retileMax: 0, drawn: 0 };

  function draw(now = performance.now()) {
    if (!g) return false;
    const t0 = performance.now();
    const cam = app.camera, dpr = cam.dpr;
    const dt = lastDraw ? Math.min(0.1, (now - lastDraw) / 1000) : 1 / 60;
    lastDraw = now;
    const want = mode() === 'mosaic' ? 1 : 0;
    if (modeAlpha !== want) {
      const step = (dt * 1000) / MOSAIC.modeMs;
      modeAlpha = want > modeAlpha ? Math.min(want, modeAlpha + step) : Math.max(want, modeAlpha - step);
    }
    beginCanvas(g, canvas, dpr);
    if (modeAlpha <= 0 || !grid) return modeAlpha !== want;
    const s = app.store.get();
    const W = cam.width, H = cam.height, kx = cam.scaleX, ky = cam.scaleY, cx = cam.cx, cy = cam.cy;
    const w = grid.cw * kx, h = grid.ch * ky;
    const trueScale = s.mosaic.scale === 'true';
    const sel = s.selection ? s.selection.mask : null;
    const inspected = s.inspected;
    const rad = Math.min(2, 0.08 * Math.min(w, h));
    const snapv = (v) => Math.round(v * dpr) / dpr;
    let animating = false;
    let drawn = 0;
    let hoverRect = null, inspRect = null;
    const selRects = [];
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    // without thumbnails the frames stay translucent so the dimmed glow shows through
    const slotFill = K ? rgba(COLORS.bg2, 0.86) : rgba(COLORS.bg2, 0.3);
    const slotLine = K ? rgba(COLORS.cream, 0.1) : rgba(COLORS.cream, 0.16);
    const plot = ov.plotRect();
    g.save();
    g.beginPath();
    g.rect(plot.l, plot.t, plot.r - plot.l, plot.b - plot.t);
    g.clip();
    for (const t of tiles.values()) {
      const x0 = W / 2 + (t.ix * grid.cw - cx) * kx;
      const y0 = H / 2 - ((t.iy + 1) * grid.ch - cy) * ky;
      if (x0 > W || y0 > H || x0 + w < 0 || y0 + h < 0) continue;
      const X0 = snapv(x0) + 0.5, Y0 = snapv(y0) + 0.5;
      const TW = snapv(x0 + w) - 0.5 - X0, TH = snapv(y0 + h) - 0.5 - Y0;
      if (!(TW > 1 && TH > 1)) continue;
      const loaded = t.k >= 0 && thumbs.isLoaded(t.k);
      const selDim = sel && t.row >= 0 && !sel[t.row] ? 0.4 : 1;
      g.globalAlpha = modeAlpha * selDim;
      g.fillStyle = slotFill;
      roundRect(X0, Y0, TW, TH, rad);
      g.fill();
      let a = 0;
      if (loaded && t.t0 != null) {
        a = (now - t.t0) / t.fade;
        if (a < 1) animating = true;
      }
      if (a <= 0) {
        g.strokeStyle = slotLine;
        g.lineWidth = 1;
        g.stroke();
      } else {
        const img = thumbs.get(t.k);
        if (img) {
          g.globalAlpha = modeAlpha * selDim * Math.min(1, a);
          g.save();
          g.clip();
          const iw = img.naturalWidth || 64, ih = img.naturalHeight || 64;
          const f = trueScale ? frac[t.k] : 1;
          drawn++;
          if (!(f > 0) || f === 1) g.drawImage(img, X0, Y0, TW, TH);
          else if (f > 1) {
            const sw = iw / f, sh = ih / f;
            g.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, X0, Y0, TW, TH);
          } else {
            const dw = TW * f, dh = TH * f;
            g.drawImage(img, X0 + (TW - dw) / 2, Y0 + (TH - dh) / 2, dw, dh);
          }
          g.restore();
        }
      }
      if (t.key === hoverKey) hoverRect = [X0, Y0, TW, TH];
      if (inspected != null && t.row === inspected) inspRect = [X0, Y0, TW, TH];
      if (sel && t.row >= 0 && sel[t.row]) selRects.push([X0, Y0, TW, TH]);
    }
    g.globalAlpha = modeAlpha;
    g.lineWidth = 1;
    g.restore();
    g.save();
    g.beginPath();
    g.rect(plot.l, plot.t, plot.r - plot.l, plot.b - plot.t);
    g.clip();
    if (selRects.length) {
      g.strokeStyle = rgba(COLORS.orange, 0.85);
      for (const r of selRects) { roundRect(r[0] + 0.5, r[1] + 0.5, r[2] - 1, r[3] - 1, rad); g.stroke(); }
    }
    if (hoverRect) {
      g.strokeStyle = rgba(COLORS.cream, 0.9);
      roundRect(...hoverRect, rad);
      g.stroke();
    }
    if (inspRect) {
      g.strokeStyle = rgba(COLORS.orange, 1);
      g.lineWidth = 1.5;
      roundRect(inspRect[0] - 1, inspRect[1] - 1, inspRect[2] + 2, inspRect[3] + 2, rad + 1);
      g.stroke();
    }
    g.restore();
    g.globalAlpha = 1;
    const ms = performance.now() - t0;
    timing.ms = timing.ms ? 0.9 * timing.ms + 0.1 * ms : ms;
    timing.max = Math.max(timing.max, ms);
    timing.drawn = drawn;
    return animating || modeAlpha !== want;
  }

  function invalidate() {
    if (!raf) raf = requestAnimationFrame(frame);
  }

  function frame() {
    raf = 0;
    // performance.now(), not the rAF timestamp: fade start times are set from timers on
    // that clock, and a rAF timestamp can lie before them
    if (draw(performance.now())) invalidate();
  }

  // click → inspect the tile's galaxy (before the default pick)
  app.interaction.addClickHandler((ctx) => {
    if (mode() !== 'mosaic' || modeAlpha < 0.5) return false;
    const t = tileAt(ctx.sx, ctx.sy);
    if (!t || t.row < 0) return false;
    app.actions.inspect(t.row);
    return true;
  }, 10);

  const stage = app.layers.stage;
  function hoverKeyAt(sx, sy) {
    const t = tileAt(sx, sy);
    return t && t.row >= 0 ? t.key : null;
  }
  const onMove = (e) => {
    const onCanvas = e.target === stage || e.target.tagName === 'CANVAS';
    if (mode() !== 'mosaic' || e.buttons || !onCanvas) {
      pointer = null;
      if (hoverKey) { hoverKey = null; invalidate(); }
      return;
    }
    const r = stage.getBoundingClientRect();
    pointer = { sx: e.clientX - r.left, sy: e.clientY - r.top };
    const key = hoverKeyAt(pointer.sx, pointer.sy);
    if (key !== hoverKey) {
      hoverKey = key;
      invalidate();
    }
  };
  stage.addEventListener('pointermove', onMove, { passive: true });
  stage.addEventListener('pointerleave', () => {
    pointer = null;
    if (hoverKey) { hoverKey = null; invalidate(); }
  });

  return {
    init,
    retile,
    scheduleMotion,
    cameraMoved,
    onThumb,
    draw: (now) => { if (draw(now)) invalidate(); },
    invalidate,
    tileAt,
    get available() { return K > 0; },
    get tiles() { return tiles; },
    get grid() { return grid; },
    stats() {
      let loaded = 0, visible = 0;
      const now = performance.now();
      for (const t of tiles.values()) {
        if (t.k >= 0 && thumbs.isLoaded(t.k)) loaded++;
        if (t.t0 != null && t.t0 <= now) visible++;
      }
      return { tiles: tiles.size, loaded, visible, cell: grid ? grid.cell : 0, thumbs: K, ...timing };
    },
  };
}
