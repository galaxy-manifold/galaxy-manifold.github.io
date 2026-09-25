// Console (DESIGN.md §13.4): mode rocker ✺/▦, color-by dial with its colorbar or category
// legend chips (chips toggle classes via the filter bitmask), a funnel that hides galaxies
// without a value of the color variable (filters.needColor), overlay toggles, rotary knobs
// for gain and point size, the z-filter histogram, and the mosaic cell-size knob with a
// fit/true-scale switch (mosaic mode only).

import { h, fmtInt } from './dom.js';
import { icon } from './icons.js';
import { setTip, refreshTip } from './tooltip.js';
import { createKnob } from './knob.js';
import { createZFilter } from './zfilter.js';
import { openColorPopover, closeColorPopover } from './colorpop.js';
import { catToken, chipFor, dimTitle, catCounts, catMissing, shortKids } from './uiconfig.js';
import { sampleColormapHex } from '../gl/colormaps.js';
import { CATEGORY_COLORS, NEUTRAL, groupColor } from '../config/style.js';

export function initConsole(app, mount, ui) {
  const { data, store, actions, config } = app;
  mount.replaceChildren();

  // ------------------------------------------------------------------ mode rocker
  const bGlow = h('button', { class: 'rk-side', type: 'button', 'data-mode': 'glow', 'aria-label': 'Glow mode', html: icon('burst') });
  const bMosaic = h('button', { class: 'rk-side', type: 'button', 'data-mode': 'mosaic', 'aria-label': 'Mosaic mode', html: icon('grid') });
  setTip(bGlow, { title: 'Glow', sub: 'Density as light; hue = color variable', key: 'M' }, 'top');
  setTip(bMosaic, { title: 'Mosaic', sub: 'Tile the plane with the most typical galaxy of each cell', key: 'M' }, 'top');
  const rocker = h('div', { class: 'rocker', role: 'group', 'aria-label': 'Display mode' }, h('i', { class: 'rk-paddle', 'aria-hidden': 'true' }), bGlow, bMosaic);
  for (const b of [bGlow, bMosaic]) b.addEventListener('click', () => actions.setMode(b.dataset.mode));

  // ------------------------------------------------------------------ color dial + legend
  const dialSym = h('span', { class: 'cd-sym' });
  const dial = h('button', { class: 'cdial', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-label': 'Color by' },
    h('span', { class: 'cd-ring', 'aria-hidden': 'true' }), h('span', { class: 'cd-face' }, dialSym));
  setTip(dial, () => {
    const c = app.colorInfo();
    if (c.mode === 'continuous') return { title: `Color: ${dimTitle(c.spec)}`, sub: 'Hue = mean of the color variable per pixel; click to change', key: 'C' };
    if (c.mode === 'categorical') return { title: `Color: ${c.spec.label}`, sub: 'Hue = mix of classes per pixel; click to change', key: 'C' };
    return { title: 'Color by…', sub: 'Density only', key: 'C' };
  }, 'top');
  dial.addEventListener('click', () => openColorPopover(app, dial));

  const cbar = h('div', { class: 'cbar' },
    h('span', { class: 'cbar-lo' }), h('span', { class: 'cbar-grad', 'aria-hidden': 'true' }), h('span', { class: 'cbar-hi' }));
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Classes' });
  const pills = h('div', { class: 'fpills', role: 'group', 'aria-label': 'Active category filters' });
  const legend = h('div', { class: 'legend' }, cbar, chips);

  // hide galaxies without a value of the color variable
  const bNeed = h('button', { class: 'tog ibtn tog-need', type: 'button', 'aria-pressed': 'false', 'aria-label': 'Only galaxies with a color value', html: icon('funnel') });
  setTip(bNeed, () => {
    const c = app.colorInfo();
    if (c.mode === 'none') return { title: 'Only galaxies with a color value', sub: 'Pick a color variable first', key: 'V' };
    const on = !!store.get().filters.needColor;
    const cat = c.mode === 'categorical';
    const name = cat ? `a ${c.spec.label} class` : dimTitle(c.spec);
    const miss = missingOf(c);
    return {
      title: on ? `Only galaxies with ${name}` : `Hide galaxies without ${name}`,
      sub: miss ? `${fmtInt(miss)} of ${fmtInt(data.n)} galaxies have no ${cat ? 'class' : 'value'}` : 'Every galaxy has a value; nothing to hide',
      meta: on ? 'click to show all' : null,
      key: 'V',
    };
  }, 'top');
  bNeed.addEventListener('click', () => actions.setFilter({ needColor: !store.get().filters.needColor }));

  const colorGroup = h('div', { class: 'con-group con-color' }, dial, legend, bNeed, pills);

  /** Galaxies without a value of the current color variable. */
  function missingOf(c) {
    if (c.mode === 'continuous') return Math.max(0, data.n - (c.spec.nvalid ?? data.n));
    if (c.mode === 'categorical') return catMissing(data, c.cat);
    return 0;
  }

  function syncNeed() {
    const c = app.colorInfo();
    const on = !!store.get().filters.needColor;
    bNeed.hidden = c.mode === 'none';
    bNeed.setAttribute('aria-pressed', on ? 'true' : 'false');
    bNeed.classList.toggle('moot', c.mode !== 'none' && missingOf(c) === 0);
    refreshTip(bNeed);
  }

  function ringCSS(c) {
    if (c.mode === 'continuous') {
      const stops = [];
      for (let k = 0; k <= 8; k++) stops.push(`${sampleColormapHex(c.cmap, k / 8, c.reverse)} ${(k / 8) * 270}deg`);
      return `conic-gradient(from 225deg, ${stops.join(', ')}, transparent 270deg 360deg)`;
    }
    if (c.mode === 'categorical') {
      const codes = c.spec.codes;
      const counts = catCounts(data, c.cat);
      const n = (e) => Math.max(1, counts[e.code] || 0);
      const tot = codes.reduce((a, e) => a + n(e), 0) || 1;
      let acc = 0;
      const stops = [];
      for (const e of codes) {
        const col = c.hex[e.code] || NEUTRAL;
        const a0 = (acc / tot) * 270;
        acc += n(e);
        const a1 = (acc / tot) * 270;
        stops.push(`${col} ${a0.toFixed(1)}deg ${Math.max(a0, a1 - 2.5).toFixed(1)}deg`, `transparent ${Math.max(a0, a1 - 2.5).toFixed(1)}deg ${a1.toFixed(1)}deg`);
      }
      return `conic-gradient(from 225deg, ${stops.join(', ')}, transparent 270deg 360deg)`;
    }
    return 'conic-gradient(from 225deg, var(--cream-3) 0deg 270deg, transparent 270deg 360deg)';
  }

  function syncColor() {
    const c = app.colorInfo();
    dial.style.setProperty('--ring', ringCSS(c));
    colorGroup.dataset.mode = c.mode;
    if (c.mode === 'continuous') {
      dialSym.replaceChildren(...shortKids(c.spec.short));
      dial.style.setProperty('--gc', groupColor(c.spec.group));
      cbar.querySelector('.cbar-grad').style.background = `linear-gradient(90deg, ${[0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1].map((t) => sampleColormapHex(c.cmap, t, c.reverse)).join(', ')})`;
      cbar.querySelector('.cbar-lo').textContent = config.dims.format(c.spec.key, c.range[0]);
      cbar.querySelector('.cbar-hi').textContent = config.dims.format(c.spec.key, c.range[1]);
      setTip(cbar, { title: dimTitle(c.spec), sub: 'Color range; values beyond it saturate', meta: `${config.dims.format(c.spec.key, c.range[0])} … ${config.dims.format(c.spec.key, c.range[1])}` }, 'top');
      chips.replaceChildren();
    } else if (c.mode === 'categorical') {
      dialSym.textContent = catToken(c.spec);
      dial.style.setProperty('--gc', 'var(--cream-2)');
      buildChips(c);
    } else {
      dialSym.innerHTML = icon('half');
      dial.style.setProperty('--gc', 'var(--cream-3)');
      chips.replaceChildren();
    }
    syncChips();
    syncPills();
    syncNeed();
  }

  function buildChips(c) {
    chips.replaceChildren();
    const spec = c.spec;
    const nmiss = catMissing(data, spec.key);
    const counts = catCounts(data, spec.key);
    const list = spec.codes.map((e) => ({ code: e.code, e: { ...e, n: counts[e.code] } }));
    if (nmiss > 0) list.push({ code: 0, e: { code: 0, label: 'no class', name: `no ${spec.label} (unmatched)`, n: nmiss } });
    for (const { code, e } of list) {
      const glyph = code === 0 ? { t: '∅' } : chipFor(spec, code);
      const col = code === 0 ? 'var(--cream-3)' : c.hex[code] || NEUTRAL;
      const chip = h('button', {
        class: `chip${glyph.hollow ? ' hollow' : ''}${code === 0 ? ' nil' : ''}`,
        type: 'button',
        'data-code': String(code),
        'aria-pressed': 'true',
        'aria-label': e.name || e.label,
        style: { '--cc': col },
      }, h('i', { class: 'chip-sw', 'aria-hidden': 'true' }), h('span', { text: glyph.t }));
      setTip(chip, () => ({
        title: e.name || e.label,
        meta: `${e.n ? `${fmtInt(e.n)} galaxies · ` : ''}click toggles · shift-click solos`,
        swatch: code === 0 ? null : col,
      }), 'top');
      chip.addEventListener('click', (ev) => toggleClass(spec.key, code, ev.shiftKey || ev.altKey));
      chips.append(chip);
    }
  }

  function toggleClass(cat, code, solo) {
    const spec = data.catSpec(cat);
    const all = spec.codes.reduce((m, e) => m | (1 << e.code), 1);   // includes code 0
    let m = store.get().filters.cats?.[cat] ?? 0xff;
    m &= 0xff;
    if (solo) m = (m & all) === (1 << code) ? 0xff : 1 << code;
    else {
      m ^= 1 << code;
      if ((m & all) === 0) m = 0xff;
    }
    if ((m & all) === all) m = 0xff;
    actions.setFilter({ cats: { [cat]: m } });
  }

  function syncChips() {
    const c = app.colorInfo();
    if (c.mode !== 'categorical') return;
    const f = store.get().filters;
    const m = (f.cats?.[c.cat] ?? 0xff) & 0xff;
    for (const chip of chips.children) {
      const code = +chip.dataset.code;
      const on = ((m >> code) & 1) === 1;
      chip.classList.toggle('off', !on);
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
      // the funnel already hides the unclassified galaxies
      if (code === 0) chip.hidden = !!f.needColor;
    }
  }

  /** Category filters that are active but not visible as chips (e.g. FP's ellipticals-only). */
  function syncPills() {
    pills.replaceChildren();
    const s = store.get();
    const c = app.colorInfo();
    for (const spec of data.categories) {
      const m = (s.filters.cats?.[spec.key] ?? 0xff) & 0xff;
      if (m === 0xff || (c.mode === 'categorical' && c.cat === spec.key)) continue;
      const shown = spec.codes.filter((e) => (m >> e.code) & 1);
      const pill = h('button', { class: 'fpill', type: 'button', 'aria-label': `Clear the ${spec.label} filter` },
        h('span', { class: 'fp-k', text: catToken(spec) }),
        shown.map((e) => h('i', { class: 'fp-sw', style: { '--cc': CATEGORY_COLORS[spec.key]?.[e.code] || e.color || NEUTRAL } })),
        h('span', { class: 'fp-x', html: icon('close') }));
      setTip(pill, { title: `${spec.label}: ${shown.map((e) => e.label).join(', ') || 'none'}`, sub: 'Filter from the current view; click to clear' }, 'top');
      pill.addEventListener('click', () => actions.setFilter({ cats: { [spec.key]: 0xff } }));
      pills.append(pill);
    }
  }

  // drop a rail token on the dial → color by it
  ui.dnd?.addTarget({
    id: 'color-dial',
    accepts: () => true,
    hit(x, y) {
      const r = dial.getBoundingClientRect();
      return Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2)) < r.width * 0.9;
    },
    show() { dial.classList.add('drop-on'); },
    hide() { dial.classList.remove('drop-on', 'drop-hot'); },
    enter() { dial.classList.add('drop-hot'); },
    leave() { dial.classList.remove('drop-hot'); },
    drop(item) { actions.setColor(item.kind === 'cat' ? `cat:${item.key}` : item.key); },
  });

  // ------------------------------------------------------------------ mosaic controls
  const cellKnob = createKnob({
    label: 'Mosaic cell size',
    glyph: 'cell',
    min: 24, max: 160, value: store.get().mosaic.cell, def: 56, log: true,
    format: (v) => `${Math.round(v)} px`,
    onInput: (v) => actions.setMosaic({ cell: Math.round(v) }),
  });
  const bFit = h('button', { class: 'seg-b', type: 'button', 'data-scale': 'fit', 'aria-label': 'Fit each galaxy to its tile', html: icon('fit') });
  const bTrue = h('button', { class: 'seg-b', type: 'button', 'data-scale': 'true', 'aria-label': 'True physical scale (50 kpc per tile)', html: icon('ruler') });
  setTip(bFit, { title: 'Fit', sub: 'Each cutout fills its tile' }, 'top');
  setTip(bTrue, { title: 'True scale', sub: 'Cutouts drawn at a common physical scale (a tile = 50 kpc)' }, 'top');
  for (const b of [bFit, bTrue]) b.addEventListener('click', () => actions.setMosaic({ scale: b.dataset.scale }));
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Mosaic scale' }, bFit, bTrue);
  const mosaicGroup = h('div', { class: 'con-group con-mosaic' }, cellKnob.el, seg);

  // ------------------------------------------------------------------ z filter
  const zf = createZFilter(app);

  // ------------------------------------------------------------------ knobs
  const gain = createKnob({
    label: 'Gain',
    glyph: 'sun',
    min: 0.1, max: 10, value: store.get().render.gain, def: 1, log: true,
    format: (v) => `${v.toFixed(2)}×`,
    onInput: (v) => actions.setRender({ gain: v }),
  });
  const size = createKnob({
    label: 'Point size',
    glyph: 'dot',
    min: 0.5, max: 8, value: store.get().render.pointSize, def: 2, log: true,
    format: (v) => `${v.toFixed(1)} px`,
    onInput: (v) => actions.setRender({ pointSize: v }),
  });

  // ------------------------------------------------------------------ toggles
  const tog = (name, ic, title, sub, key, onClick) => {
    const b = h('button', { class: `tog ibtn tog-${name}`, type: 'button', 'aria-label': title, 'aria-pressed': 'false', html: icon(ic) });
    setTip(b, { title, sub, key }, 'top');
    b.addEventListener('click', onClick);
    return b;
  };
  const tTrends = tog('trends', 'trends', 'Trends', 'Running medians (16–84% band), split by the color variable', 'T',
    () => actions.setOverlay('trends', !store.get().overlays.trends));
  const tLit = tog('lit', 'book', 'Literature', 'Published relations, drawn where the axes match theirs', 'B',
    () => actions.setOverlay('literature', !store.get().overlays.literature));
  const tLasso = tog('lasso', 'lasso', 'Lasso', 'Draw to select; shift adds, alt subtracts. The selection follows every rotation', 'L',
    () => actions.setTool(store.get().tool === 'lasso' ? 'pan' : 'lasso'));
  const bReset = h('button', { class: 'tog ibtn', type: 'button', 'aria-label': 'Reset the view', html: icon('reset') });
  setTip(bReset, { title: 'Reset', sub: 'Clear the z and color-value filters and return to the current canonical view', key: 'R' }, 'top');
  bReset.addEventListener('click', () => actions.resetView());
  const bShare = h('button', { class: 'tog ibtn tog-share', type: 'button', 'aria-label': 'Copy a link to this view', html: icon('link') });
  setTip(bShare, { title: 'Share', sub: 'Copy a link to this exact view' }, 'top');
  // inside an Artifact only a bare #anchor survives the link, so a view link cannot work
  if (data.manifest?.host?.shareLinks === false) bShare.hidden = true;
  bShare.addEventListener('click', async () => {
    const ok = await ui.url?.copyLink();
    bShare.classList.remove('copied', 'failed');
    void bShare.offsetWidth;
    bShare.classList.add(ok ? 'copied' : 'failed');
    bShare.innerHTML = icon(ok ? 'check' : 'link');
    setTimeout(() => {
      bShare.classList.remove('copied', 'failed');
      bShare.innerHTML = icon('link');
    }, 1400);
  });

  const sep = () => h('i', { class: 'con-sep', 'aria-hidden': 'true' });
  const bar = h('div', { class: 'con' },
    h('div', { class: 'con-group con-mode' }, rocker),
    sep(),
    colorGroup,
    h('div', { class: 'con-spacer' }),
    mosaicGroup,
    zf ? h('div', { class: 'con-group con-z' }, zf.el) : null,
    sep(),
    h('div', { class: 'con-group con-knobs' }, gain.el, size.el),
    sep(),
    h('div', { class: 'con-group con-toggles' }, tTrends, tLit, tLasso, h('i', { class: 'con-sep sm', 'aria-hidden': 'true' }), bReset, bShare));
  mount.append(bar);

  // ------------------------------------------------------------------ state sync
  function sync(changed) {
    const s = store.get();
    const all = !changed;
    if (all || changed.includes('mode')) {
      rocker.dataset.mode = s.mode;
      bGlow.setAttribute('aria-pressed', s.mode === 'glow' ? 'true' : 'false');
      bMosaic.setAttribute('aria-pressed', s.mode === 'mosaic' ? 'true' : 'false');
      bar.classList.toggle('mosaic', s.mode === 'mosaic');
    }
    if (all || changed.includes('color')) syncColor();
    if (all || changed.includes('filters')) {
      syncChips();
      syncPills();
      syncNeed();
    }
    if (all || changed.includes('overlays')) {
      tTrends.setAttribute('aria-pressed', s.overlays.trends ? 'true' : 'false');
      tLit.setAttribute('aria-pressed', s.overlays.literature ? 'true' : 'false');
    }
    if (all || changed.includes('tool')) tLasso.setAttribute('aria-pressed', s.tool === 'lasso' ? 'true' : 'false');
    if (all || changed.includes('render')) {
      gain.set(s.render.gain);
      size.set(s.render.pointSize);
    }
    if (all || changed.includes('mosaic')) {
      cellKnob.set(s.mosaic.cell);
      bFit.setAttribute('aria-pressed', s.mosaic.scale !== 'true' ? 'true' : 'false');
      bTrue.setAttribute('aria-pressed', s.mosaic.scale === 'true' ? 'true' : 'false');
    }
  }
  app.events.on('state', ({ changed }) => sync(changed));
  sync();

  return {
    dial,
    openColor: () => openColorPopover(app, dial),
    closeColor: closeColorPopover,
  };
}
