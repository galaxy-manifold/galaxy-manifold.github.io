// Bootstrap (§12): manifest → createApp → initUI → initOverlays → load columns → start.
// ?data=<dir> selects a dataset directory inside the site (default 'data'; dev: 'data-synth').

import { createApp } from './app.js';
import { loadManifest, resolveBase } from './data/loader.js';
import { Renderer } from './gl/renderer.js';
import { initUI } from './ui/index.js';
import { initOverlays } from './view/overlays/index.js';

const RING = 2 * Math.PI * 46;

function setProgress(f) {
  const arc = document.querySelector('#splash .core-splash .progress');
  if (arc) arc.style.strokeDashoffset = String(RING * (1 - Math.max(0, Math.min(1, f))));
}

const ICONS = {
  webgl: '<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="17"/><path d="M12 36 36 12"/><path d="M24 4v6M24 38v6M4 24h6M38 24h6"/></svg>',
  data: '<svg viewBox="0 0 48 48" aria-hidden="true"><ellipse cx="24" cy="12" rx="14" ry="5"/><path d="M10 12v24c0 2.8 6.3 5 14 5s14-2.2 14-5V12"/><path d="M10 24c0 2.8 6.3 5 14 5s14-2.2 14-5"/></svg>',
};

/** Full-screen, few-words failure card. */
function fatal(kind, detail = '') {
  const splash = document.getElementById('splash');
  if (splash) splash.hidden = true;
  const el = document.createElement('div');
  el.className = 'core-fatal';
  el.setAttribute('role', 'alert');
  const title = kind === 'webgl' ? 'WebGL 2 required' : 'Data unavailable';
  const hint = kind === 'webgl'
    ? 'Open in a recent Chrome, Edge, Firefox or Safari with hardware acceleration on.'
    : String(detail || '');
  el.innerHTML = `<div class="core-fatal-card">${ICONS[kind] || ''}<div class="core-fatal-title"></div><div class="core-fatal-hint"></div></div>`;
  el.querySelector('.core-fatal-title').textContent = title;
  el.querySelector('.core-fatal-hint').textContent = hint;
  document.body.appendChild(el);
}

async function main() {
  const params = new URLSearchParams(location.search);
  const base = resolveBase(params.get('data'));
  const t0 = performance.now();
  if (!Renderer.supported()) {
    fatal('webgl');
    return;
  }
  let manifest;
  try {
    manifest = await loadManifest(base);
  } catch (e) {
    console.error(e);
    fatal('data', e.message);
    return;
  }
  const app = createApp({ manifest, base });
  app.timing.t0 = t0;
  window.app = app;
  if (!app.webgl) {
    fatal('webgl');
    return;
  }
  app.events.on('load:progress', (p) => setProgress(p.fraction));
  try {
    await initUI(app);
  } catch (e) {
    console.error('UI init failed', e);
  }
  try {
    await initOverlays(app);
  } catch (e) {
    console.error('overlays init failed', e);
  }
  try {
    await app.load();
  } catch (e) {
    console.error(e);
    fatal('data', e.message);
    return;
  }
  app.start();
}

main();
