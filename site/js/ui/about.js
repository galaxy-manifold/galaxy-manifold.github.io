// About overlay (DESIGN.md §13.8): one-line description, data credits (manifest.sources),
// literature references (literature.json), keyboard shortcuts, caveats (§18) and the
// dimension table with units and definitions. The only place with running text.

import { h, fmtInt } from './dom.js';
import { focusQuietly } from './tooltip.js';
import { icon, starburstMark } from './icons.js';
import { groupedDims, dimTitle, GROUP_NAMES, shortKids } from './uiconfig.js';
import { groupColor } from '../config/style.js';

const CAVEATS_FALLBACK = [
  'The sample is flux-limited (r < 17.77), so scaling relations show Malmquist bias. Filter in z to explore it.',
  'Fiber spectra (3″) cover different fractions of galaxies at different z, which affects O/H, SFR and Dn4000.',
  'The SFR dependence of the FMR depends on the metallicity calibration. With T04 Bayesian O/H it is weak or even reversed at high mass, so compare OH with OH_PP04.',
  'Petrosian R₅₀ underestimates the true half-light radius of concentrated (n≈4) profiles.',
  'H I fractions are ALFALFA detections only, which biases them gas-rich at fixed M★.',
  'Lim+17 halo masses come from abundance matching on group proxies, so the SHMR is partly built in by construction.',
  'Galaxy Zoo 1 fractions are debiased vote fractions, not ground truth.',
];

const KEYS = [
  [['1', '…', '9', '0'], 'canonical views'],
  [['space'], 'grand tour'],
  [['L'], 'lasso'],
  [['M'], 'glow / mosaic'],
  [['T'], 'trends'],
  [['B'], 'literature'],
  [['C'], 'next colour (⇧ previous)'],
  [['F'], 'fit'],
  [['R'], 'reset'],
  [['Esc'], 'clear / close'],
  [['?'], 'this panel'],
];

const GESTURES = [
  ['drag a spoke', 'rotate through that dimension'],
  ['double-click a spoke', 'rotate it out'],
  ['drag a token', 'onto an axis or the compass'],
  ['scroll · drag · double-click', 'zoom · pan · fit'],
];

export function initAbout(app, ui) {
  const { data } = app;
  let root = null;
  let lastFocus = null;

  function tidy(s) {
    return String(s || '').replace(/`/g, '');
  }

  /** Plain-ASCII conventions → the symbols used everywhere else in the UI. */
  function typeset(str) {
    return String(str || '')
      .replace(/\bH0\s*=\s*/g, 'H₀ = ').replace(/\bOm\s*=\s*/g, 'Ωm = ')
      .replace(/\bMsun\b/g, 'M☉').replace(/\bsigma\b/g, 'σ').replace(/\bR50\b/g, 'R₅₀')
      .replace(/\bM_180m\b/g, 'M₁₈₀ₘ').replace(/\bM_h\b/g, 'M_h')
      .replace(/\s*;\s*/g, ' · ');
  }

  /** Text with `key` spans: dimension keys become their label, tinted with the group colour. */
  function richText(str) {
    return String(str || '').split(/`([^`]+)`/).map((part, k) => {
      if (k % 2 === 0) return part;
      const i = data.dimIndex(part);
      if (i < 0) return part;
      const d = data.dims[i];
      return h('span', { class: 'ab-dimref', style: { '--gc': groupColor(d.group) }, title: dimTitle(d), text: d.label });
    });
  }

  function build() {
    const m = data.manifest;
    const close = h('button', { class: 'ibtn ab-close', type: 'button', 'aria-label': 'Close', html: icon('close') });
    close.addEventListener('click', hide);

    const lede = `Galaxy scaling relations as rotating two-dimensional projections of a ${data.D}-dimensional manifold of ${fmtInt(data.n)} ${m.title ? m.title.replace(/^SDSS /, 'SDSS ') : 'SDSS'} galaxies.`;

    // data credits
    const sources = h('ul', { class: 'ab-list ab-sources' },
      (m.sources || []).map((src) => h('li', null,
        src.url ? h('a', { href: src.url, target: '_blank', rel: 'noopener noreferrer', text: src.label }) : h('span', { class: 'ab-strong', text: src.label }),
        src.cite ? h('span', { class: 'ab-cite', text: src.cite }) : null)));

    // conventions
    const cosmo = m.cosmology ? `flat ΛCDM, H₀ = ${m.cosmology.H0}, Ωm = ${m.cosmology.Om0}` : '';
    const conv = h('div', { class: 'ab-conv' },
      ui.litConventions ? h('p', { text: typeset(ui.litConventions) }) : null,
      cosmo ? h('p', { class: 'ab-mono', text: cosmo }) : null,
      m.sample?.cuts ? h('p', { class: 'ab-mono', text: m.sample.cuts.join(' · ') }) : null);

    // literature, grouped by preset
    const presets = app.config.allPresets || app.config.presets;
    const byView = new Map();
    for (const r of ui.literature || []) {
      const k = r.view || '';
      if (!byView.has(k)) byView.set(k, []);
      byView.get(k).push(r);
    }
    const lit = h('div', { class: 'ab-lit' });
    for (const [view, list] of byView) {
      const p = presets.find((q) => q.id === view);
      lit.append(h('div', { class: 'ab-lit-g' },
        h('span', { class: 'ab-lit-code', text: p ? p.code : view.toUpperCase() }),
        h('ul', { class: 'ab-list' }, list.map((r) => h('li', null,
          h('span', { class: 'ab-lit-l', text: r.label }),
          r.url ? h('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer', text: r.name }) : h('span', { text: r.name }),
          r.cite ? h('span', { class: 'ab-cite', text: r.cite }) : null)))));
    }
    if (!byView.size) lit.append(h('p', { class: 'ab-muted', text: '—' }));

    // keys
    const keys = h('ul', { class: 'ab-keys' },
      KEYS.map(([ks, what]) => h('li', null, h('span', { class: 'ab-kc' }, ks.map((k) => (k === '…' ? h('span', { class: 'ab-ell', text: '…' }) : h('kbd', { text: k })))), h('span', { text: what }))),
      GESTURES.map(([g, what]) => h('li', { class: 'ab-gest' }, h('span', { class: 'ab-g', text: g }), h('span', { text: what }))));

    // caveats
    const cav = h('ul', { class: 'ab-list ab-caveats' }, (m.caveats && m.caveats.length ? m.caveats : CAVEATS_FALLBACK).map((c) => h('li', null, richText(c))));

    // dimensions
    const dims = h('div', { class: 'ab-dims' });
    for (const g of groupedDims(data.dims)) {
      for (const d of g.dims) {
        dims.append(h('div', { class: 'ab-dim', style: { '--gc': g.color } },
          h('span', { class: 'ab-dim-k' }, shortKids(d.short)),
          h('span', { class: 'ab-dim-l', text: dimTitle(d) }),
          h('span', { class: 'ab-dim-d', text: d.desc || '' }),
          h('span', { class: 'ab-dim-n', text: fmtInt(d.nvalid) })));
      }
    }

    const sec = (title, ...kids) => h('section', { class: 'ab-sec' }, h('h3', { text: title }), ...kids);
    const panel = h('div', { class: 'ab-panel', role: 'document' },
      h('header', { class: 'ab-head' },
        h('div', { class: 'ab-brand', html: `${starburstMark('ab-mark')}<span>GALAXY MANIFOLD</span>` }), close),
      h('p', { class: 'ab-lede', text: lede }),
      sec('Data', sources),
      h('div', { class: 'ab-grid' },
        h('div', { class: 'ab-col' }, sec('Keys', keys)),
        h('div', { class: 'ab-col' }, sec('Caveats', cav)),
        h('div', { class: 'ab-col' }, sec('Conventions', conv))),
      sec('Relations', lit),
      sec('Dimensions', dims),
      h('footer', { class: 'ab-foot' },
        h('span', { text: m.created ? `data ${m.created}` : '' }),
        h('span', { text: `${data.D} dimensions · ${data.categories.length} categories · ${fmtInt(data.n)} galaxies` })));

    root = h('div', { class: 'about', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'About Galaxy Manifold' },
      h('div', { class: 'ab-scrim' }), panel);
    root.querySelector('.ab-scrim').addEventListener('click', hide);
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        hide();
      } else if (e.key === 'Tab') {
        const f = [...root.querySelectorAll('a[href], button')].filter((el) => !el.hidden && el.offsetParent !== null);
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    });
    document.body.append(root);
  }

  function show() {
    if (!root) build();
    lastFocus = document.activeElement;
    root.classList.add('open');
    document.documentElement.classList.add('about-open');
    requestAnimationFrame(() => root.querySelector('.ab-close')?.focus({ preventScroll: true }));
  }
  function hide() {
    if (!root || !root.classList.contains('open')) return;
    root.classList.remove('open');
    document.documentElement.classList.remove('about-open');
    if (lastFocus && lastFocus.focus) focusQuietly(lastFocus);
  }
  return {
    show,
    hide,
    toggle() {
      if (root && root.classList.contains('open')) hide();
      else show();
    },
    get open() {
      return !!root && root.classList.contains('open');
    },
    rebuild() {
      const wasOpen = root && root.classList.contains('open');
      root?.remove();
      root = null;
      if (wasOpen) show();
    },
  };
}
