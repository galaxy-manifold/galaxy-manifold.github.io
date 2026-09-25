// Preset cartridges (DESIGN.md §13.5): a tray of small rounded cartridges, each a live preview
// of its canonical view above a 3–4 character code. The active one glows orange; the glow
// fades as the frame drifts away (alignment < 0.99). Any other cartridge whose view the
// frame happens to match (e.g. after a manual rotation) lights up too.

import { h, smoothstep, debounce } from './dom.js';
import { setTip } from './tooltip.js';
import { axisInfo, axisLabel, frameFromCombos } from '../math/frame.js';

const SMALL = { width: 46, height: 26 };
const BIG = { width: 216, height: 132 };

export function keyForIndex(i) {
  return i < 9 ? String(i + 1) : i === 9 ? '0' : null;
}

export function initPresets(app, mount, ui) {
  const presets = app.config.presets;
  const tray = h('div', { class: 'carts-tray', role: 'toolbar', 'aria-label': 'Canonical views' });
  const items = new Map();

  presets.forEach((p, i) => {
    const key = keyForIndex(i);
    const screen = h('span', { class: 'cart-screen' });
    const b = h('button', {
      class: 'cart',
      type: 'button',
      'data-id': p.id,
      'aria-label': `${p.code} · ${p.name}`,
      'aria-pressed': 'false',
      style: { '--i': String(i) },
    }, screen, h('span', { class: 'cart-code', text: p.code }));
    b.addEventListener('click', () => {
      app.actions.applyPreset(p.id);
    });
    const item = { p, b, screen, key, big: null, bigVersion: -1, on: 0 };
    setTip(b, () => ({ node: richTip(item) }), 'bottom');
    b.dataset.tipDelay = '260';
    items.set(p.id, item);
    tray.append(b);
  });
  mount.append(tray);

  // ------------------------------------------------------------------ rich hover card
  let version = 0;   // bumps when previews must be regenerated (filters, context restore)
  function literatureLabels(p) {
    const lit = ui.literature || [];
    const ids = new Set(p.literature || []);
    return lit.filter((r) => ids.has(r.id) || r.view === p.id).map((r) => r.label).filter((v, i, a) => a.indexOf(v) === i);
  }

  function axesText(p) {
    const res = frameFromCombos(p.x, p.y, app.data.dims);
    if (!res.F) return ['', ''];
    const dims = app.data.dims;
    return [0, 1].map((c) => axisLabel(axisInfo(res.F, c, dims), dims));
  }

  function richTip(item) {
    const { p } = item;
    if (!item.big || item.bigVersion !== version) {
      const c = app.data.loaded ? app.preview(p.id, { ...BIG, dpr: 2 }) : null;
      if (c) {
        item.big = c;
        item.bigVersion = version;
      }
    }
    const [ax, ay] = axesText(p);
    const lits = literatureLabels(p);
    return h('div', { class: 'cp' },
      h('div', { class: 'cp-screen' }, item.big || h('span', { class: 'cp-empty' })),
      h('div', { class: 'cp-row' },
        h('span', { class: 'cp-code', text: p.code }),
        item.key ? h('kbd', { class: 'tip-key', text: item.key }) : null),
      h('div', { class: 'cp-name', text: p.name }),
      h('div', { class: 'cp-axes' },
        h('span', { class: 'cp-ax' }, h('i', { text: 'x' }), ax),
        h('span', { class: 'cp-ax' }, h('i', { text: 'y' }), ay)),
      lits.length ? h('div', { class: 'cp-lit' }, lits.map((l) => h('span', { text: l }))) : null);
  }

  // ------------------------------------------------------------------ small previews
  let queue = [];
  let pumping = false;
  function pump() {
    if (!queue.length) {
      pumping = false;
      return;
    }
    pumping = true;
    const id = queue.shift();
    const item = items.get(id);
    const c = item && app.preview(id, { ...SMALL, dpr: 2 });
    if (c && c.ready) {
      c.classList.add('cart-canvas');
      c.ready.then((ok) => {
        if (ok === null) return;
        item.screen.replaceChildren(c);
        item.screen.classList.add('lit');
      });
    }
    // one preview per frame keeps each frame's GPU/CPU cost small (~3 ms)
    requestAnimationFrame(() => setTimeout(pump, 0));
  }
  function requestPreviews() {
    if (!app.data.loaded) return;
    version++;
    queue = presets.map((p) => p.id);
    // the active / hovered ones first
    const act = app.store.get().presetId;
    if (act) queue.sort((a, b) => (a === act ? -1 : b === act ? 1 : 0));
    if (!pumping) pump();
  }
  const requestPreviewsLater = debounce(requestPreviews, 700);

  app.events.on('data:ready', () => setTimeout(requestPreviews, 120));
  app.events.on('context', ({ lost }) => {
    if (!lost) setTimeout(requestPreviews, 200);
  });
  app.events.on('state', ({ changed, state, source }) => {
    if (changed.includes('filters')) requestPreviewsLater();
    if (changed.includes('presetId')) updateActive(true);
  });

  // ------------------------------------------------------------------ active state
  let lastFV = -1, lastAll = 0;
  function updateActive(force = false) {
    if (!force && app.frameVersion === lastFV) return;
    lastFV = app.frameVersion;
    const now = performance.now();
    const act = app.store.get().presetId;
    const checkAll = force || now - lastAll > 140;
    if (checkAll) lastAll = now;
    for (const [id, item] of items) {
      let on = item.on;
      if (id === act) on = smoothstep(0.9, 0.99, app.presetAlignment(id));
      else if (checkAll) {
        const a = app.presetAlignment(id);
        on = a > 0.97 ? 0.85 * smoothstep(0.97, 0.995, a) : 0;
      }
      if (Math.abs(on - item.on) > 0.004 || (on === 0) !== (item.on === 0)) {
        item.on = on;
        item.b.style.setProperty('--on', on.toFixed(3));
        item.b.classList.toggle('active', on > 0.5);
        item.b.setAttribute('aria-pressed', on > 0.5 ? 'true' : 'false');
      }
    }
  }
  app.events.on('render', () => updateActive(false));
  app.events.on('settle', () => updateActive(true));

  // keep the active cartridge in view in a scrolling tray (narrow screens)
  app.events.on('state', ({ changed, state }) => {
    if (!changed.includes('presetId') || !state.presetId) return;
    const item = items.get(state.presetId);
    if (item && tray.scrollWidth > tray.clientWidth + 2) {
      // center the cartridge (measured against the tray itself, not the offsetParent)
      const br = item.b.getBoundingClientRect(), tr = tray.getBoundingClientRect();
      const left = tray.scrollLeft + (br.left - tr.left) - tr.width / 2 + br.width / 2;
      tray.scrollTo({ left: Math.max(0, left), behavior: app.motion.reduced() ? 'auto' : 'smooth' });
    }
  });

  return {
    items,
    requestPreviews,
    literatureLabels,
    apply(i) {
      const p = presets[i];
      if (p) app.actions.applyPreset(p.id);
    },
  };
}
