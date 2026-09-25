// Inspector drawer (DESIGN.md §13.6).
//  · One galaxy: a hot-linked Legacy Survey image (ls-dr9, falling back to sdss) with a
//    physical scale bar, category chips, icon links (SkyServer, Legacy viewer, spectrum) and a
//    percentile strip for every dimension.
//  · Selection: the count, a gallery of up to 48 thumbnails (most typical first), and strips
//    that overlay the selection's distribution against everyone's.
// Also mounts the inspected-galaxy reticle on the stage and the selection tab that reopens
// the drawer.

import { h, s, fmtInt, fmtPct, clamp, isNarrow } from './dom.js';
import { icon } from './icons.js';
import { setTip } from './tooltip.js';
import { groupedDims, dimTitle, chipFor, catToken, GROUP_NAMES, shortKids } from './uiconfig.js';
import { kpcPerArcsec } from '../math/cosmo.js';
import { CATEGORY_COLORS, NEUTRAL } from '../config/style.js';
import { FADE_WIDTH } from '../math/frame.js';

const IMG_PX = 256, PIXSCALE = 0.262;
const LS = 'https://www.legacysurvey.org/viewer';
const SAMPLE_MAX = 30000;
const BINS = 40;
const GALLERY_MAX = 48;

function ord(p) {
  const n = Math.round(p);
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return `${n}${s}`;
}

/**
 * Percentile (0–100) of physical x as the CDF of the piecewise-linear quantile function of the
 * manifest's 101-point table. Tied quantiles (values on a grid, e.g. T04 O/H) become jumps.
 */
function cdfPct(q, x) {
  const n = q ? q.length : 0;
  if (n < 2 || !(x === x)) return NaN;
  if (x < q[0]) return 0;
  if (x >= q[n - 1]) return 100;
  let lo = 0, hi = n - 1;   // last index with q[lo] <= x
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (q[mid] <= x) lo = mid; else hi = mid;
  }
  const a = q[lo], b = q[lo + 1];
  return (lo + (b > a ? (x - a) / (b - a) : 0)) * (100 / (n - 1));
}

/**
 * Percentile interval [lo, hi] covered by raw code v (the code spans half a quantization step
 * either side of its value). Continuous data gives a sliver; a grid value spans its whole tie.
 */
function pctRange(d, v) {
  return [cdfPct(d.quantiles, d.min + (v - 1.5) * d.step), cdfPct(d.quantiles, d.min + (v - 0.5) * d.step)];
}

export function initInspector(app, mount, ui) {
  const { data, store, actions, config } = app;
  const groups = groupedDims(data.dims);
  mount.replaceChildren();

  // ------------------------------------------------------------------ frame
  const bBack = h('button', { class: 'ibtn insp-back', type: 'button', 'aria-label': 'Back to the selection', html: icon('back') });
  const kind = h('span', { class: 'insp-kind' });
  const ident = h('span', { class: 'insp-id' });
  const links = h('div', { class: 'insp-links' });
  const bClose = h('button', { class: 'ibtn insp-close', type: 'button', 'aria-label': 'Close the inspector', html: icon('close') });
  setTip(bBack, { title: 'Back to the selection' }, 'bottom');
  setTip(bClose, { title: 'Close', key: 'Esc' }, 'bottom');
  const head = h('header', { class: 'insp-head' }, bBack, h('div', { class: 'insp-title' }, kind, ident), links, bClose);
  const body = h('div', { class: 'insp-body' });
  const grip = h('i', { class: 'insp-grip', 'aria-hidden': 'true' });
  const panel = h('div', { class: 'insp' }, grip, head, body);
  mount.append(panel);

  bBack.addEventListener('click', () => actions.inspect(null));
  bClose.addEventListener('click', () => {
    if (view === 'galaxy') {
      actions.inspect(null);
      if (store.get().selection) setOpen(false);
    } else setOpen(false);
  });

  let view = 'none';        // 'galaxy' | 'selection' | 'none'
  let openState = false;
  function setOpen(on) {
    openState = !!on;
    mount.classList.toggle('open', openState);
    mount.setAttribute('aria-hidden', openState ? 'false' : 'true');
    if (!isNarrow()) app.camera.setSafeArea({ right: openState ? mount.offsetWidth + 28 : 28 });
    tab.classList.toggle('on', !openState && !!store.get().selection);
  }
  mount.setAttribute('aria-hidden', 'true');

  /** Close the drawer entirely (a galaxy view is dropped; a selection stays, behind its tab). */
  function dismiss() {
    const wasGalaxy = view === 'galaxy';
    setOpen(false);
    if (wasGalaxy) actions.inspect(null);
  }

  // phone bottom sheet: drag the grip or the header down to dismiss it
  let sheet = null;
  function sheetDown(e) {
    if (!isNarrow() || !openState || e.target.closest('button, a')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    sheet = { id: e.pointerId, y0: e.clientY, y: e.clientY, t: performance.now(), v: 0, el: e.currentTarget };
    try { sheet.el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    mount.classList.add('sheet-drag');
  }
  function sheetMove(e) {
    if (!sheet || e.pointerId !== sheet.id) return;
    const now = performance.now();
    sheet.v = (e.clientY - sheet.y) / Math.max(1, now - sheet.t);
    sheet.y = e.clientY;
    sheet.t = now;
    const dy = Math.max(0, e.clientY - sheet.y0);
    mount.style.transform = dy > 0 ? `translateY(${dy.toFixed(1)}px)` : '';
  }
  function sheetUp(e) {
    if (!sheet || e.pointerId !== sheet.id) return;
    const dy = Math.max(0, e.clientY - sheet.y0);
    const fling = sheet.v > 0.6 && dy > 24;
    sheet = null;
    mount.classList.remove('sheet-drag');
    mount.style.transform = '';
    if (e.type === 'pointerup' && (dy > 96 || fling)) dismiss();
  }
  for (const el of [grip, head]) {
    el.addEventListener('pointerdown', sheetDown);
    el.addEventListener('pointermove', sheetMove);
    el.addEventListener('pointerup', sheetUp);
    el.addEventListener('pointercancel', sheetUp);
  }

  /**
   * Pan the camera (gently) so galaxy row i is not hidden under the open drawer (desktop) or
   * the bottom sheet (phone). Skipped while the tour or an animation is driving the camera.
   */
  function reveal(i) {
    if (!app.data.loaded || i == null || store.get().tour.playing || app.camera.animating) return;
    const cam = app.camera;
    const [X, Y] = app.proj.projectRow(i, app.frame);
    const [sx, sy] = cam.toScreen(X, Y);
    if (!Number.isFinite(sx) || !Number.isFinite(sy)) return;
    let dx = 0, dy = 0;
    if (isNarrow()) {
      const st = app.layers.stage.getBoundingClientRect();
      const sheetTop = window.innerHeight - (mount.offsetHeight || 0) - st.top;   // stage px
      const limit = sheetTop - 36;
      if (sy > limit && sy < cam.height + 200) dy = sy - Math.max(44, Math.min(limit - 24, sheetTop * 0.55));
    } else {
      const limit = cam.width - (mount.offsetWidth || 340) - 40;
      if (sx > limit && sx < cam.width + 200) dx = sx - (limit - 36);
    }
    if (!dx && !dy) return;
    cam.set({ cx: cam.cx + dx / cam.scaleX, cy: cam.cy - dy / cam.scaleY }, { duration: 520 * app.motion.scale() });
  }

  /**
   * Pan so the bulk (2–98 %) of the selection is not hidden by the drawer or the phone sheet,
   * as far as that is possible without pushing its other edge off the stage.
   */
  function revealMask(mask) {
    if (!app.data.loaded || !mask || store.get().tour.playing || app.camera.animating) return;
    const cam = app.camera, F = app.frame, vis = app.proj.vis;
    const narrow = isNarrow();
    const vals = [];
    for (let i = 0; i < mask.length && vals.length < 4000; i++) {
      if (!mask[i] || (vis && vis[i] < 128)) continue;
      const [X, Y] = app.proj.projectRow(i, F);
      const p = cam.toScreen(X, Y);
      vals.push(narrow ? p[1] : p[0]);
    }
    if (vals.length < 5) return;
    vals.sort((a, b) => a - b);
    const lo = vals[Math.floor(0.02 * (vals.length - 1))], hi = vals[Math.floor(0.98 * (vals.length - 1))];
    let limit, room;
    if (narrow) {
      const st = app.layers.stage.getBoundingClientRect();
      limit = window.innerHeight - (mount.offsetHeight || 0) - st.top - 24;
      room = lo - 36;
    } else {
      limit = cam.width - (mount.offsetWidth || 340) - 40;
      room = lo - 90;   // keep clear of the y ruler
    }
    if (hi <= limit) return;
    const d = Math.min(hi - limit, Math.max(0, room));
    if (d < 8) return;
    const dur = 520 * app.motion.scale();
    if (narrow) cam.set({ cy: cam.cy - d / cam.scaleY }, { duration: dur });
    else cam.set({ cx: cam.cx + d / cam.scaleX }, { duration: dur });
  }

  // selection tab on the stage edge (reopens the drawer)
  const tab = h('button', { class: 'sel-tab', type: 'button', 'aria-label': 'Show the selection' },
    h('span', { class: 'sel-tab-i', html: icon('lasso') }), h('b'));
  setTip(tab, { title: 'Selection', sub: 'Open the selection inspector' }, 'left');
  tab.addEventListener('click', () => {
    showSelection();
    setOpen(true);
    revealMask(store.get().selection?.mask);
  });
  app.layers.stageUI.append(tab);

  // ------------------------------------------------------------------ single galaxy
  let gal = null;   // {i, img, ...}
  function linkBtn(ic, label, href) {
    const a = h('a', { class: 'ibtn insp-link', href: href || '#', target: '_blank', rel: 'noopener noreferrer', 'aria-label': label, html: icon(ic) });
    if (!href) a.classList.add('off');
    setTip(a, { title: label }, 'bottom');
    return a;
  }

  function galaxyLinks(i) {
    links.replaceChildren();
    const m = data.metaRow(i);
    const ok = m && Number.isFinite(m.ra) && Number.isFinite(m.dec);
    const ra = ok ? m.ra.toFixed(6) : '', dec = ok ? m.dec.toFixed(6) : '';
    links.append(
      linkBtn('sphere', 'SkyServer explorer', ok ? `https://skyserver.sdss.org/dr17/VisualTools/explore/summary?ra=${ra}&dec=${dec}` : null),
      linkBtn('viewer', 'Legacy Survey viewer', ok ? `${LS}?ra=${ra}&dec=${dec}&layer=ls-dr9&zoom=15&mark=${ra},${dec}` : null),
      linkBtn('spectrum', 'SDSS spectrum', m && m.plate > 0 ? `https://dr17.sdss.org/optical/spectrum/view?plateid=${m.plate}&mjd=${m.mjd}&fiberid=${m.fiber}` : null),
    );
  }

  function thumbImg(k) {
    const img = h('img', { alt: '', decoding: 'async', draggable: 'false' });
    app.thumbs.assign(img, k);
    return img;
  }

  /** Scale bar for an image of `fieldArcsec` shown `dispPx` wide (default: the hot-linked cutout). */
  function scaleBar(z, dispPx, fieldArcsec = IMG_PX * PIXSCALE) {
    const kpa = kpcPerArcsec(z);
    if (!(kpa > 0 && fieldArcsec > 0)) return null;
    const pxPerKpc = dispPx / (fieldArcsec * kpa);
    const choices = [1, 2, 5, 10, 20, 50, 100, 200];
    let L = choices.find((c) => c * pxPerKpc >= 44) || choices[choices.length - 1];
    if (L * pxPerKpc > 130) L = choices[Math.max(0, choices.indexOf(L) - 1)];
    return { L, px: L * pxPerKpc };
  }

  function imageBlank(img) {
    try {
      const c = document.createElement('canvas');
      c.width = 24;
      c.height = 24;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0, 24, 24);
      const px = g.getImageData(0, 0, 24, 24).data;
      let sum = 0, mx = 0;
      for (let k = 0; k < px.length; k += 4) {
        const v = px[k] + px[k + 1] + px[k + 2];
        sum += v;
        mx = Math.max(mx, v);
      }
      return sum / (px.length / 4) < 6 && mx < 60;
    } catch {
      return false;   // tainted (no CORS) → assume it has data
    }
  }

  function buildImage(i) {
    const frame = h('div', { class: 'gimg loading' });
    const z = data.value(i, 'z');
    const disp = Math.min(300, (mount.clientWidth || 340) - 40);
    // Artifact hosting blocks hot-linked images: show the galaxy's own thumbnail instead
    const localOnly = data.manifest?.host?.externalImages === false;
    const kThumb = localOnly && app.thumbs?.available ? app.thumbs.forRow(i) : -1;
    const field = kThumb >= 0 ? app.thumbs.crop(kThumb) : IMG_PX * PIXSCALE;
    const sb = Number.isFinite(z) && (!localOnly || kThumb >= 0) ? scaleBar(z, disp, field) : null;
    const bar = sb ? h('div', { class: 'gimg-bar', style: { '--w': `${sb.px.toFixed(1)}px` } }, h('i'), h('span', { text: `${sb.L} kpc` })) : null;
    if (bar) setTip(bar, { title: `${sb.L} kpc at z = ${z.toFixed(4)}`, meta: `${kpcPerArcsec(z).toFixed(3)} kpc/″ · ${field.toFixed(0)}″ field` }, 'top');
    const reticle = h('div', { class: 'gimg-ret', 'aria-hidden': 'true' });
    const layers = h('div', { class: 'gimg-layers', role: 'group', 'aria-label': 'Image layer' });
    const bDR9 = h('button', { type: 'button', class: 'on', text: 'DR9' });
    const bSDSS = h('button', { type: 'button', text: 'SDSS' });
    setTip(bDR9, { title: 'Legacy Surveys DR9', sub: 'g r z, deeper' }, 'bottom');
    setTip(bSDSS, { title: 'SDSS', sub: 'g r i' }, 'bottom');
    layers.append(bDR9, bSDSS);
    const img = h('img', { alt: 'Image cutout of the galaxy', width: String(disp), height: String(disp), decoding: 'async', draggable: 'false' });
    img.crossOrigin = 'anonymous';
    const status = h('span', { class: 'gimg-status', html: icon('image') });
    frame.append(img, reticle, status);
    if (!localOnly) frame.append(layers);
    if (bar) frame.append(bar);
    frame.style.setProperty('--size', `${disp}px`);

    let layer = null, token = 0;
    function loadLocal() {
      frame.classList.remove('failed', 'ready');
      if (kThumb < 0) {
        frame.classList.remove('loading');
        frame.classList.add('failed');
        return;
      }
      img.onload = () => {
        frame.classList.remove('loading');
        frame.classList.add('ready');
      };
      img.onerror = () => {
        frame.classList.remove('loading');
        frame.classList.add('failed');
        status.innerHTML = icon('broken');
      };
      app.thumbs.assign(img, kThumb);
    }
    function load(which, auto) {
      if (localOnly) return loadLocal();
      const m = data.metaRow(i);
      if (!m || !Number.isFinite(m.ra)) {
        frame.classList.add('loading');
        return;
      }
      layer = which;
      bDR9.classList.toggle('on', which === 'ls-dr9');
      bSDSS.classList.toggle('on', which === 'sdss');
      const my = ++token;
      frame.classList.add('loading');
      frame.classList.remove('failed', 'ready');
      img.onload = () => {
        if (my !== token) return;
        if (which === 'ls-dr9' && auto && imageBlank(img)) {
          load('sdss', false);
          return;
        }
        frame.classList.remove('loading');
        frame.classList.add('ready');
      };
      img.onerror = () => {
        if (my !== token) return;
        if (which === 'ls-dr9' && auto) {
          load('sdss', false);
          return;
        }
        frame.classList.remove('loading');
        frame.classList.add('failed');
        status.innerHTML = icon('broken');
      };
      img.src = `${LS}/cutout.jpg?ra=${m.ra.toFixed(6)}&dec=${m.dec.toFixed(6)}&layer=${which}&pixscale=${PIXSCALE}&size=${IMG_PX}`;
    }
    bDR9.addEventListener('click', () => layer !== 'ls-dr9' && load('ls-dr9', false));
    bSDSS.addEventListener('click', () => layer !== 'sdss' && load('sdss', false));
    return { frame, load };
  }

  /** Category readout: one engraved cell per category (token above, swatch + class below). */
  function catChips(i) {
    const row = h('div', { class: 'gcats', style: { '--n': String(data.categories.length) } });
    for (const spec of data.categories) {
      const code = data.catCode(i, spec.key);
      const e = spec.codes.find((c) => c.code === code);
      const col = e ? (CATEGORY_COLORS[spec.key]?.[code] || e.color || NEUTRAL) : 'var(--cream-3)';
      const cell = h('div', { class: `gcat${e ? '' : ' nil'}${e && chipFor(spec, code).hollow ? ' hollow' : ''}`, style: { '--cc': col } },
        h('b', { text: catToken(spec) }),
        h('span', { class: 'gcat-v' }, h('i', { 'aria-hidden': 'true' }), h('span', { text: e ? e.label : '∅' })));
      setTip(cell, { title: spec.label, sub: e ? e.name : 'no class (unmatched)', swatch: e ? col : null }, 'top');
      row.append(cell);
    }
    return row;
  }

  function galaxyStrips(i) {
    const wrap = h('div', { class: 'strips' });
    for (const g of groups) {
      const blk = h('div', { class: 'strip-group', style: { '--gc': g.color } });
      for (const d of g.dims) {
        const x = data.value(i, d.key);
        const raw = data.raw[d.index] ? data.raw[d.index][i] : 0;
        const pr = raw ? pctRange(d, raw) : [NaN, NaN];
        const p = (pr[0] + pr[1]) / 2;
        const ok = Number.isFinite(x) && Number.isFinite(p);
        const row = h('div', { class: `strip${ok ? '' : ' nil'}` },
          h('span', { class: 'strip-k' }, shortKids(d.short)),
          h('span', { class: 'strip-track' }, h('i', { class: 'strip-mid' }), ok ? h('i', { class: 'strip-dot', style: { left: `${clamp(p, 0, 100)}%` } }) : null),
          h('span', { class: 'strip-v', text: ok ? config.dims.format(d.key, x) : '–' }));
        setTip(row, {
          title: dimTitle(d),
          meta: ok ? `${config.dims.format(d.key, x, { unit: true, spec: d })} · ${ord(p)} percentile` : 'not measured for this galaxy',
        }, 'left');
        blk.append(row);
      }
      wrap.append(blk);
    }
    return wrap;
  }

  function showGalaxy(i) {
    view = 'galaxy';
    panel.dataset.view = 'galaxy';
    kind.textContent = 'GALAXY';
    const m = data.metaRow(i);
    ident.textContent = m && m.plate > 0 ? `${String(m.plate).padStart(4, '0')}-${m.mjd}-${String(m.fiber).padStart(3, '0')}` : `#${i}`;
    setTip(ident, () => {
      const mm = data.metaRow(i);
      return {
        title: mm && mm.plate > 0 ? 'plate-mjd-fiber' : 'row',
        meta: mm && Number.isFinite(mm.ra) ? `α ${mm.ra.toFixed(5)}°  δ ${mm.dec >= 0 ? '+' : '−'}${Math.abs(mm.dec).toFixed(5)}°  · row ${i}` : `row ${i}`,
      };
    }, 'bottom');
    bBack.hidden = !store.get().selection;
    galaxyLinks(i);
    const im = buildImage(i);
    body.replaceChildren(im.frame, catChips(i), galaxyStrips(i));
    body.scrollTop = 0;
    gal = { i, im };
    if (data.meta.loaded) im.load('ls-dr9', true);
    else data.meta.ready.then(() => {
      if (gal && gal.i === i) {
        galaxyLinks(i);
        const mm = data.metaRow(i);
        if (mm && mm.plate > 0) ident.textContent = `${String(mm.plate).padStart(4, '0')}-${mm.mjd}-${String(mm.fiber).padStart(3, '0')}`;
        im.load('ls-dr9', true);
      }
    });
  }

  // ------------------------------------------------------------------ selection
  let selJob = 0;
  let selCache = null;   // {mask, stats}

  function sampleRows(mask) {
    const rows = [];
    for (let i = 0; i < mask.length && rows.length < SAMPLE_MAX; i++) if (mask[i]) rows.push(i);
    return rows;
  }

  /** Per-dim histogram in percentile space (40 bins) + median, computed in slices. */
  async function selectionStats(mask, job) {
    const rows = sampleRows(mask);
    const out = new Map();
    const mu = new Float64Array(data.D).fill(NaN);
    const BW = 100 / BINS;
    for (const d of data.dims) {
      if (job !== selJob) return null;
      const raw = data.raw[d.index];
      if (!raw) continue;
      // Each galaxy's unit mass is spread over the percentile interval its raw code covers,
      // so values on a grid (T04 O/H) fill their tied percentiles instead of spiking one bin.
      const counts = new Float64Array(BINS);
      const memo = new Map();
      let nv = 0, su = 0;
      for (let k = 0; k < rows.length; k++) {
        const v = raw[rows[k]];
        if (v === 0) continue;
        nv++;
        su += v * d.ua + d.ub;
        let pr = memo.get(v);
        if (!pr) {
          pr = pctRange(d, v);
          if (memo.size < 4096) memo.set(v, pr);
        }
        const [pa, pb] = pr;
        const b0 = Math.min(BINS - 1, Math.max(0, Math.floor(pa / BW)));
        const b1 = Math.min(BINS - 1, Math.max(0, Math.floor(pb / BW)));
        if (b1 <= b0 || !(pb - pa > 1e-9)) {
          counts[b0] += 1;
          continue;
        }
        const w = 1 / (pb - pa);
        for (let b = b0; b <= b1; b++) counts[b] += (Math.min(pb, (b + 1) * BW) - Math.max(pa, b * BW)) * w;
      }
      let pmed = NaN;
      if (nv > 0) {
        mu[d.index] = su / nv;
        let acc = 0;
        for (let b = 0; b < BINS; b++) {
          if (acc + counts[b] >= nv / 2) {
            pmed = ((b + (nv / 2 - acc) / Math.max(1e-9, counts[b])) * 100) / BINS;
            break;
          }
          acc += counts[b];
        }
      }
      const q = (target) => {
        let acc = 0;
        for (let b = 0; b < BINS; b++) {
          if (acc + counts[b] >= target) return ((b + (target - acc) / Math.max(1e-9, counts[b])) * 100) / BINS;
          acc += counts[b];
        }
        return 100;
      };
      out.set(d.key, { counts, nv, pmed, p16: nv ? q(0.16 * nv) : NaN, p84: nv ? q(0.84 * nv) : NaN });
      // yield between dimensions so a big selection never blocks a frame for long
      if (d.index % 5 === 4) await new Promise((r) => setTimeout(r, 0));
    }
    return { rows, out, mu };
  }

  function typicalThumbs(mask, mu) {
    const rows = data.thumbRows;
    if (!rows || !rows.length) return [];
    const cand = [];
    for (let k = 0; k < rows.length; k++) {
      const r = rows[k];
      if (!mask[r]) continue;
      let s2 = 0, c = 0;
      for (const d of data.dims) {
        const m = mu[d.index];
        if (!(m === m)) continue;
        const v = data.raw[d.index][r];
        if (v === 0) continue;
        const u = v * d.ua + d.ub;
        s2 += (u - m) * (u - m);
        c++;
      }
      if (c >= 4) cand.push([s2 / c, k, r]);
    }
    cand.sort((a, b) => a[0] - b[0]);
    return cand.slice(0, GALLERY_MAX);
  }

  function selStrip(d, st) {
    const row = h('div', { class: `strip sel${st && st.nv ? '' : ' nil'}` });
    const W = 100, H = 18;
    let path = '';
    if (st && st.nv) {
      const base = H - 1;
      const k = 5.2;   // px per unit density (uniform = 1)
      path = `M0 ${base}`;
      for (let b = 0; b < BINS; b++) {
        const dens = (st.counts[b] / st.nv) * BINS;
        const y = base - Math.min(H - 2, dens * k);
        path += `L${((b * W) / BINS).toFixed(2)} ${y.toFixed(2)}L${(((b + 1) * W) / BINS).toFixed(2)} ${y.toFixed(2)}`;
      }
      path += `L${W} ${base}Z`;
    }
    const svg = s('svg', { class: 'strip-hist', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' },
      s('line', { class: 'strip-all', x1: '0', x2: String(W), y1: String(H - 1 - 5.2), y2: String(H - 1 - 5.2) }),
      path ? s('path', { class: 'strip-area', d: path }) : null,
      st && Number.isFinite(st.pmed) ? s('line', { class: 'strip-med', x1: String(st.pmed), x2: String(st.pmed), y1: '1', y2: String(H - 1) }) : null);
    const med = st && Number.isFinite(st.pmed) ? data.quantile(d.key, st.pmed) : NaN;
    row.append(h('span', { class: 'strip-k' }, shortKids(d.short)), h('span', { class: 'strip-track tall' }, svg),
      h('span', { class: 'strip-v', text: Number.isFinite(med) ? config.dims.format(d.key, med) : '–' }));
    setTip(row, () => {
      if (!st || !st.nv) return { title: dimTitle(d), meta: 'not measured for this selection' };
      const lo = data.quantile(d.key, st.p16), hi = data.quantile(d.key, st.p84);
      return {
        title: dimTitle(d),
        sub: 'Selection (filled) against everyone (dashed = uniform in percentile)',
        meta: `median ${config.dims.format(d.key, med)} (${ord(st.pmed)} pct) · 16–84%: ${config.dims.format(d.key, lo)} … ${config.dims.format(d.key, hi)} · ${fmtInt(st.nv)} measured`,
      };
    }, 'left');
    return row;
  }

  function showSelection() {
    const sel = store.get().selection;
    if (!sel) {
      view = 'none';
      return;
    }
    view = 'selection';
    panel.dataset.view = 'selection';
    kind.textContent = 'SELECTION';
    ident.textContent = '';
    setTip(ident, null);
    links.replaceChildren();
    bBack.hidden = true;
    const bClear = h('button', { class: 'ibtn sel-clear', type: 'button', 'aria-label': 'Clear the selection', html: icon('clear') });
    setTip(bClear, { title: 'Clear the selection', key: 'Esc' }, 'bottom');
    bClear.addEventListener('click', () => actions.select(null));
    links.append(bClear);

    let inView = 0;
    const vis = app.proj?.vis;
    if (vis && !app.proj.stale) for (let i = 0; i < vis.length; i++) if (vis[i] >= 128) inView++;
    const count = h('div', { class: 'sel-count' },
      h('b', { text: fmtInt(sel.count) }),
      h('span', { text: inView ? fmtPct(sel.count / inView) : '' }));
    setTip(count, { title: `${fmtInt(sel.count)} galaxies selected`, meta: inView ? `${fmtPct(sel.count / inView)} of the ${fmtInt(inView)} in view` : '' }, 'bottom');
    const gallery = h('div', { class: 'sel-gallery' });
    const strips = h('div', { class: 'strips' });
    for (const g of groups) {
      const blk = h('div', { class: 'strip-group', style: { '--gc': g.color } });
      for (const d of g.dims) blk.append(selStrip(d, null));
      strips.append(blk);
    }
    body.replaceChildren(count, gallery, strips);
    body.scrollTop = 0;
    panel.classList.add('computing');

    const job = ++selJob;
    const mask = sel.mask;
    const finish = (res) => {
      if (job !== selJob || !res) return;
      panel.classList.remove('computing');
      selCache = { mask, res };
      // strips
      strips.replaceChildren();
      for (const g of groups) {
        const blk = h('div', { class: 'strip-group', style: { '--gc': g.color } });
        for (const d of g.dims) blk.append(selStrip(d, res.out.get(d.key)));
        strips.append(blk);
      }
      // gallery (most typical first)
      const best = app.thumbs && app.thumbs.available ? typicalThumbs(mask, res.mu) : [];
      gallery.replaceChildren();
      gallery.classList.toggle('empty', !best.length);
      best.forEach(([, k, r], n) => {
        const b = h('button', { class: 'sel-thumb', type: 'button', 'aria-label': `Inspect galaxy ${n + 1}`, style: { '--n': String(n) } },
          thumbImg(k));
        b.addEventListener('click', () => actions.inspect(r));
        b.addEventListener('pointerenter', () => peekAt(r));
        b.addEventListener('pointerleave', () => peekAt(null));
        b.addEventListener('focus', () => peekAt(r));
        b.addEventListener('blur', () => peekAt(null));
        setTip(b, () => galaxyTip(r), 'left');
        b.dataset.tipDelay = '350';
        gallery.append(b);
      });
    };
    if (selCache && selCache.mask === mask) finish(selCache.res);
    else selectionStats(mask, job).then(finish);
  }

  // ------------------------------------------------------------------ gallery peek
  // hovering a gallery thumbnail rings that galaxy where it sits in the current projection
  const peek = h('div', { class: 'peek-ring', 'aria-hidden': 'true' });
  app.layers.stageUI.append(peek);
  let peekRow = null;
  function placePeek() {
    if (peekRow == null || !app.data.loaded) {
      peek.classList.remove('on');
      return;
    }
    const [X, Y] = app.proj.projectRow(peekRow, app.frame);
    const [sx, sy] = app.camera.toScreen(X, Y);
    const inside = sx > -10 && sy > -10 && sx < app.camera.width + 10 && sy < app.camera.height + 10;
    peek.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`;
    peek.classList.toggle('on', inside);
  }
  function peekAt(row) {
    peekRow = row;
    placePeek();
  }
  app.events.on('render', () => { if (peekRow != null) placePeek(); });

  /** Two-line tooltip for a gallery galaxy: the current axes' values. */
  function galaxyTip(r) {
    const parts = [];
    for (const col of [0, 1]) {
      const info = app.axisInfo(col);
      if (!info || !info.single) continue;
      const x = data.value(r, info.refKey);
      parts.push(`${data.dims[info.ref].short} ${config.dims.format(info.refKey, x)}`);
    }
    const m = data.metaRow(r);
    return {
      title: m && m.plate > 0 ? `${String(m.plate).padStart(4, '0')}-${m.mjd}-${String(m.fiber).padStart(3, '0')}` : `row ${r}`,
      meta: parts.join(' · ') || null,
    };
  }

  // ------------------------------------------------------------------ reticle on the stage
  const ret = h('div', { class: 'insp-ret', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i'));
  app.layers.stageUI.append(ret);
  let retRow = null;
  function placeReticle() {
    if (retRow == null || !app.data.loaded || store.get().mode === 'mosaic') {
      ret.classList.remove('on');
      return;
    }
    const [X, Y] = app.proj.projectRow(retRow, app.frame);
    const [sx, sy] = app.camera.toScreen(X, Y);
    // fade like the glow does when a dimension this galaxy lacks rotates in
    let v = 1;
    const F = app.frame, D = data.D;
    for (const d of data.dims) {
      if (data.raw[d.index] && data.raw[d.index][retRow] === 0) {
        const w = Math.hypot(F[d.index], F[D + d.index]);
        v *= clamp(1 - w / FADE_WIDTH, 0, 1);
      }
    }
    const inside = sx > -20 && sy > -20 && sx < app.camera.width + 20 && sy < app.camera.height + 20;
    ret.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`;
    ret.style.opacity = inside ? v.toFixed(2) : '0';
    ret.classList.add('on');
  }
  app.events.on('render', placeReticle);

  // ------------------------------------------------------------------ wiring
  app.events.on('inspect', ({ index }) => {
    retRow = index;
    placeReticle();
    if (index != null) {
      showGalaxy(index);
      setOpen(true);
      reveal(index);
      return;
    }
    gal = null;
    if (store.get().selection) {
      showSelection();
      if (view === 'selection' && openState) setOpen(true);
    } else {
      view = 'none';
      setOpen(false);
    }
  });
  app.events.on('select', ({ count }) => {
    tab.querySelector('b').textContent = count ? fmtInt(count) : '';
    if (count) {
      if (view !== 'galaxy') {
        showSelection();
        setOpen(true);
        revealMask(store.get().selection?.mask);
      } else bBack.hidden = false;
    } else {
      selCache = null;
      selJob++;
      if (view === 'selection') {
        view = 'none';
        setOpen(false);
      }
      bBack.hidden = true;
      tab.classList.remove('on');
    }
  });
  app.events.on('data:meta', () => {
    if (gal) galaxyLinks(gal.i);
  });
  window.addEventListener('resize', () => {
    if (!isNarrow()) app.camera.setSafeArea({ right: openState ? mount.offsetWidth + 28 : 28 });
  });

  return {
    get open() {
      return openState;
    },
    get view() {
      return view;
    },
    close() {
      if (view === 'galaxy') actions.inspect(null);
      else setOpen(false);
    },
    setOpen,
  };
}
