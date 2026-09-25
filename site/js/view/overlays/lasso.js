// Lasso tool (§15): registerTool('lasso'). Drag draws a freeform polygon (dashed cream line,
// soft orange fill); on release the galaxies inside it (point-in-polygon on the projected X, Y
// of visible galaxies, via a scanline index) become the selection. Shift adds to the current
// selection, Alt subtracts. A click without a drag falls through to the normal pick/inspect.
// The polygon is stored in data coordinates so it stays glued to the data while drawing.

import { polygonIndex, polygonArea } from './geom.js';
import { COLORS, rgba, monoFont } from './draw.js';

const VIS_MIN = 128;          // proj.vis threshold: visibility > 0.5 counts as visible
const MIN_AREA = 40;          // px²; smaller loops are ignored
const FADE_MS = 700;

export function createLasso(app, ov) {
  const data = app.data;
  let pts = null;          // [X0, Y0, X1, Y1, …] while drawing
  let mods = { shift: false, alt: false };
  let done = null;         // {pts, t0, count, op} after release (fades out)

  /** Rows inside the screen-space polygon index among visible galaxies. */
  function inside(index) {
    const cam = app.camera;
    const n = data.n;
    let X, Y, vis, visMin = VIS_MIN;
    const proj = app.proj;
    if (!proj.stale && proj.X) ({ X, Y, vis } = proj);
    else {
      // the view is moving: project everything with the current frame (one-off, O(n·dims))
      const rows = new Int32Array(n);
      for (let i = 0; i < n; i++) rows[i] = i;
      ({ X, Y, vis } = proj.projectSample(rows, app.frame));
      visMin = 0.5;
    }
    const W = cam.width, H = cam.height, kx = cam.scaleX, ky = cam.scaleY, cx = cam.cx, cy = cam.cy;
    const [bx0, bx1, by0, by1] = index.bounds;
    const X0 = cx + (bx0 - W / 2) / kx, X1 = cx + (bx1 - W / 2) / kx;
    const Y0 = cy - (by1 - H / 2) / ky, Y1 = cy - (by0 - H / 2) / ky;
    const mask = new Uint8Array(n);
    let count = 0;
    for (let i = 0; i < n; i++) {
      if (vis[i] < visMin) continue;
      const x = X[i], y = Y[i];
      if (x < X0 || x > X1 || y < Y0 || y > Y1) continue;
      if (index.contains(W / 2 + (x - cx) * kx, H / 2 - (y - cy) * ky)) {
        mask[i] = 1;
        count++;
      }
    }
    return { mask, count };
  }

  function finish(p, op) {
    const cam = app.camera;
    const sp = new Float64Array(p.length);
    for (let k = 0; k < p.length; k += 2) {
      const [sx, sy] = cam.toScreen(p[k], p[k + 1]);
      sp[k] = sx;
      sp[k + 1] = sy;
    }
    if (Math.abs(polygonArea(sp)) < MIN_AREA) return false;
    const { mask, count } = inside(polygonIndex(sp, 0.5));
    const prev = app.store.get().selection;
    let next = mask;
    if (op === 'add' && prev) {
      next = Uint8Array.from(prev.mask);
      for (let i = 0; i < next.length; i++) if (mask[i]) next[i] = 1;
    } else if (op === 'sub') {
      next = prev ? Uint8Array.from(prev.mask) : null;
      if (next) for (let i = 0; i < next.length; i++) if (mask[i]) next[i] = 0;
    }
    app.actions.select(next);
    done = { pts: p, t0: performance.now(), count, op };
    ov.invalidate();
    return true;
  }

  const unregister = app.interaction.registerTool('lasso', {
    cursor: 'crosshair',
    dragCursor: 'crosshair',
    onDown(c) {
      if (!data.loaded) return false;
      pts = [c.X, c.Y];
      mods = { shift: !!c.event?.shiftKey, alt: !!c.event?.altKey };
      done = null;
      ov.invalidate();
      return true;
    },
    onMove(c) {
      if (!pts) return;
      const n = pts.length;
      const [lx, ly] = app.camera.toScreen(pts[n - 2], pts[n - 1]);
      if (Math.hypot(c.sx - lx, c.sy - ly) < 2) return;
      pts.push(c.X, c.Y);
      ov.invalidate();
    },
    onUp(c) {
      if (!pts) return false;
      const p = pts;
      pts = null;
      ov.invalidate();
      if (!c.moved || p.length < 6) return false;
      const shift = mods.shift || !!c.event?.shiftKey;
      const alt = mods.alt || !!c.event?.altKey;
      p.push(c.X, c.Y);
      finish(p, shift ? 'add' : alt ? 'sub' : 'new');
      return true;
    },
    onCancel() {
      pts = null;
      ov.invalidate();
    },
  });

  function draw(g, now) {
    const p = pts || (done && done.pts);
    if (!p || p.length < 4) return;
    let a = 1;
    if (!pts) {
      const t = (now - done.t0) / FADE_MS;
      if (t >= 1) {
        done = null;
        return;
      }
      a = t < 0.35 ? 1 : 1 - (t - 0.35) / 0.65;
      ov.invalidate();
    }
    const cam = app.camera;
    g.save();
    g.beginPath();
    let sxSum = 0, sySum = 0;
    for (let k = 0; k < p.length; k += 2) {
      const [sx, sy] = cam.toScreen(p[k], p[k + 1]);
      sxSum += sx;
      sySum += sy;
      if (k === 0) g.moveTo(sx, sy);
      else g.lineTo(sx, sy);
    }
    g.closePath();
    g.fillStyle = rgba(COLORS.orange, 0.13 * a);
    g.fill();
    g.setLineDash([4, 3]);
    g.lineDashOffset = pts ? -now / 60 : 0;
    g.lineWidth = 1.25;
    g.lineJoin = 'round';
    g.strokeStyle = rgba(COLORS.cream, 0.9 * a);
    g.stroke();
    g.setLineDash([]);
    if (pts) {
      // start marker so the closing edge reads as intentional
      const [sx, sy] = cam.toScreen(p[0], p[1]);
      g.beginPath();
      g.arc(sx, sy, 2.5, 0, 2 * Math.PI);
      g.fillStyle = rgba(COLORS.orange, 0.95);
      g.fill();
      ov.invalidate();   // marching dashes while the pointer rests
    } else if (done.count >= 0) {
      const m = p.length / 2;
      const sign = done.op === 'add' ? '+' : done.op === 'sub' ? '−' : '';
      g.font = monoFont(11, 700);
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = rgba(COLORS.bg, 0.6 * a);
      const text = sign + done.count.toLocaleString('en-US');
      const w = g.measureText(text).width + 10;
      g.fillRect(sxSum / m - w / 2, sySum / m - 9, w, 18);
      g.fillStyle = rgba(COLORS.cream, 0.95 * a);
      g.fillText(text, sxSum / m, sySum / m + 0.5);
    }
    g.restore();
  }

  return {
    draw,
    unregister,
    get active() { return !!pts; },
    /** Select the galaxies inside a screen-space polygon (flat [sx, sy, …]); op 'new'|'add'|'sub'. */
    selectPolygon(screenPoly, op = 'new') {
      const cam = app.camera;
      const p = [];
      for (let k = 0; k + 1 < screenPoly.length; k += 2) p.push(...cam.toData(screenPoly[k], screenPoly[k + 1]));
      return finish(p, op);
    },
  };
}
