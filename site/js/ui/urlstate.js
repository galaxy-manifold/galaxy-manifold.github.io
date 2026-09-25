// URL hash state (DESIGN.md §13.9). The hash encodes the view so a link restores it:
//   p   preset id (when the frame is that preset's view)   · f  frame (base64url int16)
//   pp  the last preset, when the frame has drifted from it (keeps its cartridge and Reset)
//   c   color key ('-' = none)   · cv 1 = only galaxies with a color value   · m  mode
//   z   lo,hi   · k  category masks (bpt:7f,…)
//   o   overlays that are on (t l a; omitted = all)   · v  camera bounds x0,x1,y0,y1 (u)
//   g   inspected row   · r  gain,pointSize   · mc  mosaic cell,scale
//   ts  tour set   · sp  tour speed
// Restored during initUI (before the columns load, so the first paint is the linked view);
// written with a debounced history.replaceState on every change.

import { debounce } from './dom.js';

const OVERLAY_KEYS = { t: 'trends', l: 'literature', a: 'axes' };

function b64urlEncode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const b = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

export function encodeFrame(F) {
  const q = new Int16Array(F.length);
  for (let i = 0; i < F.length; i++) q[i] = Math.max(-32767, Math.min(32767, Math.round(F[i] * 32767)));
  return b64urlEncode(new Uint8Array(q.buffer));
}

export function decodeFrame(str, D) {
  try {
    const bytes = b64urlDecode(str);
    if (bytes.length !== 4 * D) return null;
    const q = new Int16Array(bytes.buffer, bytes.byteOffset, 2 * D);
    return Float64Array.from(q, (v) => v / 32767);
  } catch {
    return null;
  }
}

const num = (x, d = 4) => {
  const s = (+x).toFixed(d).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
};

export function initUrlState(app, ui) {
  const { data, store, actions, camera } = app;
  let restoring = false;
  let lastWritten = '';
  let inspectAfterLoad = null;
  let defaultTour = (app.config.dims.tourDefault || []).filter((key) => data.dimIndex(key) >= 0);
  if (defaultTour.length < 2) defaultTour = data.dims.slice(0, 6).map((d) => d.key);

  // ------------------------------------------------------------------ encode
  function encode() {
    const s = store.get();
    const P = new URLSearchParams();
    const pid = s.presetId;
    if (pid && app.presetAlignment(pid) > 0.9995) P.set('p', pid);
    else {
      P.set('f', encodeFrame(app.frame));
      if (pid) P.set('pp', pid);
    }
    P.set('c', s.color == null ? '-' : s.color);
    if (s.filters.needColor) P.set('cv', '1');
    if (s.mode === 'mosaic') P.set('m', 'mosaic');
    if (s.filters.z) P.set('z', `${num(s.filters.z[0], 4)},${num(s.filters.z[1], 4)}`);
    const k = [];
    for (const [cat, m] of Object.entries(s.filters.cats || {})) if ((m & 0xff) !== 0xff) k.push(`${cat}:${(m & 0xff).toString(16).padStart(2, '0')}`);
    if (k.length) P.set('k', k.join(','));
    const on = Object.entries(OVERLAY_KEYS).filter(([, n]) => s.overlays[n] !== false).map(([c]) => c).join('');
    if (on !== 'tla') P.set('o', on || '-');
    if (data.loaded) {
      const b = camera.viewBounds();
      P.set('v', b.map((x) => num(x, 4)).join(','));
    }
    if (s.inspected != null) P.set('g', String(s.inspected));
    if (Math.abs(s.render.gain - 1) > 1e-3 || Math.abs(s.render.pointSize - 2) > 1e-3) P.set('r', `${num(s.render.gain, 3)},${num(s.render.pointSize, 2)}`);
    if (s.mosaic.cell !== 56 || s.mosaic.scale !== 'fit') P.set('mc', `${s.mosaic.cell},${s.mosaic.scale}`);
    if (s.tour.set.join(',') !== defaultTour.join(',')) P.set('ts', s.tour.set.join(','));
    if (Math.abs(s.tour.speed - 1) > 1e-3) P.set('sp', num(s.tour.speed, 3));
    return tidy(P.toString());
  }

  function tidy(q) {
    return q.replace(/%2C/gi, ',').replace(/%3A/gi, ':');
  }

  function write() {
    if (restoring) return;
    const h = encode();
    if (h === lastWritten) return;
    lastWritten = h;
    try {
      history.replaceState(history.state, '', `${location.pathname}${location.search}#${h}`);
    } catch { /* sandboxed */ }
  }
  const writeSoon = debounce(write, 380);

  // ------------------------------------------------------------------ decode + apply
  function parse(hash) {
    const raw = (hash || '').replace(/^#/, '');
    if (!raw) return null;
    const P = new URLSearchParams(raw);
    return P.toString() ? P : null;
  }

  function applyParams(P, { animate = false } = {}) {
    const dur = animate ? undefined : 0;
    const presets = app.config.presets;
    let viewSet = false;
    const pid = P.get('p');
    if (pid && presets.some((p) => p.id === pid)) {
      actions.applyPreset(pid, dur === 0 ? { duration: 0 } : {});
      viewSet = true;
    } else if (P.get('f')) {
      const F = decodeFrame(P.get('f'), data.D);
      if (F) {
        actions.setFrame(F, { duration: animate ? 1100 : 0 });
        if (!P.get('v')) actions.fit();
        const pp = P.get('pp');
        if (pp && presets.some((p) => p.id === pp)) store.set({ presetId: pp }, { source: 'url' });
        viewSet = true;
      }
    }
    if (!viewSet && app.config.defaultPreset) actions.applyPreset(app.config.defaultPreset, dur === 0 ? { duration: 0 } : {});

    if (P.has('c')) {
      const c = P.get('c');
      actions.setColor(c === '-' || c === '' ? null : c);
    }
    const f = {};
    if (P.has('z')) {
      const [a, b] = P.get('z').split(',').map(Number);
      f.z = Number.isFinite(a) && Number.isFinite(b) && b > a ? [a, b] : null;
    } else f.z = null;
    const cats = {};
    for (const c of data.categories) cats[c.key] = 0xff;
    if (P.get('k')) {
      for (const part of P.get('k').split(',')) {
        const [cat, hex] = part.split(':');
        const m = parseInt(hex, 16);
        if (cat in cats && Number.isFinite(m)) cats[cat] = m & 0xff;
      }
    }
    // a preset's own filter stays unless the link says otherwise
    if (P.has('k') || !pid) f.cats = cats;
    else {
      const pm = store.get().filters.cats;
      f.cats = { ...cats, ...pm };
    }
    f.needColor = P.get('cv') === '1';
    actions.setFilter(f);

    const on = P.get('o');
    for (const [c, name] of Object.entries(OVERLAY_KEYS)) actions.setOverlay(name, on == null ? true : on.includes(c));
    actions.setMode(P.get('m') === 'mosaic' ? 'mosaic' : 'glow');
    if (P.get('r')) {
      const [g, ps] = P.get('r').split(',').map(Number);
      actions.setRender({ gain: Number.isFinite(g) ? g : 1, pointSize: Number.isFinite(ps) ? ps : 2 });
    } else actions.setRender({ gain: 1, pointSize: 2 });
    if (P.get('mc')) {
      const [cell, scale] = P.get('mc').split(',');
      actions.setMosaic({ cell: +cell || 56, scale: scale === 'true' ? 'true' : 'fit' });
    }
    if (P.get('ts')) actions.tour.setSet(P.get('ts').split(','));
    if (P.get('sp')) actions.tour.setSpeed(+P.get('sp'));

    if (P.get('v')) {
      const b = P.get('v').split(',').map(Number);
      if (b.length === 4 && b.every(Number.isFinite) && b[1] > b[0] && b[3] > b[2]) setCameraBounds(b, animate);
    }
    const g = P.get('g');
    const gi = g != null && g !== '' ? parseInt(g, 10) : NaN;
    if (Number.isInteger(gi) && gi >= 0 && gi < data.n) {
      if (data.loaded) actions.inspect(gi);
      else inspectAfterLoad = gi;
    }
  }

  /** Show exactly the linked data box when the aspect allows, else fit it. */
  function setCameraBounds(b, animate) {
    const [x0, x1, y0, y1] = b;
    const W = camera.width, H = camera.height;
    const scale = W / (x1 - x0);
    const aspect = H / (y1 - y0) / scale;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const dur = animate ? 700 * app.motion.scale() : 0;
    if (aspect > 1 / (camera.maxAspect || 2.2) - 1e-9 && aspect < (camera.maxAspect || 2.2) + 1e-9) camera.set({ cx, cy, scale, aspect }, { duration: dur });
    else camera.fitBounds(b, { pad: 0, duration: dur });
  }

  function restore(hash, opts) {
    const P = parse(hash);
    if (!P) return false;
    restoring = true;
    try {
      applyParams(P, opts);
    } catch (e) {
      console.warn('could not restore the view from the URL', e);
    } finally {
      restoring = false;
    }
    lastWritten = tidy(P.toString());
    return true;
  }

  // restore now (initUI runs before the columns load)
  const restored = restore(location.hash);

  app.events.on('data:ready', () => {
    if (inspectAfterLoad != null) {
      const i = inspectAfterLoad;
      inspectAfterLoad = null;
      actions.inspect(i);
    }
  });

  // ------------------------------------------------------------------ write on change
  app.events.on('state', ({ changed }) => {
    if (changed.every((k) => k === 'selection')) return;
    writeSoon();
  });
  app.events.on('settle', writeSoon);
  window.addEventListener('hashchange', () => {
    const h = location.hash.replace(/^#/, '');
    if (h && h !== lastWritten) restore(location.hash, { animate: true });
  });

  async function copyLink() {
    writeSoon.cancel();
    write();
    const url = location.href;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(url);
        return true;
      }
    } catch { /* fall through */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  return { restored, encode, write, copyLink, restore };
}
