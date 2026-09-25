// Tooltips: full names, units and descriptions appear on hover or keyboard focus, never as
// permanent text (DESIGN.md §2.2). Delegated: any element with `data-tip` gets one.
//   el.dataset.tip = 'Title'            plain title
//   data-tip-sub / data-tip-meta / data-tip-key   optional second line, mono line, key hint
//   data-tip-pos = top | bottom | left | right   preferred side (flips to fit)
//   setTip(el, () => ({title, sub, meta, key, node}))   dynamic content (evaluated on show)

import { h, floatLayer, clamp } from './dom.js';

const dynamic = new WeakMap();
let tipEl = null;
let current = null;
let timer = 0;
let warmUntil = 0;
let suppressed = false;

export function setTip(el, content, pos) {
  if (!content) {
    dynamic.delete(el);
    el.dataset.tip = '';
    if (el === current) hideTip(true);
    return el;
  }
  if (typeof content === 'function') {
    dynamic.set(el, content);
    el.dataset.tip = el.dataset.tip || ' ';
  } else if (content && typeof content === 'object') {
    dynamic.set(el, () => content);
    el.dataset.tip = el.dataset.tip || ' ';
  } else {
    el.dataset.tip = content || '';
  }
  if (pos) el.dataset.tipPos = pos;
  return el;
}

function contentFor(el) {
  const fn = dynamic.get(el);
  if (fn) {
    try {
      return fn() || null;
    } catch (e) {
      console.error('tooltip content failed', e);
      return null;
    }
  }
  const d = el.dataset;
  if (!d.tip || !d.tip.trim()) return null;
  return { title: d.tip, sub: d.tipSub, meta: d.tipMeta, key: d.tipKey };
}

function render(c) {
  tipEl.replaceChildren();
  if (c.node) {
    tipEl.append(c.node);
    tipEl.classList.add('tip-rich');
    return;
  }
  tipEl.classList.remove('tip-rich');
  const head = h('div', { class: 'tip-head' });
  if (c.swatch) head.append(h('i', { class: 'tip-sw', style: { background: c.swatch } }));
  if (c.title) head.append(h('span', { class: 'tip-title', text: c.title }));
  if (c.key) head.append(h('kbd', { class: 'tip-key', text: c.key }));
  tipEl.append(head);
  if (c.sub) tipEl.append(h('div', { class: 'tip-sub', text: c.sub }));
  if (c.meta) tipEl.append(h('div', { class: 'tip-meta', text: c.meta }));
}

function place(el) {
  const r = el.getBoundingClientRect();
  const pos = el.dataset.tipPos || 'top';
  tipEl.style.left = '0px';
  tipEl.style.top = '0px';
  const tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  const gap = 9, m = 8;
  const fits = {
    top: r.top - gap - th >= m,
    bottom: r.bottom + gap + th <= vh - m,
    left: r.left - gap - tw >= m,
    right: r.right + gap + tw <= vw - m,
  };
  const opposite = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
  let side = pos;
  if (!fits[side]) side = fits[opposite[side]] ? opposite[side] : (['top', 'bottom', 'right', 'left'].find((s) => fits[s]) || pos);
  let x, y;
  if (side === 'top' || side === 'bottom') {
    x = r.left + r.width / 2 - tw / 2;
    y = side === 'top' ? r.top - gap - th : r.bottom + gap;
  } else {
    y = r.top + r.height / 2 - th / 2;
    x = side === 'left' ? r.left - gap - tw : r.right + gap;
  }
  x = clamp(x, m, vw - tw - m);
  y = clamp(y, m, vh - th - m);
  tipEl.style.left = `${Math.round(x)}px`;
  tipEl.style.top = `${Math.round(y)}px`;
  tipEl.dataset.side = side;
}

export function showTip(el) {
  clearTimeout(timer);
  if (suppressed || !el || !el.isConnected) return;
  const c = contentFor(el);
  if (!c) {
    hideTip();
    return;
  }
  current = el;
  render(c);
  tipEl.classList.add('on');
  tipEl.setAttribute('aria-hidden', 'false');
  place(el);
}

export function hideTip(instant = false) {
  clearTimeout(timer);
  if (current) warmUntil = performance.now() + 450;
  current = null;
  if (!tipEl) return;
  tipEl.classList.remove('on');
  tipEl.setAttribute('aria-hidden', 'true');
  if (instant) tipEl.classList.add('instant');
  else tipEl.classList.remove('instant');
}

/** Re-render the visible tooltip (e.g. a knob value while it turns). */
export function refreshTip(el) {
  if (current && (!el || el === current)) {
    const c = contentFor(current);
    if (c) {
      render(c);
      place(current);
    }
  }
}

/** Temporarily block tooltips (during drags). */
export function suppressTips(on) {
  suppressed = !!on;
  if (on) hideTip(true);
}

function schedule(el) {
  clearTimeout(timer);
  const warm = performance.now() < warmUntil || current;
  const delay = Number(el.dataset.tipDelay) || (warm ? 40 : 420);
  timer = setTimeout(() => showTip(el), delay);
}

let quietEl = null;

/** Move focus without popping the element's tooltip (focus restored after a menu closes). */
export function focusQuietly(el) {
  if (!el || !el.focus) return;
  quietEl = el;
  el.focus({ preventScroll: true });
  setTimeout(() => { if (quietEl === el) quietEl = null; }, 0);
}

export function initTooltips() {
  tipEl = h('div', { class: 'tip', role: 'tooltip', 'aria-hidden': 'true' });
  floatLayer().append(tipEl);
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const t = e.target.closest ? e.target.closest('[data-tip]') : null;
    if (t === current) return;
    if (!t) {
      if (current) hideTip();
      else clearTimeout(timer);
      return;
    }
    if (current) hideTip();
    schedule(t);
  });
  document.addEventListener('pointerout', (e) => {
    if (e.pointerType === 'touch') return;   // a lifted finger "leaves"; long-press tips outlive it
    if (!e.relatedTarget) hideTip();
  });
  document.addEventListener('pointerdown', () => hideTip(true), true);

  // touch: a long press (≈ 0.5 s, finger still) shows the tooltip; the click that follows the
  // release is swallowed, so a long press only reveals the name and never triggers the control
  let lp = null;
  const endLongPress = (e) => {
    if (!lp) return;
    clearTimeout(lp.timer);
    const { t, shown } = lp;
    lp = null;
    if (!shown || e.type === 'pointercancel') return;
    const swallow = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    };
    t.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => t.removeEventListener('click', swallow, { capture: true }), 450);
    setTimeout(() => { if (current === t) hideTip(); }, 1800);
  };
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    const t = e.target.closest ? e.target.closest('[data-tip]') : null;
    if (!t) return;
    lp = { t, x: e.clientX, y: e.clientY, shown: false, timer: 0 };
    lp.timer = setTimeout(() => {
      if (!lp || lp.t !== t) return;
      lp.shown = true;
      showTip(t);
    }, 520);
  }, true);
  document.addEventListener('pointermove', (e) => {
    if (lp && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 10) {
      clearTimeout(lp.timer);
      lp = null;
    }
  }, true);
  document.addEventListener('pointerup', endLongPress, true);
  document.addEventListener('pointercancel', endLongPress, true);
  document.addEventListener('contextmenu', (e) => {
    if (lp && lp.shown) e.preventDefault();   // no system menu over a tooltip
  }, true);
  document.addEventListener('focusin', (e) => {
    const t = e.target.closest ? e.target.closest('[data-tip]') : null;
    if (!t || t === quietEl) return;
    let fv = false;
    try { fv = t.matches(':focus-visible'); } catch { fv = false; }
    if (fv) showTip(t);
  });
  document.addEventListener('focusout', () => hideTip());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideTip(true);
  });
  document.addEventListener('scroll', () => hideTip(true), true);
  window.addEventListener('blur', () => hideTip(true));
  // a tooltip whose anchor disappeared (menu closed, panel re-rendered) goes too
  setInterval(() => {
    if (current && !current.isConnected) hideTip(true);
  }, 400);
}
