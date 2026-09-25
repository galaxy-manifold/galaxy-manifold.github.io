// Rail of dimension tokens (DESIGN.md §13.2). Pill tokens (`short`) grouped by `group` with a
// thin group-colored bar. States: in view (w_d > 0.1: filled with the group color, fill
// opacity ∝ w_d), in tour set (outlined), color variable (◐ marker). Hover highlights the
// compass spoke; click opens a radial icon menu (→X, →Y, ◐ color, ⟲ tour set); drag onto the
// X/Y strips or the compass. Categories sit below as color-only tokens.

import { h, rafBatch, isNarrow } from './dom.js';
import { setTip } from './tooltip.js';
import { openRadial, closeRadial } from './radial.js';
import { groupedDims, catToken, GROUP_NAMES, dimTitle, shortKids, shortText } from './uiconfig.js';
import { groupColor, CATEGORY_COLORS, NEUTRAL } from '../config/style.js';
import { fmtInt } from './dom.js';

const DRAG_SLOP = 6;

export function initRail(app, mount, ui) {
  const { data, store, actions } = app;
  mount.replaceChildren();
  const root = h('div', { class: 'rail' });
  const tokens = new Map();     // key → {el, d}
  const catTokens = new Map();  // cat key → {el, spec}

  for (const g of groupedDims(data.dims)) {
    const block = h('div', { class: 'rail-group', role: 'group', 'aria-label': GROUP_NAMES[g.group] || g.group, style: { '--gc': g.color } },
      h('i', { class: 'rail-bar', 'aria-hidden': 'true' }));
    for (const d of g.dims) {
      const el = h('button', {
        class: 'tok',
        type: 'button',
        'data-key': d.key,
        'aria-haspopup': 'menu',
        'aria-expanded': 'false',
        'aria-label': dimTitle(d),
        style: { '--gc': g.color },
      }, h('span', { class: 'tok-fill', 'aria-hidden': 'true' }), h('span', { class: 'tok-t' }, shortKids(d.short)), h('i', { class: 'tok-c', 'aria-hidden': 'true' }));
      setTip(el, () => ({
        title: dimTitle(d),
        sub: d.desc,
        meta: `${fmtInt(d.nvalid)} galaxies · ${GROUP_NAMES[d.group] || d.group}`,
      }), isNarrow() ? 'bottom' : 'right');
      wireToken(el, { kind: 'dim', key: d.key, label: d.short, color: g.color });
      el.addEventListener('pointerenter', () => ui.compass?.highlight(d.key, true));
      el.addEventListener('pointerleave', () => ui.compass?.highlight(d.key, false));
      el.addEventListener('focus', () => ui.compass?.highlight(d.key, true));
      el.addEventListener('blur', () => ui.compass?.highlight(d.key, false));
      tokens.set(d.key, { el, d });
      block.append(el);
    }
    root.append(block);
  }

  if (data.categories.length) {
    const block = h('div', { class: 'rail-group rail-cats', role: 'group', 'aria-label': 'Categories' },
      h('i', { class: 'rail-bar', 'aria-hidden': 'true' }));
    for (const spec of data.categories) {
      const cols = spec.codes.map((c) => CATEGORY_COLORS[spec.key]?.[c.code] || c.color || NEUTRAL);
      const stops = cols.map((c, i) => `${c} ${(i / cols.length) * 100}% ${((i + 1) / cols.length) * 100}%`).join(', ');
      const el = h('button', {
        class: 'tok tok-cat',
        type: 'button',
        'data-cat': spec.key,
        'aria-label': `Color by ${spec.label}`,
        style: { '--stripe': `linear-gradient(90deg, ${stops})` },
      }, h('span', { class: 'tok-t', text: catToken(spec) }), h('i', { class: 'tok-stripe', 'aria-hidden': 'true' }),
      h('i', { class: 'tok-c', 'aria-hidden': 'true' }), h('i', { class: 'tok-f', 'aria-hidden': 'true' }));
      setTip(el, () => {
        const m = store.get().filters.cats?.[spec.key] ?? 0xff;
        const shown = spec.codes.filter((c) => (m >> c.code) & 1).map((c) => c.label);
        return {
          title: spec.label,
          sub: spec.desc,
          meta: (m & 0xff) === 0xff ? spec.codes.map((c) => c.label).join(' · ') : `showing ${shown.join(' · ') || 'none'}`,
        };
      }, isNarrow() ? 'bottom' : 'right');
      wireToken(el, { kind: 'cat', key: spec.key, label: catToken(spec), color: '#b8af9a' });
      catTokens.set(spec.key, { el, spec });
      block.append(el);
    }
    root.append(block);
  }
  mount.append(root);

  // ------------------------------------------------------------------ click → menu, drag → dnd
  function wireToken(el, item) {
    let down = null;
    let suppressClick = false;
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      down = { id: e.pointerId, x: e.clientX, y: e.clientY, touch: e.pointerType === 'touch' };
    });
    el.addEventListener('pointermove', (e) => {
      if (!down || e.pointerId !== down.id || ui.dnd.active) return;
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      const dist = Math.hypot(dx, dy);
      if (dist < DRAG_SLOP) return;
      // on the phone strip, horizontal swipes scroll the rail; a downward pull drags
      if (down.touch && isNarrow() && !(dy > Math.abs(dx))) {
        down = null;
        return;
      }
      down = null;
      suppressClick = true;
      ui.dnd.begin(item, e, el, { onEnd: () => setTimeout(() => { suppressClick = false; }, 0) });
    });
    const clear = () => { down = null; };
    el.addEventListener('pointerup', clear);
    el.addEventListener('pointercancel', clear);
    el.addEventListener('click', (e) => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      if (item.kind === 'cat') {
        const c = `cat:${item.key}`;
        actions.setColor(store.get().color === c ? null : c);
        return;
      }
      if (el.getAttribute('aria-expanded') === 'true') {
        closeRadial();   // a second click on the same token closes its menu
        return;
      }
      menuFor(el, item.key, e.detail === 0);
    });
    el.addEventListener('dragstart', (e) => e.preventDefault());
  }

  function menuFor(el, key, viaKeyboard) {
    const s = store.get();
    const inTour = s.tour.set.includes(key);
    const isColor = s.color === key;
    const cur = app.currentCombos();
    const onlyX = Object.keys(cur.x).length === 1 && cur.x[key] !== undefined;
    const onlyY = Object.keys(cur.y).length === 1 && cur.y[key] !== undefined;
    const m = openRadial(el, [
      { icon: 'toY', label: 'Put on the y axis', active: onlyY, onSelect: () => ui.dnd.setAxisTo('y', key) },
      { icon: 'toX', label: 'Put on the x axis', active: onlyX, onSelect: () => ui.dnd.setAxisTo('x', key) },
      { icon: 'half', label: isColor ? 'Stop coloring' : 'Color by this', active: isColor, onSelect: () => actions.setColor(isColor ? null : key) },
      {
        icon: 'orbit',
        label: inTour ? 'Remove from the tour' : 'Add to the tour',
        sub: inTour && s.tour.set.length <= 2 ? 'A tour needs at least two dimensions' : `${s.tour.set.length} dimensions tour`,
        active: inTour,
        disabled: inTour && s.tour.set.length <= 2,
        onSelect: () => {
          const set = store.get().tour.set;
          if (inTour) actions.tour.setSet(set.filter((k) => k !== key));
          else actions.tour.setSet([...set, key]);
        },
      },
    ], { side: isNarrow() ? 'down' : 'right' });
    if (viaKeyboard) m.focusFirst();
  }

  // ------------------------------------------------------------------ live state
  let lastFV = -1;
  function updateWeights() {
    if (app.frameVersion === lastFV) return;
    lastFV = app.frameVersion;
    const w = app.dimWeights();
    for (const [key, t] of tokens) {
      const wd = w[t.d.index] || 0;
      const fill = wd > 0.1 ? Math.min(1, wd) : 0;
      if (Math.abs((t.fill ?? -1) - fill) > 0.01) {
        t.fill = fill;
        t.el.style.setProperty('--fill', fill.toFixed(3));
        t.el.classList.toggle('inview', fill > 0);
        t.el.classList.toggle('strong', fill > 0.68);
      }
    }
  }
  const scheduleWeights = rafBatch(updateWeights);
  app.events.on('render', updateWeights);
  app.events.on('frame', scheduleWeights);

  function updateState() {
    const s = store.get();
    const set = new Set(s.tour.set);
    for (const [key, t] of tokens) {
      t.el.classList.toggle('tour', set.has(key));
      t.el.classList.toggle('color', s.color === key);
    }
    for (const [key, t] of catTokens) {
      t.el.classList.toggle('color', s.color === `cat:${key}`);
      const m = s.filters.cats?.[key] ?? 0xff;
      t.el.classList.toggle('filtered', (m & 0xff) !== 0xff);
    }
  }
  app.events.on('state', ({ changed }) => {
    if (changed.some((k) => k === 'tour' || k === 'color' || k === 'filters')) updateState();
  });
  updateState();
  updateWeights();

  // a column that failed to load reads as all-missing: say so on its token
  function markFailed() {
    const failed = data.failed || [];
    if (!failed.length) return;
    for (const [, t] of tokens) {
      const bad = failed.some((u) => String(u).endsWith(t.d.file));
      t.el.classList.toggle('failed', bad);
      if (bad) t.el.setAttribute('aria-label', `${dimTitle(t.d)} (not loaded)`);
    }
  }
  if (data.loaded) markFailed();
  else app.events.on('data:ready', markFailed);

  return {
    tokens,
    highlight(key, on) {
      tokens.get(key)?.el.classList.toggle('hl', !!on);
    },
    close: closeRadial,
  };
}
