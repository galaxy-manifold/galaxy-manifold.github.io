// Hover card (DESIGN.md §13.7): after a 120 ms dwell, a small cream-framed card with the
// thumbnail (a thumbnail galaxy within 12 px is preferred) and three values: x, y and the
// colour variable. Never shown while the view is moving.

import { h, clamp, fmtFixed } from './dom.js';
import { axisValue } from '../math/frame.js';
import { sampleColormapHex } from '../gl/colormaps.js';
import { NEUTRAL } from '../config/style.js';
import { shortKids, catToken } from './uiconfig.js';

const DWELL = 120;

export function initHover(app, mount, ui) {
  const { data, config } = app;
  const img = h('img', { alt: '', decoding: 'async', draggable: 'false' });
  const pic = h('div', { class: 'hc-pic' }, img);
  const rows = h('div', { class: 'hc-rows' });
  const card = h('div', { class: 'hc', role: 'tooltip', 'aria-hidden': 'true' }, pic, rows);
  const ring = h('div', { class: 'hc-ring', 'aria-hidden': 'true' });
  mount.append(ring, card);

  let timer = 0, shownI = -1, pendingI = -1, last = null;

  function hide() {
    clearTimeout(timer);
    timer = 0;
    pendingI = -1;
    shownI = -1;
    card.classList.remove('on');
    ring.classList.remove('on');
  }

  function axisRow(i, col) {
    const info = app.axisInfo(col);
    const tag = col === 0 ? 'x' : 'y';
    if (!info) return { k: tag, v: '–' };
    const label = info.single ? data.dims[info.ref].short : tag;
    for (const t of info.terms) {
      const raw = data.raw[t.index];
      if (raw && raw[i] === 0) return { k: label, v: '–', axis: true, combo: !info.single };
    }
    const [X, Y] = app.proj.projectRow(i, app.frame);
    const A = axisValue(info, col === 0 ? X : Y);
    const v = info.single ? config.dims.format(info.refKey, A) : fmtFixed(A, 2);
    return { k: label, v, axis: true, combo: !info.single };
  }

  function colorRow(i) {
    const c = app.colorInfo();
    if (c.mode === 'continuous') {
      const x = data.value(i, c.key);
      if (!Number.isFinite(x)) return { k: c.spec.short, v: '–', sw: null };
      const t = clamp((x - c.range[0]) / (c.range[1] - c.range[0]), 0, 1);
      return { k: c.spec.short, v: config.dims.format(c.key, x), sw: sampleColormapHex(c.cmap, t, c.reverse) };
    }
    if (c.mode === 'categorical') {
      const code = data.catCode(i, c.cat);
      const e = c.spec.codes.find((q) => q.code === code);
      return { k: catToken(c.spec), v: e ? e.label : '∅', sw: e ? c.hex[code] || NEUTRAL : null, cat: true };
    }
    return null;
  }

  function show(i, sx, sy, atCursor = false) {
    if (app.isMoving() || ui.dnd?.active || document.documentElement.classList.contains('dragging')) return;
    shownI = i;
    const k = app.thumbs?.available ? app.thumbs.forRow(i) : -1;
    card.classList.toggle('has-pic', k >= 0);
    if (k >= 0) {
      app.thumbs.assign(img, k);
    } else img.removeAttribute('src');
    const list = [axisRow(i, 0), axisRow(i, 1)];
    const cr = colorRow(i);
    if (cr) list.push(cr);
    rows.replaceChildren(...list.map((r) => h('div', { class: `hc-row${r.combo ? ' combo' : ''}${r.cat ? ' cat' : ''}` },
      h('span', { class: 'hc-k' }, r.combo || r.cat ? [r.k] : shortKids(r.k)),
      r.sw !== undefined ? h('i', { class: 'hc-sw', style: { background: r.sw || 'transparent' } }) : null,
      h('span', { class: 'hc-v', text: r.v }))));

    // anchor at the galaxy (not the cursor) with a ring on it; in mosaic mode the tile under
    // the cursor is the galaxy (the overlay highlights the tile), so anchor at the cursor
    let gx = sx, gy = sy;
    if (!atCursor) {
      const [X, Y] = app.proj.projectRow(i, app.frame);
      [gx, gy] = app.camera.toScreen(X, Y);
      ring.style.transform = `translate(${gx.toFixed(1)}px, ${gy.toFixed(1)}px)`;
    }
    ring.classList.toggle('on', !atCursor);
    card.classList.add('on');
    const W = card.offsetWidth, H = card.offsetHeight;
    const sw = app.camera.width, sh = app.camera.height;
    let x = gx + 14, y = gy + 14;
    if (x + W > sw - 8) x = gx - 14 - W;
    if (y + H > sh - 8) y = gy - 14 - H;
    card.style.transform = `translate(${Math.round(clamp(x, 6, sw - W - 6))}px, ${Math.round(clamp(y, 6, sh - H - 6))}px)`;
  }

  app.events.on('hover', ({ index, sx, sy }) => {
    const mosaicTile = app.store.get().mode === 'mosaic' && Number.isFinite(sx) ? app.overlays?.mosaic?.tileAt?.(sx, sy) : null;
    if (index < 0 && !(mosaicTile && mosaicTile.row >= 0)) {
      hide();
      return;
    }
    // no card over the awake compass: the instrument has the pointer's attention there
    const sr = app.layers.stage.getBoundingClientRect();
    if (ui.compass?.covers(sx + sr.left, sy + sr.top)) {
      hide();
      return;
    }
    let i = index, atCursor = false;
    const tile = mosaicTile;
    if (tile && tile.row >= 0) {
      i = tile.row;   // the galaxy whose cutout is on this tile
      atCursor = true;
    } else if (app.thumbs?.available) {
      const t = app.proj.pick(sx, sy, 12, { thumbsOnly: true });
      if (t >= 0) i = t;
    }
    last = { i, sx, sy, atCursor };
    if (i === shownI) return;
    if (i !== pendingI) {
      pendingI = i;
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = 0;
        if (last && last.i === i) show(i, last.sx, last.sy, last.atCursor);
      }, shownI >= 0 ? 40 : DWELL);
    }
  });
  app.events.on('frame', ({ animating }) => {
    if (animating) hide();
  });
  app.events.on('camera', hide);
  app.events.on('resize', hide);
  // the card's values (and, in mosaic mode, its galaxy) depend on these
  app.events.on('state', ({ changed }) => {
    if (changed.some((k) => k === 'mode' || k === 'color' || k === 'filters' || k === 'mosaic')) hide();
  });
  app.layers.stage.addEventListener('pointerleave', hide);
  app.layers.stage.addEventListener('pointerdown', hide);

  return { hide };
}
