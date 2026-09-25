// Keyboard shortcuts (DESIGN.md §13.10):
//   1–9, 0 presets · space tour · L lasso · M mode · T trends · B literature · C cycle color
//   (⇧C backwards) · V only galaxies with a color value · F fit · R reset
//   · Esc clear selection / close · ? about

import { COLOR_CYCLE } from './uiconfig.js';

function typing(t) {
  return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

function onControl(t) {
  if (!t || t === document.body) return false;
  const role = t.getAttribute && t.getAttribute('role');
  return t.tagName === 'BUTTON' || t.tagName === 'A' || role === 'slider' || role === 'menuitem' || role === 'option' || role === 'button';
}

export function initKeys(app, ui) {
  const { store, actions, data } = app;

  function cycleColor(dir) {
    const list = COLOR_CYCLE.filter((k) => k == null || (k.startsWith('cat:') ? !!data.catSpec(k.slice(4)) : data.dimIndex(k) >= 0));
    // skip dimensions that are (mostly) on the axes: coloring by them adds nothing
    const w = app.dimWeights();
    const usable = list.filter((k) => k == null || k.startsWith('cat:') || (w[data.dimIndex(k)] || 0) < 0.5);
    const seq = usable.length ? usable : list;
    const cur = store.get().color;
    let i = seq.indexOf(cur);
    if (i < 0) i = dir > 0 ? -1 : 0;
    actions.setColor(seq[(i + dir + seq.length) % seq.length]);
  }

  function escape() {
    if (ui.about?.open) {
      ui.about.hide();
      return true;
    }
    if (ui.closeMenus?.()) return true;
    if (store.get().inspected != null) {
      actions.inspect(null);
      return true;
    }
    if (store.get().selection) {
      actions.select(null);
      return true;
    }
    if (ui.inspector?.open) {
      ui.inspector.setOpen(false);
      return true;
    }
    if (store.get().tool === 'lasso') {
      actions.setTool('pan');
      return true;
    }
    return false;
  }

  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (typing(e.target)) return;
    const k = e.key;
    if (k === 'Escape') {
      if (escape()) e.preventDefault();
      return;
    }
    if (k === '?') {
      e.preventDefault();
      ui.about?.toggle();
      return;
    }
    if (ui.about?.open) return;
    if (!data.loaded && k !== ' ') return;
    if (/^[0-9]$/.test(k)) {
      const i = k === '0' ? 9 : Number(k) - 1;
      if (i < app.config.presets.length) {
        e.preventDefault();
        ui.header?.presets.apply(i);
      }
      return;
    }
    const lk = k.length === 1 ? k.toLowerCase() : k;
    switch (lk) {
      case ' ':
        if (onControl(e.target)) return;   // let buttons and sliders take their own space
        e.preventDefault();
        actions.tour.toggle();
        break;
      case 'l':
        e.preventDefault();
        actions.setTool(store.get().tool === 'lasso' ? 'pan' : 'lasso');
        break;
      case 'm':
        e.preventDefault();
        actions.setMode(store.get().mode === 'mosaic' ? 'glow' : 'mosaic');
        break;
      case 't':
        e.preventDefault();
        actions.setOverlay('trends', !store.get().overlays.trends);
        break;
      case 'b':
        e.preventDefault();
        actions.setOverlay('literature', !store.get().overlays.literature);
        break;
      case 'c':
        e.preventDefault();
        cycleColor(e.shiftKey ? -1 : 1);
        break;
      case 'v':
        e.preventDefault();
        actions.setFilter({ needColor: !store.get().filters.needColor });
        break;
      case 'f':
        e.preventDefault();
        actions.fit();
        break;
      case 'r':
        e.preventDefault();
        actions.resetView();
        break;
      default:
    }
  });

  return { cycleColor, escape };
}
