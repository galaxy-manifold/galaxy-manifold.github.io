// Color-by popover (DESIGN.md §13.4): a grid of every dimension (with its colormap) and every
// category (with its class colors), plus "none". Arrow keys move, Enter picks, Esc closes.

import { h, floatLayer, isNarrow } from './dom.js';
import { icon } from './icons.js';
import { setTip, hideTip, focusQuietly } from './tooltip.js';
import { groupedDims, catToken, dimTitle, GROUP_NAMES, shortKids } from './uiconfig.js';
import { colormapCSS } from '../gl/colormaps.js';
import { CATEGORY_COLORS, NEUTRAL } from '../config/style.js';

let open = null;

export function colorPopoverOpen() {
  return !!open;
}

export function closeColorPopover() {
  open?.close();
}

export function openColorPopover(app, anchor) {
  if (open) {
    open.close();
    return null;
  }
  const { data, store, actions, config } = app;
  const cur = store.get().color;
  const cells = [];

  const grid = h('div', { class: 'cpop-grid', role: 'listbox', 'aria-label': 'Color by' });
  for (const g of groupedDims(data.dims)) {
    for (const d of g.dims) {
      const cfg = config.dims.get(d.key);
      const bar = colormapCSS(cfg.cmap, { reverse: cfg.reverse, steps: 9 });
      const cell = h('button', {
        class: `cpop-cell${cur === d.key ? ' on' : ''}`,
        type: 'button',
        role: 'option',
        'aria-selected': cur === d.key ? 'true' : 'false',
        'aria-label': dimTitle(d),
        style: { '--gc': g.color, '--bar': bar },
      }, h('span', { class: 'cpop-t' }, shortKids(d.short)), h('i', { class: 'cpop-bar' }));
      setTip(cell, { title: dimTitle(d), sub: d.desc, meta: GROUP_NAMES[d.group] || d.group }, 'top');
      cell.addEventListener('click', () => pick(d.key));
      cells.push(cell);
      grid.append(cell);
    }
  }
  const cats = h('div', { class: 'cpop-grid cpop-cats', role: 'listbox', 'aria-label': 'Color by category' });
  for (const spec of data.categories) {
    const key = `cat:${spec.key}`;
    const cols = spec.codes.map((c) => CATEGORY_COLORS[spec.key]?.[c.code] || c.color || NEUTRAL);
    const stops = cols.map((c, i) => `${c} ${(i / cols.length) * 100}% ${((i + 1) / cols.length) * 100}%`).join(', ');
    const cell = h('button', {
      class: `cpop-cell cat${cur === key ? ' on' : ''}`,
      type: 'button',
      role: 'option',
      'aria-selected': cur === key ? 'true' : 'false',
      'aria-label': spec.label,
      style: { '--bar': `linear-gradient(90deg, ${stops})`, '--gc': 'var(--cream-3)' },
    }, h('span', { class: 'cpop-t', text: catToken(spec) }), h('i', { class: 'cpop-bar' }));
    setTip(cell, { title: spec.label, sub: spec.desc, meta: spec.codes.map((c) => c.label).join(' · ') }, 'top');
    cell.addEventListener('click', () => pick(key));
    cells.push(cell);
    cats.append(cell);
  }
  const none = h('button', {
    class: `cpop-cell none${cur == null ? ' on' : ''}`,
    type: 'button',
    role: 'option',
    'aria-selected': cur == null ? 'true' : 'false',
    'aria-label': 'No color',
    html: `${icon('clear')}`,
  });
  setTip(none, { title: 'No color', sub: 'Density only' }, 'top');
  none.addEventListener('click', () => pick(null));
  cells.push(none);
  cats.append(none);

  const root = h('div', { class: 'cpop', role: 'dialog', 'aria-label': 'Color by' },
    grid, h('div', { class: 'cpop-rule', 'aria-hidden': 'true' }), cats);
  floatLayer().append(root);

  // position above the anchor (console lives at the bottom)
  const r = anchor.getBoundingClientRect();
  const vw = window.innerWidth;
  const w = root.offsetWidth;
  let left = isNarrow() ? (vw - w) / 2 : r.left - 6;
  left = Math.max(8, Math.min(vw - w - 8, left));
  root.style.left = `${Math.round(left)}px`;
  root.style.bottom = `${Math.round(window.innerHeight - r.top + 10)}px`;
  root.style.setProperty('--ax', `${Math.round(r.left + r.width / 2 - left)}px`);
  requestAnimationFrame(() => root.classList.add('open'));
  anchor.setAttribute('aria-expanded', 'true');

  function pick(key) {
    actions.setColor(key);
    close();
    focusQuietly(anchor);
  }

  function cols() {
    const style = getComputedStyle(grid);
    return Math.max(1, style.gridTemplateColumns.split(' ').length);
  }
  function onKey(e) {
    const i = cells.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      focusQuietly(anchor);
      return;
    }
    const n = cols();
    const moves = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: n, ArrowUp: -n };
    if (e.key in moves) {
      e.preventDefault();
      e.stopPropagation();
      const j = i < 0 ? 0 : Math.max(0, Math.min(cells.length - 1, i + moves[e.key]));
      cells[j].focus();
    }
  }
  function onDown(e) {
    if (!root.contains(e.target) && !anchor.contains(e.target)) close();
  }
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    hideTip(true);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('resize', close);
    anchor.setAttribute('aria-expanded', 'false');
    root.classList.remove('open');
    setTimeout(() => root.remove(), 180);
    open = null;
  }
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onDown, true);
  window.addEventListener('resize', close);
  open = { close, root };
  const sel = cells.find((c) => c.classList.contains('on')) || cells[0];
  sel?.focus({ preventScroll: true });
  return open;
}
