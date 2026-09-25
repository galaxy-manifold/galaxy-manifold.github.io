// Custom line icons (DESIGN.md §3.3): 24-unit grid, 1.5 px strokes, round caps and joins,
// geometric mid-century line style. `fill="currentColor"` marks the few solid accents.

const P = {
  // atomic starburst: glow mode, wordmark
  burst: '<path d="M12 2.8v4.6M12 16.6v4.6M2.8 12h4.6M16.6 12h4.6M5.5 5.5l3.1 3.1M15.4 15.4l3.1 3.1M18.5 5.5l-3.1 3.1M8.6 15.4l-3.1 3.1"/><circle cx="12" cy="12" r="1.9" fill="currentColor" stroke="none"/>',
  // mosaic mode: tiled cells
  grid: '<rect x="4" y="4" width="6.6" height="6.6" rx="1.3"/><rect x="13.4" y="4" width="6.6" height="6.6" rx="1.3"/><rect x="4" y="13.4" width="6.6" height="6.6" rx="1.3"/><rect x="13.4" y="13.4" width="6.6" height="6.6" rx="1.3"/>',
  info: '<circle cx="12" cy="12" r="8.6"/><path d="M12 10.8v5.6"/><circle cx="12" cy="7.7" r="1" fill="currentColor" stroke="none"/>',
  close: '<path d="M7 7l10 10M17 7L7 17"/>',
  play: '<path d="M8.6 6.4v11.2L17.8 12z"/>',
  pause: '<path d="M9.2 6.8v10.4M14.8 6.8v10.4"/>',
  // tighten (projection pursuit): arrows squeezing a band
  tighten: '<ellipse cx="12" cy="12" rx="2.6" ry="6.4"/><path d="M2.8 12h4.6M5.3 9.6 7.6 12l-2.3 2.4M21.2 12h-4.6M18.7 9.6 16.4 12l2.3 2.4"/>',
  // running-median trend with its band
  trends: '<path d="M3 16.4c2.6-.1 4.2-1.6 5.8-4.1s3.1-4.8 5.9-5.2c2.1-.3 3.8.2 6.3 1.2"/><path d="M3 19.6c3.1-.2 5-1.8 6.6-3.9M14.6 10.1c1.6-.8 3.5-.8 6.4.4" opacity=".45"/>',
  // literature: open book
  book: '<path d="M12 7.3C9.9 5.8 6.9 5.2 4 5.6v11.9c2.9-.4 5.9.2 8 1.7 2.1-1.5 5.1-2.1 8-1.7V5.6c-2.9-.4-5.9.2-8 1.7z"/><path d="M12 7.3v11.9"/>',
  // lasso: dashed loop with a tail
  lasso: '<path d="M12 4.8c4.6 0 7.8 2.3 7.8 5.2s-3.2 5.1-7.8 5.1S4.2 12.9 4.2 10 7.4 4.8 12 4.8z" stroke-dasharray="2.1 2.3"/><path d="M8.2 14.6c-.9 1.1-.9 2.5.3 3.3 1.1.7 1.4 1.7.9 2.8"/>',
  reset: '<path d="M5.6 12.4a6.6 6.6 0 1 0 2-5"/><path d="M5.1 4.6v3.3h3.3"/>',
  link: '<path d="M10.2 13.8l3.6-3.6"/><path d="M8.7 11.3l-2 2a3.3 3.3 0 0 0 4.7 4.7l2-2"/><path d="M15.3 12.7l2-2A3.3 3.3 0 0 0 12.6 6l-2 2"/>',
  check: '<path d="M5.6 12.6l4 3.9 8.8-8.9"/>',
  // send to X axis (drop onto the bottom ruler) / Y axis (left ruler)
  toX: '<path d="M4 18.6h16"/><path d="M12 4.2v9.6M8.7 10.6 12 13.9l3.3-3.3"/><path d="M7 18.6v1.8M12 18.6v1.8M17 18.6v1.8" opacity=".55"/>',
  toY: '<path d="M5.4 4v16"/><path d="M19.8 12h-9.6M13.4 8.7 10.1 12l3.3 3.3"/><path d="M5.4 7H3.6M5.4 12H3.6M5.4 17H3.6" opacity=".55"/>',
  half: '<circle cx="12" cy="12" r="7.6"/><path d="M12 4.4a7.6 7.6 0 0 1 0 15.2z" fill="currentColor" stroke="none"/>',
  // tour-set membership: an orbit with a body
  orbit: '<ellipse cx="12" cy="12" rx="8.8" ry="4" transform="rotate(-28 12 12)"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="18.9" cy="7.9" r="1.35" fill="currentColor" stroke="none"/>',
  // SkyServer (celestial sphere), Legacy viewer (framed sky), spectrum (emission lines)
  sphere: '<circle cx="12" cy="12" r="8.2"/><path d="M3.8 12h16.4"/><path d="M12 3.8c2.4 2.3 3.5 5 3.5 8.2s-1.1 5.9-3.5 8.2c-2.4-2.3-3.5-5-3.5-8.2s1.1-5.9 3.5-8.2z"/>',
  viewer: '<rect x="3.8" y="5" width="16.4" height="14" rx="2.4"/><path d="M12 8.4l.9 2.2 2.3.2-1.8 1.5.6 2.3-2-1.2-2 1.2.6-2.3-1.8-1.5 2.3-.2z"/>',
  spectrum: '<path d="M3 17.2h2.1l1.4-2.6 1.6 4 2-11.4 1.9 8.6 1.5-3.4 1.4 1.8h1.8l1.1-5.6 1.1 5.6H21"/>',
  back: '<path d="M14.4 6.2 8.6 12l5.8 5.8"/>',
  sun: '<circle cx="12" cy="12" r="3.5"/><path d="M12 3.4v2.3M12 18.3v2.3M3.4 12h2.3M18.3 12h2.3M5.9 5.9l1.6 1.6M16.5 16.5l1.6 1.6M18.1 5.9l-1.6 1.6M7.5 16.5l-1.6 1.6"/>',
  dot: '<circle cx="12" cy="12" r="2.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="6.9" stroke-dasharray="1.4 2.7"/>',
  fit: '<path d="M4.4 9V4.4H9M15 4.4h4.6V9M19.6 15v4.6H15M9 19.6H4.4V15"/>',
  ruler: '<rect x="3" y="8.2" width="18" height="7.6" rx="1.6"/><path d="M6.8 8.2v2.8M10.2 8.2v3.8M13.6 8.2v2.8M17 8.2v3.8"/>',
  clear: '<circle cx="12" cy="12" r="7.6"/><path d="M6.7 17.3 17.3 6.7"/>',
  cell: '<rect x="4.2" y="4.2" width="15.6" height="15.6" rx="2.2"/><path d="M4.2 12h15.6M12 4.2v15.6"/>',
  speed: '<path d="M4.6 16.4a7.4 7.4 0 1 1 14.8 0"/><path d="M12 16.4l3.8-4.6"/><circle cx="12" cy="16.4" r="1.2" fill="currentColor" stroke="none"/>',
  chevron: '<path d="M7 10l5 5 5-5"/>',
  external: '<path d="M13.5 5H19v5.5M19 5l-8 8"/><path d="M16.5 13.8V18a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V9A1.5 1.5 0 0 1 6 7.5h4.2"/>',
  swap: '<path d="M7 7.5h11M15 4.5l3 3-3 3M17 16.5H6M9 13.5l-3 3 3 3"/>',
  image: '<rect x="4" y="5" width="16" height="14" rx="2.2"/><circle cx="12" cy="12" r="3.2"/><path d="M12 5v2.3M12 16.7V19"/>',
  broken: '<rect x="4" y="5" width="16" height="14" rx="2.2"/><path d="M8 16l8-8"/>',
};

/** Inline SVG markup for icon `name`. */
export function icon(name, cls = '') {
  const p = P[name] || '';
  return `<svg class="i i-${name}${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
}

export const ICON_NAMES = Object.keys(P);

/**
 * The wordmark's atomic starburst (larger, two-tone): 16 rays of three lengths, balls on the
 * long ones, orange hub. viewBox −12..12.
 */
export function starburstMark(cls = '') {
  const rays = [];
  const tips = [];
  for (let i = 0; i < 16; i++) {
    const a = (i * Math.PI) / 8 - Math.PI / 2;
    const long = i % 2 === 0;
    const r1 = long ? (i % 4 === 0 ? 10.6 : 8.6) : 6.2;
    const r0 = 2.6;
    rays.push(`M${(r0 * Math.cos(a)).toFixed(2)} ${(r0 * Math.sin(a)).toFixed(2)}L${(r1 * Math.cos(a)).toFixed(2)} ${(r1 * Math.sin(a)).toFixed(2)}`);
    if (long) tips.push(`<circle cx="${(r1 * Math.cos(a)).toFixed(2)}" cy="${(r1 * Math.sin(a)).toFixed(2)}" r="${i % 4 === 0 ? 1.15 : 0.85}"/>`);
  }
  return `<svg class="mark${cls ? ` ${cls}` : ''}" viewBox="-12 -12 24 24" aria-hidden="true" focusable="false"><g class="mark-rays"><path d="${rays.join('')}"/></g><g class="mark-tips">${tips.join('')}</g><circle class="mark-hub" r="1.9"/></svg>`;
}
