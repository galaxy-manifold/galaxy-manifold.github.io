// z-filter mini histogram with two draggable handles (DESIGN.md §13.4). The selected range is
// bright, the rest dim; drag a handle, drag the lit band to slide it, click outside it to move
// the nearest handle, double-click to clear. Handles are keyboard sliders.

import { h, s, clamp, rafBatch, fmtFixed } from './dom.js';
import { setTip, refreshTip } from './tooltip.js';

const W = 132, H = 26, BINS = 60;

export function createZFilter(app) {
  const { data, store, actions } = app;
  const zi = data.dimIndex('z');
  if (zi < 0) return null;
  const d = data.dims[zi];
  const q = (p) => data.quantile('z', p);
  let lo = Math.max(d.min, Math.floor((q(0.2) || d.min) * 200) / 200);
  let hi = Math.min(d.max, Math.ceil((q(99.8) || d.max) * 200) / 200);
  if (!(hi > lo)) { lo = d.min; hi = d.max; }
  const X = (z) => ((z - lo) / (hi - lo)) * W;
  const Z = (x) => lo + (clamp(x, 0, W) / W) * (hi - lo);

  const clipId = `zf-clip-${Math.random().toString(36).slice(2, 7)}`;
  const barsDim = s('path', { class: 'zf-bars' });
  const barsLit = s('path', { class: 'zf-bars lit', 'clip-path': `url(#${clipId})` });
  const clipRect = s('rect', { x: '0', y: '-2', width: String(W), height: String(H + 4) });
  const band = s('rect', { class: 'zf-band', x: '0', y: '0', width: String(W), height: String(H) });
  const svg = s('svg', { class: 'zf-svg', viewBox: `0 0 ${W} ${H}`, width: String(W), height: String(H), 'aria-hidden': 'true' },
    s('defs', null, s('clipPath', { id: clipId }, clipRect)),
    s('line', { class: 'zf-base', x1: '0', y1: String(H - 0.5), x2: String(W), y2: String(H - 0.5) }),
    barsDim, barsLit, band);

  const mkHandle = (which) => h('span', {
    class: `zf-h zf-${which}`,
    role: 'slider',
    tabindex: '0',
    'aria-label': which === 'lo' ? 'Minimum redshift' : 'Maximum redshift',
    'aria-valuemin': String(lo),
    'aria-valuemax': String(hi),
  }, h('i'));
  const hLo = mkHandle('lo'), hHi = mkHandle('hi');
  const lLo = h('span', { class: 'zf-v zf-v-lo' }), lHi = h('span', { class: 'zf-v zf-v-hi' });
  const track = h('div', { class: 'zf-track' }, svg, hLo, hHi, lLo, lHi);
  const el = h('div', { class: 'zf' }, h('span', { class: 'zf-glyph', text: 'z' }), track);
  setTip(el, () => {
    const z = store.get().filters.z;
    return { title: 'Redshift filter', sub: 'Drag the handles; double-click to clear. The flux limit makes every relation z-dependent.', meta: z ? `${fmtFixed(z[0], 3)} – ${fmtFixed(z[1], 3)}` : 'all z' };
  }, 'top');
  el.dataset.tipDelay = '700';

  // ------------------------------------------------------------------ histogram
  function buildHist() {
    const raw = data.raw[zi];
    if (!raw) return;
    const counts = new Float64Array(BINS);
    const { min, step } = d;
    const k = BINS / (hi - lo);
    for (let i = 0; i < raw.length; i++) {
      const v = raw[i];
      if (v === 0) continue;
      const z = min + (v - 1) * step;
      const b = Math.floor((z - lo) * k);
      if (b >= 0 && b < BINS) counts[b]++;
    }
    let mx = 0;
    for (const c of counts) mx = Math.max(mx, c);
    const bw = W / BINS;
    let p = '';
    for (let b = 0; b < BINS; b++) {
      const hgt = mx > 0 ? Math.max(counts[b] > 0 ? 1 : 0, Math.sqrt(counts[b] / mx) * (H - 3)) : 0;
      if (hgt <= 0) continue;
      p += `M${(b * bw + 0.35).toFixed(2)} ${H - 1}h${(bw - 0.7).toFixed(2)}v${(-hgt).toFixed(2)}h${(-(bw - 0.7)).toFixed(2)}z`;
    }
    barsDim.setAttribute('d', p);
    barsLit.setAttribute('d', p);
  }

  // ------------------------------------------------------------------ state ↔ view
  let cur = [lo, hi];
  function paint(active) {
    const x0 = X(cur[0]), x1 = X(cur[1]);
    clipRect.setAttribute('x', x0.toFixed(2));
    clipRect.setAttribute('width', Math.max(0, x1 - x0).toFixed(2));
    band.setAttribute('x', x0.toFixed(2));
    band.setAttribute('width', Math.max(0, x1 - x0).toFixed(2));
    hLo.style.left = `${x0.toFixed(1)}px`;
    hHi.style.left = `${x1.toFixed(1)}px`;
    lLo.style.left = `${x0.toFixed(1)}px`;
    lHi.style.left = `${x1.toFixed(1)}px`;
    lLo.textContent = fmtFixed(cur[0], 3);
    lHi.textContent = fmtFixed(cur[1], 3);
    hLo.setAttribute('aria-valuenow', cur[0].toFixed(3));
    hHi.setAttribute('aria-valuenow', cur[1].toFixed(3));
    el.classList.toggle('active', !!active);
  }
  function sync() {
    const z = store.get().filters.z;
    cur = z ? [clamp(z[0], lo, hi), clamp(z[1], lo, hi)] : [lo, hi];
    paint(!!z);
  }

  const commit = rafBatch(() => {
    const full = cur[0] <= lo + 1e-6 && cur[1] >= hi - 1e-6;
    actions.setFilter({ z: full ? null : [cur[0], cur[1]] });
  });

  function set(a, b) {
    const minGap = (hi - lo) / 80;
    a = clamp(a, lo, hi);
    b = clamp(b, lo, hi);
    if (b - a < minGap) {
      if (dragWhich === 'lo') a = b - minGap;
      else b = a + minGap;
    }
    cur = [clamp(a, lo, hi), clamp(b, lo, hi)];
    paint(true);
    refreshTip(el);
    commit();
  }

  // ------------------------------------------------------------------ pointer
  let dragWhich = null;
  function localX(e) {
    const r = track.getBoundingClientRect();
    return ((e.clientX - r.left) / r.width) * W;
  }
  track.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    const x = localX(e);
    const x0 = X(cur[0]), x1 = X(cur[1]);
    const tol = 7;
    if (e.target.closest('.zf-lo') || Math.abs(x - x0) <= tol && Math.abs(x - x0) <= Math.abs(x - x1)) dragWhich = 'lo';
    else if (e.target.closest('.zf-hi') || Math.abs(x - x1) <= tol) dragWhich = 'hi';
    else if (x > x0 && x < x1) dragWhich = 'band';
    else {
      dragWhich = Math.abs(x - x0) < Math.abs(x - x1) ? 'lo' : 'hi';
      if (dragWhich === 'lo') set(Z(x), cur[1]);
      else set(cur[0], Z(x));
    }
    track.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    const start = { x, a: cur[0], b: cur[1] };
    const move = (ev) => {
      const xx = localX(ev);
      if (dragWhich === 'lo') set(Z(xx), cur[1]);
      else if (dragWhich === 'hi') set(cur[0], Z(xx));
      else if (dragWhich === 'band') {
        const dz = ((xx - start.x) / W) * (hi - lo);
        const w = start.b - start.a;
        const a = clamp(start.a + dz, lo, hi - w);
        set(a, a + w);
      }
    };
    const up = () => {
      track.removeEventListener('pointermove', move);
      track.removeEventListener('pointerup', up);
      track.removeEventListener('pointercancel', up);
      dragWhich = null;
      el.classList.remove('dragging');
    };
    track.addEventListener('pointermove', move);
    track.addEventListener('pointerup', up);
    track.addEventListener('pointercancel', up);
  });
  track.addEventListener('dblclick', (e) => {
    e.preventDefault();
    actions.setFilter({ z: null });
  });
  const keyStep = (which, e) => {
    const k = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (!k) {
      if (e.key === 'Escape' || e.key === 'Delete') actions.setFilter({ z: null });
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const dz = ((hi - lo) / 100) * (e.shiftKey ? 10 : 1) * k;
    dragWhich = which;
    if (which === 'lo') set(cur[0] + dz, cur[1]);
    else set(cur[0], cur[1] + dz);
    dragWhich = null;
  };
  hLo.addEventListener('keydown', (e) => keyStep('lo', e));
  hHi.addEventListener('keydown', (e) => keyStep('hi', e));

  app.events.on('state', ({ changed }) => {
    if (changed.includes('filters') && !dragWhich) sync();
  });
  if (data.loaded) buildHist();
  else app.events.on('data:ready', buildHist);
  sync();

  return { el, sync };
}
