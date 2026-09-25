// Starburst compass (DESIGN.md §13.3): the projection drawn as an atomic-age starburst clock.
// One spoke per dimension with w_d > 0.03, from the hub to (px_d, −py_d)·R, ending in a
// group-colored knob with the `short` label. Dimensions out of view sit as dots on a parking
// arc. Drag a knob → actions.rotateDim (live manual tour); double-click a knob → rotate it out;
// click or drag a parked dot → bring it in. Crowns: ▶/❚❚ tour, speed dial, ⊸ tighten.
// Fades to 40% when idle and wakes when the pointer comes near.

import { h, s, clamp, tween, isNarrow } from './dom.js';
import { icon } from './icons.js';
import { setTip, hideTip } from './tooltip.js';
import { createKnob } from './knob.js';
import { groupColor } from '../config/style.js';
import { dimTitle, GROUP_NAMES, shortParts } from './uiconfig.js';

const R = 70;            // spoke length of a dimension fully in the plane (SVG units)
const PARK_R = 109;      // parking arc radius
const PARK_A0 = 101;     // parking arc start/end (degrees, counter-clockwise from +x)
const PARK_A1 = -8;
const SHOW_W = 0.03;
const IDLE_MS = 1600;

const rad = (deg) => (deg * Math.PI) / 180;

/** SVG label with the manifest's "_" suffix as a lowered, smaller tspan. */
function svgLabel(cls, short) {
  const [a, b] = shortParts(short);
  const t = s('text', { class: cls }, a);
  if (b) t.append(s('tspan', { class: 'sub', dy: '0.28em', 'font-size': '0.74em' }, b));
  return t;
}

export function initCompass(app, mount, ui) {
  const { data, actions, store } = app;
  const D = data.D;

  const root = h('div', { class: 'compass', role: 'group', 'aria-label': 'Projection compass' });
  const svg = s('svg', { class: 'cmp-svg', viewBox: '-120 -120 240 240', 'aria-hidden': 'false' });

  // ------------------------------------------------------------------ bezel
  const bezel = s('g', { class: 'cmp-bezel', 'aria-hidden': 'true' },
    s('circle', { class: 'cmp-disc', r: '101' }),
    s('circle', { class: 'cmp-ring', r: '101' }),
    s('circle', { class: 'cmp-ticks', r: '95.5' }),
    s('circle', { class: 'cmp-ticks-major', r: '95.5' }),
    s('circle', { class: 'cmp-unit', r: String(R) }),
    s('circle', { class: 'cmp-half', r: String(R / 2) }),
    s('path', { class: 'cmp-cross', d: `M${-R - 6} 0H${R + 6}M0 ${-R - 6}V${R + 6}` }),
    s('text', { class: 'cmp-axis', x: String(R + 13), y: '3.2', 'text-anchor': 'middle' }, 'x'),
    s('text', { class: 'cmp-axis', x: '0', y: String(-R - 9), 'text-anchor': 'middle' }, 'y'),
  );
  const p0 = [PARK_R * Math.cos(rad(PARK_A0)), -PARK_R * Math.sin(rad(PARK_A0))];
  const p1 = [PARK_R * Math.cos(rad(PARK_A1)), -PARK_R * Math.sin(rad(PARK_A1))];
  const parkArc = s('path', {
    class: 'cmp-park-arc',
    d: `M${p0[0].toFixed(1)} ${p0[1].toFixed(1)}A${PARK_R} ${PARK_R} 0 0 1 ${p1[0].toFixed(1)} ${p1[1].toFixed(1)}`,
    'aria-hidden': 'true',
  });
  const gDrop = s('g', { class: 'cmp-drop', 'aria-hidden': 'true' },
    s('circle', { class: 'cmp-drop-ring', r: '101' }),
    s('line', { class: 'cmp-drop-spoke', x1: '0', y1: '0', x2: '0', y2: '0' }),
    s('circle', { class: 'cmp-drop-knob', r: '6' }));
  const gSpokes = s('g', { class: 'cmp-spokes' });
  const gParked = s('g', { class: 'cmp-parked' });
  const hub = s('g', { class: 'cmp-hub', 'aria-hidden': 'true' }, s('circle', { class: 'cmp-hub-ring', r: '7.2' }), s('circle', { class: 'cmp-hub-dot', r: '3.2' }));
  svg.append(bezel, parkArc, gDrop, gSpokes, gParked, hub);
  root.append(svg);

  // ------------------------------------------------------------------ per-dimension marks
  const marks = data.dims.map((d) => {
    const color = groupColor(d.group);
    const line = s('line', { class: 'sp-line', x1: '0', y1: '0', x2: '0', y2: '0' });
    const knob = s('circle', { class: 'sp-knob', r: '5.2' });
    const label = svgLabel('sp-label', d.short);
    const hit = s('circle', {
      class: 'sp-hit',
      r: '12',
      tabindex: '0',
      role: 'slider',
      'aria-label': `${d.label} spoke`,
      'aria-valuetext': '',
    });
    const spoke = s('g', { class: 'sp', 'data-key': d.key, style: `--gc:${color}` }, line, knob, label, hit);
    const pdot = s('circle', { class: 'pk-dot', r: '3.3' });
    const phit = s('circle', { class: 'pk-hit', r: '8', tabindex: '0', role: 'button', 'aria-label': `Bring ${d.label} into view` });
    const plabel = svgLabel('pk-label', d.short);
    const parked = s('g', { class: 'pk', 'data-key': d.key, style: `--gc:${color}` }, pdot, plabel, phit);
    gSpokes.append(spoke);
    gParked.append(parked);
    const m = { d, color, spoke, line, knob, label, hit, parked, pdot, plabel, phit, shown: null, park: null };
    const tipFn = () => ({ title: dimTitle(d), sub: d.desc, meta: `${GROUP_NAMES[d.group] || d.group} · weight ${(weight(d.index)).toFixed(2)}` });
    setTip(hit, tipFn, 'top');
    setTip(phit, tipFn, 'top');
    hit.dataset.tipDelay = '500';
    phit.dataset.tipDelay = '300';
    wireKnob(m);
    wireParked(m);
    return m;
  });

  function weight(i) {
    return Math.hypot(app.frame[i], app.frame[D + i]);
  }

  // ------------------------------------------------------------------ crowns (tour controls)
  const play = h('button', { class: 'crown crown-play ibtn', type: 'button', 'aria-label': 'Play the grand tour', 'aria-pressed': 'false', html: icon('play') });
  setTip(play, () => ({ title: store.get().tour.playing ? 'Pause the tour' : 'Grand tour', sub: 'Smooth random rotation through the tour set', key: 'space' }), 'top');
  play.addEventListener('click', () => actions.tour.toggle());

  const speed = createKnob({
    label: 'Tour speed',
    glyph: 'speed',
    min: 0.2, max: 4, value: store.get().tour.speed, def: 1, log: true,
    format: (v) => `${v.toFixed(2)}×`,
    onInput: (v) => actions.tour.setSpeed(v),
    className: 'knob-sm crown crown-speed',
  });

  const tighten = h('button', { class: 'crown crown-tighten ibtn', type: 'button', 'aria-label': 'Tighten: find the x combination that minimizes scatter in y', html: icon('tighten') });
  setTip(tighten, { title: 'Tighten', sub: 'Keep y; search x for the tightest relation (projection pursuit)' }, 'top');
  tighten.addEventListener('click', async () => {
    const p = app.pursuit;
    if (!p || typeof p.tighten !== 'function' || tighten.classList.contains('busy')) return;
    tighten.classList.add('busy');
    tighten.setAttribute('aria-busy', 'true');
    try {
      const r = await p.tighten({});
      if (r === false) {
        tighten.classList.add('nope');
        setTimeout(() => tighten.classList.remove('nope'), 700);
      }
    } catch (e) {
      console.error('tighten failed', e);
    } finally {
      tighten.classList.remove('busy');
      tighten.removeAttribute('aria-busy');
    }
  });
  const crowns = h('div', { class: 'crowns' }, play, speed.el, tighten);
  root.append(crowns);
  mount.append(root);

  // ------------------------------------------------------------------ geometry helpers
  function toSvg(clientX, clientY) {
    const m = svg.getScreenCTM();
    if (!m) return [0, 0];
    const p = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
    return [p.x, p.y];
  }
  // The compass box only moves on resize, so its center is cached (the window-level pointer
  // tracking below must not force a layout while a tour updates the spokes every frame).
  let centerCache = null;
  function center() {
    if (!centerCache) {
      const r = svg.getBoundingClientRect();
      centerCache = { x: r.left + r.width / 2, y: r.top + r.height / 2, k: r.width / 240, rect: r };
    }
    return centerCache;
  }
  const dropCenterCache = () => { centerCache = null; };
  window.addEventListener('resize', dropCenterCache);
  app.events.on('resize', dropCenterCache);
  if (typeof ResizeObserver === 'function') new ResizeObserver(dropCenterCache).observe(root);

  // ------------------------------------------------------------------ manual tour: knobs
  let dragging = null;      // key
  let animCancel = null;
  const pending = { key: null, t: null };
  let rafId = 0;
  function flushRotate() {
    rafId = 0;
    if (pending.key && pending.t) actions.rotateDim(pending.key, pending.t);
  }
  function rotateTo(key, a, b) {
    pending.key = key;
    pending.t = [a, b];
    if (!rafId) rafId = requestAnimationFrame(flushRotate);
  }
  function stopAnim() {
    if (animCancel) {
      animCancel();
      animCancel = null;
    }
  }

  /** Animate dim `key` along a straight path in the compass disk to target (a, b). */
  function animateDim(key, target, ms = 800) {
    stopAnim();
    const j = data.dimIndex(key);
    if (j < 0) return;
    const a0 = app.frame[j], b0 = app.frame[D + j];
    let [a1, b1] = target;
    const r1 = Math.hypot(a1, b1);
    if (r1 > 0.985) {
      a1 *= 0.985 / r1;
      b1 *= 0.985 / r1;
    }
    const dur = Math.max(1, ms * app.motion.scale());
    animCancel = tween(dur, (e) => {
      actions.rotateDim(key, [a0 + (a1 - a0) * e, b0 + (b1 - b0) * e]);
    }, { onDone: () => { animCancel = null; } });
  }

  function beginDrag(m, e) {
    e.preventDefault();
    e.stopPropagation();
    stopAnim();
    hideTip(true);
    dragging = m.d.key;
    root.classList.add('dragging');
    m.spoke.classList.add('grab');
    const el = e.currentTarget;
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    wake(true);
    const move = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      const [x, y] = toSvg(ev.clientX, ev.clientY);
      rotateTo(m.d.key, x / R, -y / R);
    };
    const up = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (rafId) {
        cancelAnimationFrame(rafId);
        flushRotate();
      }
      dragging = null;
      root.classList.remove('dragging');
      m.spoke.classList.remove('grab');
      wake();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  function wireKnob(m) {
    m.hit.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      beginDrag(m, e);
    });
    m.hit.addEventListener('dblclick', (e) => {
      e.preventDefault();
      animateDim(m.d.key, [0, 0], 650);
    });
    m.hit.addEventListener('pointerenter', () => ui.rail?.highlight(m.d.key, true));
    m.hit.addEventListener('pointerleave', () => ui.rail?.highlight(m.d.key, false));
    m.hit.addEventListener('keydown', (e) => keyNudge(m, e));
  }

  function keyNudge(m, e) {
    const j = m.d.index;
    const a = app.frame[j], b = app.frame[D + j];
    const step = e.shiftKey ? 0.15 : 0.05;
    const moves = { ArrowRight: [step, 0], ArrowLeft: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[e.key]) {
      e.preventDefault();
      e.stopPropagation();
      actions.rotateDim(m.d.key, [a + moves[e.key][0], b + moves[e.key][1]]);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      animateDim(m.d.key, [0, 0], 650);
    } else if (e.key === 'Enter' && weight(j) <= SHOW_W) {
      e.preventDefault();
      bringIn(m);
    }
  }

  function parkAngle(m) {
    return m.park != null ? m.park : 45;
  }

  function bringIn(m) {
    const a = rad(parkAngle(m));
    animateDim(m.d.key, [0.72 * Math.cos(a), 0.72 * Math.sin(a)], 850);
  }

  function wireParked(m) {
    m.phit.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const x0 = e.clientX, y0 = e.clientY;
      const el = m.phit;
      try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      let moved = false;
      const move = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
        if (!moved) {
          moved = true;
          stopAnim();
          dragging = m.d.key;
          root.classList.add('dragging');
          hideTip(true);
        }
        const [x, y] = toSvg(ev.clientX, ev.clientY);
        rotateTo(m.d.key, x / R, -y / R);
      };
      const up = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        if (rafId) {
          cancelAnimationFrame(rafId);
          flushRotate();
        }
        root.classList.remove('dragging');
        dragging = null;
        if (!moved && ev.type === 'pointerup') bringIn(m);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
    m.phit.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        bringIn(m);
        return;
      }
      // the parked dots are one tab stop; arrows walk along the arc
      const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!dir) return;
      e.preventDefault();
      e.stopPropagation();
      const k = parkedList.indexOf(m);
      const next = parkedList[(k + dir + parkedList.length) % parkedList.length];
      if (next && next !== m) {
        parkFocus = next.d.key;
        syncParkTabs();
        next.phit.focus({ preventScroll: true });
      }
    });
    m.phit.addEventListener('focus', () => {
      parkFocus = m.d.key;
      syncParkTabs();
    });
    m.phit.addEventListener('pointerenter', () => ui.rail?.highlight(m.d.key, true));
    m.phit.addEventListener('pointerleave', () => ui.rail?.highlight(m.d.key, false));
  }

  // ------------------------------------------------------------------ drawing
  let lastFV = -1;
  let parkedKey = '';
  function update(force = false) {
    if (!force && app.frameVersion === lastFV) return;
    lastFV = app.frameVersion;
    const F = app.frame;
    const parked = [];
    for (const m of marks) {
      const i = m.d.index;
      const px = F[i], py = F[D + i];
      const w = Math.hypot(px, py);
      const show = w > SHOW_W || dragging === m.d.key;
      if (show !== m.shown) {
        m.shown = show;
        m.spoke.classList.toggle('on', show);
        m.parked.classList.toggle('on', !show);
        m.hit.setAttribute('tabindex', show ? '0' : '-1');
        if (show) m.phit.setAttribute('tabindex', '-1');
      }
      if (!show) {
        parked.push(m);
        continue;
      }
      const x = px * R, y = -py * R;
      m.line.setAttribute('x2', x.toFixed(2));
      m.line.setAttribute('y2', y.toFixed(2));
      m.knob.setAttribute('cx', x.toFixed(2));
      m.knob.setAttribute('cy', y.toFixed(2));
      m.hit.setAttribute('cx', x.toFixed(2));
      m.hit.setAttribute('cy', y.toFixed(2));
      const ux = w > 1e-6 ? px / w : 1, uy = w > 1e-6 ? -py / w : 0;
      const off = 11.5;
      const lx = x + ux * off, ly = y + uy * off;
      m.label.setAttribute('x', lx.toFixed(1));
      m.label.setAttribute('y', (ly + (uy > 0.45 ? 7 : uy < -0.45 ? -1.5 : 3.4)).toFixed(1));
      m.label.setAttribute('text-anchor', ux > 0.38 ? 'start' : ux < -0.38 ? 'end' : 'middle');
      const lo = clamp((w - 0.1) / 0.22, 0, 1);
      m.label.style.opacity = (0.25 + 0.75 * lo).toFixed(2);
      m.spoke.style.setProperty('--w', w.toFixed(3));
      m.hit.setAttribute('aria-valuetext', `weight ${w.toFixed(2)}, direction ${Math.round((Math.atan2(py, px) * 180) / Math.PI)}°`);
    }
    const key = parked.map((m) => m.d.key).join(',');
    if (key !== parkedKey) {
      parkedKey = key;
      layoutParked(parked);
    }
  }

  // roving tabindex over the parked dots
  let parkedList = [];
  let parkFocus = null;
  function syncParkTabs() {
    const target = parkedList.find((m) => m.d.key === parkFocus) || parkedList[0];
    for (const m of parkedList) m.phit.setAttribute('tabindex', m === target ? '0' : '-1');
  }

  function layoutParked(parked) {
    parkedList = parked;
    syncParkTabs();
    const n = parked.length;
    if (!n) return;
    const span = PARK_A0 - PARK_A1;
    const step = n > 1 ? Math.min(6.7, span / (n - 1)) : 0;
    const start = PARK_A0;   // pack from the top of the arc
    parked.forEach((m, k) => {
      const a = start - k * step;
      m.park = a;
      const x = PARK_R * Math.cos(rad(a)), y = -PARK_R * Math.sin(rad(a));
      m.parked.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`;
      // radial label pointing outward
      m.plabel.setAttribute('transform', `rotate(${(-a).toFixed(1)}) translate(8 3)`);
    });
  }

  app.events.on('render', () => update(false));
  app.events.on('frame', () => { if (!app.data.loaded) update(true); });
  update(true);

  // ------------------------------------------------------------------ tour state
  function syncTour() {
    const t = store.get().tour;
    play.innerHTML = icon(t.playing ? 'pause' : 'play');
    play.setAttribute('aria-pressed', t.playing ? 'true' : 'false');
    play.setAttribute('aria-label', t.playing ? 'Pause the grand tour' : 'Play the grand tour');
    play.classList.toggle('on', !!t.playing);
    root.classList.toggle('touring', !!t.playing);
    speed.set(t.speed);
    const set = new Set(t.set);
    for (const m of marks) {
      m.spoke.classList.toggle('tour', set.has(m.d.key));
      m.parked.classList.toggle('tour', set.has(m.d.key));
    }
  }
  app.events.on('state', ({ changed }) => {
    if (changed.includes('tour')) syncTour();
  });
  syncTour();

  // ------------------------------------------------------------------ idle fade
  let idleTimer = 0;
  let near = false;
  function wake(hold = false) {
    root.classList.add('awake');
    clearTimeout(idleTimer);
    if (!hold) idleTimer = setTimeout(sleep, IDLE_MS);
  }
  function sleep() {
    if (dragging || near || root.matches(':focus-within') || ui.dnd?.active) {
      idleTimer = setTimeout(sleep, IDLE_MS);
      return;
    }
    root.classList.remove('awake');
  }
  window.addEventListener('pointermove', (e) => {
    const c = center();
    const d = Math.hypot(e.clientX - c.x, e.clientY - c.y) / c.k;
    const n = d < 128;
    if (n) {
      near = true;
      wake();
    } else if (near) {
      near = false;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(sleep, 500);
    }
    root.classList.toggle('near', n);
  }, { passive: true });
  root.addEventListener('focusin', () => wake(true));
  root.addEventListener('focusout', () => wake());
  wake();

  // ------------------------------------------------------------------ drop target (rail tokens)
  let dropCenter = null;
  ui.dnd?.addTarget({
    id: 'compass',
    accepts: (item) => item.kind === 'dim',
    hit(x, y) {
      const c = dropCenter || center();
      return Math.hypot(x - c.x, y - c.y) / c.k < 112;
    },
    show() {
      dropCenter = center();
      root.classList.add('drop-on');
      wake(true);
    },
    hide() {
      dropCenter = null;
      root.classList.remove('drop-on', 'drop-hot');
      wake();
    },
    enter(item) {
      root.classList.add('drop-hot');
      gDrop.style.setProperty('--gc', item.color);
    },
    leave() {
      root.classList.remove('drop-hot');
    },
    over(item, x, y) {
      const [sx, sy] = toSvg(x, y);
      const r = Math.hypot(sx, sy);
      const k = r > R * 0.985 ? (R * 0.985) / r : 1;
      gDrop.querySelector('.cmp-drop-spoke').setAttribute('x2', (sx * k).toFixed(1));
      gDrop.querySelector('.cmp-drop-spoke').setAttribute('y2', (sy * k).toFixed(1));
      gDrop.querySelector('.cmp-drop-knob').setAttribute('cx', (sx * k).toFixed(1));
      gDrop.querySelector('.cmp-drop-knob').setAttribute('cy', (sy * k).toFixed(1));
    },
    drop(item, x, y) {
      const [sx, sy] = toSvg(x, y);
      let a = sx / R, b = -sy / R;
      const r = Math.hypot(a, b);
      if (r < 0.2) {
        // dropped on the hub: bring it in along its parking direction
        const m = marks.find((mm) => mm.d.key === item.key);
        const ang = rad(m ? parkAngle(m) : 45);
        a = 0.7 * Math.cos(ang);
        b = 0.7 * Math.sin(ang);
      }
      animateDim(item.key, [a, b], 850);
    },
  });

  return {
    el: root,
    box: () => svg.getBoundingClientRect(),
    /** True if a client point is over the (awake) compass disk. */
    covers(x, y) {
      if (!root.classList.contains('awake')) return false;
      const c = center();
      return Math.hypot(x - c.x, y - c.y) / c.k < 104;
    },
    highlight(key, on) {
      const m = marks.find((mm) => mm.d.key === key);
      if (!m) return;
      m.spoke.classList.toggle('hl', !!on);
      m.parked.classList.toggle('hl', !!on);
      if (on) wake();
    },
    animateDim,
    update: () => update(true),
  };
}
