// Drag and drop of rail tokens (DESIGN.md §13.2): a pointer-driven ghost token and drop
// targets. The X and Y targets are DOM strips along the bottom and left edges of #stage-ui,
// shown and highlighted only while a drag is in progress; they call actions.setAxes while
// preserving the other axis. The compass and the color dial register their own targets.
//
//   dnd.addTarget({id, accepts(item), hit(x, y), show(item), hide(), enter(item), leave(),
//                  over(item, x, y), drop(item, x, y)})
//   dnd.begin(item, pointerEvent, sourceEl)   item: {kind:'dim'|'cat', key, label, color}

import { h, floatLayer } from './dom.js';
import { icon } from './icons.js';
import { suppressTips } from './tooltip.js';
import { comboVector } from '../math/frame.js';
import { shortKids } from './uiconfig.js';

export function createDnd(app, ui) {
  const targets = [];
  let drag = null;

  // ------------------------------------------------------------------ axis strips
  const stageUI = app.layers.stageUI;
  const stripX = h('div', { class: 'dz dz-x', 'aria-hidden': 'true' },
    h('span', { class: 'dz-mark', html: `${icon('toX')}<b>x</b>` }));
  const stripY = h('div', { class: 'dz dz-y', 'aria-hidden': 'true' },
    h('span', { class: 'dz-mark', html: `${icon('toY')}<b>y</b>` }));
  stageUI.append(stripX, stripY);

  function stripTarget(el, axis) {
    return {
      id: `axis-${axis}`,
      accepts: (item) => item.kind === 'dim',
      hit(x, y) {
        const r = el.getBoundingClientRect();
        return r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      },
      show() {
        el.classList.add('on');
      },
      hide() {
        el.classList.remove('on', 'hot');
        app.overlays?.highlightAxis?.(null);
      },
      enter() {
        el.classList.add('hot');
        app.overlays?.highlightAxis?.(axis);
      },
      leave() {
        el.classList.remove('hot');
        app.overlays?.highlightAxis?.(null);
      },
      drop(item) {
        setAxisTo(axis, item.key);
      },
    };
  }
  targets.push(stripTarget(stripX, 'x'), stripTarget(stripY, 'y'));

  /**
   * Put dimension `key` on `axis` ('x' | 'y') and keep the other axis (as a physical combo,
   * via frame→combo). If the other axis is (nearly) that same dimension, the axes swap.
   */
  function setAxisTo(axis, key) {
    const combo = { [key]: 1 };
    const cur = app.currentCombos();
    const otherAxis = axis === 'x' ? 'y' : 'x';
    const other = cur[otherAxis];
    const dims = app.data.dims;
    const va = comboVector(combo, dims), vb = comboVector(other, dims);
    let dot = 0;
    if (va && vb) for (let i = 0; i < va.v.length; i++) dot += va.v[i] * vb.v[i];
    const patch = Math.abs(dot) > 0.9
      ? { [axis]: combo, [otherAxis]: cur[axis] }   // swap
      : { [axis]: combo, [otherAxis]: other };
    return app.actions.setAxes(patch);
  }

  /** Keep the strips clear of the compass (bottom-left corner). */
  function layoutStrips() {
    const c = ui.compass?.box?.();
    const st = app.layers.stage.getBoundingClientRect();
    if (c && c.width > 0) {
      stripX.style.left = `${Math.max(0, Math.round(c.right - st.left + 6))}px`;
      stripY.style.bottom = `${Math.max(0, Math.round(st.bottom - c.top + 6))}px`;
    } else {
      stripX.style.left = '0px';
      stripY.style.bottom = '0px';
    }
  }

  // ------------------------------------------------------------------ drag loop
  function onMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    e.preventDefault();
    drag.x = e.clientX;
    drag.y = e.clientY;
    drag.ghost.style.transform = `translate(${Math.round(e.clientX + 10)}px, ${Math.round(e.clientY - 12)}px)`;
    let hot = null;
    for (const t of targets) {
      if (!t.accepts(drag.item)) continue;
      if (t.hit(e.clientX, e.clientY)) {
        hot = t;
        break;
      }
    }
    if (hot !== drag.hot) {
      drag.hot?.leave?.();
      drag.hot = hot;
      hot?.enter?.(drag.item);
      drag.ghost.classList.toggle('hot', !!hot);
    }
    hot?.over?.(drag.item, e.clientX, e.clientY);
  }

  function finish(e, cancel = false) {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    const d = drag;
    drag = null;
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onCancel, true);
    window.removeEventListener('keydown', onKey, true);
    document.documentElement.classList.remove('dragging');
    d.source?.classList.remove('dragging');
    const dropped = !cancel && d.hot;
    if (dropped) {
      d.ghost.classList.add('drop');
      try {
        d.hot.drop(d.item, d.x, d.y);
      } catch (err) {
        console.error('drop failed', err);
      }
    } else d.ghost.classList.add('back');
    for (const t of targets) t.hide?.();
    setTimeout(() => d.ghost.remove(), 220);
    suppressTips(false);
    d.onEnd?.(!!dropped);
  }
  const onUp = (e) => finish(e);
  const onCancel = (e) => finish(e, true);
  const onKey = (e) => {
    if (e.key === 'Escape' && drag) {
      e.preventDefault();
      e.stopPropagation();
      finish({ pointerId: drag.id }, true);
    }
  };

  function begin(item, e, source, { onEnd } = {}) {
    if (drag) finish({ pointerId: drag.id }, true);
    layoutStrips();
    const ghost = h('div', { class: `dnd-ghost${item.kind === 'cat' ? ' cat' : ''}`, style: { '--gc': item.color } },
      h('span', null, item.kind === 'dim' ? shortKids(item.label) : item.label));
    floatLayer().append(ghost);
    ghost.style.transform = `translate(${Math.round(e.clientX + 10)}px, ${Math.round(e.clientY - 12)}px)`;
    drag = { item, id: e.pointerId, ghost, hot: null, x: e.clientX, y: e.clientY, source, onEnd };
    try { source?.releasePointerCapture?.(e.pointerId); } catch { /* not captured */ }
    source?.classList.add('dragging');
    document.documentElement.classList.add('dragging');
    suppressTips(true);
    ui.closeMenus?.();
    for (const t of targets) if (t.accepts(item)) t.show?.(item);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
    window.addEventListener('keydown', onKey, true);
    onMove(e);
  }

  return {
    begin,
    setAxisTo,
    addTarget(t) {
      targets.push(t);
      return () => {
        const i = targets.indexOf(t);
        if (i >= 0) targets.splice(i, 1);
      };
    },
    get active() {
      return !!drag;
    },
    layoutStrips,
  };
}
