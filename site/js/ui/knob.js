// Rotary knob (Braun/Rams hi-fi dial): drag vertically or scroll to turn, double-click resets,
// arrow keys when focused. A 270° sweep with the glyph sitting in the gap at the bottom.
//   const k = createKnob({label, glyph, min, max, value, def, log, format, onInput, onChange})
//   k.el, k.set(v, {silent}), k.get()

import { h, clamp } from './dom.js';
import { icon } from './icons.js';
import { setTip, refreshTip } from './tooltip.js';

const SWEEP = 270;
const A0 = -135;   // degrees clockwise from 12 o'clock

function polar(r, deg) {
  const a = ((deg - 90) * Math.PI) / 180;
  return [20 + r * Math.cos(a), 20 + r * Math.sin(a)];
}

function arcPath(r, d0, d1) {
  const [x0, y0] = polar(r, d0);
  const [x1, y1] = polar(r, d1);
  const large = d1 - d0 > 180 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export function createKnob({
  label, glyph, min, max, value, def = value, log = true, format = (v) => v.toFixed(2),
  onInput, onChange, tipPos = 'top', className = '', ariaLabel,
}) {
  const toT = (v) => (log ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min));
  const fromT = (t) => (log ? min * Math.pow(max / min, t) : min + (max - min) * t);
  let t = clamp(toT(value), 0, 1);

  let ticks = '';
  for (let i = 0; i <= 10; i++) {
    const d = A0 + (SWEEP * i) / 10;
    const [xa, ya] = polar(i % 5 === 0 ? 15.4 : 16.3, d);
    const [xb, yb] = polar(18.4, d);
    ticks += `M${xa.toFixed(2)} ${ya.toFixed(2)}L${xb.toFixed(2)} ${yb.toFixed(2)}`;
  }
  const el = h('div', {
    class: `knob ${className}`.trim(),
    role: 'slider',
    tabindex: '0',
    'aria-label': ariaLabel || label,
    'aria-valuemin': String(min),
    'aria-valuemax': String(max),
  });
  el.innerHTML = `<svg viewBox="0 0 40 40" aria-hidden="true">
    <path class="knob-ticks" d="${ticks}"/>
    <path class="knob-track" d="${arcPath(17.4, A0, A0 + SWEEP)}"/>
    <path class="knob-arc" d=""/>
    <circle class="knob-body" cx="20" cy="20" r="11.2"/>
    <circle class="knob-grip" cx="20" cy="20" r="8.6"/>
    <line class="knob-ptr" x1="20" y1="20" x2="20" y2="10"/>
    <circle class="knob-cap" cx="20" cy="20" r="1.5"/>
  </svg><span class="knob-glyph">${icon(glyph)}</span>`;
  const arc = el.querySelector('.knob-arc');
  const ptr = el.querySelector('.knob-ptr');

  function draw() {
    const d = A0 + SWEEP * t;
    arc.setAttribute('d', t > 0.004 ? arcPath(17.4, A0, d) : '');
    const [x1, y1] = polar(4.2, d);
    const [x2, y2] = polar(10.2, d);
    ptr.setAttribute('x1', x1.toFixed(2));
    ptr.setAttribute('y1', y1.toFixed(2));
    ptr.setAttribute('x2', x2.toFixed(2));
    ptr.setAttribute('y2', y2.toFixed(2));
    const v = fromT(t);
    el.setAttribute('aria-valuenow', String(+v.toFixed(4)));
    el.setAttribute('aria-valuetext', format(v));
  }

  setTip(el, () => ({ title: label, meta: format(fromT(t)) }), tipPos);

  function setT(nt, { input = true, change = false } = {}) {
    nt = clamp(nt, 0, 1);
    if (Math.abs(nt - t) < 1e-6 && !change) return;
    t = nt;
    draw();
    refreshTip(el);
    const v = fromT(t);
    if (input) onInput?.(v);
    if (change) onChange?.(v);
  }

  // drag vertically to turn
  let drag = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    el.focus({ preventScroll: true });
    drag = { id: e.pointerId, y: e.clientY, x: e.clientX, t };
    el.setPointerCapture(e.pointerId);
    el.classList.add('turning');
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const k = e.shiftKey ? 600 : 160;
    const dy = drag.y - e.clientY + (e.clientX - drag.x) * 0.35;
    setT(drag.t + dy / k);
  });
  const end = (e) => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    drag = null;
    el.classList.remove('turning');
    onChange?.(fromT(t));
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  let wheelTimer = 0;
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    const dir = e.deltaY > 0 ? -1 : 1;
    setT(t + dir * (e.shiftKey ? 0.01 : 0.035));
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => onChange?.(fromT(t)), 180);
  }, { passive: false });
  el.addEventListener('dblclick', (e) => {
    e.preventDefault();
    setT(toT(def), { change: true });
  });
  el.addEventListener('keydown', (e) => {
    const steps = { ArrowUp: 0.025, ArrowRight: 0.025, ArrowDown: -0.025, ArrowLeft: -0.025, PageUp: 0.1, PageDown: -0.1 };
    if (e.key in steps) {
      e.preventDefault();
      e.stopPropagation();
      setT(t + steps[e.key], { change: true });
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      e.stopPropagation();
      setT(e.key === 'Home' ? 0 : 1, { change: true });
    }
  });

  draw();
  return {
    el,
    get: () => fromT(t),
    set(v, { silent = true } = {}) {
      if (drag) return;   // the user is turning it
      const nt = clamp(toT(v), 0, 1);
      if (Math.abs(nt - t) < 1e-6) return;
      t = nt;
      draw();
      if (!silent) onInput?.(fromT(t));
    },
  };
}
