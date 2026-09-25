// Unit tests for the pure projection math (DESIGN.md §10) and small stats/cosmo helpers.
// Run with: node --test site/tests/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import * as fm from '../js/math/frame.js';
import { mulberry32, dot, norm } from '../js/math/linalg.js';
import * as st from '../js/math/stats.js';
import { kpcPerArcsec, comovingDistance } from '../js/math/cosmo.js';

// A dimension table shaped like the manifest (§6), with realistic centers/scales.
const DIMS = [
  ['logM', 'log M★', 'M☉', 10.62, 0.58], ['logSFR', 'log SFR', 'M☉ yr⁻¹', -0.5, 0.8],
  ['logsSFR', 'log sSFR', 'yr⁻¹', -11.1, 0.9], ['D4000', 'Dₙ4000', '', 1.6, 0.25],
  ['HdA', 'HδA', 'Å', 0.5, 2.5], ['gr', '⁰·¹(g−r)', 'mag', 0.78, 0.12],
  ['OH', '12+log(O/H)', '', 8.94, 0.14], ['OH_PP04', '12+log(O/H)ᴼ³ᴺ²', '', 8.72, 0.12],
  ['logR50', 'log R₅₀', 'kpc', 0.55, 0.2], ['C', 'R₉₀/R₅₀', '', 2.6, 0.4],
  ['logSigma', 'log Σ★', 'M☉ kpc⁻²', 8.6, 0.5], ['ba', 'b/a', '', 0.7, 0.2],
  ['pEl', 'P(E)', '', 0.3, 0.3], ['logSigV', 'log σ', 'km s⁻¹', 2.1, 0.15],
  ['mu50', '⟨μ⟩₅₀', 'mag arcsec⁻²', 20.8, 0.8], ['logfHI', 'log M_HI/M★', '', 0.1, 0.5],
  ['logMh', 'log M_h', 'M☉', 12.4, 0.8], ['N2Ha', 'log [NII]/Hα', '', -0.35, 0.2],
  ['O3Hb', 'log [OIII]/Hβ', '', -0.1, 0.35], ['z', 'z', '', 0.1, 0.05],
].map(([key, label, unit, center, scale], index) => ({ key, label, unit, center, scale, index }));
const D = DIMS.length;
const I = Object.fromEntries(DIMS.map((d) => [d.key, d.index]));

const TOL = 1e-10;
const rng = mulberry32(12345);

function randomFrame(idx) {
  return fm.randomFrame(D, idx, rng);
}

function maxAbsDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

function proj(F, j) {
  return [F[j], F[D + j]];
}

/** Residual of vector v (length D) after projecting onto span of the given unit-ish vectors. */
function residualOutsideSpan(v, basis) {
  // Gram-Schmidt the basis first
  const Q = [];
  for (const b of basis) {
    const q = Float64Array.from(b);
    for (const p of Q) {
      const d = dot(q, p);
      for (let i = 0; i < D; i++) q[i] -= d * p[i];
    }
    const n = norm(q);
    if (n > 1e-9) {
      for (let i = 0; i < D; i++) q[i] /= n;
      Q.push(q);
    }
  }
  const r = Float64Array.from(v);
  for (const q of Q) {
    const d = dot(r, q);
    for (let i = 0; i < D; i++) r[i] -= d * q[i];
  }
  return norm(r);
}

const col = (F, c) => F.slice(c * D, c * D + D);
const e = (j) => { const v = new Float64Array(D); v[j] = 1; return v; };

describe('frame basics', () => {
  test('orthonormalize and polar produce orthonormal frames', () => {
    for (let k = 0; k < 50; k++) {
      const F = new Float64Array(2 * D).map(() => rng() - 0.5);
      const G = fm.orthonormalize(Float64Array.from(F));
      assert.ok(fm.orthonormalityError(G) < TOL);
      const P = fm.polarOrthonormalize(Float64Array.from(F));
      assert.ok(fm.orthonormalityError(P) < TOL);
    }
    // degenerate inputs still give a valid frame
    assert.ok(fm.isOrthonormal(fm.orthonormalize(new Float64Array(2 * D))));
    const same = new Float64Array(2 * D); same[3] = 1; same[D + 3] = 1;
    assert.ok(fm.isOrthonormal(fm.orthonormalize(same)));
  });

  test('randomFrame stays inside the requested subspace', () => {
    const idx = [I.logM, I.OH, I.logR50, I.C];
    for (let k = 0; k < 20; k++) {
      const F = randomFrame(idx);
      assert.ok(fm.isOrthonormal(F, TOL));
      for (let i = 0; i < D; i++) {
        if (idx.includes(i)) continue;
        assert.equal(F[i], 0);
        assert.equal(F[D + i], 0);
      }
    }
  });

  test('fade factors and visibility', () => {
    const F = fm.basisFrame(D, I.logM, I.OH);
    const f = fm.fadeFactors(F);
    assert.equal(f[I.logM], 0);
    assert.equal(f[I.OH], 0);
    assert.equal(f[I.z], 1);
    const G = new Float64Array(2 * D);
    G[I.logM] = Math.sqrt(1 - 0.06 * 0.06); G[I.OH] = 0.06; G[D + I.gr] = 1;
    const g = fm.fadeFactors(G);
    assert.ok(Math.abs(g[I.OH] - 0.5) < 1e-12);
    // visibility multiplies over missing dims only
    const mask = (1 << I.OH) | (1 << I.z);
    assert.ok(Math.abs(fm.visibility(mask, g) - 0.5) < 1e-12);
    assert.equal(fm.visibility(0, g), 1);
    assert.equal(fm.visibility(1 << I.logM, g), 0);
  });
});

describe('manual rotation (Cook & Buja)', () => {
  test('orthonormal, target reached, stays in span(F, e_j)', () => {
    for (let k = 0; k < 400; k++) {
      const F = randomFrame(k % 3 === 0 ? [0, 2, 6, 8, 9, 5, 3, 13, 16] : null);
      const j = Math.floor(rng() * D);
      const r = Math.sqrt(rng() * 0.99), t = rng() * 2 * Math.PI;
      const target = [r * Math.cos(t), r * Math.sin(t)];
      const G = fm.manualRotate(F, j, target);
      assert.ok(fm.orthonormalityError(G) < 1e-10, 'orthonormal');
      const [a, b] = proj(G, j);
      assert.ok(Math.abs(a - target[0]) < 1e-9 && Math.abs(b - target[1]) < 1e-9, `target reached (${a},${b}) vs ${target}`);
      const span = [col(F, 0), col(F, 1), e(j)];
      assert.ok(residualOutsideSpan(col(G, 0), span) < 1e-9);
      assert.ok(residualOutsideSpan(col(G, 1), span) < 1e-9);
    }
  });

  test('targets beyond the rim are clamped to a′²+b′² = 0.995', () => {
    const F = randomFrame();
    const G = fm.manualRotate(F, I.gr, [3, 4]);
    const [a, b] = proj(G, I.gr);
    assert.ok(Math.abs(a * a + b * b - 0.995) < 1e-9);
    assert.ok(Math.abs(Math.atan2(b, a) - Math.atan2(4, 3)) < 1e-9);
  });

  test('bringing in a dimension that is out of view', () => {
    const F = fm.basisFrame(D, I.logM, I.OH);
    const G = fm.manualRotate(F, I.logSFR, [0.3, -0.4]);
    assert.ok(fm.isOrthonormal(G, 1e-10));
    const [a, b] = proj(G, I.logSFR);
    assert.ok(Math.abs(a - 0.3) < 1e-12 && Math.abs(b + 0.4) < 1e-12);
    // only the three involved dims are touched
    for (let i = 0; i < D; i++) {
      if ([I.logM, I.OH, I.logSFR].includes(i)) continue;
      assert.equal(G[i], 0);
      assert.equal(G[D + i], 0);
    }
  });

  test('dimension in the plane: rim target rotates in-plane, inner target tilts', () => {
    const F = fm.basisFrame(D, I.logM, I.OH);
    const G = fm.manualRotate(F, I.logM, [0, 1]);   // on the rim → in-plane quarter turn
    assert.ok(fm.isOrthonormal(G, 1e-12));
    assert.ok(Math.abs(G[D + I.logM] - 1) < 1e-12);
    assert.ok(fm.frameDistance(F, G) < 1e-7, 'plane unchanged');
    const H = fm.manualRotate(F, I.logM, [0.6, 0.2], { prefer: [I.logsSFR] });
    assert.ok(fm.isOrthonormal(H, 1e-10));
    const [a, b] = proj(H, I.logM);
    assert.ok(Math.abs(a - 0.6) < 1e-12 && Math.abs(b - 0.2) < 1e-12);
    const w = fm.dimWeights(H);
    assert.ok(w[I.logsSFR] > 0.1, 'preferred dimension brought in');
    for (let i = 0; i < D; i++) if (![I.logM, I.OH, I.logsSFR].includes(i)) assert.ok(w[i] < 1e-12);
  });

  test('small drags make small changes (continuity)', () => {
    const F = randomFrame();
    const j = 4;
    const [a, b] = proj(F, j);
    const G = fm.manualRotate(F, j, [a + 1e-4, b - 1e-4]);
    assert.ok(maxAbsDiff(F, G) < 1e-3);
  });
});

describe('geodesic interpolation', () => {
  function checkPath(Fa, Fb, opts = {}) {
    const g = fm.geodesic(Fa, Fb, opts);
    const end = opts.noSpin ? g.target : Fb;
    assert.deepEqual(Array.from(g.at(0)), Array.from(Fa), 'F(0) = Fa exactly');
    assert.deepEqual(Array.from(g.at(1)), Array.from(end), 'F(1) = Fb exactly');
    let prev = g.at(0);
    let maxStep = 0;
    for (let k = 1; k <= 200; k++) {
      const t = k / 200;
      const Ft = g.at(t);
      assert.ok(fm.orthonormalityError(Ft) < 1e-10, `orthonormal at t=${t}`);
      maxStep = Math.max(maxStep, maxAbsDiff(prev, Ft));
      prev = Ft;
    }
    // continuity: each step moves entries by at most ~ (path length)/200 (loose bound)
    const bound = 4 * (g.dist + Math.abs(g.spin) + 0.05) / 200 + 1e-9;
    assert.ok(maxStep <= bound, `continuous path (step ${maxStep} > ${bound})`);
    // approaching the end is continuous as well
    assert.ok(maxAbsDiff(g.at(1 - 1e-7), end) < 1e-5);
    return g;
  }

  test('random pairs: endpoints exact, orthonormal throughout', () => {
    for (let k = 0; k < 60; k++) checkPath(randomFrame(), randomFrame());
  });

  test('tour-set frames', () => {
    const idx = [I.logM, I.logsSFR, I.OH, I.logR50, I.C, I.gr, I.D4000, I.logSigV, I.logMh];
    for (let k = 0; k < 30; k++) checkPath(randomFrame(idx), randomFrame(idx));
  });

  test('identical frames and pure in-plane rotation', () => {
    const F = randomFrame();
    const g = checkPath(F, F);
    assert.ok(g.dist < 1e-7 && Math.abs(g.spin) < 1e-7);
    // in-plane rotation by 70°
    const a = (70 * Math.PI) / 180;
    const G = new Float64Array(2 * D);
    for (let i = 0; i < D; i++) {
      G[i] = Math.cos(a) * F[i] - Math.sin(a) * F[D + i];
      G[D + i] = Math.sin(a) * F[i] + Math.cos(a) * F[D + i];
    }
    const h = checkPath(F, G);
    assert.ok(h.dist < 1e-6, 'same plane');
    assert.ok(Math.abs(Math.abs(h.spin) - a) < 1e-7, 'spin = 70°');
    // the plane never changes along an in-plane rotation
    for (const t of [0.25, 0.5, 0.75]) assert.ok(fm.frameDistance(F, h.at(t)) < 1e-6);
  });

  test('orientation reversals (flipped axis, swapped axes) stay orthonormal', () => {
    const MZR = fm.basisFrame(D, I.logM, I.OH);
    const flip = fm.basisFrame(D, I.logM, I.OH); flip[D + I.OH] = -1;
    const swap = fm.basisFrame(D, I.OH, I.logM);
    const g1 = checkPath(MZR, flip, { prefer: [I.z] });
    assert.ok(Math.abs(g1.angles[1] - Math.PI) < 1e-9, 'flip passes a 180° principal angle');
    // the flip goes through the preferred dimension
    assert.ok(fm.dimWeights(g1.at(0.5))[I.z] > 0.99);
    checkPath(MZR, swap);
    // random frame vs its reflection
    for (let k = 0; k < 20; k++) {
      const F = randomFrame();
      const R = Float64Array.from(F);
      for (let i = 0; i < D; i++) R[D + i] = -R[D + i];
      checkPath(F, R);
      const S = new Float64Array(2 * D);
      S.set(F.subarray(D), 0); S.set(F.subarray(0, D), D);
      checkPath(F, S);
    }
  });

  test('orthogonal planes (MZR → BPT) rotate through 90° principal angles', () => {
    const MZR = fm.basisFrame(D, I.logM, I.OH);
    const BPT = fm.basisFrame(D, I.N2Ha, I.O3Hb);
    const g = checkPath(MZR, BPT);
    assert.ok(Math.abs(g.angles[0] - Math.PI / 2) < 1e-9 && Math.abs(g.angles[1] - Math.PI / 2) < 1e-9);
    const mid = g.at(0.5);
    const w = fm.dimWeights(mid);
    for (const k of ['logM', 'OH', 'N2Ha', 'O3Hb']) assert.ok(Math.abs(w[I[k]] - Math.SQRT1_2) < 1e-9);
  });

  test('noSpin legs: same plane as the target, zero spin, constant angular speed', () => {
    for (let k = 0; k < 20; k++) {
      const Fa = randomFrame(), Fb = randomFrame();
      const g = checkPath(Fa, Fb, { noSpin: true });
      assert.equal(g.spin, 0);
      assert.ok(fm.frameDistance(g.target, Fb) < 1e-6);
      for (const t of [0.2, 0.5, 0.8]) {
        const d = fm.frameDistance(Fa, g.at(t));
        assert.ok(Math.abs(d - t * g.dist) < 1e-6, `distance grows linearly (t=${t})`);
      }
    }
  });

  test('blend fallback is orthonormal when not degenerate', () => {
    const Fa = randomFrame(), Fb = randomFrame();
    for (const t of [0, 0.3, 0.7, 1]) assert.ok(fm.isOrthonormal(fm.blendFrames(Fa, Fb, t), 1e-10));
  });
});

describe('physical combos, labels and ticks', () => {
  test('frameFromCombos builds x then Gram–Schmidt y', () => {
    const { F } = fm.frameFromCombos({ logM: 1 }, { OH: 1 }, DIMS);
    assert.deepEqual(Array.from(F), Array.from(fm.basisFrame(D, I.logM, I.OH)));
    const fmr = fm.frameFromCombos({ logM: 1, logSFR: -0.32 }, { OH_PP04: 1 }, DIMS).F;
    const vx = [0.58, -0.32 * 0.8];
    const n = Math.hypot(...vx);
    assert.ok(Math.abs(fmr[I.logM] - vx[0] / n) < 1e-12 && Math.abs(fmr[I.logSFR] - vx[1] / n) < 1e-12);
    // non-orthogonal request: y is orthogonalized, x kept exactly
    const { F: G } = fm.frameFromCombos({ logM: 1 }, { logM: 0.5, OH: 1 }, DIMS);
    assert.ok(fm.isOrthonormal(G, 1e-12));
    assert.equal(G[I.logM], 1);
    assert.ok(Math.abs(G[D + I.logM]) < 1e-12 && Math.abs(G[D + I.OH] - 1) < 1e-12);
    // degenerate and empty requests
    assert.equal(fm.frameFromCombos({ logM: 1 }, { logM: -2 }, DIMS).degenerate, true);
    assert.equal(fm.frameFromCombos({ nope: 1 }, { OH: 1 }, DIMS).degenerate, true);
  });

  test('frame → combos → frame round trip (orientation preserved)', () => {
    for (let k = 0; k < 50; k++) {
      const F = randomFrame();
      if (k % 2) for (let i = 0; i < D; i++) F[i] = -F[i];
      const { x, y } = fm.frameToCombos(F, DIMS);
      const { F: G } = fm.frameFromCombos(x, y, DIMS);
      assert.ok(maxAbsDiff(F, G) < 1e-9);
    }
    // keeping x while replacing y
    const F = randomFrame();
    const x = fm.columnCombo(F, 0, DIMS);
    const { F: G } = fm.frameFromCombos(x, { gr: 1 }, DIMS);
    assert.ok(maxAbsDiff(F.subarray(0, D), G.subarray(0, D)) < 1e-12);
    // reference coefficient is ±1
    const c = fm.columnCombo(F, 1, DIMS);
    const maxAbs = Math.max(...Object.values(c).map((v, i) => Math.abs(F[D + I[Object.keys(c)[i]]])));
    const refKey = Object.keys(c).find((key) => Math.abs(F[D + I[key]]) === maxAbs);
    assert.ok(Math.abs(Math.abs(c[refKey]) - 1) < 1e-12);
  });

  test('axis value round trip: A = Σ κ_d x_d = (X + Σ k_d c_d)/k_r', () => {
    for (let k = 0; k < 100; k++) {
      const F = randomFrame();
      const info = fm.axisInfo(F, k % 2, DIMS);
      assert.equal(info.kappa[info.ref], 1);
      // a random galaxy in physical units
      const x = DIMS.map((d) => d.center + d.scale * (rng() * 4 - 2));
      const u = x.map((v, i) => (v - DIMS[i].center) / DIMS[i].scale);
      const X = dot(u, F, D, 0, (k % 2) * D);
      const A = x.reduce((s, v, i) => s + info.kappa[i] * v, 0);
      assert.ok(Math.abs(fm.axisValue(info, X) - A) < 1e-9);
      assert.ok(Math.abs(fm.axisPosition(info, A) - X) < 1e-9);
    }
  });

  test('axis labels', () => {
    const mzr = fm.frameFromCombos({ logM: 1 }, { OH: 1 }, DIMS).F;
    assert.equal(fm.axisLabel(fm.axisInfo(mzr, 0, DIMS), DIMS), 'log M★ [M☉]');
    assert.equal(fm.axisLabel(fm.axisInfo(mzr, 1, DIMS), DIMS), '12+log(O/H)');
    const fmr = fm.frameFromCombos({ logM: 1, logSFR: -0.32 }, { OH_PP04: 1 }, DIMS).F;
    assert.equal(fm.axisLabel(fm.axisInfo(fmr, 0, DIMS), DIMS), 'log M★ − 0.32 log SFR');
    // ref term leads even when listed second; tiny terms are omitted
    const G = fm.frameFromCombos({ logSFR: 0.2, logM: 1, z: 0.01 }, { OH: 1 }, DIMS).F;
    const info = fm.axisInfo(G, 0, DIMS);
    assert.equal(info.refKey, 'logM');
    assert.equal(fm.axisLabel(info, DIMS), 'log M★ + 0.20 log SFR');
    // flipped single axis still reads as the physical quantity
    const flip = fm.basisFrame(D, I.logM, I.OH); flip[I.logM] = -1;
    const fi = fm.axisInfo(flip, 0, DIMS);
    assert.ok(fi.kr < 0);
    assert.equal(fm.axisLabel(fi, DIMS), 'log M★ [M☉]');
  });

  test('axis ticks are nice, in range and map back to A', () => {
    const mzr = fm.frameFromCombos({ logM: 1 }, { OH: 1 }, DIMS).F;
    const info = fm.axisInfo(mzr, 0, DIMS);
    const X0 = fm.axisPosition(info, 8.7), X1 = fm.axisPosition(info, 11.9);
    const ticks = fm.axisTicks(info, X0, X1, { count: 6 });
    assert.deepEqual(ticks.map((t) => t.text), ['9.0', '9.5', '10.0', '10.5', '11.0', '11.5']);
    for (const t of ticks) {
      assert.ok(t.X >= X0 - 1e-9 && t.X <= X1 + 1e-9);
      assert.ok(Math.abs(fm.axisValue(info, t.X) - t.A) < 1e-9);
    }
    // flipped axis: A decreases with X, ticks still sorted by X
    const flip = fm.basisFrame(D, I.logM, I.OH); flip[I.logM] = -1;
    const fi = fm.axisInfo(flip, 0, DIMS);
    const ft = fm.axisTicks(fi, -3, 3);
    for (let k = 1; k < ft.length; k++) {
      assert.ok(ft[k].X > ft[k - 1].X);
      assert.ok(ft[k].A < ft[k - 1].A);
    }
    // negative values use a unicode minus
    const s = fm.frameFromCombos({ logsSFR: 1 }, { OH: 1 }, DIMS).F;
    const si = fm.axisInfo(s, 0, DIMS);
    const st2 = fm.axisTicks(si, fm.axisPosition(si, -12.5), fm.axisPosition(si, -9.5), { count: 6 });
    assert.equal(st2[0].text, '−12.5');
    assert.equal(fm.niceStep(0.37), 0.5);
    assert.equal(fm.niceStep(0.13), 0.1);
    assert.equal(fm.niceStep(0.17), 0.2);
    assert.equal(fm.niceStep(7), 5);
    assert.equal(fm.niceStep(8), 10);
  });
});

describe('alignment and native mapping', () => {
  test('alignment, literature opacity and view alignment', () => {
    const mzr = fm.frameFromCombos({ logM: 1 }, { OH: 1 }, DIMS).F;
    assert.equal(fm.alignment({ logM: 1 }, mzr, 0, DIMS), 1);
    assert.equal(fm.literatureOpacity({ logM: 1 }, { OH: 1 }, mzr, DIMS), 1);
    assert.equal(fm.literatureOpacity({ logM: 1 }, { OH_PP04: 1 }, mzr, DIMS), 0);
    // rotate the y axis 10° toward logSFR: min alignment cos 10° = 0.985 → still visible
    const rot = (deg) => {
      const G = fm.basisFrame(D, I.logM, I.OH);
      const a = (deg * Math.PI) / 180;
      G[D + I.OH] = Math.cos(a); G[D + I.logSFR] = Math.sin(a);
      return G;
    };
    assert.ok(fm.literatureOpacity({ logM: 1 }, { OH: 1 }, rot(9), DIMS) > 0.99);
    assert.equal(fm.literatureOpacity({ logM: 1 }, { OH: 1 }, rot(30), DIMS), 0);
    const mid = fm.literatureOpacity({ logM: 1 }, { OH: 1 }, rot(19), DIMS);
    assert.ok(mid > 0 && mid < 1);
    // flipped axes are still "aligned" for literature, but not the same view
    const flip = fm.basisFrame(D, I.logM, I.OH); flip[D + I.OH] = -1;
    assert.equal(fm.literatureOpacity({ logM: 1 }, { OH: 1 }, flip, DIMS), 1);
    assert.equal(fm.viewAlignment({ logM: 1 }, { OH: 1 }, flip, DIMS), -1);
    assert.equal(fm.viewAlignment({ logM: 1 }, { OH: 1 }, mzr, DIMS), 1);
  });

  test('native curve points land where galaxies with those values project', () => {
    const frames = [
      fm.frameFromCombos({ logM: 1 }, { OH: 1 }, DIMS).F,
      (() => { const G = fm.basisFrame(D, I.logM, I.OH); G[I.logM] = -1; return G; })(),
      fm.manualRotate(fm.basisFrame(D, I.logM, I.OH), I.logSFR, [0.1, 0.05]),
    ];
    for (const F of frames) {
      const map = fm.nativeMap({ logM: 1 }, { OH: 1 }, F, DIMS);
      for (const [m, oh] of [[9.5, 8.6], [10.5, 9.0], [11.2, 9.1]]) {
        const u = new Float64Array(D);
        u[I.logM] = (m - DIMS[I.logM].center) / DIMS[I.logM].scale;
        u[I.OH] = (oh - DIMS[I.OH].center) / DIMS[I.OH].scale;
        const [X, Y] = map.toFrame(m, oh);
        assert.ok(Math.abs(X - dot(u, F, D, 0, 0)) < 1e-12);
        assert.ok(Math.abs(Y - dot(u, F, D, 0, D)) < 1e-12);
      }
    }
    // combined native axis: X_native = (A_x − Σκc)/|v_x|
    const fmr = fm.frameFromCombos({ logM: 1, logSFR: -0.32 }, { OH_PP04: 1 }, DIMS).F;
    const map = fm.nativeMap({ logM: 1, logSFR: -0.32 }, { OH_PP04: 1 }, fmr, DIMS);
    const Ax = 10.2, Ay = 8.8;
    const [X] = map.toFrame(Ax, Ay);
    const nx = Math.hypot(0.58, 0.32 * 0.8);
    assert.ok(Math.abs(X - (Ax - (10.62 - 0.32 * -0.5)) / nx) < 1e-12);
    assert.equal(map.opacity, 1);
  });
});

describe('stats and cosmology helpers', () => {
  test('quantiles and percentile tables', () => {
    const vals = Float64Array.from({ length: 1001 }, (_, i) => i / 10);
    assert.equal(st.quantiles(vals, [0.5])[0], 50);
    const qtab = Array.from({ length: 101 }, (_, i) => i * 0.1);
    assert.ok(Math.abs(st.percentileFromQuantiles(qtab, 2.55) - 25.5) < 1e-9);
    assert.ok(Math.abs(st.valueFromQuantiles(qtab, 25.5) - 2.55) < 1e-9);
    assert.equal(st.percentileFromQuantiles(qtab, -1), 0);
    assert.equal(st.percentileFromQuantiles(qtab, 99), 100);
    const flat = [0, ...Array(99).fill(1), 2];
    assert.ok(Math.abs(st.percentileFromQuantiles(flat, 1) - 50) < 1e-9);
    assert.ok(Math.abs(st.robustScatter(Float64Array.from({ length: 20001 }, (_, i) => (i - 10000) / 10000)) - 1.4826 * 0.5) < 1e-3);
  });

  test('running quantiles recover a linear trend', () => {
    const n = 20000;
    const xs = new Float64Array(n), ys = new Float64Array(n);
    for (let i = 0; i < n; i++) { xs[i] = rng() * 10; ys[i] = 2 * xs[i] + (rng() - 0.5); }
    const r = st.runningQuantiles(xs, ys, { bins: 10, range: [0, 10] });
    for (let b = 0; b < 10; b++) assert.ok(Math.abs(r.q[1][b] - 2 * r.centers[b]) < 0.1);
    const h = st.hist2d(xs, ys, { nx: 10, ny: 10, x0: 0, x1: 10, y0: -1, y1: 21 });
    assert.equal(h.reduce((a, b) => a + b, 0), n);
  });

  test('flat ΛCDM (H0=70, Ωm=0.3) matches astropy', () => {
    const ref = [[0.01, 0.2051142], [0.05, 0.9774946], [0.1, 1.8442951], [0.2, 3.2996550], [0.3, 4.4543073], [1.0, 8.0087070]];
    for (const [z, v] of ref) assert.ok(Math.abs(kpcPerArcsec(z) / v - 1) < 1e-5, `z=${z}`);
    assert.ok(Math.abs(comovingDistance(0.1) - 418.4544876) < 1e-3);
  });
});

// ---------------------------------------------------------------------------------------
// Other pure modules the app is built on (loader helpers, projection kernel, camera, store)
// ---------------------------------------------------------------------------------------
import * as ld from '../js/data/loader.js';
import * as kn from '../js/workers/kernel.js';
import { Camera, fitParams, cubicBezier } from '../js/view/camera.js';
import { Store } from '../js/state.js';

function synthManifest(n) {
  const dims = DIMS.slice(0, 6).map((d) => ({ ...d, min: d.center - 6 * d.scale, max: d.center + 6 * d.scale, quantiles: Array.from({ length: 101 }, (_, i) => d.center + d.scale * (i - 50) / 25), file: `dims/${d.key}.u16.gz` }));
  return { n, dims, categories: [{ key: 'bpt', label: 'BPT', codes: [{ code: 1, label: 'SF' }, { code: 4, label: 'Sy' }] }, { key: 'env', codes: { 1: 'iso', 3: { label: 'sat', color: '#b07aa1' } } }] };
}

function quantize(x, lo, hi) {
  if (!Number.isFinite(x) || x < lo || x > hi) return 0;
  return 1 + Math.round(((x - lo) / (hi - lo)) * 65534);
}

describe('data loader helpers', () => {
  test('resolveBase keeps dataset paths inside the site', () => {
    assert.equal(ld.resolveBase('data-synth'), 'data-synth');
    assert.equal(ld.resolveBase('data/'), 'data');
    for (const bad of ['', null, '../secret', 'https://evil.org/x', '//cdn', '/etc', 'a\\b', 'a b']) assert.equal(ld.resolveBase(bad), 'data');
  });

  test('byte unshuffle and gzip sniffing (gzip or already-decompressed bytes)', async () => {
    const v = Uint16Array.from([0, 1, 65535, 258, 4097]);
    const n = v.length;
    const s = new Uint8Array(2 * n);
    for (let i = 0; i < n; i++) { s[i] = v[i] & 255; s[n + i] = v[i] >> 8; }
    assert.deepEqual(Array.from(ld.unshuffleU16(s, n)), Array.from(v));
    assert.throws(() => ld.unshuffleU16(s.subarray(1), n));
    const gz = new Uint8Array(await new Response(new Blob([s]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    assert.ok(ld.isGzip(gz));
    assert.deepEqual(Array.from(await ld.gunzipIfNeeded(gz)), Array.from(s));
    assert.equal(await ld.gunzipIfNeeded(s), s);   // plain bytes pass through untouched
  });

  test('CatSpec normalization accepts arrays and maps of codes', () => {
    const a = ld.normalizeCatSpec({ key: 'bpt', codes: [{ code: 4, label: 'Sy' }, { code: 1, label: 'SF' }] }, 0);
    assert.deepEqual(a.codes.map((c) => c.code), [1, 4]);
    assert.equal(a.slot, 0);
    assert.equal(a.file, 'cats/bpt.u8.gz');
    const b = ld.normalizeCatSpec({ key: 'env', codes: { 1: 'iso', 3: { label: 'sat', color: '#b07aa1' } } }, 1);
    assert.deepEqual(b.codes.map((c) => [c.code, c.label]), [[1, 'iso'], [3, 'sat']]);
    assert.equal(b.codes[1].color, '#b07aa1');
    assert.equal(ld.normalizeCatSpec({ key: 'x', codes: ['a', 'b'] }, 4).slot, -1);
  });

  test('Dataset decoding: value, ustd, column, percentile and the shader constants', () => {
    const n = 5;
    const ds = new ld.Dataset(synthManifest(n), 'data');
    const d = ds.dims[0];
    const xs = [10.1, NaN, d.min, d.max, 99];
    ds.raw[0] = Uint16Array.from(xs.map((x) => quantize(x, d.min, d.max)));
    assert.ok(Math.abs(ds.value(0, 'logM') - 10.1) < (d.max - d.min) / 65534);
    assert.ok(Number.isNaN(ds.value(1, 'logM')) && Number.isNaN(ds.value(4, 0)));
    assert.ok(Math.abs(ds.value(2, 0) - d.min) < 1e-12 && Math.abs(ds.value(3, 0) - d.max) < 1e-9);
    assert.ok(Math.abs(ds.ustd(0, 'logM') - (ds.value(0, 0) - d.center) / d.scale) < 1e-12);
    const col = ds.column('logM');
    assert.ok(Math.abs(col[0] - ds.value(0, 0)) < 1e-5 && Number.isNaN(col[1]));
    assert.equal(ds.raw.logM, ds.raw[0]);
    // shader decode u = A·(v/65535) + B equals the integer decode
    for (const v of [1, 2, 30000, 65535]) {
      const u1 = d.A * (v / 65535) + d.B, u2 = v * d.ua + d.ub;
      assert.ok(Math.abs(u1 - u2) < 1e-9);
    }
    assert.ok(Math.abs(ds.percentile('logM', d.center) - 50) < 1e-9);
    assert.equal(ds.dimIndex('nope'), -1);
    assert.equal(ds.catSpec('env').codes.length, 2);
  });
});

describe('projection kernel', () => {
  // small dataset with missing values and categories
  const n = 3000, D = DIMS.length;
  const r = mulberry32(7);
  const raw = [], ua = new Float64Array(D), ub = new Float64Array(D);
  const phys = [];
  for (let d = 0; d < D; d++) {
    const s = DIMS[d];
    const lo = s.center - 6 * s.scale, hi = s.center + 6 * s.scale, step = (hi - lo) / 65534;
    ua[d] = step / s.scale;
    ub[d] = (lo - step - s.center) / s.scale;
    const col = new Uint16Array(n), x = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = r() < (d === 6 ? 0.7 : 0.05) ? NaN : s.center + s.scale * (r() * 4 - 2);
      col[i] = quantize(x[i], lo, hi);
      x[i] = col[i] ? lo + (col[i] - 1) * step : NaN;
    }
    raw.push(col);
    phys.push(x);
  }
  const bpt = Uint8Array.from({ length: n }, () => Math.floor(r() * 8));
  const ctx = { n, D, raw, ua, ub, cats: [bpt, null, null, null] };

  test('projectRange matches the direct projection, fade and filters', () => {
    const F = fm.manualRotate(fm.basisFrame(D, 0, 1), 6, [0.05, 0.03]);   // O/H partly in view
    const fade = fm.fadeFactors(F);
    const zd = 19, zlo = -0.5, zhi = 0.8;
    const masks = Uint32Array.from([0xff & ~(1 << 3), 0xffffffff, 0xffffffff, 0xffffffff]);
    const out = { X: new Float32Array(n), Y: new Float32Array(n), vis: new Uint8Array(n), visf: new Float32Array(n) };
    kn.projectRange(ctx, { F, fade, zDim: zd, zlo, zhi, masks }, out, 0, n);
    let checked = 0;
    for (let i = 0; i < n; i++) {
      let X = 0, Y = 0, v = 1, miss = 0;
      for (let d = 0; d < D; d++) {
        const x = phys[d][i];
        if (Number.isNaN(x)) { miss |= 1 << d; continue; }
        const u = (x - DIMS[d].center) / DIMS[d].scale;
        X += F[d] * u;
        Y += F[D + d] * u;
      }
      v = fm.visibility(miss, fade);
      const zu = (phys[zd][i] - DIMS[zd].center) / DIMS[zd].scale;
      if (Number.isNaN(zu) || zu < zlo || zu > zhi || bpt[i] === 3) v = 0;
      assert.ok(Math.abs(out.X[i] - X) < 1e-4 && Math.abs(out.Y[i] - Y) < 1e-4);
      const expect = v < kn.VIS_MIN ? 0 : Math.max(1, Math.round(255 * v));
      assert.equal(out.vis[i], expect);
      if (expect) checked++;
    }
    assert.ok(checked > 200);
  });

  test('projectRange needDim hides exactly the rows missing that dim', () => {
    const F = fm.basisFrame(D, 0, 1);
    const fade = fm.fadeFactors(F);
    const masks = new Uint32Array(4).fill(0xffffffff);
    const mk = () => ({ X: new Float32Array(n), Y: new Float32Array(n), vis: new Uint8Array(n), visf: new Float32Array(n) });
    const all = mk(), need = mk();
    kn.projectRange(ctx, { F, fade, zDim: -1, masks, needDim: -1 }, all, 0, n);
    kn.projectRange(ctx, { F, fade, zDim: -1, masks, needDim: 6 }, need, 0, n);
    let hidden = 0;
    for (let i = 0; i < n; i++) {
      if (raw[6][i] === 0) {
        assert.equal(need.vis[i], 0);
        if (all.vis[i]) hidden++;
      } else assert.equal(need.vis[i], all.vis[i]);
    }
    assert.ok(hidden > 50);
  });

  test('pick grid holds every visible point exactly once', () => {
    const F = fm.basisFrame(D, 0, 2);
    const out = { X: new Float32Array(n), Y: new Float32Array(n), vis: new Uint8Array(n), visf: new Float32Array(n) };
    kn.projectRange(ctx, { F, fade: fm.fadeFactors(F), zDim: -1, masks: new Uint32Array(4).fill(0xffffffff) }, out, 0, n);
    const g = kn.buildGrid(out.X, out.Y, out.vis, n, 32);
    const seen = new Uint8Array(n);
    for (let c = 0; c < 32 * 32; c++) for (let k = g.start[c]; k < g.start[c + 1]; k++) seen[g.items[k]]++;
    for (let i = 0; i < n; i++) assert.equal(seen[i], out.vis[i] ? 1 : 0);
  });

  test('exposure helpers: uniform density gives ref = K × density × sprite integral', () => {
    const cam = { cx: 0, cy: 0, scale: 100, aspect: 1, width: 400, height: 400 };
    const m = 40000;
    const X = new Float32Array(m), Y = new Float32Array(m), V = new Float32Array(m).fill(1);
    for (let i = 0; i < m; i++) { X[i] = r() * 4 - 2; Y[i] = r() * 4 - 2; }   // fills the view
    const H = kn.makeHist(cam);
    const inView = kn.histAdd(H, cam, X, Y, V, 0, m);
    assert.equal(inView, m);
    const ref = kn.refFromHist(H, inView, m, m, 6, 1);
    const density = m / (400 * 400);
    // p95 of Poisson(λ) bin counts ≈ λ + 1.645 √λ, with λ = 16 galaxies per 8×8 px bin
    const lam = m / 2500;
    const expect = kn.EXPOSURE_K * density * kn.spriteIntegral(6) * (lam + 1.645 * Math.sqrt(lam)) / lam;
    assert.ok(Math.abs(ref / expect - 1) < 0.08, `ref ${ref} vs ${expect}`);
    // a sparse subsample of the same density merges bins instead of inflating the estimate
    const sub = 4000;
    const H2 = kn.makeHist(cam);
    const n2 = kn.histAdd(H2, cam, X, Y, V, 0, sub);
    const ref2 = kn.refFromHist(H2, n2, sub, m, 6, 1);   // scaled to the full m rows
    const lam2 = (sub / 2500) * 16;                        // per 32×32 px bin after merging
    const expect2 = kn.EXPOSURE_K * density * kn.spriteIntegral(6) * (lam2 + 1.645 * Math.sqrt(lam2)) / lam2;
    assert.ok(Math.abs(ref2 / expect2 - 1) < 0.15, `sparse ref ${ref2} vs ${expect2}`);
    assert.equal(kn.refFromHist(kn.makeHist(cam), 3, m, m, 6, 1), null);
  });
});

describe('camera and store', () => {
  test('screen/data round trip, zoom anchor, anisotropic fit', () => {
    const c = new Camera();
    c.resize(1000, 600, 2);
    c.set({ cx: 1, cy: -2, scale: 150, aspect: 0.5 });
    const [sx, sy] = c.toScreen(0.3, -1.7);
    const [X, Y] = c.toData(sx, sy);
    assert.ok(Math.abs(X - 0.3) < 1e-12 && Math.abs(Y + 1.7) < 1e-12);
    const before = c.toData(640, 211);
    c.zoomAt(640, 211, 1.7);
    const after = c.toData(640, 211);
    assert.ok(Math.abs(before[0] - after[0]) < 1e-12 && Math.abs(before[1] - after[1]) < 1e-12);
    // a wide box fills the width; aspect bounded by maxAspect
    const p = fitParams([-4, 4, -1, 1], 1000, 600, { pad: 0, maxAspect: 2 });
    assert.ok(Math.abs(p.scale * 8 - 1000) < 1e-9);
    assert.ok(p.aspect <= 2 + 1e-12 && p.aspect >= 0.5 - 1e-12);
    const iso = fitParams([-4, 4, -1, 1], 1000, 600, { pad: 0, maxAspect: 1 });
    assert.equal(iso.aspect, 1);
    // the fitted box is centered in the safe area
    const safe = { left: 100, right: 0, top: 0, bottom: 100 };
    const q = fitParams([0, 2, 0, 2], 1000, 600, { pad: 0, safe, maxAspect: 1 });
    const cc = new Camera(); cc.resize(1000, 600); cc.set(q);
    const [mx, my] = cc.toScreen(1, 1);
    assert.ok(Math.abs(mx - 550) < 1e-9 && Math.abs(my - 250) < 1e-9);
    const ease = cubicBezier(0.65, 0, 0.35, 1);
    assert.equal(ease(0), 0); assert.equal(ease(1), 1);
    assert.ok(Math.abs(ease(0.5) - 0.5) < 1e-6 && ease(0.25) < 0.25);
  });

  test('store deep-merges plain objects and reports changed keys', () => {
    const s = new Store({ filters: { z: null, cats: { bpt: 255, env: 255 } }, color: null, sel: null });
    const seen = [];
    s.subscribe((st, changed) => seen.push(changed));
    s.set({ filters: { cats: { bpt: 2 } } });
    assert.deepEqual(s.get().filters, { z: null, cats: { bpt: 2, env: 255 } });
    assert.deepEqual(seen.pop(), ['filters']);
    assert.deepEqual(s.set({ color: null }), []);          // no change, no notification
    const mask = new Uint8Array(3);
    s.set({ sel: { mask, count: 0 } });
    assert.equal(s.get().sel.mask, mask);                  // typed arrays are kept by reference
    s.set({ filters: { z: [0.02, 0.05] } });
    assert.deepEqual(s.get().filters.z, [0.02, 0.05]);
  });
});
