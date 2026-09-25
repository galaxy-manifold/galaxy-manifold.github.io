// Top bar (DESIGN.md §13.1): starburst glyph + wordmark, a live N badge (galaxies currently
// in view), the preset cartridge tray, and the ⓘ button.

import { h, fmtInt } from './dom.js';
import { icon, starburstMark } from './icons.js';
import { setTip } from './tooltip.js';
import { initPresets } from './presets.js';

export function initHeader(app, mount, ui) {
  mount.replaceChildren();
  const brand = h('a', {
    class: 'tb-brand',
    href: '#',
    'aria-label': 'Galaxy Manifold — reset the view',
    html: `${starburstMark('tb-mark')}<span class="tb-word">GALAXY<span class="tb-word-gap"></span>MANIFOLD</span>`,
  });
  brand.addEventListener('click', (e) => {
    e.preventDefault();
    app.actions.resetView();
  });
  setTip(brand, { title: 'Galaxy Manifold', sub: 'Reset to the current canonical view' }, 'bottom');

  const count = h('b', { text: fmtInt(app.data.n) });
  const badge = h('span', { class: 'tb-badge', role: 'status', 'aria-live': 'off' }, h('i', { text: 'N' }), count);
  let inView = app.data.n;
  setTip(badge, () => ({
    title: `${fmtInt(inView)} galaxies in view`,
    meta: `${fmtInt(app.data.n)} in ${app.data.manifest.title || 'the sample'}`,
  }), 'bottom');

  const carts = h('div', { class: 'tb-carts' });
  const about = h('button', { class: 'tb-about ibtn', type: 'button', 'aria-label': 'About, credits and shortcuts', html: icon('info') });
  setTip(about, { title: 'About', sub: 'Data, literature, shortcuts, caveats', key: '?' }, 'bottom');
  about.addEventListener('click', () => ui.about?.toggle());

  mount.append(h('div', { class: 'tb' }, h('div', { class: 'tb-left' }, brand, badge), carts, about));

  const presets = initPresets(app, carts, ui);

  // live count of galaxies in view (vis ≥ 50%, filters included), refreshed at each settle
  let last = -1;
  function recount() {
    const vis = app.proj && app.proj.vis;
    if (!vis || app.proj.stale) return;
    if (app.proj.version === last) return;
    last = app.proj.version;
    let c = 0;
    for (let i = 0; i < vis.length; i++) if (vis[i] >= 128) c++;
    inView = c;
    const txt = fmtInt(c);
    if (count.textContent !== txt) {
      count.textContent = txt;
      badge.classList.remove('tick');
      void badge.offsetWidth;
      badge.classList.add('tick');
    }
  }
  app.events.on('settle', recount);

  // the wordmark's starburst turns while the grand tour runs
  app.events.on('state', ({ changed, state }) => {
    if (changed.includes('tour')) mount.classList.toggle('touring', !!state.tour.playing);
  });

  return { presets, about, recount };
}
