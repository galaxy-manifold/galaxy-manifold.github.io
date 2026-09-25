// Splash (DESIGN.md §13.8): the wordmark plus an animated starburst, two orbits and a thin
// progress arc — no other text. The markup lives in index.html so it shows before any script;
// this module drives the arc from `load:progress` and stills the animation under reduced motion.

import { reducedMotion } from './dom.js';

const RING = 2 * Math.PI * 104;

export function initSplash(app) {
  const el = document.getElementById('splash');
  if (!el) return null;
  const arc = el.querySelector('.sp-progress');
  const svg = el.querySelector('.gm-splash-mark');
  let shown = 0;
  function set(f) {
    const v = Math.max(shown, Math.max(0, Math.min(1, f)));
    shown = v;
    if (arc) arc.style.strokeDashoffset = String(RING * (1 - v));
    el.setAttribute('aria-valuenow', String(Math.round(v * 100)));
  }
  if (arc) {
    arc.style.strokeDasharray = String(RING);
    set(0.02);
  }
  if (reducedMotion()) {
    el.classList.add('still');
    try { svg?.pauseAnimations?.(); } catch { /* ignore */ }
  }
  // reveal the wordmark once Michroma is in (no flash of the fallback face)
  const fonts = document.fonts;
  if (fonts && fonts.load) {
    Promise.race([fonts.load('12px Michroma'), new Promise((r) => setTimeout(r, 1200))]).then(() => el.classList.add('fonts'));
  } else el.classList.add('fonts');

  app.events.on('load:progress', (p) => set(p.phase === 'upload' ? Math.max(0.94, p.fraction * 0.94) : p.fraction * 0.94));
  app.events.on('data:ready', () => {
    set(1);
    el.classList.add('complete');
  });
  return { set };
}
