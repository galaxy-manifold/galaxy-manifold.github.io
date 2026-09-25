// Pan/zoom camera over projected u-space coordinates (y up).
//   toScreen(X, Y) → [sx, sy] CSS px from the stage's top-left
//   toData(sx, sy) → [X, Y]
//   fitBounds([x0, x1, y0, y1], {duration, pad, iso}) — frames a box inside the safe area
// `scale` is CSS px per u along x; `aspect` = (px per u along y) / (px per u along x). A fit
// may stretch one axis by up to `maxAspect` so a relation fills the stage (iso: true keeps 1).
// `safe` = CSS-px margins kept free for rulers/compass when fitting.

/** CSS-style cubic-bezier easing → function of t ∈ [0, 1]. */
export function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (s) => ((ax * s + bx) * s + cx) * s;
  const sy = (s) => ((ay * s + by) * s + cy) * s;
  const dsx = (s) => (3 * ax * s + 2 * bx) * s + cx;
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let s = t;
    for (let i = 0; i < 6; i++) {
      const e = sx(s) - t;
      const d = dsx(s);
      if (Math.abs(e) < 1e-7) return sy(s);
      if (Math.abs(d) < 1e-6) break;
      s -= e / d;
    }
    let lo = 0, hi = 1;
    s = t;
    for (let i = 0; i < 30; i++) {
      const v = sx(s);
      if (Math.abs(v - t) < 1e-7) break;
      if (v < t) lo = s; else hi = s;
      s = 0.5 * (lo + hi);
    }
    return sy(s);
  };
}

export const easeView = cubicBezier(0.65, 0, 0.35, 1);
export const easeOut = cubicBezier(0.2, 0.7, 0.3, 1);

const MIN_SCALE = 2;
const MAX_SCALE = 2e5;

export const MAX_ASPECT = 2.2;

/**
 * Camera parameters {cx, cy, scale, aspect} that fit bounds into a width×height viewport with
 * the given safe margins and fractional padding. maxAspect = 1 gives an isotropic fit.
 */
export function fitParams(bounds, width, height, { pad = 0.06, safe = { left: 0, right: 0, top: 0, bottom: 0 }, maxAspect = MAX_ASPECT } = {}) {
  let [x0, x1, y0, y1] = bounds;
  if (!(x1 > x0)) { x0 -= 1; x1 += 1; }
  if (!(y1 > y0)) { y0 -= 1; y1 += 1; }
  // usable area inside the safe margins; on tiny viewports ignore the margins (center instead)
  const availW = width - safe.left - safe.right, availH = height - safe.top - safe.bottom;
  const aw = Math.max(width * 0.45, availW), ah = Math.max(height * 0.45, availH);
  const ox = availW >= width * 0.45 ? safe.left : (width - aw) / 2;
  const oy = availH >= height * 0.45 ? safe.top : (height - ah) / 2;
  const fx = aw / ((x1 - x0) * (1 + 2 * pad)), fy = ah / ((y1 - y0) * (1 + 2 * pad));
  const A = Math.max(1, maxAspect);
  // x scale and y scale, each as large as fits, with their ratio limited to [1/A, A]
  const kx = Math.min(fx, fy * A), ky = Math.min(fy, fx * A);
  const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, kx));
  const aspect = Math.min(A, Math.max(1 / A, ky / kx));
  const xc = 0.5 * (x0 + x1), yc = 0.5 * (y0 + y1);
  const scx = ox + aw / 2, scy = oy + ah / 2;
  return { cx: xc - (scx - width / 2) / s, cy: yc + (scy - height / 2) / (s * aspect), scale: s, aspect };
}

export class Camera {
  constructor({ onChange } = {}) {
    this.cx = 0;
    this.cy = 0;
    this.scale = 120;
    this.aspect = 1;
    this.maxAspect = MAX_ASPECT;
    this.width = 1;
    this.height = 1;
    this.dpr = 1;
    this.safe = { left: 76, right: 28, top: 28, bottom: 64 };
    this.onChange = onChange || (() => {});
    this._anim = null;
  }

  resize(width, height, dpr = this.dpr) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.dpr = dpr;
    this.onChange('resize');
  }

  setSafeArea(safe) {
    this.safe = { ...this.safe, ...safe };
  }

  /** CSS px per u along x and along y. */
  get scaleX() {
    return this.scale;
  }

  get scaleY() {
    return this.scale * this.aspect;
  }

  toScreen(X, Y) {
    return [this.width / 2 + (X - this.cx) * this.scale, this.height / 2 - (Y - this.cy) * this.scale * this.aspect];
  }

  toData(sx, sy) {
    return [this.cx + (sx - this.width / 2) / this.scale, this.cy - (sy - this.height / 2) / (this.scale * this.aspect)];
  }

  /** Visible data box [x0, x1, y0, y1]. */
  viewBounds() {
    const hw = this.width / 2 / this.scale, hh = this.height / 2 / (this.scale * this.aspect);
    return [this.cx - hw, this.cx + hw, this.cy - hh, this.cy + hh];
  }

  /** Plain parameters for the renderer. */
  params() {
    return { cx: this.cx, cy: this.cy, scale: this.scale, aspect: this.aspect, width: this.width, height: this.height, dpr: this.dpr };
  }

  snapshot() {
    return { cx: this.cx, cy: this.cy, scale: this.scale, aspect: this.aspect };
  }

  get animating() {
    return !!this._anim;
  }

  stop() {
    this._anim = null;
  }

  /** Jump or animate to {cx, cy, scale, aspect}. */
  set({ cx = this.cx, cy = this.cy, scale = this.scale, aspect = this.aspect }, { duration = 0, ease = easeView } = {}) {
    scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    aspect = Math.min(8, Math.max(1 / 8, aspect));
    if (!(Number.isFinite(cx) && Number.isFinite(cy) && Number.isFinite(scale) && Number.isFinite(aspect))) return;
    if (duration > 0) {
      this._anim = { from: this.snapshot(), to: { cx, cy, scale, aspect }, t0: performance.now(), duration, ease };
      this.onChange('animate');
      return;
    }
    this._anim = null;
    this.cx = cx;
    this.cy = cy;
    this.scale = scale;
    this.aspect = aspect;
    this.onChange('set');
  }

  /** Frame a data box inside the safe area. iso: true forces aspect 1. */
  fitBounds(bounds, { duration = 0, pad = 0.06, iso = false } = {}) {
    if (!bounds) return;
    this.set(fitParams(bounds, this.width, this.height, { pad, safe: this.safe, maxAspect: iso ? 1 : this.maxAspect }), { duration });
  }

  /** Zoom by `factor` keeping the data point under (sx, sy) fixed. */
  zoomAt(sx, sy, factor) {
    this._anim = null;
    const [X, Y] = this.toData(sx, sy);
    const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * factor));
    this.scale = s;
    this.cx = X - (sx - this.width / 2) / s;
    this.cy = Y + (sy - this.height / 2) / (s * this.aspect);
    this.onChange('zoom');
  }

  /** Pan by a screen displacement in CSS px. */
  panBy(dx, dy) {
    this._anim = null;
    this.cx -= dx / this.scale;
    this.cy += dy / (this.scale * this.aspect);
    this.onChange('pan');
  }

  /** Advance an animation; returns true while animating. */
  update(now = performance.now()) {
    const a = this._anim;
    if (!a) return false;
    const t = Math.min(1, (now - a.t0) / a.duration);
    const e = a.ease(t);
    this.cx = a.from.cx + (a.to.cx - a.from.cx) * e;
    this.cy = a.from.cy + (a.to.cy - a.from.cy) * e;
    this.scale = Math.exp(Math.log(a.from.scale) + (Math.log(a.to.scale) - Math.log(a.from.scale)) * e);
    this.aspect = Math.exp(Math.log(a.from.aspect) + (Math.log(a.to.aspect) - Math.log(a.from.aspect)) * e);
    if (t >= 1) this._anim = null;
    this.onChange('animate');
    return t < 1;
  }
}
