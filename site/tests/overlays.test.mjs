// Unit tests for the overlays' pure helpers (DESIGN.md §15): lasso geometry, literature
// mapping and offsets, ruler ticks and titles, trend grouping, mosaic tile choice, and the
// projection-pursuit math (js/math/pursuit.js).
// Run with: node --test site/tests/   (or node --test site/tests/overlays.test.mjs)
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import * as geom from '../js/view/overlays/geom.js';
import * as text from '../js/view/overlays/text.js';
import { rulerTicks, titleSegments } from '../js/view/overlays/axes.js';
import { computeTrends, smooth121, firmness, strengthRuns } from '../js/view/overlays/trends.js';
import * as pz from '../js/math/pursuit.js';
import * as fm from '../js/math/frame.js';
import { mulberry32, gauss } from '../js/math/linalg.js';

const DIMS = [
  ['logM', 'log M★', 'M☉', 10.62, 0.58, 'stars'], ['logSFR', 'log SFR', 'M☉ yr⁻¹', -0.5, 0.8, 'sf'],
  ['OH', '12+log(O/H)', '', 8.94, 0.14, 'chem'], ['logR50', 'log R₅₀', 'kpc', 0.55, 0.2, 'struct'],
  ['N2Ha', 'log [NII]/Hα', '', -0.35, 0.2, 'lines'], ['O3Hb', 'log [OIII]/Hβ', '', -0.1, 0.35, 'lines'],
  ['pEl', 'P(E)', '', 0.2, 0.25, 'struct'],
].map(([key, label, unit, center, scale, group], index) => ({ key, label, unit, center, scale, group, index }));
const D = DIMS.length;

// ------------------------------------------------------------------ lasso geometry
describe('polygons', () => {
  test('area and bounds', () => {
    const sq = [0, 0, 2, 0, 2, 3, 0, 3];
    assert.equal(geom.polygonArea(sq), 6);
    assert.equal(geom.polygonArea([0, 0, 0, 3, 2, 3, 2, 0]), -6);
    assert.deepEqual(geom.polygonBounds(sq), [0, 2, 0, 3]);
  });

  test('scanline index agrees with the exact even–odd test away from edges', () => {
    // a concave, self-touching-free "C" shape plus a star
    const shapes = [
      [10, 10, 90, 10, 90, 30, 30, 30, 30, 70, 90, 70, 90, 90, 10, 90],
      Array.from({ length: 20 }, (_, k) => {
        const t = (k / 10) * Math.PI, r = k % 2 ? 18 : 45;
        return [50 + r * Math.cos(t), 50 + r * Math.sin(t)];
      }).flat(),
    ];
    const rng = mulberry32(3);
    for (const poly of shapes) {
      const idx = geom.polygonIndex(poly, 0.5);
      const n = poly.length / 2;
      const distToEdges = (x, y) => {
        let m = Infinity;
        for (let i = 0, j = n - 1; i < n; j = i++) {
          const ax = poly[2 * j], ay = poly[2 * j + 1], bx = poly[2 * i], by = poly[2 * i + 1];
          const dx = bx - ax, dy = by - ay;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
          m = Math.min(m, Math.hypot(x - ax - t * dx, y - ay - t * dy));
        }
        return m;
      };
      let checked = 0;
      for (let k = 0; k < 4000; k++) {
        const x = rng() * 100, y = rng() * 100;
        if (distToEdges(x, y) < 0.6) continue;
        assert.equal(idx.contains(x, y), geom.pointInPolygon(poly, x, y), `(${x}, ${y})`);
        checked++;
      }
      assert.ok(checked > 3500);
    }
  });

  test('degenerate polygons contain nothing', () => {
    assert.equal(geom.polygonIndex([0, 0, 1, 1]).contains(0.5, 0.5), false);
    assert.equal(geom.polygonIndex([0, 0, 1, 0, 2, 0]).contains(1, 0), false);
  });
});

// ------------------------------------------------------------------ literature helpers
describe('literature helpers', () => {
  test('polylineFunction interpolates, sorts and is NaN outside', () => {
    const f = geom.polylineFunction([[3, 30], [1, 10], [2, 20], [NaN, 5]]);
    assert.equal(f(1.5), 15);
    assert.equal(f(3), 30);
    assert.ok(Number.isNaN(f(0.5)));
    assert.ok(Number.isNaN(f(NaN)));
  });

  test('nativeAxes matches frame.nativeMap for random frames and combos', () => {
    const rng = mulberry32(11);
    const combos = [[{ logM: 1 }, { OH: 1 }], [{ logM: 1, logSFR: -0.32 }, { OH: 1 }], [{ N2Ha: 1 }, { O3Hb: 1, N2Ha: 0.2 }]];
    for (let t = 0; t < 30; t++) {
      const F = fm.randomFrame(D, [...Array(D).keys()], rng);
      for (const [x, y] of combos) {
        const ref = fm.nativeMap(x, y, F, DIMS);
        const na = geom.nativeAxes(fm.comboVector(x, DIMS), fm.comboVector(y, DIMS), F);
        assert.ok(Math.abs(na.ax - ref.ax) < 1e-12 && Math.abs(na.ay - ref.ay) < 1e-12);
        for (const [Ax, Ay] of [[9.5, 8.7], [11, 9.1], [-0.5, 0.3]]) {
          const [X1, Y1] = ref.toFrame(Ax, Ay);
          const [X2, Y2] = na.toFrame(Ax, Ay);
          assert.ok(Math.abs(X1 - X2) < 1e-9 && Math.abs(Y1 - Y2) < 1e-9);
        }
      }
    }
  });

  test('nativeAxes on the native frame is the identity mapping of §10', () => {
    const F = fm.frameFromCombos({ logM: 1 }, { OH: 1 }, DIMS).F;
    const na = geom.nativeAxes(fm.comboVector({ logM: 1 }, DIMS), fm.comboVector({ OH: 1 }, DIMS), F);
    assert.equal(na.ax, 1);
    assert.equal(na.ay, 1);
    const [X, Y] = na.toFrame(10, 9.0, 0.1);
    assert.ok(Math.abs(X - (10 - 10.62) / 0.58) < 1e-12);
    assert.ok(Math.abs(Y - (9.1 - 8.94) / 0.14) < 1e-12);
    assert.equal(geom.nativeAxes(fm.comboVector({ logM: 1 }, DIMS), fm.comboVector({ logM: 2 }, DIMS), F), null);
  });

  test('spreadOrdered keeps the order and the gap with least-squares displacement', () => {
    // two clashing labels move apart symmetrically; a far one stays put
    const p = geom.spreadOrdered([10, 12, 50], 14);
    assert.ok(Math.abs(p[0] - 4) < 1e-9 && Math.abs(p[1] - 18) < 1e-9 && p[2] === 50, JSON.stringify(p));
    // the given order wins even when the preferred positions are inverted
    const q = geom.spreadOrdered([30, 20], 10);
    assert.ok(q[1] - q[0] >= 10 - 1e-9 && Math.abs(q[0] + q[1] - 50) < 1e-9);
    // bounds shift the block
    const r = geom.spreadOrdered([0, 1, 2], 10, 5, 100);
    assert.deepEqual(r.map((v) => +v.toFixed(9)), [5, 15, 25]);
    assert.deepEqual(geom.spreadOrdered([], 5), []);
  });

  test('label candidates start past the curve end; placement avoids labels, ends and blocked rects', () => {
    const it = { ax: 100, ay: 100, dx: 1, dy: 0, w: 40, h: 14, trueEnd: true };
    const c = geom.labelCandidates(it);
    assert.ok(c[0][0] > 100 && Math.abs(c[0][1] + 7 - 100) < 1e-9, 'first choice is right of a rightward end');
    const cl = geom.labelCandidates({ ...it, dx: -1 });
    assert.ok(cl[0][0] + 40 < 100, 'first choice is left of a leftward end');
    const bounds = { l: 0, t: 0, r: 400, b: 400 };
    // two ends close together: the second label must not sit on the first label or on its end
    const items = [it, { ...it, ax: 112, ay: 104 }];
    const obst = [100, 100, 80, 112, 104, 80];
    const pos = geom.chooseLabelBoxes(items, obst, bounds);
    const [a, b] = pos;
    const overlap = a.x < b.x + 40 && b.x < a.x + 40 && a.y < b.y + 14 && b.y < a.y + 14;
    assert.ok(!overlap, JSON.stringify(pos));
    for (const [p, q] of [[a, [112, 104]], [b, [100, 100]]]) {
      assert.ok(!(q[0] >= p.x - 2 && q[0] <= p.x + 42 && q[1] >= p.y - 2 && q[1] <= p.y + 16), 'label covers another end');
    }
    // a blocked rect right of the end pushes the label elsewhere; nothing fits → clamped fallback
    const [d] = geom.chooseLabelBoxes([it], [], bounds, { blocked: [{ x: 100, y: 80, w: 100, h: 40 }] });
    assert.ok(d.x + 40 <= 100 || d.y + 14 <= 80 || d.y >= 120);
    const [e] = geom.chooseLabelBoxes([{ ...it, ax: 395, ay: 5 }], [], { l: 0, t: 0, r: 30, b: 10 });
    assert.equal(e.fallback, true);
  });

  test('spreadPositions keeps the gap, the order and the bounds', () => {
    const p = geom.spreadPositions([10, 11, 12, 50, 13], 5, 0, 60);
    const sorted = [...p].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i] - sorted[i - 1] >= 5 - 1e-9);
    assert.ok(p[0] <= p[1] && p[1] <= p[2] && p[2] <= p[4]);
    const q = geom.spreadPositions([58, 59, 60], 5, 0, 60);
    assert.ok(Math.max(...q) <= 60 && Math.min(...q) >= 0);
  });
});

// ------------------------------------------------------------------ rulers
describe('rulers', () => {
  test('minor steps follow the 1-2-5 major step', () => {
    assert.ok(Math.abs(geom.minorStep(1) - 0.2) < 1e-12);
    assert.ok(Math.abs(geom.minorStep(0.2) - 0.05) < 1e-12);
    assert.ok(Math.abs(geom.minorStep(5) - 1) < 1e-12);
    const m = geom.minorTicks(0, 1, 0.5);
    assert.deepEqual(m.map((v) => +v.toFixed(6)), [0.1, 0.2, 0.3, 0.4, 0.6, 0.7, 0.8, 0.9]);
  });

  test('ruler ticks are nice physical values that map back through the axis', () => {
    const F = fm.frameFromCombos({ logM: 1, logSFR: -0.32 }, { OH: 1 }, DIMS).F;
    const info = fm.axisInfo(F, 0, DIMS);
    const t = rulerTicks(info, -2, 2, 6);
    assert.ok(t.major.length >= 4 && t.major.length <= 12);
    for (const tk of t.major) {
      assert.ok(Math.abs(fm.axisValue(info, tk.X) - tk.A) < 1e-9);
      assert.ok(Math.abs(tk.A / t.step - Math.round(tk.A / t.step)) < 1e-9);
    }
    for (let i = 1; i < t.major.length; i++) assert.ok(t.major[i].X > t.major[i - 1].X);
    assert.ok(t.minor.length > t.major.length);
  });

  test('titles parenthesize a multi-term label after the first term', () => {
    const F = fm.frameFromCombos({ pEl: 1, OH: -0.3 }, { logR50: 1 }, DIMS).F;
    const info = fm.axisInfo(F, 0, DIMS);
    const t = titleSegments(info, DIMS).map((s) => s.text).join('');
    assert.ok(/^(P\(E\) − \d\.\d\d \(12\+log\(O\/H\)\)|12\+log\(O\/H\) − \d\.\d\d P\(E\))$/.test(t), t);
    assert.ok(titleSegments(info, DIMS, { maxTerms: 1 }).map((s) => s.text).join('').length < t.length);
  });

  test('titles: single term with unit, combos with signed coefficients', () => {
    const F = fm.frameFromCombos({ logM: 1, logSFR: -0.32 }, { OH: 1 }, DIMS).F;
    const x = titleSegments(fm.axisInfo(F, 0, DIMS), DIMS).map((s) => s.text).join('');
    assert.equal(x, 'log M★ − 0.32 log SFR');
    const y = titleSegments(fm.axisInfo(F, 1, DIMS), DIMS, { arrow: 'up' }).map((s) => s.text).join('');
    assert.equal(y, '↑  12+log(O/H)');
    const G = fm.frameFromCombos({ logM: 1 }, { logR50: 1 }, DIMS).F;
    assert.equal(titleSegments(fm.axisInfo(G, 1, DIMS), DIMS).map((s) => s.text).join(''), 'log R₅₀ [kpc]');
  });
});

// ------------------------------------------------------------------ text
describe('script text', () => {
  test('unicode super/subscripts and _x become runs of plain characters', () => {
    const j = (t) => text.scriptRuns(t).map((r) => `${r.script}:${r.text}`).join(' | ');
    assert.equal(j('12+log(O/H)ᴼ³ᴺ²'), '0:12+log(O/H) | 1:O3N2');
    assert.equal(j('log R₅₀ [kpc]'), '0:log R | -1:50 | 0: [kpc]');
    assert.equal(j('⁰·¹(g−r)'), '1:0.1 | 0:(g−r)');
    assert.equal(j('M☉ yr⁻¹'), '0:M☉ yr | 1:−1');
    assert.equal(j('log M_HI/M★'), '0:log M | -1:HI | 0:/M★');
    assert.equal(j('Dₙ4000'), '0:D | -1:n | 0:4000');
    assert.equal(j('a · b'), '0:a · b');
    assert.equal(j('x_'), '0:x_');
    assert.equal(text.hasScripts('log M★'), false);
    assert.equal(text.hasScripts('R₉₀/R₅₀'), true);
  });

  test('needsParens looks for a top-level sign only', () => {
    assert.equal(text.needsParens('12+log(O/H)'), true);
    assert.equal(text.needsParens('12+log(O/H)ᴼ³ᴺ²'), true);
    assert.equal(text.needsParens('⁰·¹(g−r)'), false);
    assert.equal(text.needsParens('log [NII]/Hα'), false);
    assert.equal(text.needsParens('−x'), false);
    assert.equal(text.needsParens('a - b'), true);
  });

  test('layoutRuns shrinks and shifts script runs and sums widths', () => {
    const L = text.layoutRuns(text.scriptRuns('R₅₀'), 10, (t, size) => t.length * size * 0.6);
    assert.equal(L.runs.length, 2);
    assert.equal(L.runs[0].size, 10);
    assert.ok(L.runs[1].size < 10 && L.runs[1].dy > 0);
    assert.ok(Math.abs(L.width - (6 + 2 * L.runs[1].size * 0.6)) < 1e-9);
    const S = text.layoutRuns(text.scriptRuns('yr⁻¹'), 10, (t, size) => t.length * size);
    assert.ok(S.runs[1].dy < 0);
  });
});

// ------------------------------------------------------------------ trends
describe('trends', () => {
  test('firmness ramps from faint to full with the bin count', () => {
    const f = firmness(Int32Array.from([0, 30, 90, 150, 1000]));
    assert.ok(Math.abs(f[1] - 0.32) < 1e-9 && f[2] > f[1] && f[3] === 1 && f[4] === 1);
    const g = firmness(Int32Array.from([40]), { scale: 4 });
    assert.equal(g[0], 1);
  });

  test('strengthRuns splits a polyline by strength and skips NaN gaps', () => {
    const v = Float64Array.from([1, 2, 3, NaN, 5, 6]);
    const fa = Float64Array.from([1, 1, 0.3, 1, 1, 1]);
    const r = strengthRuns(v, fa, 4);
    assert.deepEqual(r.map((x) => [x.from, x.to]), [[0, 1], [1, 2], [4, 5]]);
    assert.ok(r[0].level === 1 && r[1].level < 0.5 && r[2].level === 1);
  });

  test('the selection median follows the selected subset and breaks where it is sparse', () => {
    const rng = mulberry32(17);
    const n = 30000;
    const xs = new Float64Array(n), ys = new Float64Array(n), sel = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      xs[i] = rng();
      sel[i] = xs[i] < 0.5 && rng() < 0.3 ? 1 : 0;
      ys[i] = xs[i] + (sel[i] ? 1 : 0) + 0.05 * gauss(rng);
    }
    const t = computeTrends(xs, ys, n, { sel, bins: 10, x0: 0, x1: 1 });
    assert.ok(t.sel && t.sel.n > 3000);
    assert.ok(Math.abs(t.sel.mid[2] - (t.centers[2] + 1)) < 0.05);
    assert.ok(Number.isNaN(t.sel.mid[8]), 'no selected galaxies at x > 0.5');
    assert.ok(t.mid[2] < t.sel.mid[2]);
  });

  test('quantile groups split into equal counts; NaN has no group', () => {
    const v = Float64Array.from({ length: 1000 }, (_, i) => i);
    const { edges, medians } = geom.quantileGroups(v, 4);
    assert.equal(edges.length, 3);
    const counts = [0, 0, 0, 0];
    for (const x of v) counts[geom.groupIndex(x, edges)]++;
    for (const c of counts) assert.ok(Math.abs(c - 250) <= 1);
    assert.ok(medians[0] < medians[1] && medians[2] < medians[3]);
    assert.equal(geom.groupIndex(NaN, edges), -1);
  });

  test('smooth121 keeps NaN gaps and constants', () => {
    const s = smooth121(Float64Array.from([1, 1, NaN, 2, 2, 2]));
    assert.deepEqual(Array.from(s).map((x) => (Number.isNaN(x) ? 'nan' : x)), [1, 1, 'nan', 2, 2, 2]);
  });

  test('computeTrends recovers a median line and orders color groups', () => {
    const rng = mulberry32(5);
    const n = 20000;
    const xs = new Float64Array(n), ys = new Float64Array(n), cv = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      xs[i] = rng() * 4 - 2;
      cv[i] = gauss(rng);
      ys[i] = 0.5 * xs[i] + 0.3 * cv[i] + 0.05 * gauss(rng);
    }
    const ci = { mode: 'continuous', cmap: 'redshift', reverse: false, range: [-2, 2] };
    const t = computeTrends(xs, ys, n, { cv, cs: { mode: 'continuous', ci }, bins: 16, x0: -2, x1: 2 });
    assert.equal(t.groups.length, 4);
    const b = 8;   // bin centered near x = 0.125
    assert.ok(Math.abs(t.mid[b] - 0.5 * t.centers[b]) < 0.03, `median ${t.mid[b]} at ${t.centers[b]}`);
    assert.ok(t.lo[b] < t.mid[b] && t.mid[b] < t.hi[b]);
    for (let g = 1; g < 4; g++) assert.ok(t.groups[g].mid[b] > t.groups[g - 1].mid[b]);
    assert.ok(t.groups.every((g) => /^#[0-9a-f]{6}$/.test(g.color)));
  });

  test('categorical trends keep classes with ≥ 200 points only', () => {
    const rng = mulberry32(8);
    const n = 5000;
    const xs = new Float64Array(n), ys = new Float64Array(n), cc = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      xs[i] = rng();
      cc[i] = i < 150 ? 3 : 1 + (i % 2);
      ys[i] = cc[i] + 0.1 * gauss(rng);
    }
    const spec = { codes: [{ code: 1 }, { code: 2 }, { code: 3 }] };
    const ci = { mode: 'categorical', spec, hex: ['#000000', '#6fa8dc', '#9cc3e4', '#3aa6a0'] };
    const t = computeTrends(xs, ys, n, { cc, cs: { mode: 'categorical', ci }, bins: 5, x0: 0, x1: 1 });
    assert.deepEqual(t.groups.map((g) => g.code), [1, 2]);
    assert.ok(Math.abs(t.groups[1].mid[2] - 2) < 0.05);
  });
});

// ------------------------------------------------------------------ mosaic
describe('mosaic', () => {
  test('typicalPerCell picks the member nearest the cell mean, ignoring missing dims fairly', () => {
    const Dm = 3;
    // cell 0: a (0,0,0), b (1,1,1), c (0.4,0.5,0.6) → mean (0.4667,0.5,0.5333) → c
    // cell 1: d (5, NaN, NaN) (1 valid dim, far on it), e (2, 2, 2), f (2.2, 2.2, NaN)
    const U = Float32Array.from([0, 0, 0, 1, 1, 1, 0.4, 0.5, 0.6, 5, NaN, NaN, 2, 2, 2, 2.2, 2.2, NaN]);
    const cellOf = Int32Array.from([0, 0, 0, 1, 1, 1]);
    const pick = geom.typicalPerCell(cellOf, U, Dm);
    assert.equal(pick.get(0), 2);
    assert.equal(pick.get(1), 5);   // mean (3.07, 2.1, 2): f is closest per valid dim
    const only = geom.typicalPerCell(cellOf, U, Dm, Uint8Array.from([1, 1, 0, 0, 1, 0]));
    assert.equal(only.get(1), 4);
    assert.ok(only.get(0) === 0 || only.get(0) === 1);
    assert.equal(geom.typicalPerCell(Int32Array.from([-1, -1]), U, Dm).size, 0);
  });

  test('stagger delays grow with distance and are capped', () => {
    assert.equal(geom.staggerDelay(0, 0, 56), 0);
    assert.ok(geom.staggerDelay(112, 0, 56) > geom.staggerDelay(56, 0, 56));
    assert.equal(geom.staggerDelay(1e6, 0, 56, 18, 420), 420);
  });
});

// ------------------------------------------------------------------ pursuit
describe('pursuit', () => {
  test('quickselect and medianRange match sorting (duplicates included)', () => {
    const rng = mulberry32(21);
    for (let t = 0; t < 40; t++) {
      const n = 1 + Math.floor(rng() * 300);
      const a = Float64Array.from({ length: n }, () => Math.round(rng() * 20));
      const s = Float64Array.from(a).sort();
      const k = Math.floor(rng() * n);
      assert.equal(pz.quickselect(Float64Array.from(a), k), s[k]);
      const med = n % 2 ? s[(n - 1) / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
      assert.equal(pz.medianRange(Float64Array.from(a), 0, n), med);
    }
  });

  test('runningScatter measures the scatter about a curved relation, scale- and sign-free', () => {
    const rng = mulberry32(4);
    const n = 20000;
    const X = new Float64Array(n), Y = new Float64Array(n), X2 = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      X[i] = gauss(rng);
      Y[i] = Math.tanh(X[i]) + 0.1 * gauss(rng);
      X2[i] = -3 * X[i] + 7;
    }
    const a = pz.runningScatter(X, Y, n);
    assert.ok(Math.abs(a.sigma - 0.1) < 0.006, `sigma ${a.sigma}`);
    const b = pz.runningScatter(X2, Y, n);
    assert.ok(Math.abs(a.sigma - b.sigma) < 1e-12);
    assert.ok(Number.isNaN(pz.runningScatter(X, Y, 10).sigma));
  });

  test('pearson and rSquared', () => {
    const rng = mulberry32(9);
    const n = 5000;
    const a = Float64Array.from({ length: n }, () => gauss(rng));
    const b = Float64Array.from({ length: n }, () => gauss(rng));
    const c = Float64Array.from(a, (v, i) => 2 * v - b[i] + 1);
    assert.ok(Math.abs(pz.pearson(a, a)) > 0.999999);
    assert.ok(Math.abs(pz.pearson(a, b)) < 0.05);
    assert.ok(pz.rSquared(c, [a, b]) > 0.999999);
    assert.ok(pz.rSquared(b, [a]) < 0.01);
    assert.equal(pz.rSquared(a, []), 0);
  });

  test('Nelder–Mead finds the Rosenbrock minimum; scan1d a parabola', () => {
    const rosen = ([x, y]) => (1 - x) ** 2 + 100 * (y - x * x) ** 2;
    const r = pz.runSync(pz.nelderMead(rosen, [-1.2, 1], { step: 0.5, maxEvals: 2000, tolX: 1e-7, tolF: 1e-14 }));
    assert.ok(Math.abs(r.x[0] - 1) < 2e-3 && Math.abs(r.x[1] - 1) < 4e-3, JSON.stringify(Array.from(r.x)));
    const [a] = pz.runSync(pz.scan1d((v) => (v - 1.3) ** 2, -4, 4, 0.5));
    assert.ok(Math.abs(a - 1.3) < 1e-3);
  });

  test('tightenSearch finds an FMR-like α and skips noise and collinear copies', () => {
    const rng = mulberry32(7);
    const N = 20000, sM = 0.6, sS = 0.55;
    const uM = new Float64Array(N), uS = new Float64Array(N), uN = new Float64Array(N), uC = new Float64Array(N), Y = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const M = 10 + 0.6 * gauss(rng), S = 0.8 * (M - 10) + 0.4 * gauss(rng);
      const oh = 8.8 + 0.3 * Math.tanh(1.2 * (M - 0.32 * S - 10)) + 0.03 * gauss(rng);
      uM[i] = (M - 10) / sM;
      uS[i] = S / sS;
      uN[i] = i % 50 ? gauss(rng) : NaN;
      uC[i] = uS[i] + 0.05 * gauss(rng);
      Y[i] = (oh - 8.8) / 0.12;
    }
    const r = pz.runSync(pz.tightenSearch({
      Y, ref: 0, cols: [
        { key: 'logM', u: uM, w0: 1, current: true },
        { key: 'noise', u: uN, w0: 0 },
        { key: 'logSFR', u: uS, w0: 0 },
        { key: 'copy', u: uC, w0: 0 },
      ],
    }));
    assert.deepEqual(r.chosen.slice(0, 2), [0, 2]);
    assert.ok(!r.chosen.includes(1) && !r.chosen.includes(3));
    const alpha = -(r.coef[1] / sS) * sM;
    assert.ok(Math.abs(alpha - 0.32) < 0.04, `alpha ${alpha}`);
    assert.ok(r.sigma < 0.7 * r.sigma0);
    assert.equal(r.trace[0].key, 'logSFR');
    assert.ok(r.screen.length >= 2);
  });

  test('tightenSearch with nothing useful keeps the current direction', () => {
    const rng = mulberry32(12);
    const N = 4000;
    const u = Float64Array.from({ length: N }, () => gauss(rng));
    const noise = Float64Array.from({ length: N }, () => gauss(rng));
    const Y = Float64Array.from(u, (v) => v + 0.3 * gauss(rng));
    const r = pz.runSync(pz.tightenSearch({ Y, ref: 0, cols: [{ key: 'a', u, w0: 1, current: true }, { key: 'n', u: noise, w0: 0 }] }));
    assert.deepEqual(r.chosen, [0]);
    assert.ok(r.sigma <= r.sigma0);
  });
});
