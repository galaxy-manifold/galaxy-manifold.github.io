// Small DOM helpers shared by the UI modules (no framework).
//   h('div', {class, text, html, style, dataset, on*: fn, attr: value}, ...children)
//   s('circle', {...})  — same for SVG elements

export const SVGNS = 'http://www.w3.org/2000/svg';

function applyProps(el, props) {
  if (!props) return;
  for (const k of Object.keys(props)) {
    const v = props[k];
    if (v == null || v === false) continue;
    if (k === 'class') el.setAttribute('class', v);
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [p, val] of Object.entries(v)) {
        if (val == null) continue;
        if (p.startsWith('--')) el.style.setProperty(p, val);
        else el.style[p] = val;
      }
    } else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
}

function append(el, kids) {
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  applyProps(el, props);
  append(el, kids);
  return el;
}

export function s(tag, props, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  applyProps(el, props);
  append(el, kids);
  return el;
}

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

const MINUS = '−';

/** Integer with thousands separators (Space Mono friendly). */
export function fmtInt(n) {
  if (!Number.isFinite(n)) return '–';
  return Math.round(n).toLocaleString('en-US');
}

/** Number with fixed decimals and a unicode minus. */
export function fmtFixed(x, d = 2) {
  if (!Number.isFinite(x)) return '–';
  const s = Math.abs(x).toFixed(d);
  return (x < 0 && Number(s) !== 0 ? MINUS : '') + s;
}

/** Percentage with sensible precision. */
export function fmtPct(f) {
  if (!Number.isFinite(f)) return '–';
  const p = f * 100;
  if (p >= 10) return `${p.toFixed(0)}%`;
  if (p >= 1) return `${p.toFixed(1)}%`;
  if (p >= 0.1) return `${p.toFixed(2)}%`;
  return p > 0 ? '<0.1%' : '0%';
}

/** Coalesce calls into one per animation frame. */
export function rafBatch(fn) {
  let id = 0;
  const run = () => {
    id = 0;
    fn();
  };
  const call = () => {
    if (!id) id = requestAnimationFrame(run);
  };
  call.cancel = () => {
    if (id) cancelAnimationFrame(id);
    id = 0;
  };
  call.flush = () => {
    if (id) {
      cancelAnimationFrame(id);
      run();
    }
  };
  return call;
}

/** Debounce with trailing call. */
export function debounce(fn, ms) {
  let t = 0;
  const d = (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  d.cancel = () => clearTimeout(t);
  d.flush = (...a) => {
    clearTimeout(t);
    fn(...a);
  };
  return d;
}

/** The body-level layer for floating UI (tooltips, menus, popovers, drag ghosts). */
export function floatLayer() {
  let el = document.getElementById('ui-float');
  if (!el) {
    el = h('div', { id: 'ui-float' });
    document.body.append(el);
  }
  return el;
}

/** True under prefers-reduced-motion. */
export function reducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Narrow (phone) layout, matching core.css's breakpoint. */
export function isNarrow() {
  return typeof matchMedia === 'function' && matchMedia('(max-width: 759.98px)').matches;
}

/** Hex color → rgba() string. */
export function rgba(hex, a) {
  const v = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${a})`;
}

/** Ease helpers for UI-driven animations. */
export function easeInOut(t) {
  // cubic-bezier(.65,0,.35,1) is close to this symmetric quintic-ish curve
  return t < 0.5 ? 16 * t ** 5 : 1 - (-2 * t + 2) ** 5 / 2;
}

export function easeOutCubic(t) {
  return 1 - (1 - t) ** 3;
}

/** requestAnimationFrame-driven tween; returns a cancel function. */
export function tween(ms, onStep, { ease = easeInOut, onDone } = {}) {
  const t0 = performance.now();
  let id = 0;
  let dead = false;
  const step = (now) => {
    if (dead) return;
    const t = ms > 0 ? Math.min(1, (now - t0) / ms) : 1;
    onStep(ease(t), t);
    if (t < 1) id = requestAnimationFrame(step);
    else onDone?.();
  };
  id = requestAnimationFrame(step);
  return () => {
    dead = true;
    cancelAnimationFrame(id);
  };
}

/**
 * Soft edge fades on a scroll container that hint at hidden content: sets data-fade to
 * 's' (start), 'e' (end) or 's e' while there is more to scroll that way, and removes the
 * attribute when nothing overflows. axis 'x' | 'y' | 'auto' (whichever overflows).
 */
export function edgeFades(el, axis = 'x') {
  if (!el) return () => {};
  const upd = rafBatch(() => {
    const ax = axis === 'auto' ? (el.scrollWidth - el.clientWidth > el.scrollHeight - el.clientHeight ? 'x' : 'y') : axis;
    const pos = ax === 'x' ? el.scrollLeft : el.scrollTop;
    const max = ax === 'x' ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight;
    const f = [];
    if (max > 2 && pos > 2) f.push('s');
    if (max > 2 && pos < max - 2) f.push('e');
    el.dataset.fadeAxis = ax;
    if (f.length) el.dataset.fade = f.join(' ');
    else delete el.dataset.fade;
  });
  el.addEventListener('scroll', upd, { passive: true });
  window.addEventListener('resize', upd);
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(upd);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);   // content growing inside
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(upd);
  upd();
  return upd;
}
