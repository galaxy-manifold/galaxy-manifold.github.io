// app.pursuit.tighten(opts) (§15): keep y fixed and search x within the span of the current x
// dims plus the tour-set dims, minimising the robust scatter of y about its running median in
// x over a 20k visible subsample (math in js/math/pursuit.js, time-sliced here so the main
// thread never blocks for more than ~8 ms). Then animate to the result.
//
// Candidate rules (y's own dims are always excluded):
// - tour-set dims that share a physical group with y's main terms are skipped (the other O/H
//   calibration for an O/H axis, sSFR for an SFR axis, Σ★ or μ₅₀ for a size axis …), since
//   they would "predict" y from a copy of itself;
// - x may not contain every other member of a definitional identity with y (logsSFR =
//   logSFR − logM, logΣ★ = logM − 2 logR₅₀ + c, the O3N2 calibration from its line ratios);
// - with log M★ on x, log sSFR and log SFR span the same plane (sSFR = SFR/M★), so log sSFR
//   is searched as log SFR and results read in the FMR form "log M★ − α log SFR".
// A dimension joins x only if it cuts the scatter by ≥ 3 % (opts.minGain), which keeps the
// formulas short enough to read on the ruler.
//
// opts: {dims: [keys] (candidate pool instead of the tour set), sample: 20000, maxDims: 5,
//        minGain: 0.03, duration: 1400, animate: true}.
// Resolves to the result {x, y, dims, coef, sigma0, sigma, improved, n, evals, added, screen,
// alpha?, alphaAlone?} (sigma in y's physical units) when the view was tightened, and to
// false when nothing changed (nothing to search, too few galaxies, no gain, cancelled, or the
// view was moved while the search ran);
// app.pursuit.last and the 'pursuit' event {phase: 'start'|'done'|'cancel', result} carry the
// details either way.

import * as fm from '../../math/frame.js';
import { tightenSearch } from '../../math/pursuit.js';

// y → dims it is partly derived from (MPA-JHU SFRs of galaxies without usable emission lines
// come from Dₙ4000, Brinchmann et al. 2004; both O/H calibrations are functions of the strong
// line ratios)
const DERIVED = {
  logSFR: ['D4000'],
  logsSFR: ['D4000'],
  OH: ['N2Ha', 'O3Hb'],
  OH_PP04: ['N2Ha', 'O3Hb'],
};

const IDENTITIES = [
  ['logSFR', 'logsSFR', 'logM'],
  ['logM', 'logSigma', 'logR50'],
  ['OH_PP04', 'N2Ha', 'O3Hb'],
  ['OH', 'N2Ha', 'O3Hb'],
];

function fmtSigma(v) {
  if (!Number.isFinite(v)) return '–';
  const d = v >= 1 ? 2 : v >= 0.1 ? 3 : 3;
  return v.toFixed(d);
}

export function createTighten(app, ov, axes) {
  const data = app.data;
  let running = null;
  let cancelled = false;
  let last = null;

  function waitSettle(timeout = 4000) {
    if (!app.proj.stale && !app.isMoving()) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer = 0;
      const off = app.events.on('settle', () => {
        clearTimeout(timer);
        off();
        resolve(true);
      });
      timer = setTimeout(() => { off(); resolve(!app.proj.stale); }, timeout);
    });
  }

  function runSliced(gen, budget = 8) {
    return new Promise((resolve, reject) => {
      const step = () => {
        if (cancelled) { resolve(null); return; }
        const t0 = performance.now();
        try {
          for (;;) {
            const r = gen.next();
            if (r.done) { resolve(r.value); return; }
            if (performance.now() - t0 > budget) break;
          }
        } catch (e) {
          reject(e);
          return;
        }
        setTimeout(step, 0);
      };
      setTimeout(step, 0);
    });
  }

  async function run(opts) {
    if (!data.loaded) return null;
    cancelled = false;
    app.events.emit('pursuit', { phase: 'start' });
    axes.scan(true);
    if (app.store.get().tour.playing) app.actions.tour.pause();
    const settled = await waitSettle();
    if (cancelled || !settled) return null;
    const dims = data.dims, D = data.D;
    const F = Float64Array.from(app.frame);
    const frameVersion = app.frameVersion;
    const px = (d) => F[d], py = (d) => F[D + d];
    const all = [...Array(D).keys()];
    const yDims = all.filter((d) => Math.abs(py(d)) >= 0.05);
    const yKeys = new Set(yDims.map((d) => dims[d].key));
    const yGroups = new Set(all.filter((d) => Math.abs(py(d)) >= 0.2).map((d) => dims[d].group));
    let xCur = all.filter((d) => Math.abs(px(d)) >= 0.05 && Math.abs(py(d)) < 0.05)
      .sort((a, b) => Math.abs(px(b)) - Math.abs(px(a)));
    if (!xCur.length) {
      const free = all.filter((d) => Math.abs(py(d)) < 0.05).sort((a, b) => Math.abs(px(b)) - Math.abs(px(a)));
      if (!free.length || Math.abs(px(free[0])) < 1e-6) return null;
      xCur = [free[0]];
    }
    const maxDims = Math.max(1, Math.min(5, opts.maxDims ?? 5));
    xCur = xCur.slice(0, maxDims);
    const poolKeys = Array.isArray(opts.dims) ? opts.dims : app.store.get().tour.set;
    const derived = new Set([...yKeys].flatMap((k) => DERIVED[k] || []));
    let pool = poolKeys.map((k) => data.dimIndex(k));
    const iM = data.dimIndex('logM'), iS = data.dimIndex('logSFR'), iSS = data.dimIndex('logsSFR');
    if (iM >= 0 && iS >= 0 && iSS >= 0 && xCur.includes(iM)) pool = pool.map((d) => (d === iSS ? iS : d));
    const extra = [...new Set(pool)].filter((d) => d >= 0
      && !xCur.includes(d) && Math.abs(py(d)) < 0.05 && !yGroups.has(dims[d].group) && !derived.has(dims[d].key));
    const colDims = [...xCur, ...extra];

    // sample: visible rows with y and the current x dims valid
    const S = Math.max(500, Math.min(60000, opts.sample ?? 20000));
    const rows = app.proj.sampleVisible(S * 6, { minVis: 128 });
    const need = [...new Set([...yDims, ...xCur])].map((d) => data.raw[d]);
    const base = [];
    for (let j = 0; j < rows.length && base.length < S; j++) {
      const i = rows[j];
      let ok = true;
      for (const col of need) if (col[i] === 0) { ok = false; break; }
      if (ok) base.push(i);
    }
    const N = base.length;
    if (N < 400) return null;
    const Y = new Float64Array(N);
    const uOf = (d, i) => { const v = data.raw[d][i]; return v === 0 ? NaN : v * dims[d].ua + dims[d].ub; };
    for (let k = 0; k < N; k++) {
      let y = 0;
      for (let d = 0; d < D; d++) {
        const w = py(d);
        if (w === 0) continue;
        const u = uOf(d, base[k]);
        if (u === u) y += w * u;
      }
      Y[k] = y;
    }
    const cols = colDims.map((d, j) => {
      const u = new Float64Array(N);
      for (let k = 0; k < N; k++) u[k] = uOf(d, base[k]);
      return { key: dims[d].key, d, u, w0: j < xCur.length ? px(d) : 0, current: j < xCur.length };
    });
    const identities = IDENTITIES.filter((I) => I.some((k) => yKeys.has(k)))
      .map((I) => I.filter((k) => !yKeys.has(k)));
    const allowed = (chosen, j) => {
      const keys = new Set([...chosen.map((c) => cols[c].key), cols[j].key]);
      return identities.every((rest) => rest.length < 2 || !rest.every((k) => keys.has(k)));
    };
    const res = await runSliced(tightenSearch({ Y, cols, ref: 0, allowed, maxDims, minGain: opts.minGain ?? 0.03 }));
    // the user moved the view meanwhile: the result belongs to a view that is gone
    if (app.frameVersion !== frameVersion) cancelled = true;
    if (!res || cancelled) return null;

    // u-space weights → physical combo (reference coefficient ±1, orientation kept)
    const w = new Float64Array(D);
    const sgn = Math.sign(px(cols[0].d)) || 1;
    res.chosen.forEach((j, q) => { w[cols[j].d] = sgn * res.coef[q]; });
    const ref = cols[0].d;
    const kr = Math.abs(w[ref] / dims[ref].scale);
    const x = {};
    for (let d = 0; d < D; d++) if (w[d] !== 0) x[dims[d].key] = w[d] / dims[d].scale / kr;
    const y = fm.columnCombo(F, 1, dims);
    const iy = fm.axisInfo(F, 1, dims);
    const toPhys = iy ? 1 / Math.abs(iy.kr) : 1;
    const improved = res.sigma < res.sigma0 * 0.995;
    const result = {
      x, y,
      dims: res.chosen.map((j) => cols[j].key),
      coef: Object.fromEntries(res.chosen.map((j) => [cols[j].key, x[cols[j].key]])),
      sigma0: res.sigma0 * toPhys,
      sigma: res.sigma * toPhys,
      improved,
      n: res.n,
      evals: res.evals,
      candidates: cols.map((c) => c.key),
      ranked: res.ranked.map((r) => ({ key: r.key, score: +r.score.toFixed(4) })),
      added: res.trace.map((t) => ({ key: t.key, gain: +t.gain.toFixed(4) })),
      // each candidate on its own (first round): physical coefficient relative to the reference
      screen: res.screen.map((c) => ({
        key: c.key,
        coef: +((c.a * dims[ref].scale) / dims[cols[c.j].d].scale).toFixed(4),
        gain: +c.gain.toFixed(4),
      })),
    };
    if (dims[ref].key === 'logM') {
      // FMR-style α (x = log M★ − α log SFR): from the result if SFR (or sSFR, with
      // log M★ + β log sSFR = (1 − β) log M★ + β log SFR) is in it, else from the
      // single-dimension screen
      const s1 = result.screen.find((c) => c.key === 'logSFR');
      const kM = x.logM || 1;
      if (x.logSFR != null && x.logsSFR == null) result.alpha = -x.logSFR / kM;
      else if (x.logsSFR != null && x.logSFR == null && kM - x.logsSFR !== 0) result.alpha = -x.logsSFR / (kM - x.logsSFR);
      if (s1) result.alphaAlone = -s1.coef;
    }
    last = result;
    axes.scan(false);
    axes.flash(`σ ${fmtSigma(result.sigma0)} → ${fmtSigma(result.sigma)}`);
    if (improved && opts.animate !== false) {
      await app.actions.setAxes({ x, y }, { duration: opts.duration ?? 1400, fit: true });
    }
    app.events.emit('pursuit', { phase: 'done', result });
    return improved ? result : false;
  }

  return {
    /** Tighten the current view (see the header). Concurrent calls share one run. */
    tighten(opts = {}) {
      if (running) return running;
      running = run(opts)
        .catch((e) => {
          console.error('tighten failed', e);
          return null;
        })
        .then((r) => {
          if (r == null) {
            app.events.emit('pursuit', { phase: cancelled ? 'cancel' : 'done', result: null });
            return false;
          }
          return r;
        })
        .finally(() => {
          running = null;
          axes.scan(false);
        });
      return running;
    },
    cancel() {
      if (running) cancelled = true;
    },
    get busy() { return !!running; },
    get last() { return last; },
  };
}
