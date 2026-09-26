#!/usr/bin/env python3
"""Synthetic galaxy catalog in the exact site/data contract (DESIGN.md §5) for client dev.

Writes (default) site/data-synth/:
  manifest.json, dims/<key>.u16.gz, cats/<key>.u8.gz, meta/*.gz,
  thumbs/index.u32.gz, thumbs/crop.f32.gz, thumbs/<shard>/<k>.jpg (64x64 fake cutouts),
  literature.json (a few well-known relations, marked as dev copies).

The manifold is a toy but correlated one: a bimodal star-forming / quiescent population with
a main sequence, a green valley, mass-dependent quenching boosted for satellites in massive
halos, a T04-like curved MZR with a weak SFR dependence, a BPT "seagull" (SF sequence,
composites, Seyferts, LINERs), mass-size relations per population, a Faber-Jackson-like
sigma, a flux limit in z, and realistic missingness for OH, OH_PP04, logfHI, line ratios,
logMh, gr and logSigV. Select it in the browser with ?data=data-synth.

Usage: python3 tools/make_synth.py [--n 250000] [--k 4000] [--out site/data-synth] [--no-thumbs]
"""
from __future__ import annotations

import argparse
import gzip
import io
import json
import math
import shutil
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SEED = 20260924

# DESIGN.md §6 — key, label, short, unit, group, min, max, source, desc
DIMS = [
    ("logM", "log M★", "M★", "M☉", "stars", 7.0, 12.5, "mpajhu", "Stellar mass (synthetic), Kroupa IMF"),
    ("logSFR", "log SFR", "SFR", "M☉ yr⁻¹", "sf", -4.0, 2.5, "mpajhu", "Star formation rate (synthetic)"),
    ("logsSFR", "log sSFR", "sSFR", "yr⁻¹", "sf", -14.0, -8.0, "mpajhu", "Specific SFR (synthetic)"),
    ("D4000", "Dₙ4000", "D4k", "", "stars", 0.8, 2.6, "mpajhu", "4000 Å break (synthetic)"),
    ("HdA", "HδA", "Hδ", "Å", "stars", -6.0, 12.0, "mpajhu", "Lick HδA (synthetic)"),
    ("gr", "⁰·¹(g−r)", "g−r", "mag", "stars", -0.2, 1.4, "lim17", "g−r at z=0.1 (synthetic)"),
    ("OH", "12+log(O/H)", "O/H", "", "chem", 7.6, 9.5, "mpajhu", "T04 metallicity (synthetic), SF only"),
    ("OH_PP04", "12+log(O/H)ᴼ³ᴺ²", "O/Hᴾ", "", "chem", 7.8, 9.2, "pp04", "PP04 O3N2 metallicity (synthetic)"),
    ("logR50", "log R₅₀", "R₅₀", "kpc", "struct", -1.0, 2.0, "sdss", "Petrosian half-light radius (synthetic)"),
    ("C", "R₉₀/R₅₀", "C", "", "struct", 1.2, 4.5, "sdss", "Concentration (synthetic)"),
    ("logSigma", "log Σ★", "Σ★", "M☉ kpc⁻²", "struct", 5.5, 11.0, "mpajhu", "Stellar surface density (synthetic)"),
    ("ba", "b/a", "b/a", "", "struct", 0.0, 1.0, "sdss", "Axis ratio (synthetic)"),
    ("pEl", "P(E)", "P(E)", "", "struct", 0.0, 1.0, "gz1", "GZ1 elliptical fraction (synthetic)"),
    ("logSigV", "log σ", "σ", "km s⁻¹", "kin", 1.3, 2.8, "mpajhu", "Velocity dispersion (synthetic)"),
    ("mu50", "⟨μ⟩₅₀", "μ₅₀", "mag arcsec⁻²", "struct", 16.0, 26.0, "sdss", "Surface brightness (synthetic)"),
    ("logfHI", "log M_HI/M★", "f_HI", "", "gas", -3.0, 2.5, "alfalfa", "H I fraction (synthetic)"),
    ("logMh", "log M_h", "M_h", "M☉", "env", 10.0, 15.5, "lim17", "Group halo mass (synthetic)"),
    ("N2Ha", "log [NII]/Hα", "N2", "", "lines", -2.5, 1.0, "mpajhu", "log [NII]/Hα (synthetic)"),
    ("O3Hb", "log [OIII]/Hβ", "O3", "", "lines", -1.5, 1.5, "mpajhu", "log [OIII]/Hβ (synthetic)"),
    ("z", "z", "z", "", "obs", 0.0, 0.3, "sdss", "Redshift (synthetic)"),
]

CATS = [
    dict(key="bpt", label="BPT class", source="mpajhu", desc="BPT class (synthetic)", codes=[
        dict(code=1, label="SF", name="star-forming", color="#6fa8dc"),
        dict(code=2, label="SF low-S/N", name="low-S/N star-forming", color="#9cc3e4"),
        dict(code=3, label="Composite", name="composite", color="#3aa6a0"),
        dict(code=4, label="Seyfert", name="Seyfert", color="#de5b52"),
        dict(code=5, label="LINER", name="LINER", color="#e8743b"),
        dict(code=6, label="LINER low-S/N", name="low-S/N LINER", color="#e2b23a"),
        dict(code=7, label="Unclassifiable", name="unclassifiable", color="#7a7465")]),
    dict(key="env", label="environment", source="lim17", desc="Group membership (synthetic)", codes=[
        dict(code=1, label="isolated", name="isolated central", color="#efe6d2"),
        dict(code=2, label="group central", name="group central", color="#e2b23a"),
        dict(code=3, label="satellite", name="satellite", color="#b07aa1")]),
    dict(key="morph", label="Galaxy Zoo 1", source="gz1", desc="GZ1 flags (synthetic)", codes=[
        dict(code=1, label="elliptical", name="elliptical", color="#de5b52"),
        dict(code=2, label="spiral", name="spiral", color="#6fa8dc"),
        dict(code=3, label="uncertain", name="uncertain", color="#7a7465")]),
]

SOURCES = [
    {"key": "synthetic", "label": "Synthetic dev data", "cite": "tools/make_synth.py", "url": ""},
    {"key": "sdss", "label": "SDSS (synthetic stand-in)", "cite": "", "url": ""},
    {"key": "mpajhu", "label": "MPA-JHU (synthetic stand-in)", "cite": "", "url": ""},
    {"key": "lim17", "label": "Lim+17 (synthetic stand-in)", "cite": "", "url": ""},
    {"key": "alfalfa", "label": "ALFALFA (synthetic stand-in)", "cite": "", "url": ""},
    {"key": "gz1", "label": "Galaxy Zoo 1 (synthetic stand-in)", "cite": "", "url": ""},
    {"key": "pp04", "label": "PP04 (synthetic stand-in)", "cite": "", "url": ""},
]


def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-x))


def k03(n2):
    return 0.61 / (n2 - 0.05) + 1.30


def k01(n2):
    return 0.61 / (n2 - 0.47) + 1.19


def kpc_per_arcsec(z):
    """Flat LCDM H0=70, Om0=0.3 (vectorized Simpson on a table)."""
    zs = np.linspace(0, 0.35, 3501)
    ez = 1.0 / np.sqrt(0.3 * (1 + zs) ** 3 + 0.7)
    dc = np.concatenate([[0], np.cumsum(0.5 * (ez[1:] + ez[:-1]) * np.diff(zs))]) * 299792.458 / 70.0
    da = np.interp(z, zs, dc) / (1 + z)
    return da * 1000.0 / 206264.806


# ---------------------------------------------------------------------------------------
# the toy manifold
# ---------------------------------------------------------------------------------------

def generate(n: int, rng: np.random.Generator):
    nan = np.nan
    comp = rng.random(n) < 0.8
    logM = np.where(comp, rng.normal(10.78, 0.42, n), rng.normal(10.0, 0.62, n))
    logM = np.clip(logM, 7.8, 12.15)

    # flux limit: brighter (more massive) galaxies reach larger z; quiescent have higher M/L
    zmax = np.clip(0.039 * 10 ** (0.43 * (logM - 9.5)), 0.012, 0.30)
    z = np.clip(zmax * rng.random(n) ** (1 / 3), 0.005, 0.30)

    # environment (Lim+17-like): 1 isolated, 2 group central, 3 satellite, 0 no match
    u = rng.random(n)
    p_sat = np.clip(0.30 - 0.09 * (logM - 10.5), 0.10, 0.45)
    p_gc = np.clip(0.07 + 0.14 * (logM - 10.3), 0.02, 0.45)
    env = np.where(u < p_sat, 3, np.where(u < p_sat + p_gc, 2, 1)).astype(np.uint8)
    env[(rng.random(n) < 0.035) | (z > 0.2)] = 0

    lm = logM + rng.normal(0, 0.14, n)
    dl = lm - 10.13
    cen_mh = np.where(dl < 0, 12.0 + 1.9 * dl, 12.0 + 2.3 * dl - 0.35 * dl ** 2)
    cen_mh = cen_mh + np.where(env == 2, 0.35, 0.0)
    sat_mh = 11.8 + 3.1 * rng.beta(1.6, 2.2, n) + 0.15 * (logM - 10.5)
    logMh = np.clip(np.where(env == 3, sat_mh, cen_mh), 10.05, 15.4)

    # quenching: mass quenching plus environmental quenching of satellites
    p_q = sigmoid((logM - 10.72) / 0.24)
    env_q = 0.5 * sigmoid((logMh - 13.0) / 0.35)
    p_q = np.where(env == 3, 1 - (1 - p_q) * (1 - env_q), p_q)
    q = rng.random(n) < np.clip(p_q, 0.02, 0.97)
    green = (~q) & (rng.random(n) < 0.12)

    sfms = 0.72 * (logM - 10.0) - 0.08
    dsf = np.where(q, rng.normal(-1.75, 0.42, n) - 0.3 * (logM - 10.8), rng.normal(0.0, 0.27, n))
    dsf = np.where(green, rng.uniform(-1.4, -0.45, n), dsf)
    logSFR = sfms + dsf
    logsSFR = logSFR - logM
    passive = sigmoid(-(logsSFR + 11.0) / 0.33)   # 0 = star forming, 1 = passive

    D4000 = 1.20 + 0.72 * passive + 0.05 * (logM - 10.5) + rng.normal(0, 0.05, n)
    HdA = 6.2 - 8.0 * (D4000 - 1.2) + rng.normal(0, 0.9, n)
    gr = 0.45 + 0.36 * sigmoid(-(logsSFR + 10.9) / 0.33) + 0.07 * (logM - 10.5) + rng.normal(0, 0.035, n)

    # structure: two mass-size relations, concentration, surface density
    logR50 = np.where(q, 0.56 * (logM - 10.8) + 0.60, 0.22 * (logM - 10.0) + 0.60)
    logR50 = logR50 + np.where(q, rng.normal(0, 0.14, n), rng.normal(0, 0.17, n))
    C = np.where(q, 2.95 + 0.10 * (logM - 10.8), 2.25 + 0.15 * (logM - 10.0) + 0.5 * passive)
    C = np.clip(C + rng.normal(0, 0.2, n), 1.55, 3.9)
    logSigma = logM - np.log10(2 * np.pi * (10 ** logR50) ** 2)
    cosi = rng.random(n)
    ba_disk = np.sqrt((1 - 0.2 ** 2) * cosi ** 2 + 0.2 ** 2)
    ba = np.where(q, np.clip(rng.normal(0.74, 0.14, n), 0.3, 0.999), ba_disk)
    pEl = np.where(q, rng.beta(5.0, 2.0, n), rng.beta(1.1, 6.0, n))
    gz_missing = rng.random(n) < 0.12
    morph = np.where(pEl > 0.8, 1, np.where(pEl < 0.15, 2, 3)).astype(np.uint8)
    morph[gz_missing] = 0
    pEl = np.where(gz_missing, nan, pEl)

    lsig = np.where(q, 2.18 + 0.30 * (logM - 10.8), 1.88 + 0.27 * (logM - 10.2)) + rng.normal(0, 0.07, n)
    bad_sig = rng.random(n) < 0.03 + 0.4 * sigmoid((1.72 - lsig) / 0.05)
    logSigV = np.where((lsig > np.log10(40)) & (lsig < np.log10(500)) & ~bad_sig, lsig, nan)
    mu50 = 21.4 - 1.9 * (logSigma - 8.5) + 0.9 * (gr - 0.7) + rng.normal(0, 0.22, n)

    # metallicity: curved T04 MZR with a weak SFR dependence
    oh_true = -1.492 + 1.847 * logM - 0.08026 * logM ** 2 - 0.08 * np.clip(dsf, -1.5, 1.0) + rng.normal(0, 0.06, n)

    # emission lines and BPT
    snr = logSFR - 2.0 * np.log10(z / 0.1) + rng.normal(0, 0.45, n)
    sf = ~q
    strong_sf = sf & (snr > np.quantile(snr[sf], 0.45))
    massive = sigmoid((logM - 10.45) / 0.25)
    seyfert = (rng.random(n) < 0.05 * massive) & (sf | green | (rng.random(n) < 0.3))
    liner = (~seyfert) & (rng.random(n) < 0.10 * massive) & (q | green)
    comp_ = (~seyfert) & (~liner) & strong_sf & (rng.random(n) < 0.22 * massive)
    strong = strong_sf | seyfert | liner | comp_

    N2 = np.full(n, nan)
    O3 = np.full(n, nan)
    m = strong_sf & ~comp_ & ~seyfert & ~liner
    n2 = np.clip(-0.45 + 2.4 * (oh_true[m] - 8.9), -1.7, -0.3) + rng.normal(0, 0.05, m.sum())
    N2[m] = n2
    O3[m] = np.minimum(k03(n2) - 0.25 + rng.normal(0, 0.12, m.sum()), k03(n2) - 0.03)
    m = comp_
    n2 = np.clip(rng.normal(-0.22, 0.1, m.sum()), -0.42, 0.02)
    lo = np.maximum(k03(n2), -1.0) + 0.02
    hi = k01(n2) - 0.02
    N2[m] = n2
    O3[m] = lo + (hi - lo) * rng.random(m.sum())
    m = seyfert
    n2 = rng.normal(0.05, 0.15, m.sum())
    N2[m] = n2
    O3[m] = np.maximum(rng.normal(0.82, 0.18, m.sum()), np.maximum(1.05 * n2 + 0.5, k01(np.minimum(n2, 0.4)) + 0.05))
    m = liner
    n2 = np.clip(rng.normal(0.14, 0.13, m.sum()), -0.1, 0.6)
    N2[m] = n2
    o3 = rng.normal(0.02, 0.18, m.sum())
    O3[m] = np.clip(o3, np.where(n2 < 0.45, k01(np.minimum(n2, 0.44)) + 0.05, -1.4), 1.05 * n2 + 0.40)

    bpt = np.zeros(n, np.uint8)
    has = np.isfinite(N2)
    below_k03 = has & (N2 < 0.05) & (O3 < k03(np.minimum(N2, 0.04)))
    below_k01 = has & (N2 < 0.47) & (O3 < k01(np.minimum(N2, 0.46)))
    above = has & ~below_k01 & ~below_k03
    bpt[below_k03] = 1
    bpt[below_k01 & ~below_k03] = 3
    bpt[above & (O3 > 1.05 * N2 + 0.45)] = 4
    bpt[above & (O3 <= 1.05 * N2 + 0.45)] = 5
    weak = ~has
    bpt[weak & sf & ~green] = 2
    bpt[weak & sf & green] = np.where(rng.random((weak & sf & green).sum()) < 0.5, 2, 6)
    wq = weak & q
    bpt[wq] = np.where(rng.random(wq.sum()) < 0.3 * massive[wq] + 0.05, 6, 7)
    bpt[weak & (bpt == 0)] = 7
    bpt[rng.random(n) < 0.005] = 0

    OH = np.where((bpt == 1) & (rng.random(n) > 0.03), oh_true + rng.normal(0, 0.03, n), nan)
    o3n2 = O3 - N2
    pp_ok = (bpt == 1) & has & (o3n2 > -1) & (o3n2 < 1.9) & (rng.random(n) < 0.88)
    OH_PP04 = np.where(pp_ok, 8.73 - 0.32 * o3n2, nan)

    # ALFALFA detections: nearby, gas rich
    fhi = -0.55 * (logM - 10.0) - 0.35 + 0.35 * np.clip(dsf, -2, 1) + rng.normal(0, 0.3, n)
    det = (z < 0.05) & (fhi > -0.7 + 25 * (z - 0.02) - 0.1 * (logM - 10)) & (rng.random(n) < 0.8)
    logfHI = np.where(det, fhi, nan)

    gr = np.where(env == 0, nan, gr)
    logMh = np.where(env == 0, nan, logMh)
    N2Ha = np.where(bpt == 0, nan, N2)
    O3Hb = np.where(bpt == 0, nan, O3)

    cols = dict(logM=logM, logSFR=logSFR, logsSFR=logsSFR, D4000=D4000, HdA=HdA, gr=gr, OH=OH,
                OH_PP04=OH_PP04, logR50=logR50, C=C, logSigma=logSigma, ba=ba, pEl=pEl,
                logSigV=logSigV, mu50=mu50, logfHI=logfHI, logMh=logMh, N2Ha=N2Ha, O3Hb=O3Hb, z=z)
    cats = dict(bpt=bpt, env=env, morph=morph)
    # sky positions in an SDSS-like cap, plate/mjd/fiber
    ra = rng.uniform(110, 260, n)
    dec = np.degrees(np.arcsin(rng.uniform(np.sin(np.radians(-5)), np.sin(np.radians(65)), n)))
    meta = dict(ra=ra.astype(np.float32), dec=dec.astype(np.float32),
                plate=rng.integers(266, 2975, n).astype(np.uint16),
                mjd=(rng.integers(51578, 54664, n) - 50000).astype(np.uint16),
                fiber=rng.integers(1, 641, n).astype(np.uint16))
    latent = dict(q=q)
    return cols, cats, meta, latent


# ---------------------------------------------------------------------------------------
# encoding (DESIGN.md §5.3)
# ---------------------------------------------------------------------------------------

def gz(b: bytes) -> bytes:
    out = gzip.compress(b, compresslevel=9, mtime=0)
    return out[:9] + b"\xff" + out[10:]   # OS byte pinned, as in pipeline/export_web.gz


def quantize(x, lo, hi):
    v = np.zeros(len(x), np.uint16)
    ok = np.isfinite(x) & (x >= lo) & (x <= hi)
    v[ok] = (1 + np.round((x[ok] - lo) / (hi - lo) * 65534)).astype(np.uint16)
    return v


def decode(v, lo, hi):
    x = lo + (v.astype(np.float64) - 1) * (hi - lo) / 65534
    return np.where(v == 0, np.nan, x)


def shuffle_bytes(v):
    return np.concatenate([(v & 0xFF).astype(np.uint8), (v >> 8).astype(np.uint8)]).tobytes()


# ---------------------------------------------------------------------------------------
# fake cutouts
# ---------------------------------------------------------------------------------------

def render_thumb(rng, gr, logR50, C, ba, z, quiescent, size=64):
    kpa = float(kpc_per_arcsec(z))
    r50 = 10 ** logR50 / kpa                    # arcsec
    crop = float(np.clip(3.0 * C * r50, 12.0, 42.0))
    pix = crop / size
    re = max(r50 / pix, 0.6)
    ns = float(np.clip(1 + (C - 2.3) / 0.7 * 3, 0.6, 5.0))
    bn = 2 * ns - 1 / 3
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float64)
    cx, cy = (size - 1) / 2 + rng.normal(0, 0.4), (size - 1) / 2 + rng.normal(0, 0.4)
    pa = rng.uniform(0, np.pi)
    dx, dy = xx - cx, yy - cy
    xr = dx * np.cos(pa) + dy * np.sin(pa)
    yr = (-dx * np.sin(pa) + dy * np.cos(pa)) / max(ba, 0.12)
    r = np.hypot(xr, yr) + 1e-3
    main = np.exp(-bn * ((r / re) ** (1 / ns) - 1))
    t = float(np.clip((gr - 0.3) / 0.7, 0, 1)) if np.isfinite(gr) else 0.6
    blue, red = np.array([0.55, 0.72, 1.0]), np.array([1.0, 0.8, 0.52])
    col = blue * (1 - t) + red * t
    img = main[..., None] * col
    if not quiescent:
        th = np.arctan2(yr, xr)
        arms = 1 + 0.55 * np.cos(2 * th - 2.6 * np.log(r / re + 0.15) + rng.uniform(0, 6.28))
        img *= (0.55 + 0.45 * arms * np.exp(-(r / (2.2 * re)) ** 2))[..., None]
        # knots of star formation
        for _ in range(rng.integers(2, 7)):
            kr, kt = abs(rng.normal(1.1 * re, 0.5 * re)), rng.uniform(0, 2 * np.pi)
            kx = cx + kr * np.cos(kt) * np.cos(pa) - kr * np.sin(kt) * max(ba, 0.12) * np.sin(pa)
            ky = cy + kr * np.cos(kt) * np.sin(pa) + kr * np.sin(kt) * max(ba, 0.12) * np.cos(pa)
            img += 0.35 * np.exp(-((xx - kx) ** 2 + (yy - ky) ** 2) / 1.2)[..., None] * np.array([0.6, 0.75, 1.0])
        bulge = np.exp(-7.67 * ((r / (0.3 * re)) ** 0.25 - 1)) * 0.02 * (C - 1.8)
        img += np.clip(bulge, 0, 50)[..., None] * red
    for _ in range(rng.integers(0, 4)):   # field stars
        sx, sy = rng.uniform(0, size, 2)
        amp = 10 ** rng.uniform(-0.5, 1.2)
        star = amp * np.exp(-((xx - sx) ** 2 + (yy - sy) ** 2) / (2 * 1.1 ** 2))
        img += star[..., None] * rng.uniform(0.7, 1.0, 3)
    peak = np.quantile(img, 0.995) + 1e-6
    img = img / peak
    img += rng.normal(0, 0.012, img.shape) + 0.01
    img = np.arcsinh(np.clip(img, 0, None) / 0.08) / np.arcsinh(1 / 0.08)
    img = np.clip(img * np.array([1.0, 0.97, 0.95]), 0, 1)
    return (img * 255 + 0.5).astype(np.uint8), crop


def choose_thumbs(cols, k, rng):
    from sklearn.cluster import MiniBatchKMeans
    keys = ["logM", "logsSFR", "logR50", "C", "gr", "D4000", "z"]
    X = np.stack([cols[c] for c in keys], axis=1)
    ok = np.all(np.isfinite(X), axis=1)
    idx = np.nonzero(ok)[0]
    Xs = X[ok]
    Xs = (Xs - np.median(Xs, axis=0)) / (1.4826 * np.median(np.abs(Xs - np.median(Xs, axis=0)), axis=0))
    km = MiniBatchKMeans(n_clusters=k, batch_size=8192, n_init=1, max_iter=60, random_state=SEED)
    lab = km.fit_predict(Xs)
    d = np.sum((Xs - km.cluster_centers_[lab]) ** 2, axis=1)
    order = np.lexsort((d, lab))
    first = np.ones(len(order), bool)
    first[1:] = lab[order][1:] != lab[order][:-1]
    rows = idx[order[first]]
    return np.sort(rows)


def literature():
    """A few classic relations in the §9 format (dev copies; the real file comes from the
    literature agent)."""
    xs = np.round(np.arange(8.5, 11.51, 0.05), 3)
    t04 = [[float(x), round(float(-1.492 + 1.847 * x - 0.08026 * x * x), 4)] for x in xs]
    n2a = np.round(np.arange(-2.0, 0.0, 0.02), 3)
    kz = [[float(x), round(float(k03(x)), 4)] for x in n2a if k03(x) > -1.5]
    n2b = np.round(np.arange(-2.0, 0.40, 0.02), 3)
    kw = [[float(x), round(float(k01(x)), 4)] for x in n2b if k01(x) > -1.5]
    s07 = [[x, round(1.05 * x + 0.45, 4)] for x in [-0.18, 0.0, 0.25, 0.5, 0.75]]
    ver = {"status": "dev-copy", "source": "tools/make_synth.py", "excerpt": ""}
    return {"schema": 1, "relations": [
        {"id": "T04", "label": "T04", "name": "Tremonti et al. (2004) MZR",
         "cite": "Tremonti, C. A., et al. 2004, ApJ, 613, 898", "url": "https://ui.adsabs.harvard.edu/abs/2004ApJ...613..898T",
         "view": "mzr", "x": {"logM": 1.0}, "y": {"OH": 1.0}, "kind": "fit",
         "curves": [{"id": "main", "label": None, "style": "solid", "points": t04}], "band": None,
         "fitOffset": False, "range": [8.5, 11.5], "notes": "dev copy", "conversions": "none", "verification": ver},
        {"id": "K03", "label": "K03", "name": "Kauffmann et al. (2003) SF/AGN demarcation",
         "cite": "Kauffmann, G., et al. 2003, MNRAS, 346, 1055", "url": "https://ui.adsabs.harvard.edu/abs/2003MNRAS.346.1055K",
         "view": "bpt", "x": {"N2Ha": 1.0}, "y": {"O3Hb": 1.0}, "kind": "demarcation",
         "curves": [{"id": "main", "label": None, "style": "dashed", "points": kz}], "band": None,
         "fitOffset": False, "range": [-2.0, 0.0], "notes": "dev copy", "conversions": "none", "verification": ver},
        {"id": "K01", "label": "K01", "name": "Kewley et al. (2001) maximum starburst line",
         "cite": "Kewley, L. J., et al. 2001, ApJ, 556, 121", "url": "https://ui.adsabs.harvard.edu/abs/2001ApJ...556..121K",
         "view": "bpt", "x": {"N2Ha": 1.0}, "y": {"O3Hb": 1.0}, "kind": "demarcation",
         "curves": [{"id": "main", "label": None, "style": "dotted", "points": kw}], "band": None,
         "fitOffset": False, "range": [-2.0, 0.4], "notes": "dev copy", "conversions": "none", "verification": ver},
        {"id": "S07", "label": "S07", "name": "Schawinski et al. (2007) Seyfert/LINER line",
         "cite": "Schawinski, K., et al. 2007, MNRAS, 382, 1415", "url": "https://ui.adsabs.harvard.edu/abs/2007MNRAS.382.1415S",
         "view": "bpt", "x": {"N2Ha": 1.0}, "y": {"O3Hb": 1.0}, "kind": "demarcation",
         "curves": [{"id": "main", "label": None, "style": "dashed", "points": s07}], "band": None,
         "fitOffset": False, "range": [-0.18, 0.75], "notes": "dev copy", "conversions": "none", "verification": ver},
    ]}


# ---------------------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--n", type=int, default=250_000)
    ap.add_argument("--k", type=int, default=4000, help="number of thumbnails")
    ap.add_argument("--out", default=str(ROOT / "site" / "data-synth"))
    ap.add_argument("--no-thumbs", action="store_true")
    args = ap.parse_args()

    t0 = time.time()
    out = Path(args.out)
    if out.resolve().parent != (ROOT / "site").resolve():
        sys.exit(f"refusing to write outside site/: {out}")
    if out.exists():
        shutil.rmtree(out)
    for sub in ("dims", "cats", "meta", "thumbs"):
        (out / sub).mkdir(parents=True, exist_ok=True)

    rng = np.random.default_rng(SEED)
    cols, cats, meta, latent = generate(args.n, rng)

    # fixed random row order (any prefix is a uniform subsample)
    perm = np.random.default_rng(SEED).permutation(args.n)
    cols = {k: v[perm] for k, v in cols.items()}
    cats = {k: v[perm] for k, v in cats.items()}
    meta = {k: v[perm] for k, v in meta.items()}
    latent = {k: v[perm] for k, v in latent.items()}

    dims = []
    for key, label, short, unit, group, lo, hi, source, desc in DIMS:
        x = cols[key]
        eps = (hi - lo) * 1e-6
        x = np.where(np.isfinite(x), np.clip(x, lo + eps, hi - eps), np.nan)
        v = quantize(x, lo, hi)
        (out / "dims" / f"{key}.u16.gz").write_bytes(gz(shuffle_bytes(v)))
        xv = decode(v, lo, hi)
        good = xv[np.isfinite(xv)]
        center = float(np.median(good))
        scale = float(1.4826 * np.median(np.abs(good - center)))
        if not scale > 0:
            scale = float(np.std(good)) or 1.0
        dims.append(dict(key=key, label=label, short=short, unit=unit, group=group,
                         file=f"dims/{key}.u16.gz", min=lo, max=hi, center=round(center, 6),
                         scale=round(scale, 6), nvalid=int(good.size),
                         quantiles=[round(float(q), 6) for q in np.quantile(good, np.linspace(0, 1, 101))],
                         desc=desc, source=source))
    categories = []
    for spec in CATS:
        c = cats[spec["key"]].astype(np.uint8)
        (out / "cats" / f"{spec['key']}.u8.gz").write_bytes(gz(c.tobytes()))
        counts = {str(k): int((c == k).sum()) for k in range(8) if (c == k).any()}
        categories.append(dict(spec, file=f"cats/{spec['key']}.u8.gz", counts=counts))
    meta_spec = {}
    for key, dtype in (("ra", "f32"), ("dec", "f32"), ("plate", "u16"), ("mjd", "u16"), ("fiber", "u16")):
        (out / "meta" / f"{key}.{dtype}.gz").write_bytes(gz(meta[key].tobytes()))
        meta_spec[key] = {"file": f"meta/{key}.{dtype}.gz", "dtype": dtype}
    meta_spec["mjd"]["offset"] = 50000

    thumbs = None
    if not args.no_thumbs and args.k > 0:
        from PIL import Image
        rows = choose_thumbs(cols, min(args.k, args.n // 20), rng)
        crops = np.zeros(len(rows), np.float32)
        trng = np.random.default_rng(SEED + 1)
        for k, i in enumerate(rows):
            arr, crop = render_thumb(trng, cols["gr"][i], cols["logR50"][i], cols["C"][i], cols["ba"][i],
                                     cols["z"][i], bool(latent["q"][i]))
            crops[k] = crop
            d = out / "thumbs" / str(k // 1000)
            d.mkdir(exist_ok=True)
            buf = io.BytesIO()
            Image.fromarray(arr, "RGB").save(buf, "JPEG", quality=88, optimize=True)
            (d / f"{k}.jpg").write_bytes(buf.getvalue())
        (out / "thumbs" / "index.u32.gz").write_bytes(gz(rows.astype(np.uint32).tobytes()))
        (out / "thumbs" / "crop.f32.gz").write_bytes(gz(crops.tobytes()))
        thumbs = {"count": int(len(rows)), "size": 64, "shard": 1000, "index": "thumbs/index.u32.gz",
                  "crop": "thumbs/crop.f32.gz", "url": "thumbs/{shard}/{k}.jpg", "pixscale": 0.262,
                  "source": "synthetic (tools/make_synth.py)"}

    manifest = {
        "schema": 1, "title": "Synthetic galaxies (dev)", "n": int(args.n), "seed": SEED,
        "created": time.strftime("%Y-%m-%d"), "cosmology": {"H0": 70.0, "Om0": 0.3},
        "encoding": {"dims": "u16-shuffle-gzip", "missing": 0},
        "dims": dims, "categories": categories, "meta": meta_spec, "thumbs": thumbs,
        "sources": SOURCES, "synthetic": True,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1))
    (out / "literature.json").write_text(json.dumps(literature(), ensure_ascii=False, indent=1))

    size = sum(p.stat().st_size for p in out.rglob("*") if p.is_file())
    print(f"wrote {out} : n={args.n}, thumbs={0 if thumbs is None else thumbs['count']}, "
          f"{size / 1e6:.1f} MB, {time.time() - t0:.1f} s")
    for d in dims:
        print(f"  {d['key']:9s} valid {d['nvalid'] / args.n:6.1%}  center {d['center']:8.3f}  scale {d['scale']:.3f}")
    for c in categories:
        print(f"  {c['key']:6s}", c["counts"])


if __name__ == "__main__":
    main()
