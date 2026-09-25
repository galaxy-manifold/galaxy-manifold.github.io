#!/usr/bin/env python3
"""Verified literature scaling relations for the Galaxy Manifold site (DESIGN.md section 9).

Every relation is a function below (``rel_<id>``). Its docstring records the provenance:
arXiv id, equation or table, the coefficients as printed, the IMF, cosmology,
band/aperture/calibration, and each conversion applied to reach OUR data conventions
(DESIGN.md section 9):

* stellar masses and SFRs on the Kroupa IMF as in MPA-JHU (Chabrier -> Kroupa uses the
  Madau & Dickinson 2014 factors: +0.034 dex in mass, +0.027 dex in SFR);
* H0 = 70, Om = 0.3;
* R50 = Petrosian r-band half-light radius in kpc; sigma corrected to R50/8; mu50 as in
  section 6 (Petrosian, extinction and dimming corrected, no K-correction);
* O/H on the T04 scale (``OH``) or PP04 O3N2 (``OH_PP04``);
* halo mass = Lim+17 group mass (M_180m, mean density x 180) in Msun with h = 0.7.

Verification is automatic and repeatable. Each relation lists verbatim excerpts together
with the cached source file they come from (pipeline/cache/literature_src/<key>/, filled by
``--fetch``). On every build, the excerpts are searched for in the comment-stripped,
whitespace-normalised LaTeX. ``verification.status`` is "verified" only if every excerpt is
found. Tabulated data (T04 Table 3, C18 Table 1) are parsed from the cached tables and
compared with the copies in this file.

An independent review (literature verifier, 2026-09-24) re-derived every relation from the
primary sources. Its results are recorded in REVIEW, and each record carries them as the
additive field ``verification.review`` (result verified | corrected | removed, what was checked,
and the correction with before and after values). Every build also compares the curves with a
second implementation of all formulas and conversions (``independent_check``) and stops on a
mismatch.

A second independent review (same date) checked everything again from freshly downloaded
sources with a third implementation. Its results are in SECOND_REVIEW and in the additive field
``verification.second_review`` (result, what was checked, the third implementation's largest
difference, and a checksum of the drawn content; ``current`` is false if a later build changed a
curve after the review).

Outputs
  site/data/literature.json                  relations evaluated as polylines (native units)
  pipeline/LITERATURE.md                     table, excerpts, conversions, verification, recommendations
  pipeline/cache/literature_check.png        curves over the data density (if data exist)
  pipeline/cache/literature_verify.png       verifier figure: curves as drawn plus targeted data checks
  pipeline/cache/literature_conversions.json derived conversion numbers

Usage
  python3 pipeline/literature.py              build (offline, uses the caches)
  python3 pipeline/literature.py --fetch      download arXiv sources, the S03 erratum record
                                              (OpenAlex) and the SkyServer R50 r/z sample
  python3 pipeline/literature.py --no-plot    skip the check plot
"""
from __future__ import annotations

import argparse
import gzip
import io
import json
import math
import re
import sys
import tarfile
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
PIPE = ROOT / "pipeline"
CACHE = PIPE / "cache"
SRC_DIR = CACHE / "literature_src"
OUT_JSON = ROOT / "site" / "data" / "literature.json"
OUT_MD = PIPE / "LITERATURE.md"
CHECK_PNG = CACHE / "literature_check.png"
CONV_JSON = CACHE / "literature_conversions.json"
R50_SAMPLE_CSV = CACHE / "literature_r50_rz_sample.csv"
S03_ERRATUM_JSON = SRC_DIR / "S03err" / "openalex.json"
PARENT = ROOT / "catalog" / "mgs_parent.parquet"     # read-only (sibling project)
GALAXIES = CACHE / "galaxies.parquet"                  # written by the data agent; read-only here
MANIFEST = ROOT / "site" / "data" / "manifest.json"

UA = {"User-Agent": "galaxy-manifold (research)"}
BUILT = "2026-09-24"
Z_REF = 0.1            # typical MGS redshift; z-dependent relations are evaluated here
H_OURS, OM_OURS = 0.7, 0.3
N_GRID = 121           # points per fitted curve (>= 60 required)
N_LINE = 61            # points per threshold line

# arXiv ids of every primary source consulted (relations and conventions)
ARXIV = {
    "T04": "astro-ph/0405537", "AM13": "1211.3418", "C20": "1910.00597",
    "M10": "1005.0006", "KE08": "0801.1849", "RP15": "1502.01027",
    "S14": "1405.2041", "S16": "1607.05289", "S03": "astro-ph/0301527",
    "K03a": "astro-ph/0204055", "K03b": "astro-ph/0205070",
    "B03": "astro-ph/0301626", "HB09": "0810.4924", "K03c": "astro-ph/0304239",
    "K01": "astro-ph/0106324", "S07": "0709.3015", "Mo13": "1205.5807",
    "B13": "1207.6105", "L17": "1706.02307", "C18": "1802.02373",
    "MD14": "1403.0007", "H12": "1207.0523", "W12": "1107.5311",
    "PP04": "astro-ph/0401128", "D08": "0804.2486", "BN98": "astro-ph/9710107",
}

# ADS bibcodes (journal, volume and page checked against Crossref by DOI, 2026-09-24)
BIBCODE = {
    "T04": "2004ApJ...613..898T", "AM13": "2013ApJ...765..140A", "C20": "2020MNRAS.491..944C",
    "M10": "2010MNRAS.408.2115M", "KE08": "2008ApJ...681.1183K", "RP15": "2015ApJ...801L..29R",
    "S14": "2014ApJS..214...15S", "S16": "2016MNRAS.462.1749S", "S03": "2003MNRAS.343..978S",
    "S03err": "2007MNRAS.379..400S", "K03a": "2003MNRAS.341...33K", "K03b": "2003MNRAS.341...54K",
    "B03": "2003AJ....125.1866B", "HB09": "2009MNRAS.396.1171H", "K03c": "2003MNRAS.346.1055K",
    "K01": "2001ApJ...556..121K", "S07": "2007MNRAS.382.1415S", "Mo13": "2013MNRAS.428.3121M",
    "B13": "2013ApJ...770...57B", "L17": "2017MNRAS.470.2982L", "C18": "2018MNRAS.476..875C",
    "MD14": "2014ARA&A..52..415M", "H12": "2012ApJ...756..113H", "W12": "2012MNRAS.424..232W",
    "PP04": "2004MNRAS.348L..59P", "D08": "2008MNRAS.390L..64D", "BN98": "1998ApJ...495...80B",
}
S03_ERRATUM_DOI = "10.1111/j.1365-2966.2007.12056.x"

# default dimension ranges and scales (DESIGN.md section 6); refreshed from the manifest
DIM_RANGE = {"logM": (7.0, 12.5), "logSFR": (-4.0, 2.5), "logsSFR": (-14.0, -8.0),
             "logSigma": (5.5, 11.0), "logMh": (10.0, 15.5), "N2Ha": (-2.5, 1.0),
             "O3Hb": (-1.5, 1.5), "logR50": (-1.0, 2.0), "OH": (7.6, 9.5),
             "OH_PP04": (7.8, 9.2), "logfHI": (-3.0, 2.5)}
DIM_SCALE = {"N2Ha": 0.172, "O3Hb": 0.351}


def ads(bibcode: str) -> str:
    return "https://ui.adsabs.harvard.edu/abs/" + bibcode.replace("&", "%26")


# =========================================================================================
# fetching (only with --fetch; the build itself is offline)
# =========================================================================================
def fetch_sources(keys=None, pause=4.0):
    """Download arXiv LaTeX sources into pipeline/cache/literature_src/<key>/ (cached)."""
    import requests
    SRC_DIR.mkdir(parents=True, exist_ok=True)
    for key, aid in ARXIV.items():
        if keys and key not in keys:
            continue
        out = SRC_DIR / key
        if out.exists() and any(out.iterdir()):
            continue
        body = None
        for attempt in range(5):
            try:
                r = requests.get(f"https://arxiv.org/src/{aid}", headers=UA, timeout=90)
                if r.status_code == 200 and len(r.content) > 500:
                    body = r.content
                    break
                print(f"  {key}: HTTP {r.status_code}, retrying", file=sys.stderr)
            except Exception as e:  # network hiccup
                print(f"  {key}: {e}, retrying", file=sys.stderr)
            time.sleep(pause * (2 ** attempt))
        if body is None:
            print(f"FAILED {key} {aid}", file=sys.stderr)
            continue
        out.mkdir(parents=True, exist_ok=True)
        (SRC_DIR / f"{key}.raw").write_bytes(body)
        raw = gzip.decompress(body) if body[:2] == b"\x1f\x8b" else body
        try:
            with tarfile.open(fileobj=io.BytesIO(raw)) as tf:
                tf.extractall(out, filter="data")
        except tarfile.ReadError:
            (out / ("paper.pdf" if raw[:4] == b"%PDF" else "main.tex")).write_bytes(raw)
        print(f"ok {key} {aid}")
        time.sleep(pause)


def fetch_s03_erratum():
    """Cache the OpenAlex record of the Shen et al. (2007) erratum (its abstract is the full
    erratum text; the publisher page is behind a bot check)."""
    import requests
    S03_ERRATUM_JSON.parent.mkdir(parents=True, exist_ok=True)
    r = requests.get(f"https://api.openalex.org/works/doi:{S03_ERRATUM_DOI}", headers=UA, timeout=60)
    r.raise_for_status()
    d = r.json()
    inv = d.get("abstract_inverted_index") or {}
    words = sorted((p, w) for w, ps in inv.items() for p in ps)
    d["_abstract_text"] = " ".join(w for _, w in words)
    S03_ERRATUM_JSON.write_text(json.dumps(d, indent=1))
    print("ok S03 erratum:", d["_abstract_text"][:120], "...")


R50_SQL = """SELECT TOP 30000 p.petroR50_r, p.petroR50_z, p.petroR90_r, p.fracDeV_r, s.z
FROM PhotoObj AS p JOIN SpecObj AS s ON s.bestObjID = p.objID
WHERE s.class = 'GALAXY' AND s.z BETWEEN 0.02 AND 0.25 AND p.petroMag_r < 17.77
 AND (s.legacy_target1 & 64) > 0 AND s.zWarning = 0 AND (p.objID % 23) = 5
 AND p.petroR50_r > 0 AND p.petroR50_z > 0"""


def fetch_r50_sample():
    """One SkyServer DR17 query: r- and z-band Petrosian R50 of a pseudo-random MGS subsample
    (objID % 23 == 5), used for the r-vs-z size conversion of S03 and K03b."""
    import pandas as pd
    import requests
    url = "https://skyserver.sdss.org/dr17/SkyServerWS/SearchTools/SqlSearch"
    for attempt in range(4):
        r = requests.get(url, params={"cmd": R50_SQL, "format": "csv"}, headers=UA, timeout=300)
        if r.status_code == 200 and len(r.text) > 1000:
            break
        time.sleep(10 * (attempt + 1))
    lines = r.text.splitlines()
    df = pd.read_csv(io.StringIO("\n".join(lines[1:] if lines[0].startswith("#") else lines)))
    df.to_csv(R50_SAMPLE_CSV, index=False)
    print("ok R50 sample:", len(df), "rows")


# =========================================================================================
# excerpt verification
# =========================================================================================
_norm_cache: dict = {}


def _normalise(text: str, strip_comments: bool = True) -> str:
    if strip_comments:
        text = re.sub(r"(?<!\\)%.*", "", text)
    return re.sub(r"\s+", " ", text)


def _source_text(key: str, fname: str) -> str | None:
    p = SRC_DIR / key / fname
    ck = str(p)
    if ck not in _norm_cache:
        if not p.exists():
            _norm_cache[ck] = None
        elif p.suffix == ".json":   # OpenAlex record: the erratum text
            _norm_cache[ck] = _normalise(json.loads(p.read_text()).get("_abstract_text", ""), False)
        else:
            _norm_cache[ck] = _normalise(p.read_text(errors="replace"))
    return _norm_cache[ck]


def check_excerpts(excerpts):
    """excerpts: list of (source_key, file, text). Returns (all_found, [(key, file, text, found)])."""
    rows, ok = [], True
    for key, fname, text in excerpts:
        src = _source_text(key, fname)
        found = None if src is None else (_normalise(text, False) in src)
        if found is not True:
            ok = False
        rows.append((key, fname, text, found))
    return ok, rows


# =========================================================================================
# conversions (derived numbers, all documented)
# =========================================================================================
# Madau & Dickinson (2014), arXiv:1403.0007, sec. 3 (verified): "To rescale stellar masses from
# Chabrier or Kroupa to Salpeter IMF, we divide by constant factors 0.61 and 0.66, respectively."
# and, for SFRs, "we divide by constant factors of 0.63 (Chabrier) or 0.67 (Kroupa)."
DEX_C2K_MASS = math.log10(0.66 / 0.61)    # +0.0342 dex, Chabrier -> Kroupa stellar mass
DEX_C2K_SFR = math.log10(0.67 / 0.63)     # +0.0267 dex, Chabrier -> Kroupa SFR
CONVENTION_EXCERPTS = [
    ("MD14", "paper.tex", "To rescale stellar masses from Chabrier or Kroupa to Salpeter IMF, we divide by constant factors 0.61 and 0.66, respectively."),
    ("MD14", "paper.tex", "we divide by constant factors of 0.63 (Chabrier) or 0.67 (Kroupa)."),
    ("D08", "update_concmass.tex", r"F & 0--2 & $5.71 \pm^{0.12}_{0.12}$ & $-0.084 \pm^{0.006}_{0.006}$ & $-0.47 \pm^{0.04}_{0.04}$"),
    ("D08", "update_concmass.tex", r"F & 0--2 & $7.85 \pm^{0.17}_{0.18}$ & $-0.081 \pm^{0.006}_{0.006}$ & $-0.71 \pm^{0.04}_{0.04}$"),
    ("D08", "update_concmass.tex", r"$M_{\rm pivot} = 2\times 10^{12}\,h^{-1}{\rm M}_{\odot}$"),
    ("BN98", None, r"\Delta_c = 18\pi^2 + 82x - 39x^2"),
    ("L17", "local_group.tex", r"$r_{180}$ is the radius of the halo, within which the mean mass density is 180 times the mean density of the universe"),
    ("PP04", "o3n2_08jan04.tex", r"A least squares linear fit to the data in the range $-1 < O3N2 < 1.9$ yields the relation:"),
    ("PP04", "o3n2_08jan04.tex", r"12 + \log {\rm (O/H)} = 8.73 - 0.32 \times O3N2"),
    ("K03a", "masses0_mn.tex", r"We adopt the universal initial mass function (IMF) as parametrized by Kroupa (2001)."),
    ("HB09", "hydebernardi.tex", r"a_{\rm ort} &=& 1.434 \quad {\rm and}\quad b_{\rm ort} = 0.315"),
]


def _find_tex(key: str) -> str | None:
    """Name of the .tex file in a source directory that holds the text (for None entries)."""
    d = SRC_DIR / key
    if not d.exists():
        return None
    texs = sorted(d.glob("*.tex"), key=lambda p: -p.stat().st_size)
    return texs[0].name if texs else None


# ---- Duffy et al. (2008) c(M, z), NFW, full sample, z = 0-2 (Table 1; verified) ----------
DUFFY08 = {"200c": (5.71, -0.084, -0.47), "vir": (7.85, -0.081, -0.71)}   # A, B, C
DUFFY08_PIVOT = 2e12   # h^-1 Msun


def omega_m_z(z, om0):
    a3 = (1.0 + z) ** 3
    return om0 * a3 / (om0 * a3 + 1.0 - om0)


def bn98_delta_vir_crit(z, om0):
    """Bryan & Norman (1998) eq. 6 for a flat universe: virial overdensity w.r.t. rho_crit(z)."""
    x = omega_m_z(z, om0) - 1.0
    return 18.0 * math.pi ** 2 + 82.0 * x - 39.0 * x ** 2


def duffy08_c(m_hinv, z, kind):
    A, B, C = DUFFY08[kind]
    return A * (m_hinv / DUFFY08_PIVOT) ** B * (1.0 + z) ** C


def _nfw_mu(x):
    return np.log1p(x) - x / (1.0 + x)


def to_m180m(log_m, kind, h, om0, z=Z_REF):
    """log10 of M_180m (180 x mean matter density, as in Lim+17) for NFW haloes of mass
    10**log_m [Msun] defined as `kind` ('200c' or 'vir', Bryan & Norman), in the source
    cosmology (h, om0). Concentrations from Duffy+08 (their masses are in h^-1 Msun).
    Solves m(x2)/x2^3 = q m(c)/c^3 with q = Delta_2 rho_2 / (Delta_1 rho_1)."""
    from scipy.optimize import brentq
    d_src = 200.0 if kind == "200c" else bn98_delta_vir_crit(z, om0)
    q = 180.0 * omega_m_z(z, om0) / d_src
    out = []
    for lm in np.atleast_1d(log_m):
        c = duffy08_c(10.0 ** lm * h, z, kind)
        rhs = q * _nfw_mu(c) / c ** 3
        x2 = brentq(lambda x: _nfw_mu(x) / x ** 3 - rhs, 1e-3 * c, 1e3 * c)
        out.append(lm + math.log10(_nfw_mu(x2) / _nfw_mu(c)))
    return np.array(out)


# ---- Petrosian R50 of a Sersic profile (seeing-free; SDSS eta = 0.2, 2 r_P aperture) -----
def petro_r50_over_re(n: float) -> float:
    """SDSS Petrosian half-light radius / true half-light radius for a Sersic-n profile.
    Petrosian radius where the annulus (0.8-1.25 r) SB equals 0.2 x mean SB inside r; the
    Petrosian flux is inside 2 r_P; R50 contains half of it. For n = 4 this gives 0.713
    (S03: 'only about 70 percent'), and a flux fraction of 0.816 (S03: 'about 80 percent')."""
    from scipy.optimize import brentq
    from scipy.special import gammainc, gammaincinv
    b = gammaincinv(2 * n, 0.5)
    L = lambda r: gammainc(2 * n, b * r ** (1.0 / n))
    ratio = lambda r: ((L(1.25 * r) - L(0.8 * r)) / (np.pi * (1.25 ** 2 - 0.8 ** 2) * r ** 2)) / (L(r) / (np.pi * r ** 2))
    r_p = brentq(lambda r: ratio(r) - 0.2, 0.05, 50.0)
    f_p = L(2 * r_p)
    return brentq(lambda r: L(r) - 0.5 * f_p, 1e-4, 2 * r_p)


M10_N_FINAL = 141825   # M10 sec. 2.1: "The final galaxy sample contains 141825 galaxies."


def m10_aperture_offset():
    """Median log SFR_tot - log SFR_fib of MPA-JHU for an M10-like selection.

    M10 select SDSS DR7 emission-line galaxies with 0.07 < z < 0.30, S/N(Halpha) > 25, no AGN
    (Kauffmann+03 BPT) and use SFRs *inside the fibre*. Our logSFR is the MPA-JHU total SFR,
    so the offset maps M10's mu_0.32 onto ours. We select MPA BPT classes 1-2 and
    0.07 < z < 0.30, and cut S/N(Halpha) > 25 on the catalogue errors AS GIVEN (no rescaling).

    Why raw errors (verifier, 2026-09-24): M10 do not rescale, and only the raw errors reproduce
    their sample. In our MGS parent the raw cut leaves 140,574 galaxies (M10: 141,825), while the
    MPA-JHU recommended rescaling (x2.473) leaves 50,144, a factor 2.8 too few. The two
    selections give median offsets of 0.51 and 0.29 dex. The first build used the rescaled cut.

    Also returned: the median of (mu_tot - mu_M10) in bins of our axis mu_tot (``inv_map``). A
    running median in mu_tot compares against this, so it tests the constant shift.
    Reads the sibling catalogue catalog/mgs_parent.parquet (read-only)."""
    import pandas as pd
    df = pd.read_parquet(PARENT, columns=["z", "log_mstar", "log_sfr", "log_sfr_fib", "bptclass", "f_ha", "e_ha"])
    try:
        sys.path.insert(0, str(PIPE))
        from config import LINE_ERR_SCALE  # the data agent's verified MPA-JHU rescalings
        ha_scale = float(LINE_ERR_SCALE["ha"])
    except Exception:
        ha_scale = 2.473
    base = ((df.z > 0.07) & (df.z < 0.30) & df.bptclass.isin([1, 2])
            & np.isfinite(df.log_sfr) & np.isfinite(df.log_sfr_fib) & (df.log_sfr > -10) & (df.log_sfr_fib > -10))
    with np.errstate(divide="ignore", invalid="ignore"):
        sn_raw = df.f_ha / df.e_ha
    m = base & (sn_raw > 25)                       # the M10 selection (raw errors)
    m_resc = base & (sn_raw / ha_scale > 25)       # for the record only
    dap = df.log_sfr - df.log_sfr_fib
    d = dap[m]
    bins = {}
    for lo in np.arange(9.0, 11.5, 0.5):
        mm = m & (df.log_mstar >= lo) & (df.log_mstar < lo + 0.5)
        if mm.sum() > 100:
            bins[f"{lo:.1f}-{lo + 0.5:.1f}"] = round(float(dap[mm].median()), 3)
    # per-galaxy mu_tot (ours: Kroupa, total SFR) and mu_M10 (Chabrier via 1.06, fibre SFR)
    mu_tot = (df.log_mstar - 0.32 * df.log_sfr)[m]
    mu_m10 = ((df.log_mstar - math.log10(1.06)) - 0.32 * (df.log_sfr_fib - DEX_C2K_SFR))[m]
    inv = {}
    for lo in np.arange(9.2, 11.4, 0.2):
        mm = (mu_tot >= lo) & (mu_tot < lo + 0.2)
        if mm.sum() > 1000:
            inv[f"{lo + 0.1:.1f}"] = round(float(np.median(mu_tot[mm]) - np.median(mu_m10[mm])), 3)
    return {"median": round(float(d.median()), 4), "p16": round(float(d.quantile(0.16)), 3),
            "p84": round(float(d.quantile(0.84)), 3), "n": int(m.sum()), "by_mass": bins,
            "sn_errors": "raw", "n_m10_paper": M10_N_FINAL,
            "n_rescaled": int(m_resc.sum()), "median_rescaled": round(float(dap[m_resc].median()), 4),
            "inv_map": inv, "ha_err_scale": ha_scale,
            "reconstruction": m10_reconstruction(ha_scale)}


# M10 sec. 2.1 (second review): of the 927,552 DR7 galaxies, the emission-line galaxies at
# 0.07 < z < 0.30 are 47 per cent (436k); S/N(Halpha) > 25 "selects 43% of the remaining sample";
# AGN-like galaxies are 22 per cent; log(total mass) - log(fiber mass) = 0.50 +/- 0.15.
M10_STATS = {"n_el": round(0.47 * 927552), "pass_sn25": 0.43, "agn": 0.22, "mtot_mfib": 0.50}


def m10_reconstruction(ha_scale):
    """Second review, 2026-09-24: which S/N(Halpha) > 25 cut reproduces M10's own sample
    statistics (M10_STATS)? 'Emission-line galaxies' are taken as S/N(Halpha) > 2 or > 3 on the raw
    errors. Also rebuilds M10-style fibre SFRs (Kennicutt 1998 from the Balmer-decrement corrected
    fibre Halpha flux, Cardelli law, case B 2.86) and compares them with the MPA-JHU fibre SFRs
    moved to Chabrier with MD14. Reads catalog/mgs_parent.parquet (read-only)."""
    import pandas as pd
    from astropy.cosmology import FlatLambdaCDM
    df = pd.read_parquet(PARENT, columns=["z", "log_mstar", "log_mstar_fib", "log_sfr_fib", "bptclass", "f_ha", "e_ha", "f_hb"])
    zc = ((df.z > 0.07) & (df.z < 0.30)).to_numpy()
    with np.errstate(divide="ignore", invalid="ignore"):
        sn = (df.f_ha / df.e_ha).to_numpy()
    bpt = df.bptclass.to_numpy()
    out = {"m10": M10_STATS, "mgs_parent_note": "MGS parent only; M10 used the full DR7 MPA-JHU catalogue"}
    for tag, scale in (("raw", 1.0), ("rescaled", ha_scale)):
        s25 = zc & (sn / scale > 25)
        r = {"n_sn25": int(s25.sum()), "agn": round(float(np.isin(bpt[s25], [3, 4, 5]).mean()), 3)}
        for thr in (2, 3):
            el = zc & (sn > thr)
            r[f"n_el_sn{thr}"] = int(el.sum())
            r[f"pass_el_sn{thr}"] = round(float((el & s25).sum() / el.sum()), 3)
        sf = s25 & np.isin(bpt, [1, 2]) & (df.log_mstar_fib.to_numpy() > 0)
        dmf = (df.log_mstar - df.log_mstar_fib).to_numpy()[sf]
        dmf = dmf[np.isfinite(dmf)]
        r["mtot_mfib_median"], r["mtot_mfib_std"] = round(float(np.median(dmf)), 3), round(float(np.std(dmf)), 3)
        out[tag] = r
    # M10-style fibre SFRs for the raw-error M10-like sample
    s = zc & (sn > 25) & np.isin(bpt, [1, 2]) & (df.f_hb.to_numpy() > 0) & (df.log_sfr_fib.to_numpy() > -10)
    with np.errstate(divide="ignore", invalid="ignore"):
        bd = (df.f_ha / df.f_hb).to_numpy()[s]
    ebv = 2.5 / (3.61 - 2.53) * np.log10(np.clip(bd, 2.86, None) / 2.86)
    ok = (bd >= 2.5) & (3.1 * ebv < 2.5)
    zz = df.z.to_numpy()[s][ok]
    dl = FlatLambdaCDM(H0=70.0, Om0=0.3).luminosity_distance(zz).to("cm").value
    lha = 4 * np.pi * dl ** 2 * df.f_ha.to_numpy()[s][ok] * 1e-17 * 10 ** (0.4 * 2.53 * ebv[ok])
    mpa_c = df.log_sfr_fib.to_numpy()[s][ok] - DEX_C2K_SFR
    out["k98_fibre_minus_mpa_fibre"] = {f"{f:g}": round(float(np.median(np.log10(7.9e-42 * lha / f) - mpa_c)), 3)
                                        for f in (1.0 / 0.63, 1.7, 1.8)}
    return out


def r50_band_ratio():
    """Median log10(petroR50_r / petroR50_z) from the SkyServer DR17 sample (R50_SQL), split at
    C = R90/R50 = 2.86 (the early/late divider used by S03)."""
    import pandas as pd
    df = pd.read_csv(R50_SAMPLE_CSV)
    df = df[(df.petroR50_r > 0) & (df.petroR50_z > 0) & (df.petroR90_r > 0)]
    c = df.petroR90_r / df.petroR50_r
    d = np.log10(df.petroR50_r / df.petroR50_z)
    # second review: the ratio depends on angular size (seeing pulls it towards zero for small
    # galaxies), so record it in bins of petroR50_r [arcsec]
    by_size = {}
    for lo, hi in ((0.0, 1.5), (1.5, 2.0), (2.0, 3.0), (3.0, 5.0), (5.0, 100.0)):
        mm = (df.petroR50_r >= lo) & (df.petroR50_r < hi)
        by_size[f"{lo:g}-{hi:g}"] = {"n": int(mm.sum()), "late": round(float(d[mm & (c < 2.86)].median()), 4),
                                     "early": round(float(d[mm & (c >= 2.86)].median()), 4)}
    return {"late": round(float(d[c < 2.86].median()), 4), "early": round(float(d[c >= 2.86].median()), 4),
            "all": round(float(d.median()), 4), "n": int(len(df)),
            "n_late": int((c < 2.86).sum()), "n_early": int((c >= 2.86).sum()), "by_size": by_size}


def derive_conversions() -> dict:
    """All derived numbers used by the conversions. Expensive pieces fall back to the cache."""
    cached = json.loads(CONV_JSON.read_text()) if CONV_JSON.exists() else {}
    conv = {"imf_mass_chab_to_kroupa": round(DEX_C2K_MASS, 4),
            "imf_sfr_chab_to_kroupa": round(DEX_C2K_SFR, 4),
            "m10_mass_factor_dex": round(math.log10(1.06), 4)}
    try:
        conv["m10_aperture"] = m10_aperture_offset()
    except Exception as e:
        if "m10_aperture" not in cached:
            raise
        print(f"  (aperture offset from cache: {e})")
        conv["m10_aperture"] = cached["m10_aperture"]
    try:
        conv["r50_r_over_z"] = r50_band_ratio()
    except Exception as e:
        if "r50_r_over_z" not in cached:
            raise
        print(f"  (R50 r/z ratio from cache: {e})")
        conv["r50_r_over_z"] = cached["r50_r_over_z"]
    conv["petro_r50_over_re"] = {str(n): round(petro_r50_over_re(n), 4) for n in (1, 4)}
    conv["petro_flux_fraction"] = {str(n): round(petro_flux_fraction(n), 4) for n in (1, 4)}
    conv["s03_petro_minus_sersic"] = {}
    for early, key, xs in [(False, "late", [9.0, 10.0, 11.0]), (True, "early", [10.0, 10.5, 11.0, 11.5])]:
        xs = np.array(xs)
        _, _, dps = _s03_to_ours(xs, _s03_sersic_z(xs, early), early, conv)
        conv["s03_petro_minus_sersic"][key] = dict(zip([f"{v:.1f}" for v in xs], np.round(dps, 4).tolist()))
    from astropy.cosmology import FlatLambdaCDM
    conv["age_z0p1_gyr_S14"] = round(float(FlatLambdaCDM(H0=70.0, Om0=0.3).age(Z_REF).value), 4)
    grid = np.array([11.0, 12.0, 13.0, 14.0, 15.0])
    conv["halo_m180m_minus_m200c_Mo13"] = dict(zip([f"{g:.0f}" for g in grid], np.round(to_m180m(grid, "200c", 0.704, 0.272) - grid, 4).tolist()))
    conv["halo_m180m_minus_mvir_B13"] = dict(zip([f"{g:.0f}" for g in grid], np.round(to_m180m(grid, "vir", 0.7, 0.27) - grid, 4).tolist()))
    conv["halo_om_sensitivity_B13_at_12"] = round(float(to_m180m([12.0], "vir", 0.7, 0.30)[0] - to_m180m([12.0], "vir", 0.7, 0.27)[0]), 4)
    CONV_JSON.write_text(json.dumps(conv, indent=1))
    return conv


# =========================================================================================
# small helpers
# =========================================================================================
def grid(lo, hi, n=N_GRID):
    return np.linspace(lo, hi, n)


def sg(v, nd=3):
    """Signed number for UI text: a true minus sign, and no '-0.000'."""
    v = float(v)
    if abs(v) < 0.5 * 10 ** -nd:
        return f"{0:.{nd}f}"
    return ("+" if v > 0 else "\u2212") + f"{abs(v):.{nd}f}"


def curve(xs, ys, style="solid", cid="main", label=None, nodes=None):
    pts = [[round(float(a), 4), round(float(b), 4)] for a, b in zip(xs, ys) if np.isfinite(a) and np.isfinite(b)]
    c = {"id": cid, "label": label, "style": style, "points": pts}
    if nodes is not None:   # optional, additive: the measured points a 'median' curve joins
        c["nodes"] = [[round(float(a), 4), round(float(b), 4)] for a, b in nodes]
    return c


def resample_arclength(x, y, n=N_GRID, sx=1.0, sy=1.0):
    x, y = np.asarray(x, float), np.asarray(y, float)
    s = np.concatenate([[0.0], np.cumsum(np.hypot(np.diff(x) / sx, np.diff(y) / sy))])
    t = np.linspace(0.0, s[-1], n)
    return np.interp(t, s, x), np.interp(t, s, y)


def relation(rid, label, name, cite, bib, view, x, y, kind, curves, *, band=None, fit_offset=False,
             rng=None, notes="", conversions="None.", source="", excerpts=(), meta=None):
    """Assemble one DESIGN.md section 9 record (+ internal metadata for LITERATURE.md)."""
    xs = [p[0] for c in curves for p in c["points"]]
    rng = rng or [round(min(xs), 4), round(max(xs), 4)]
    ok, rows = check_excerpts(list(excerpts))
    status = "verified" if ok else "unverified"
    rec = {
        "id": rid, "label": label, "name": name, "cite": cite, "url": ads(bib), "view": view,
        "x": x, "y": y, "kind": kind, "curves": curves, "band": band, "fitOffset": bool(fit_offset),
        "range": [round(float(rng[0]), 4), round(float(rng[1]), 4)], "notes": notes,
        "conversions": conversions,
        "verification": {"status": status, "source": source,
                         "excerpt": " ... ".join(e[2] for e in excerpts[:2])},
    }
    rec["_meta"] = dict(meta or {}, excerpt_rows=rows)
    return rec


# =========================================================================================
# relations
# =========================================================================================
T04_TABLE3 = [  # log M*, P2.5, P16, P50, P84, P97.5 of 12+log(O/H)  (T04 Table 3, tb3.tex)
    (8.57, 8.18, 8.25, 8.44, 8.64, 8.77), (8.67, 8.11, 8.28, 8.48, 8.65, 8.84),
    (8.76, 8.13, 8.32, 8.57, 8.70, 8.88), (8.86, 8.14, 8.37, 8.61, 8.73, 8.89),
    (8.96, 8.21, 8.46, 8.63, 8.75, 8.95), (9.06, 8.26, 8.56, 8.66, 8.82, 8.97),
    (9.16, 8.37, 8.59, 8.68, 8.82, 8.95), (9.26, 8.39, 8.60, 8.71, 8.86, 9.04),
    (9.36, 8.46, 8.63, 8.74, 8.88, 9.03), (9.46, 8.53, 8.66, 8.78, 8.92, 9.07),
    (9.57, 8.59, 8.69, 8.82, 8.94, 9.08), (9.66, 8.60, 8.72, 8.84, 8.96, 9.09),
    (9.76, 8.63, 8.76, 8.87, 8.99, 9.10), (9.86, 8.67, 8.80, 8.90, 9.01, 9.12),
    (9.96, 8.71, 8.83, 8.94, 9.05, 9.14), (10.06, 8.74, 8.85, 8.97, 9.06, 9.15),
    (10.16, 8.77, 8.88, 8.99, 9.09, 9.16), (10.26, 8.80, 8.92, 9.01, 9.10, 9.17),
    (10.36, 8.82, 8.94, 9.03, 9.11, 9.18), (10.46, 8.85, 8.96, 9.05, 9.12, 9.21),
    (10.56, 8.87, 8.98, 9.07, 9.14, 9.21), (10.66, 8.89, 9.00, 9.08, 9.15, 9.23),
    (10.76, 8.91, 9.01, 9.09, 9.15, 9.24), (10.86, 8.93, 9.02, 9.10, 9.16, 9.25),
    (10.95, 8.93, 9.03, 9.11, 9.17, 9.26), (11.05, 8.92, 9.03, 9.11, 9.17, 9.27),
    (11.15, 8.94, 9.04, 9.12, 9.18, 9.29), (11.25, 8.93, 9.03, 9.12, 9.18, 9.29),
]

C18_TABLE1 = [  # <log M*>, weighted mean, weighted median of log(MHI/M*), N  (C18 Table 1)
    (9.14, -0.242, -0.092, 113), (9.44, -0.459, -0.320, 92), (9.74, -0.748, -0.656, 96),
    (10.07, -0.869, -0.854, 214), (10.34, -1.175, -1.278, 191), (10.65, -1.231, -1.223, 189),
    (10.95, -1.475, -1.707, 196), (11.20, -1.589, -1.785, 86),
]


def _parse_rows(key, fname, start_pat, ncol, nrows):
    """Parse numeric rows of a cached LaTeX table (for cross-checking hard-coded copies)."""
    p = SRC_DIR / key / fname
    if not p.exists():
        return None
    t = p.read_text(errors="replace")
    i = t.find(start_pat)
    if i < 0:
        return None
    rows = []
    for line in t[i:].split("\\\\"):
        nums = re.findall(r"-?\d+\.\d+|(?<![.\d])\d+(?![.\d])", line.replace("$-$", "-").replace("\\pm", " "))
        if len(nums) >= ncol:
            rows.append(tuple(float(v) for v in nums[:ncol]))
        if len(rows) == nrows:
            break
    return rows


def rel_T04(conv):
    """Tremonti et al. (2004) MZR. arXiv:astro-ph/0405537, eq. 3; band from Table 3.

    Coefficients: 12+log(O/H) = -1.492 + 1.847 x - 0.08026 x^2, x = log M*, valid 8.5-11.5.
    IMF Kroupa (2001); H0 = 70, Om = 0.3. Masses: Kauffmann+03a (spectral indices + z band,
    DR2). O/H: Bayesian CL01-model fits (Charlot+04 formalism), the method behind MPA-JHU
    OH_P50 = our `OH`. Conversions: none. Table 3 gives P2.5..P97.5 in 0.1-dex mass bins;
    the band is P16-P84."""
    tab = _parse_rows("T04", "tb3.tex", r"\startdata", 6, 28)
    if tab is not None:
        assert [tuple(r) for r in tab] == [tuple(r) for r in T04_TABLE3], "T04 Table 3 copy differs from source"
    x = grid(8.5, 11.5)
    y = -1.492 + 1.847 * x - 0.08026 * x ** 2
    band = [[r[0], r[2], r[4]] for r in T04_TABLE3]
    return relation(
        "T04", "T04", "Tremonti et al. (2004) mass-metallicity relation",
        "Tremonti, C. A., et al. 2004, ApJ, 613, 898", BIBCODE["T04"], "mzr",
        {"logM": 1.0}, {"OH": 1.0}, "fit", [curve(x, y, "solid")], band=band,
        notes="Fit to about 53,000 SDSS DR2 star-forming galaxies. T04 masses use a Kroupa IMF, as ours do. "
              "T04 O/H comes from the same Bayesian method as the MPA-JHU OH values on this axis. "
              "The band shows the 16th to 84th percentiles in bins of mass from T04 Table 3.",
        conversions="None.",
        source="arXiv:astro-ph/0405537 eq. 3 and Table 3",
        excerpts=[("T04", "ms.tex", r"\textrm{12+log(O/H)} = -1.492 + 1.847 (\log \textrm{M}_{*}) - 0.08026 (\log \textrm{M}_{*})^2"),
                  ("T04", "ms.tex", r"This equation is valid over the range $8.5 < \log\textrm{M}_{*} < 11.5$."),
                  ("T04", "ms.tex", r"Our masses assume a \citet{Kroupa_2001} Initial Mass Function (IMF)."),
                  ("T04", "tb3.tex", r"8.57 & 8.18 & 8.25 & 8.44 & 8.64 & 8.77")],
        meta=dict(arxiv=ARXIV["T04"], where="eq. 3; Table 3", imf="Kroupa (2001)", cosmo="H0=70, Om=0.3, OL=0.7",
                  calib="O/H from Bayesian CL01 photoionization-model fits (Charlot+04), the MPA-JHU OH_P50 method; masses Kauffmann+03a",
                  validity="8.5 < log M* < 11.5"))


def rel_KE08(conv):
    """Kewley & Ellison (2008) MZR for the PP04 O3N2 calibration. arXiv:0801.1849, Table 2.

    Robust cubic y = a + b x + c x^2 + d x^3 (the table note misprints it as a+bx+bx^2+bx^3),
    PP04 O3N2 row: a = 32.1488, b = -8.51258, c = 0.976384, d = -0.0359763, rms 0.10.
    SDSS DR4, masses from T04/Kauffmann+03a (Kroupa, H0 = 70; the paper itself adopts h=0.72 but
    uses those masses). Medians in 0.2-dex bins centred 8.6..11.0. Same calibration as our
    OH_PP04 (8.73 - 0.32 O3N2). Conversions: none."""
    x = grid(8.5, 11.0)
    y = 32.1488 - 8.51258 * x + 0.976384 * x ** 2 - 0.0359763 * x ** 3
    return relation(
        "KE08", "KE08", "Kewley & Ellison (2008) mass-metallicity relation, PP04 O3N2",
        "Kewley, L. J., & Ellison, S. L. 2008, ApJ, 681, 1183", BIBCODE["KE08"], "mzr2",
        {"logM": 1.0}, {"OH_PP04": 1.0}, "fit", [curve(x, y, "solid")],
        notes="Robust cubic fit for the PP04 O3N2 calibration, which is also the calibration of our OH_PP04 axis. "
              "KE08 used SDSS DR4 star-forming galaxies and the Kauffmann et al. (2003) masses, which use a Kroupa IMF.",
        conversions="None.",
        source="arXiv:0801.1849 Table 2 (PP04 O3N2 row)",
        excerpts=[("KE08", "ms.tex", r"PP04 O3N2 & 32.1488 & -8.51258 & 0.976384 & -0.0359763 & 0.10"),
                  ("KE08", "ms.tex", r"Robust fits are of the form $y=a+bx+bx^2+bx^3$ where $y=\log({\rm O/H})+12$ and $x=\log({\rm M})$"),
                  ("KE08", "ms.tex", r"centered at $\log({\rm M})=8.6,8.8,...,11$"),
                  ("KE08", "ms.tex", r"The SDSS stellar masses were derived by \citet{Tremonti04} and \citet{Kauffmann03a}")],
        meta=dict(arxiv=ARXIV["KE08"], where="Table 2, PP04 O3N2 row", imf="Kroupa (T04/K03a masses)",
                  cosmo="masses from K03a/T04 (H0=70); paper adopts h=0.72, Om=0.29",
                  calib="PP04 O3N2, same as our OH_PP04", validity="bins centred at log M* = 8.6 to 11.0"))


def _t04(x):
    return -1.492 + 1.847 * x - 0.08026 * x ** 2


def _am13(x):
    return 8.798 - np.log10(1.0 + (10 ** 8.901 / 10 ** np.asarray(x)) ** 0.640)


def _c20(x_kroupa, conv):
    xc = np.asarray(x_kroupa) - conv["imf_mass_chab_to_kroupa"]
    return 8.793 - (0.28 / 1.2) * np.log10(1.0 + (10 ** (xc - 10.02)) ** -1.2)


def rel_AM13(conv):
    """Andrews & Martini (2013) direct-method MZR. arXiv:1211.3418, eq. 5 and Table 4.

    12+log(O/H) = 12+log(O/H)_asm - log(1 + (M_TO/M*)^gamma) with log M_TO = 8.901,
    12+log(O/H)_asm = 8.798, gamma = 0.640, fit range 7.4-10.5 (M* stacks). Masses: MPA-JHU DR7
    total (our masses). O/H: electron-temperature (direct) method on stacked spectra.
    Axis choice: drawn on OH_PP04. The direct scale sits 0.2-0.4 dex below the CL01-model T04
    scale, and PP04 O3N2 is an empirical calibration against (mostly) Te-based H II region
    abundances, so it is the closer of our two axes. Conversions: none."""
    x = grid(7.4, 10.5)
    y = _am13(x)
    d9, d11 = float(_t04(9.0) - _am13(9.0)), float(_t04(11.0) - _am13(11.0))
    return relation(
        "AM13", "AM13", "Andrews & Martini (2013) direct-method mass-metallicity relation",
        "Andrews, B. H., & Martini, P. 2013, ApJ, 765, 140", BIBCODE["AM13"], "mzr2",
        {"logM": 1.0}, {"OH_PP04": 1.0}, "fit", [curve(x, y, "dashed")],
        notes="O/H from the direct (electron temperature) method in stacked SDSS DR7 spectra, binned by mass. "
              "Masses are the MPA-JHU DR7 total masses, the same as ours. "
              f"The direct O/H scale is lower than the T04 scale, by {d9:.2f} dex at 10⁹ M☉ and {d11:.2f} dex at 10¹¹ M☉. "
              "We draw AM13 on the O3N2 axis because PP04 O3N2 is tied to direct O/H of H II regions.",
        conversions="None. The curve is drawn on the OH_PP04 axis, not the T04 axis.",
        source="arXiv:1211.3418 eq. 5 and Table 4",
        excerpts=[("AM13", "tab4.tex", r"MZR & 8.901 & 8.798 & 0.640 & 7.4--10.5 & 0.18"),
                  ("AM13", "ms.tex", r"12 + {\rm log(O/H)} = 12 + {\rm log(O/H)}_{\rm asm} - {\rm log}\left(1 + \left(\frac{M_{\rm TO}}{M_\star}\right)^\gamma\right),"),
                  ("AM13", "ms.tex", r"We adopt the total stellar mass \citep{kauffmann2003a} and the total SFR \citep{brinchmann2004, salim2007} values from the MPA-JHU")],
        meta=dict(arxiv=ARXIV["AM13"], where="eq. 5; Table 4 row 'MZR'", imf="MPA-JHU DR7 (Kroupa), unchanged",
                  cosmo="H0=70, Om=0.3, OL=0.7", calib="direct Te method (T_e[OII] based) on stacks; drawn on OH_PP04",
                  validity="7.4 < log M* < 10.5"))


def rel_C20(conv):
    """Curti et al. (2020) MZR on a Te-based strong-line scale. arXiv:1910.00597, eq. 2, Table 4.

    12+log(O/H) = Z0 - gamma/beta log(1 + (M/M0)^-beta), Z0 = 8.793, log M0 = 10.02,
    gamma = 0.28, beta = 1.2, trustworthy for 7.95 < log M* < 11.85. Masses: MPA-JHU (SED fits)
    'rescaled to a common Chabrier IMF'. O/H: Curti+17 strong-line calibrations tied to Te.
    Axis choice: OH_PP04 (as AM13). Conversions: log M* + 0.034 dex (MD14, Chabrier -> Kroupa)
    to undo the rescaling; range shifted accordingly."""
    k = conv["imf_mass_chab_to_kroupa"]
    xc = grid(7.95, 11.85)
    y = 8.793 - (0.28 / 1.2) * np.log10(1.0 + (10 ** (xc - 10.02)) ** -1.2)
    return relation(
        "C20", "C20", "Curti et al. (2020) mass-metallicity relation, Te-based calibrations",
        "Curti, M., et al. 2020, MNRAS, 491, 944", BIBCODE["C20"], "mzr2",
        {"logM": 1.0}, {"OH_PP04": 1.0}, "fit", [curve(xc + k, y, "dotted")],
        notes="Fit to median O/H in bins of mass for about 150,000 SDSS DR7 galaxies. "
              "O/H comes from strong line calibrations that Curti et al. (2017) tied to electron temperature abundances. "
              "We draw it on the O3N2 axis for the same reason as AM13.",
        conversions=f"log M★ {sg(k)} dex. C20 rescaled the MPA-JHU masses to a Chabrier IMF, and we undo that "
                    f"with the Madau & Dickinson (2014) factors 0.61 and 0.66.",
        source="arXiv:1910.00597 eq. 2 and Table 4",
        excerpts=[("C20", "fmr_new_paper.tex", r"\text{Equation (2)} & 8.793 $\pm$ 0.005 & 10.02 $\pm$ 0.09 & 0.28 $\pm$ 0.02 & 1.2 $\pm$ 0.2"),
                  ("C20", "fmr_new_paper.tex", r"\text{12 + log(O/H)} = \text{Z}_{0} - \gamma/\beta * \text{log}\bigg(1 + \bigg(\frac{\text{M}}{\text{M}_{0}} \bigg)^{-\beta} \bigg)"),
                  ("C20", "fmr_new_paper.tex", r"Both stellar masses and SFRs estimates are re-scaled to a common \cite{Chabrier:2003aa} IMF."),
                  ("C20", "fmr_new_paper.tex", r"trustworthy only in the $7.95 < $log(M$_{\star}$)$ < 11.85$ range")],
        meta=dict(arxiv=ARXIV["C20"], where="eq. 2; Table 4 row 'Equation (2)'", imf="Chabrier (MPA-JHU masses rescaled)",
                  cosmo="not needed (MPA-JHU masses)", calib="Curti+17 Te-based strong-line calibrations; drawn on OH_PP04",
                  validity="7.95 < log M* < 11.85 (Chabrier)"))


def rel_M10(conv):
    """Mannucci et al. (2010) FMR projection. arXiv:1005.0006, eq. 4 (x = mu_0.32 - 10).

    12+log(O/H) = 8.90 + 0.39x - 0.20x^2 - 0.077x^3 + 0.064x^4, mu_0.32 = log M* - 0.32 log SFR.
    Table 1 spans log M* 9.10-11.35 and log SFR -1.45..+0.80, i.e. mu_0.32 ~ 9.2-11.4.
    Masses: MPA-JHU (K03a) divided by 1.06 to Chabrier. SFRs: dust-corrected Halpha INSIDE the
    3" fibre with Kennicutt (1998) scaled to Chabrier. O/H: Maiolino+08 (average of N2 and R23).
    Conversions to our mu_0.32 (total SFR, Kroupa):
      + log 1.06 = 0.025 (mass IMF), - 0.32 x 0.027 (SFR IMF, MD14),
      - 0.32 x Delta_ap with Delta_ap = median MPA-JHU log SFR_tot - log SFR_fib for an
        M10-like sample selected on the raw Halpha errors, which reproduces M10's N
        (0.51 dex; see m10_aperture_offset). Verifier correction 2026-09-24: the first build
        used rescaled errors (N 2.8x too small) and 0.29 dex, i.e. a shift of -0.075 instead
        of -0.146.
    Drawn on OH_PP04 (the FMR preset y) with fitOffset: the M08 and PP04 zero points differ."""
    ap = conv["m10_aperture"]["median"]
    dx = conv["m10_mass_factor_dex"] - 0.32 * conv["imf_sfr_chab_to_kroupa"] - 0.32 * ap
    mu = grid(9.2, 11.4)
    t = mu - 10.0
    y = 8.90 + 0.39 * t - 0.20 * t ** 2 - 0.077 * t ** 3 + 0.064 * t ** 4
    bm = conv["m10_aperture"]["by_mass"]
    k_lo, k_hi = max(bm, key=bm.get), min(bm, key=bm.get)
    rng_txt = lambda k: k.replace("-", " to ")
    n_sel, n_paper = conv["m10_aperture"]["n"], conv["m10_aperture"].get("n_m10_paper", M10_N_FINAL)
    return relation(
        "M10", "M10", "Mannucci et al. (2010) fundamental metallicity relation, μ0.32 projection",
        "Mannucci, F., et al. 2010, MNRAS, 408, 2115", BIBCODE["M10"], "fmr",
        {"logM": 1.0, "logSFR": -0.32}, {"OH_PP04": 1.0}, "fit", [curve(mu + dx, y, "solid")],
        fit_offset=True,
        notes="Projection of the fundamental metallicity relation onto μ0.32 = log M★ − 0.32 log SFR. "
              "M10 used the Maiolino et al. (2008) O/H calibrations, whose zero point and dynamic range differ from PP04 O3N2. "
              "For this reason the site shifts the curve in y to the median of the data, and the shape is only a guide. "
              "M10 used SFRs inside the 3 arcsec fibre, while our SFRs are totals.",
        conversions=f"μ0.32 {sg(dx)} dex in total. This is {sg(conv['m10_mass_factor_dex'])} for the mass IMF (M10 divided the "
                    f"MPA-JHU masses by 1.06), −0.32 × {conv['imf_sfr_chab_to_kroupa']:.3f} for the SFR IMF, and −0.32 × {ap:.3f} "
                    f"for fibre versus total SFR. The {ap:.3f} dex is the median MPA-JHU aperture correction for galaxies "
                    f"selected as in M10, with the S/N(Hα) > 25 cut on the catalogue errors as M10 applied it. This selection "
                    f"gives N = {n_sel:,}, close to the {n_paper:,} of M10. It is {bm[k_lo]:.2f} dex at log M★ = {rng_txt(k_lo)} "
                    f"and {bm[k_hi]:.2f} dex at log M★ = {rng_txt(k_hi)}.",
        source="arXiv:1005.0006 eq. 4 (projection), sec. 2 (sample, IMF, fibre SFRs)",
        excerpts=[("M10", "fmr4.tex", r"12+log(O/H) = 8.90 + 0.39x -0.20x^2 - 0.077x^3 +0.064x^4"),
                  ("M10", "fmr4.tex", r"where $x=\mu_{0.32}-10$."),
                  ("M10", "fmr4.tex", r"with a correction factor of 1.06 to scale the masses down from a \cite{Kroupa01} to a \cite{Chabrier03} initial mass function (IMF)."),
                  ("M10", "fmr4.tex", r"SFRs inside the spectroscopic aperture were measured from the \ha\ emission line flux corrected for dust extinction"),
                  ("M10", "fmr4.tex", r"We selected emission-line galaxies with redshift between 0.07 and 0.30")],
        meta=dict(arxiv=ARXIV["M10"], where="eq. 4 (mu_0.32 quartic); eq. 2 is the fit in M* and SFR", imf="Chabrier (masses = MPA-JHU / 1.06)",
                  cosmo="MPA-JHU (H0=70)", calib="Maiolino+08 (N2 and R23 average); fibre Halpha SFRs",
                  validity="mu_0.32 about 9.2 to 11.4 (M10 Table 1 grid)"))


def rel_RP15(conv):
    """Renzini & Peng (2015) SF main sequence ridge line. arXiv:1502.01027, sec. 2 (text).

    log SFR = (0.76 +/- 0.01) log M* - 7.64 +/- 0.02, SDSS DR7, 0.02 < z < 0.085, AGN excluded,
    no SF preselection (ridge = mode). SFRs from Halpha and SED masses 'following the same
    procedures as in Brinchmann04', i.e. the MPA-JHU pipeline (Kroupa). The IMF is not stated.
    Range 8.5-11.0 (their Fig. 4 shows a straight ridge up to ~10^11). Conversions: none.
    IMF (second review, 2026-09-24): not stated. Had RP15 used Chabrier values, moving both mass
    (+0.034) and SFR (+0.027) to Kroupa shifts the line by 0.027 - 0.76 x 0.034 = +0.001 dex only
    (the first build's text said 'up to 0.03 dex')."""
    x = grid(8.5, 11.0)
    return relation(
        "RP15", "RP15", "Renzini & Peng (2015) star-forming main sequence (ridge line)",
        "Renzini, A., & Peng, Y. 2015, ApJL, 801, L29", BIBCODE["RP15"], "sfms",
        {"logM": 1.0}, {"logSFR": 1.0}, "fit", [curve(x, 0.76 * x - 7.64, "solid")],
        notes="Ridge line, that is the peak of the SFR distribution at fixed mass, for SDSS DR7 galaxies at 0.02 < z < 0.085. "
              "RP15 did not preselect star-forming galaxies. "
              "Their SFRs and masses follow the Brinchmann et al. (2004) procedures, which use a Kroupa IMF.",
        conversions=rp15_imf_text(),
        source="arXiv:1502.01027 sec. 2 (fit to the ridge line, text below Fig. 3)",
        excerpts=[("RP15", "mainsequence_apj2b.tex", r"The best straight-line fit to the ridge line is log(SFR) = $(0.76\pm 0.01){\rm log}(M*/\msun) - 7.64\pm 0.02$"),
                  ("RP15", "mainsequence_apj2b.tex", r"release \citep{Abazajian07} for lying at $0.02<z<0.085$"),
                  ("RP15", "mainsequence_apj2b.tex", r"following the same procedures as in \cite{Brinchmann04} and P10")],
        meta=dict(arxiv=ARXIV["RP15"], where="sec. 2, text", imf="not stated (Brinchmann+04 procedures, Kroupa)",
                  cosmo="not stated (MPA-JHU-style values)", calib="Halpha SFRs, SED masses", validity="about 8.5 < log M* < 11"))


def rp15_imf_text():
    """RP15 do not state their IMF. For a line of slope s in (log M*, log SFR), moving a galaxy
    from Chabrier to Kroupa (+k_m in mass, +k_s in SFR) moves the line by k_s - s k_m; in the
    sSFR form (slope s - 1) the shift is (k_s - k_m) - (s - 1) k_m, the same number."""
    d = DEX_C2K_SFR - 0.76 * DEX_C2K_MASS
    return (f"None. RP15 do not state the IMF. If their masses and SFRs were Chabrier values, moving both to Kroupa "
            f"({sg(DEX_C2K_MASS)} dex in mass, {sg(DEX_C2K_SFR)} dex in SFR) would move the line by only {sg(d)} dex, "
            f"because the two shifts nearly cancel along its slope.")


def rel_RP15s(conv):
    """RP15 ridge line in sSFR form: log sSFR = log SFR - log M* = -0.24 log M* - 7.64."""
    x = grid(8.5, 11.0)
    return relation(
        "RP15s", "RP15", "Renzini & Peng (2015) main sequence, as sSFR",
        "Renzini, A., & Peng, Y. 2015, ApJL, 801, L29", BIBCODE["RP15"], "ssfr",
        {"logM": 1.0}, {"logsSFR": 1.0}, "fit", [curve(x, -0.24 * x - 7.64, "solid")],
        notes="The RP15 ridge line written as log sSFR = −0.24 log M★ − 7.64.",
        conversions="None. The line is log SFR − log M★ from RP15. " + rp15_imf_text()[len("None. "):],
        source="arXiv:1502.01027 sec. 2",
        excerpts=[("RP15", "mainsequence_apj2b.tex", r"The best straight-line fit to the ridge line is log(SFR) = $(0.76\pm 0.01){\rm log}(M*/\msun) - 7.64\pm 0.02$")],
        meta=dict(arxiv=ARXIV["RP15"], where="sec. 2, text (rewritten as sSFR)", imf="as RP15", cosmo="as RP15",
                  calib="as RP15", validity="about 8.5 < log M* < 11"))


def rel_S14(conv):
    """Speagle et al. (2014) main sequence at z = 0.1. arXiv:1405.2041, eq. 28 (sec. 4.1).

    log SFR = (0.84 - 0.026 t) log M* - (6.51 - 0.11 t), t = age of the universe in Gyr,
    (h, Om, OL) = (0.7, 0.3, 0.7), Kroupa IMF. Fitted mass range 9.7-11.1. The local SDSS
    studies were excluded from the fit, so z = 0.1 is an extrapolation in time.
    t(z=0.1) = 12.2 Gyr (astropy FlatLambdaCDM 70/0.3). Conversions: none."""
    t = conv["age_z0p1_gyr_S14"]
    x = grid(9.7, 11.1)
    y = (0.84 - 0.026 * t) * x - (6.51 - 0.11 * t)
    return relation(
        "S14", "S14", f"Speagle et al. (2014) main sequence at z = {Z_REF}",
        "Speagle, J. S., et al. 2014, ApJS, 214, 15", BIBCODE["S14"], "sfms",
        {"logM": 1.0}, {"logSFR": 1.0}, "fit", [curve(x, y, "dashed")],
        notes=f"Consensus main sequence from 25 studies, evaluated at the age of the universe at z = {Z_REF} "
              f"(t = {t:.1f} Gyr in their cosmology). S14 left the local SDSS studies out of their fit, so this curve "
              f"extends their fit to low redshift. S14 use a Kroupa IMF and h = 0.7, as we do. The fit covers log M★ = 9.7 to 11.1.",
        conversions="None.",
        source="arXiv:1405.2041 eq. 28 (best fit, sec. 4.1)",
        excerpts=[("S14", "ms_emulateapj.tex", r"\log\psi(M_*,t) &= \left(0.84 \pm 0.02 - 0.026 \pm 0.003 \times t\right) \log M_* \nonumber \\ &- \left(6.51 \pm 0.24 - 0.11 \pm 0.03 \times t\right),"),
                  ("S14", "ms_emulateapj.tex", r"within the fitted mass range $\log M_* = 9.7$\,--\,$11.1$"),
                  ("S14", "ms_emulateapj.tex", r"$(h,\Omega_M,\Omega_\Lambda)=(0.7,0.3,0.7)$"),
                  ("S14", "ms_emulateapj.tex", r"a Kroupa \citep{kroupa01,kroupaweidner03} IMF"),
                  ("S14", "ms_emulateapj.tex", r"we decide not to include them at all rather than unduly overweight the fit towards results in the local Universe")],
        meta=dict(arxiv=ARXIV["S14"], where="eq. 28 (sec. 4.1)", imf="Kroupa", cosmo="h=0.7, Om=0.3, OL=0.7",
                  calib="compilation calibrated to common SFR/mass conventions", validity="9.7 < log M* < 11.1"))


def rel_S16(conv):
    """Saintonge et al. (2016) main sequence. arXiv:1607.05289, eq. 5.

    log SFR = -2.332 x + 0.4156 x^2 - 0.01828 x^3, x = log M*. Characteristic (Gaussian peak)
    SFRs of SDSS DR7 galaxies with 0.01 < z < 0.05 and M* > 10^8 in 0.15-dex bins. Masses from
    MPA-JHU (Salim+07 photometric method), used as given. SFRs: GALEX NUV + WISE, Kroupa-based,
    then 'a 6% correction factor following madaudickinson14 ... consistent with a Chabrier IMF'.
    Conversions: log SFR + log(0.67/0.63) = +0.027 dex (undo the Chabrier scaling)."""
    k = conv["imf_sfr_chab_to_kroupa"]
    x = grid(8.0, 11.5)
    y = -2.332 * x + 0.4156 * x ** 2 - 0.01828 * x ** 3
    return relation(
        "S16", "S16", "Saintonge et al. (2016) main sequence",
        "Saintonge, A., et al. 2016, MNRAS, 462, 1749", BIBCODE["S16"], "sfms",
        {"logM": 1.0}, {"logSFR": 1.0}, "fit", [curve(x, y + k, "dotted")],
        notes="Cubic fit to the peak SFR of SDSS DR7 galaxies at 0.01 < z < 0.05 in bins of mass. "
              "The SFRs come from GALEX NUV and WISE data, not from MPA-JHU. The masses are MPA-JHU values.",
        conversions=f"log SFR {sg(k)} dex. S16 scaled their SFRs down by 6 percent to a Chabrier IMF, and we undo that "
                    f"(Madau & Dickinson 2014 factors 0.63 and 0.67).",
        source="arXiv:1607.05289 eq. 5",
        excerpts=[("S16", "ms.tex", r"\log {\rm SFR} = -2.332 x + 0.4156 x^2 - 0.01828 x^3,"),
                  ("S16", "ms.tex", r"We extract all galaxies from the SDSS DR7 with $0.01<z<0.05$ and \mstar$>10^8$\msun"),
                  ("S16", "ms.tex", r"We finally apply a 6\% correction factor following \citet{madaudickinson14} to make \sfruv\ consistent with a Chabrier IMF."),
                  ("S16", "ms.tex", r"Stellar masses derived based on the SDSS photometry method of \citet{salim07} are retrieved from the MPA/JHU catalog.")],
        meta=dict(arxiv=ARXIV["S16"], where="eq. 5", imf="Chabrier (SFR scaled by 0.94); MPA-JHU masses",
                  cosmo="H0=70, Om=0.3, OL=0.7", calib="NUV + WISE SFRs", validity="fit to bins with M* > 10^8"))


def _w12_threshold(rid, view, x, y, xr, pts_y, name_suffix):
    xs = np.linspace(xr[0], xr[1], N_LINE)
    ys = pts_y(xs)
    return relation(
        rid, "W12", f"Quiescence threshold, sSFR = 10⁻¹¹ yr⁻¹ ({name_suffix})",
        "Wetzel, A. R., Tinker, J. L., & Conroy, C. 2012, MNRAS, 424, 232", BIBCODE["W12"], view,
        x, y, "threshold", [curve(xs, ys, "dotted")],
        notes="Line of constant sSFR = 10⁻¹¹ yr⁻¹. W12 call galaxies below it quenched and galaxies above it active. "
              "W12 used the MPA-JHU DR7 sSFRs, as we do.",
        conversions="None.",
        source="arXiv:1107.5311 sec. 2.1",
        excerpts=[("W12", "ms.tex", r"we divide galaxies into those with $\ssfr > 10^{-11}\yrinv$, referred to as `active', and those with $\ssfr < 10^{-11}\yrinv$, referred to as `quenched'.")],
        meta=dict(arxiv=ARXIV["W12"], where="sec. 2.1", imf="MPA-JHU (same as ours)", cosmo="-", calib="MPA-JHU DR7 sSFR",
                  validity="all masses"))


def rel_Q11(conv):
    """sSFR = 1e-11 /yr in the SFMS view: log SFR = log M* - 11 (W12 sec. 2.1)."""
    return _w12_threshold("Q11", "sfms", {"logM": 1.0}, {"logSFR": 1.0}, DIM_RANGE["logM"], lambda x: x - 11.0, "SFR view")


def rel_Q11s(conv):
    """sSFR = 1e-11 /yr in the sSFR view: log sSFR = -11."""
    return _w12_threshold("Q11s", "ssfr", {"logM": 1.0}, {"logsSFR": 1.0}, DIM_RANGE["logM"], lambda x: np.full_like(x, -11.0), "sSFR view")


def rel_Q11e(conv):
    """sSFR = 1e-11 /yr in the environment view (x = halo mass)."""
    return _w12_threshold("Q11e", "env", {"logMh": 1.0}, {"logsSFR": 1.0}, DIM_RANGE["logMh"], lambda x: np.full_like(x, -11.0), "halo mass view")


def rel_Q11d(conv):
    """sSFR = 1e-11 /yr in the surface density view (x = log Sigma*)."""
    return _w12_threshold("Q11d", "sigma", {"logSigma": 1.0}, {"logsSFR": 1.0}, DIM_RANGE["logSigma"], lambda x: np.full_like(x, -11.0), "surface density view")


# Shen et al. (2003) Table 1 size-luminosity fits (verified excerpts in rel_S03L/rel_S03E):
#   row "Figure 4": Petrosian r-band R50 vs Petrosian M_r (early = c > 2.86)
#   row "Figure 6": Sersic r-band R50 vs Sersic M_r (early = n > 2.5)
# early:  log R = -0.4 a M + b ;  late: log R = -0.4 alpha M + (beta - alpha) log[1 + 10^(-0.4 (M - M0))] + gamma
S03_LUM_FITS = {
    "Fig4": dict(a=0.60, b=-4.63, alpha=0.21, beta=0.53, gamma=-1.31, M0=-20.52),
    "Fig6": dict(a=0.65, b=-5.06, alpha=0.26, beta=0.51, gamma=-1.71, M0=-20.91),
}
S03_PETRO_FLUX_EARLY = 0.80   # S03: "the Petrosian magntitude includes about 80 percent of the total flux"


def _s03_logr_lum(M, fit, early):
    p = S03_LUM_FITS[fit]
    if early:
        return -0.4 * p["a"] * M + p["b"]
    return -0.4 * p["alpha"] * M + (p["beta"] - p["alpha"]) * np.log10(1.0 + 10.0 ** (-0.4 * (M - p["M0"]))) + p["gamma"]


def s03_petro_minus_sersic(log_r_sersic_r, early, flux_frac):
    """log(R50_Petrosian / R50_Sersic), both r band, at fixed galaxy, implied by S03's own median
    size-luminosity fits in the two definitions (Table 1 rows 'Figure 4' and 'Figure 6').

    For a median galaxy with Sersic r-band radius R_S we find its Sersic magnitude M_S from the
    Figure 6 fit, move to its Petrosian magnitude M_P = M_S + 2.5 log(1/flux_frac), and read the
    Petrosian radius from the Figure 4 fit. This empirical ratio includes seeing (Petrosian radii
    are not PSF corrected; the Blanton+03 Sersic radii are), unlike a seeing-free profile model."""
    from scipy.optimize import brentq
    dm = 2.5 * math.log10(1.0 / flux_frac)
    out = []
    for lr in np.atleast_1d(log_r_sersic_r):
        m_s = brentq(lambda M: _s03_logr_lum(M, "Fig6", early) - lr, -27.0, -12.0)
        out.append(_s03_logr_lum(m_s + dm, "Fig4", early) - lr)
    return np.array(out)


S03_COMMON_EXCERPTS = [
    ("S03", "paper.tex", r"Figure \ref{SRdisMassz} shows the results based on the $z$-band \Sersic half-light radii."),
    ("S03", "paper.tex", r"(here defined to be those with $n<2.5$), while the squares are for early-type galaxies (with $n>2.5$)"),
    ("S03", "paper.tex", r"Figure 4 & 0.60 & $-4.63$ & & 0.21 & 0.53 & $-1.31$ & $-20.52$ &"),
    ("S03", "paper.tex", r"Figure 6 & 0.65 & $-5.06$ & & 0.26 & 0.51 & $-1.71$ & $-20.91$ &"),
    ("S03", "paper.tex", r"\Log(\bar{R}/\kpc)=-0.4aM+b\,,"),
    ("S03", "paper.tex", r"\Log(\bar{R}/\kpc)=-0.4\alpha M+ (\beta-\alpha)\Log[1+10^{-0.4(M-M_0)}]+\gamma"),
    ("S03", "paper.tex", r"median and dispersion of the distribution of Petrosian half-light radius $R_{50}$ (in the $r$-band), as functions of $r$-band Petrosian absolute magnitude"),
    ("S03", "paper.tex", r"half-light radius $R_{50,S}$ (in the $r$-band) as functions of $r$-band absolute \Sersic magnitude."),
    ("S03", "paper.tex", r"Hubble's constant $h=0.7$"),
]


def _s03_to_ours(x, log_r_sz, early, conv):
    """Sersic z-band median R50 at stellar mass x -> our Petrosian r-band R50."""
    rz = conv["r50_r_over_z"]["early" if early else "late"]
    flux = S03_PETRO_FLUX_EARLY if early else petro_flux_fraction(1.0)
    dps = s03_petro_minus_sersic(log_r_sz + rz, early, flux)
    return log_r_sz + rz + dps, rz, dps


def petro_flux_fraction(n: float) -> float:
    """Fraction of the total light inside 2 r_P for a seeing-free Sersic-n profile."""
    from scipy.optimize import brentq
    from scipy.special import gammainc, gammaincinv
    b = gammaincinv(2 * n, 0.5)
    L = lambda r: gammainc(2 * n, b * r ** (1.0 / n))
    ratio = lambda r: ((L(1.25 * r) - L(0.8 * r)) / (np.pi * (1.25 ** 2 - 0.8 ** 2) * r ** 2)) / (L(r) / (np.pi * r ** 2))
    return float(L(2 * brentq(lambda r: ratio(r) - 0.2, 0.05, 50.0)))


def _s03_sersic_z(x, early):
    """S03 Table 1 row 'Figure 11' median Sersic z-band log R50 [kpc] at log M* = x (b from the erratum)."""
    x = np.asarray(x, float)
    if early:
        return math.log10(2.88e-6) + 0.56 * x
    M = 10.0 ** x
    return np.log10(0.10 * M ** 0.14 * (1.0 + M / 3.98e10) ** (0.39 - 0.14))


def rel_S03L(conv):
    """Shen et al. (2003) late-type size-mass relation. arXiv:astro-ph/0301527 (v3, accepted),
    published eq. 18, Table 1 row 'Figure 11'.

    R50 [kpc] = gamma M^alpha (1 + M/M0)^(beta - alpha), alpha = 0.14, beta = 0.39,
    gamma = 0.10, M0 = 3.98e10 Msun. R50 = SERSIC half-light radius in the z band (Blanton+03
    fits, PSF corrected); late = r-band Sersic n < 2.5. Masses Kauffmann+03a (Kroupa); h = 0.7,
    Om = 0.3. Data span log M* ~ 8.75-11.75 (Fig. 11).
    Conversions to Petrosian r-band R50 (mass dependent, see _s03_to_ours):
      + median log(R50_r/R50_z) = +0.029 for C < 2.86 (SkyServer DR17 sample, R50_SQL)
      + log(R_Petro/R_Sersic) from S03's own Table 1 fits (Figure 4 vs Figure 6, late types),
        about +0.03 dex (seeing enlarges Petrosian radii; a seeing-free n = 1 profile gives -0.003)."""
    x = grid(8.7, 11.8)
    y2, rz, dps = _s03_to_ours(x, _s03_sersic_z(x, False), False, conv)
    return relation(
        "S03L", "S03L", "Shen et al. (2003) size-mass relation, late types",
        "Shen, S., et al. 2003, MNRAS, 343, 978", BIBCODE["S03"], "size",
        {"logM": 1.0}, {"logR50": 1.0}, "fit", [curve(x, y2, "solid")],
        notes="Median size of late type galaxies (Sérsic n < 2.5) as a function of stellar mass. "
              "S03 used Sérsic half-light radii in the z band, while our radii are Petrosian radii in the r band. "
              "S03 masses are the Kauffmann et al. (2003) values with a Kroupa IMF.",
        conversions=f"log R₅₀ {sg(rz + dps.min())} to {sg(rz + dps.max())} dex, depending on mass. This is {sg(rz)} dex for r band "
                    f"versus z band Petrosian radii (median for C < 2.86 in an SDSS DR17 sample) and {sg(dps.min())} to "
                    f"{sg(dps.max())} dex for Petrosian versus Sérsic radii. We get the second term from the S03 size-luminosity "
                    f"fits for Petrosian radii (their Figure 4) and Sérsic radii (their Figure 6), compared at the same galaxy.",
        source="arXiv:astro-ph/0301527 Table 1 (rows Figure 11, 4 and 6), published eq. 18",
        excerpts=[("S03", "paper.tex", r"Figure 11& 0.56 & $3.47\times10^{-5}$ & & 0.14 & 0.39 & 0.10 & $3.98\times10^{10}\Msun$&"),
                  ("S03", "paper.tex", r"\bar{R}(\kpc)=\gamma\left(\frac{M}{\Msun}\right)^{\alpha} \left(1+\frac{M}{M_0}\right)^{\beta-\alpha}")]
                 + S03_COMMON_EXCERPTS,
        meta=dict(arxiv=ARXIV["S03"], where="Table 1 row 'Figure 11'; published eq. 18", imf="Kroupa (K03a masses)",
                  cosmo="h=0.7, Om=0.3, OL=0.7", calib="Sersic z-band R50 (Blanton+03), n<2.5", validity="log M* about 8.75 to 11.75"))


def rel_S03E(conv):
    """Shen et al. (2003) early-type size-mass relation, published eq. 17, Table 1 row
    'Figure 11', with b from the erratum (Shen et al. 2007, MNRAS 379, 400).

    R50 [kpc] = b M^a, a = 0.56, b = 2.88e-6 (erratum; Table 1 printed 3.47e-5, which would
    give ~50 kpc at 1e11 Msun, while their Fig. 11 shows ~4 kpc). Early = n > 2.5. Data span
    log M* ~ 10.1-11.9. Conversions to Petrosian r-band R50 (mass dependent):
      + median log(R50_r/R50_z) = +0.024 for C >= 2.86
      + log(R_Petro/R_Sersic) from S03's own Table 1 fits (Figure 4 vs Figure 6, early types)
        with the Petrosian flux fraction 0.8 that S03 quote: about -0.02 to -0.11 dex from
        10^10 to 10^11.9. (A seeing-free de Vaucouleurs profile gives -0.147; S03 quote
        'only about 70 percent'. Seeing makes real SDSS Petrosian radii larger than that.)"""
    x = grid(10.0, 11.9)
    y2, rz, dps = _s03_to_ours(x, _s03_sersic_z(x, True), True, conv)
    return relation(
        "S03E", "S03E", "Shen et al. (2003) size-mass relation, early types",
        "Shen, S., et al. 2003, MNRAS, 343, 978; erratum 2007, MNRAS, 379, 400", BIBCODE["S03"], "size",
        {"logM": 1.0}, {"logR50": 1.0}, "fit", [curve(x, y2, "dashed")],
        notes="Median size of early type galaxies (Sérsic n > 2.5) as a function of stellar mass. "
              "We use b = 2.88 × 10⁻⁶ from the 2007 erratum, since Table 1 printed 3.47 × 10⁻⁵. "
              "The radius and mass caveats of S03L apply here too.",
        conversions=f"log R₅₀ {sg(rz + dps.max())} dex at 10¹⁰ M☉ to {sg(rz + dps.min())} dex at 10¹¹·⁹ M☉. This is {sg(rz)} dex "
                    f"for r band versus z band Petrosian radii (median for C ≥ 2.86) plus {sg(dps.max())} to {sg(dps.min())} dex for "
                    f"Petrosian versus Sérsic radii. We get the second term from the S03 size-luminosity fits for Petrosian and Sérsic "
                    f"radii (their Figures 4 and 6), compared at the same galaxy, with the Petrosian flux fraction of 0.8 that S03 give. "
                    f"A de Vaucouleurs profile without seeing would give {sg(math.log10(conv['petro_r50_over_re']['4']))} dex.",
        source="arXiv:astro-ph/0301527 Table 1 (rows Figure 11, 4 and 6), published eq. 17; b from the erratum (DOI 10.1111/j.1365-2966.2007.12056.x)",
        excerpts=[("S03", "paper.tex", r"Figure 11& 0.56 & $3.47\times10^{-5}$ &"),
                  ("S03err", "openalex.json", "The value of fitting parameter b in equation (17) of fig. 11 given in table 1 is wrong. The correct value is 2.88 × 10−6."),
                  ("S03", "paper.tex", r"\bar{R}(\kpc)=b\left(\frac{M}{\Msun}\right)^{a}\,."),
                  ("S03", "paper.tex", r"the Petrosian magntitude includes about 80 percent of the total flux, while the Petrosian half-light radius is only about 70 percent of the real half-light radius.")]
                 + S03_COMMON_EXCERPTS,
        meta=dict(arxiv=ARXIV["S03"], where="Table 1 row 'Figure 11'; published eq. 17; erratum MNRAS 379, 400 (2007)", imf="Kroupa (K03a masses)",
                  cosmo="h=0.7, Om=0.3, OL=0.7", calib="Sersic z-band R50 (Blanton+03), n>2.5", validity="log M* about 10.1 to 11.9"))


def rel_K03S(conv):
    """Kauffmann et al. (2003b) surface-density transition. arXiv:astro-ph/0205070, sec. 5.

    'a strong transition at mu_* ~ 3 x 10^8 Msun kpc^-2' in Dn4000 (and HdA). mu_* =
    0.5 M*/[pi R50(z)^2] with the Petrosian z-band R50, i.e. our logSigma definition but with
    z-band radii. Kroupa IMF, H0 = 70. Conversion: log Sigma - 2 x median log(R50_r/R50_z)
    = -0.054 dex (all galaxies) -> 8.42 on our axis. Drawn as a vertical line."""
    x0 = math.log10(3e8) - 2.0 * conv["r50_r_over_z"]["all"]
    ys = np.linspace(*DIM_RANGE["logsSFR"], N_LINE)
    return relation(
        "K03S", "K03", "Kauffmann et al. (2003) surface density transition",
        "Kauffmann, G., et al. 2003, MNRAS, 341, 54", BIBCODE["K03b"], "sigma",
        {"logSigma": 1.0}, {"logsSFR": 1.0}, "threshold", [curve(np.full_like(ys, x0), ys, "dashed")],
        rng=[x0, x0],
        notes="K03 found a sharp change in stellar age (Dn4000) at a surface density of about 3 × 10⁸ M☉ kpc⁻². "
              "K03 used z band Petrosian radii, and we use r band radii, so the line moves from 8.48 to "
              f"{x0:.2f} on our axis.",
        conversions=f"log Σ★ {sg(-2.0 * conv['r50_r_over_z']['all'])} dex, which is −2 × {conv['r50_r_over_z']['all']:.3f} dex "
                    f"for r band versus z band Petrosian radii (all galaxies in an SDSS DR17 sample).",
        source="arXiv:astro-ph/0205070 sec. 5 and Fig. 12",
        excerpts=[("K03b", "masses1.tex", r"with a strong transition at $\mu_* \sim 3\times 10^8 M_{\odot}$ kpc$^{-2}$"),
                  ("K03b", "masses1.tex", r"We define the surface mass density $\mu_*$ as $0.5M_*/[\pi R50^2(z)]$, where $R50(z)$ is the Petrosian half-light radius in the $z$-band"),
                  ("K03b", "masses1.tex", r"The stellar masses are derived assuming a universal initial mass function (IMF) in the parametrisation of Kroupa (2001).")],
        meta=dict(arxiv=ARXIV["K03b"], where="summary of sec. 5 (Dn4000 and HdA versus mu_*)", imf="Kroupa (2001)",
                  cosmo="H0=70, Om=0.3, OL=0.7", calib="Petrosian z-band R50", validity="-"))


def rel_B03(conv):
    """Bernardi et al. (2003c) Fundamental Plane, r* band. arXiv:astro-ph/0301626, Table 2
    (orthogonal, maximum likelihood).

    log R_o = a log sigma + b log I_o + c with a = 1.49, b = -0.75, c = -8.778 and
    mu = -2.5 log I_o, so log R_o = 1.49 log sigma + 0.30 mu_o - 8.778. Native combo
    x = {logSigV: 1.49, mu50: 0.30} (= the preset), y = logR50, and the relation is
    y = x - 8.778. B03: de Vaucouleurs R_o (circularised, h70^-1 kpc), sigma corrected to R_o/8,
    mu_o K- and evolution-corrected; ~9000 early types, 0.01 <= z <= 0.3. Our R50/mu50 are
    Petrosian and not K-corrected, so fitOffset = true. Range: B03 mean x = 1.49*2.200 +
    0.3*19.87 = 9.24 with rms ~0.25; we draw 8.5-10.2 to cover the data."""
    x = grid(8.5, 10.2)
    return relation(
        "B03", "B03", "Bernardi et al. (2003) Fundamental Plane, edge-on, r band",
        "Bernardi, M., et al. 2003, AJ, 125, 1866", BIBCODE["B03"], "fp",
        {"logSigV": 1.49, "mu50": 0.30}, {"logR50": 1.0}, "fit", [curve(x, x - 8.778, "solid")],
        fit_offset=True,
        notes="Edge-on Fundamental Plane of about 9,000 SDSS early type galaxies in the r band. "
              "The relation is log R = 1.49 log σ + 0.30 μ − 8.778, where μ = −2.5 log I. "
              "B03 used de Vaucouleurs radii and surface brightness with K and evolution corrections. "
              "Our R₅₀ and μ₅₀ are Petrosian values without a K correction, so the site shifts the curve in y to the median of the data.",
        conversions="None applied to the coefficients. The site fits the zero point to the data (fitOffset).",
        source="arXiv:astro-ph/0301626 Table 2 (orthogonal, maximum likelihood, r*) and eq. 2",
        excerpts=[("B03", "bernardi3.tex", r"$r^*$ & 1.49$\pm 0.05$ & $-0.75\pm 0.01$ & $-8.778\pm 0.020$ & 0.052 & 0.094"),
                  ("B03", "bernardi3.tex", r"\log_{10} R_o = a\,\log_{10}\sigma + b\,\log_{10}I_o + c"),
                  ("B03", "bernardi3.tex", r"Note that $\mu = -2.5\log_{10}I_o$."),
                  ("B03", "bernardi3.tex", r"$(\Omega_{\rm M},\Omega_{\Lambda},h)=(0.3,0.7,0.7)$")],
        meta=dict(arxiv=ARXIV["B03"], where="Table 2 (orthogonal ML, r*); eq. 2", imf="-", cosmo="Om=0.3, OL=0.7, h=0.7",
                  calib="de Vaucouleurs R_o, sigma at R_o/8, mu_o K- and evolution-corrected", validity="B03 x = 9.24 +/- 0.25"))


def _bpt_hyperbola(a, b, c):
    """y = a/(x - b) + c on the left branch, clipped to the axis box (x >= N2Ha min, y >= O3Hb min)."""
    x_lo, _ = DIM_RANGE["N2Ha"]
    y_lo, y_hi = DIM_RANGE["O3Hb"]
    x_hi = b + a / (y_lo - c)            # where the curve leaves through the bottom of the box
    x = np.linspace(x_lo, x_hi, 20001)
    y = a / (x - b) + c
    keep = (y >= y_lo) & (y <= y_hi)
    return resample_arclength(x[keep], y[keep], N_GRID, DIM_SCALE["N2Ha"], DIM_SCALE["O3Hb"])


def rel_K03(conv):
    """Kauffmann et al. (2003c) SF/AGN demarcation. arXiv:astro-ph/0304239, eq. 1:
    log([OIII]/Hb) > 0.61/(log([NII]/Ha) - 0.05) + 1.3 (AGN above). Domain x < 0.05; clipped to
    the O3Hb range (-1.5..1.5) and N2Ha >= -2.5."""
    x, y = _bpt_hyperbola(0.61, 0.05, 1.3)
    return relation(
        "K03", "K03", "Kauffmann et al. (2003) star-forming / AGN demarcation",
        "Kauffmann, G., et al. 2003, MNRAS, 346, 1055", BIBCODE["K03c"], "bpt",
        {"N2Ha": 1.0}, {"O3Hb": 1.0}, "demarcation", [curve(x, y, "dashed")],
        notes="Empirical upper edge of the star-forming sequence. Galaxies above it are AGN or composites.",
        conversions="None.", source="arXiv:astro-ph/0304239 eq. 1",
        excerpts=[("K03c", "tim_revisedn.tex", r"\log ([\rm{OIII}]/H\beta) > 0.61/(\log ([\rm{NII}]/H\alpha)-0.05) +1.3")],
        meta=dict(arxiv=ARXIV["K03c"], where="eq. 1", imf="-", cosmo="-", calib="line ratios", validity="log [NII]/Ha < 0.05"))


def rel_K01(conv):
    """Kewley et al. (2001) maximum-starburst line. arXiv:astro-ph/0106324, eq. 5:
    log([OIII]/Hb) = 0.61/(log([NII]/Ha) - 0.47) + 1.19. Domain x < 0.47; clipped as K03."""
    x, y = _bpt_hyperbola(0.61, 0.47, 1.19)
    return relation(
        "K01", "K01", "Kewley et al. (2001) maximum starburst line",
        "Kewley, L. J., et al. 2001, ApJ, 556, 121", BIBCODE["K01"], "bpt",
        {"N2Ha": 1.0}, {"O3Hb": 1.0}, "demarcation", [curve(x, y, "solid")],
        notes="Theoretical upper limit of starburst photoionization models. Galaxies above it are AGN.",
        conversions="None.", source="arXiv:astro-ph/0106324 eq. 5",
        excerpts=[("K01", "astroph_ms.tex", r"\log \left(\frac{{\rm [OIII]\,\lambda 5007}}{{\rm H}\beta}\right) = \frac{0.61} {\log ({\rm [NII]}/{\rm H}\alpha) -0.47}+1.19")],
        meta=dict(arxiv=ARXIV["K01"], where="eq. 5", imf="-", cosmo="-", calib="PEGASE/STARBURST99 + MAPPINGS models", validity="log [NII]/Ha < 0.47"))


def rel_S07(conv):
    """Schawinski et al. (2007) Seyfert/LINER line. arXiv:0709.3015, eq. 1:
    log([OIII]/Hb) = 1.05 log([NII]/Ha) + 0.45, drawn only above K01: from its intersection with
    the K01 left branch (x = -0.184, y = 0.257) to the edge of the axis box."""
    from scipy.optimize import brentq
    k01 = lambda x: 0.61 / (x - 0.47) + 1.19
    x0 = brentq(lambda x: 1.05 * x + 0.45 - k01(x), -1.0, 0.4)
    x1 = min(DIM_RANGE["N2Ha"][1], (DIM_RANGE["O3Hb"][1] - 0.45) / 1.05)
    x = grid(x0, x1)
    return relation(
        "S07", "S07", "Schawinski et al. (2007) Seyfert / LINER line",
        "Schawinski, K., et al. 2007, MNRAS, 382, 1415", BIBCODE["S07"], "bpt",
        {"N2Ha": 1.0}, {"O3Hb": 1.0}, "demarcation", [curve(x, 1.05 * x + 0.45, "dotted")],
        notes="Separates Seyferts (above) from LINERs (below) among AGN. We draw it only above the K01 line.",
        conversions="None.", source="arXiv:0709.3015 eq. 1",
        excerpts=[("S07", "sfh_etypes.tex", r"\mathrm{log([OIII]/H\beta) = 1.05~log([NII]/H\alpha) + 0.45}")],
        meta=dict(arxiv=ARXIV["S07"], where="eq. 1", imf="-", cosmo="-", calib="line ratios", validity="above K01"))


def moster13_log_mstar(log_mh, z):
    """Moster, Naab & White (2013) eq. 2 with eqs. 11-14 and Table 1 (masses in Msun, h=0.704)."""
    f = z / (1.0 + z)
    log_m1 = 11.590 + 1.195 * f
    n = 0.0351 - 0.0247 * f
    beta = 1.376 - 0.826 * f
    gamma = 0.608 + 0.329 * f
    r = 10.0 ** (np.asarray(log_mh) - log_m1)
    return np.asarray(log_mh) + np.log10(2.0 * n / (r ** -beta + r ** gamma))


def behroozi13_log_mstar(log_mh, z):
    """Behroozi, Wechsler & Conroy (2013) eq. 3 with the sec. 5 best-fit parameters."""
    a = 1.0 / (1.0 + z)
    nu = math.exp(-4.0 * a * a)
    log_eps = -1.777 + (-0.006 * (a - 1) + (-0.000) * z) * nu + (-0.119) * (a - 1)
    log_m1 = 11.514 + (-1.793 * (a - 1) + (-0.251) * z) * nu
    alpha = -1.412 + (0.731 * (a - 1)) * nu
    delta = 3.508 + (2.608 * (a - 1) + (-0.043) * z) * nu
    gamma = 0.316 + (1.319 * (a - 1) + 0.279 * z) * nu

    def f(x):
        return -np.log10(10.0 ** (alpha * x) + 1.0) + delta * (np.log10(1.0 + np.exp(x))) ** gamma / (1.0 + np.exp(10.0 ** (-x)))

    x = np.asarray(log_mh) - log_m1
    return log_eps + log_m1 + f(x) - f(0.0)


def rel_Mo13(conv):
    """Moster, Naab & White (2013) SHMR at z = 0.1. arXiv:1205.5807, eq. 2, eqs. 11-14, Table 1.

    m/M = 2N [(M/M1)^-beta + (M/M1)^gamma]^-1; log M1 = 11.590 + 1.195 z/(z+1),
    N = 0.0351 - 0.0247 z/(z+1), beta = 1.376 - 0.826 z/(z+1), gamma = 0.608 + 0.329 z/(z+1).
    Halo mass M200c (200 x critical), masses in Msun with WMAP7 h = 0.704; Chabrier IMF.
    Conversions: M200c -> M180m (NFW + Duffy+08 c200c, in the Mo13 cosmology) and
    x (0.704/0.7) for Lim+17's h^-1 Msun -> Msun with h = 0.7 (+0.0025 dex); stellar mass
    +0.034 (Chabrier -> Kroupa) and + 2 log(0.704/0.7) = +0.005 (h^-2 scaling). Range
    log M200c = 11-15 (Duffy+08 is calibrated for 1e11-1e15 h^-1 Msun)."""
    lm = grid(11.0, 15.0)
    ls = moster13_log_mstar(lm, Z_REF)
    x = to_m180m(lm, "200c", 0.704, 0.272) + math.log10(0.704 / H_OURS)
    y = ls + conv["imf_mass_chab_to_kroupa"] + 2.0 * math.log10(0.704 / H_OURS)
    h = conv["halo_m180m_minus_m200c_Mo13"]
    return relation(
        "Mo13", "Mo13", f"Moster, Naab & White (2013) stellar-to-halo mass relation at z = {Z_REF}",
        "Moster, B. P., Naab, T., & White, S. D. M. 2013, MNRAS, 428, 3121", BIBCODE["Mo13"], "shmr",
        {"logMh": 1.0}, {"logM": 1.0}, "fit", [curve(x, y, "solid")],
        notes="Central galaxy stellar mass versus halo mass from abundance matching at several redshifts, evaluated at "
              f"z = {Z_REF}. Mo13 halo masses are M200c (200 times the critical density) with h = 0.704. "
              "Our halo masses are Lim et al. (2017) group masses, defined as M180m (180 times the mean density) "
              "and found by abundance matching.",
        conversions=f"Halo mass from M200c to M180m for NFW haloes with Duffy et al. (2008) concentrations "
                    f"({sg(h['11'], 2)} dex at 10¹¹ and {sg(h['14'], 2)} dex at 10¹⁴ M☉), plus {sg(math.log10(0.704 / H_OURS), 4)} dex "
                    f"for h = 0.704 to 0.7. Stellar mass {sg(conv['imf_mass_chab_to_kroupa'])} dex (Chabrier to Kroupa) and "
                    f"{sg(2 * math.log10(0.704 / H_OURS), 4)} dex (h).",
        source="arXiv:1205.5807 eq. 2, eqs. 11 to 14, Table 1",
        excerpts=[("Mo13", "moster2012.tex", r"Best fit & 11.590 & 1.195 & 0.0351 & -0.0247 & 1.376 & -0.826 & 0.608 & 0.329"),
                  ("Mo13", "moster2012.tex", r"\frac{m}{M} = 2 \; N \; \left[ \left( \frac{M}{M_1} \right)^{-\beta} + \left( \frac{M}{M_1} \right)^{\gamma} \right]^{-1}"),
                  ("Mo13", "moster2012.tex", r"\log M_1(z) &=& M_{10}+M_{11}(1-a)=M_{10}+M_{11}\frac{z}{z+1}"),
                  ("Mo13", "moster2012.tex", r"All virial masses are computed with respect to 200 times the critical density."),
                  ("Mo13", "moster2012.tex", r"(\Omega_{\rm m},\Omega_{\rm \Lambda}, \Omega_{\rm b},h,n,\sigma_8)= (0.272, 0.728, 0.046,0.704,0.967,0.810)"),
                  ("Mo13", "moster2012.tex", r"We employ a \citet{chabrier2003} initial mass function (IMF) and we convert all stellar masses to this IMF.")],
        meta=dict(arxiv=ARXIV["Mo13"], where="eq. 2; eqs. 11 to 14; Table 1", imf="Chabrier", cosmo="WMAP7: Om=0.272, h=0.704",
                  calib="halo M200c (critical x 200)", validity="log M200c = 11 to 15 drawn"))


def rel_B13(conv):
    """Behroozi, Wechsler & Conroy (2013) SHMR at z = 0.1. arXiv:1207.6105, eq. 3 + sec. 5.

    log M* = log(eps M1) + f(log(Mh/M1)) - f(0), f(x) = -log(10^(alpha x) + 1) +
    delta (log(1 + e^x))^gamma / (1 + exp(10^-x)); nu = exp(-4a^2);
    log eps = -1.777 + (-0.006(a-1) - 0.000 z) nu - 0.119 (a-1); log M1 = 11.514 +
    (-1.793(a-1) - 0.251 z) nu; alpha = -1.412 + 0.731(a-1) nu; delta = 3.508 + (2.608(a-1)
    - 0.043 z) nu; gamma = 0.316 + (1.319(a-1) + 0.279 z) nu. Halo mass = virial mass
    (Bryan & Norman 1998), h = 0.7, Om = 0.27; Chabrier IMF.
    Conversions: Mvir -> M180m (NFW + Duffy+08 c_vir); stellar mass +0.034 (Chabrier -> Kroupa)."""
    lm = grid(10.5, 15.0)
    ls = behroozi13_log_mstar(lm, Z_REF)
    x = to_m180m(lm, "vir", 0.7, 0.27)
    y = ls + conv["imf_mass_chab_to_kroupa"]
    h = conv["halo_m180m_minus_mvir_B13"]
    return relation(
        "B13", "B13", f"Behroozi, Wechsler & Conroy (2013) stellar-to-halo mass relation at z = {Z_REF}",
        "Behroozi, P. S., Wechsler, R. H., & Conroy, C. 2013, ApJ, 770, 57", BIBCODE["B13"], "shmr",
        {"logMh": 1.0}, {"logM": 1.0}, "fit", [curve(x, y, "dashed")],
        notes=f"Median central galaxy stellar mass versus halo mass at z = {Z_REF}. "
              "B13 halo masses are virial masses (Bryan & Norman 1998) with h = 0.7.",
        conversions=f"Halo mass from Mvir to M180m for NFW haloes with Duffy et al. (2008) concentrations "
                    f"({sg(h['11'], 2)} dex at 10¹¹ and {sg(h['14'], 2)} dex at 10¹⁴ M☉). Stellar mass "
                    f"{sg(conv['imf_mass_chab_to_kroupa'])} dex (Chabrier to Kroupa).",
        source="arXiv:1207.6105 eq. 3 and sec. 5 best-fit parameters",
        excerpts=[("B13", "fit.tex", r"\log_{10}(M_1) &=& 11.514^{+0.053}_{-0.009} + (-1.793^{+0.315}_{-0.330}(a-1) + (-0.251^{+0.012}_{-0.125})z)\nu"),
                  ("B13", "fit.tex", r"\log_{10}(\epsilon) &=& -1.777^{+0.133}_{-0.146} + (-0.006^{+0.113}_{-0.361}(a-1) + (-0.000^{+0.003}_{-0.104})z)\nu +"),
                  ("B13", "fit.tex", r"-0.119^{+0.061}_{-0.012}(a-1)"),
                  ("B13", "fit.tex", r"\alpha &=& -1.412^{+0.020}_{-0.105} + (0.731^{+0.344}_{-0.296}(a-1))\nu"),
                  ("B13", "fit.tex", r"\delta &=& 3.508^{+0.087}_{-0.369} + (2.608^{+2.446}_{-1.261}(a-1) + -0.043^{+0.958}_{0.071}z)\nu"),
                  ("B13", "fit.tex", r"\gamma &=& 0.316^{+0.076}_{-0.012} + (1.319^{+0.584}_{-0.505}(a-1) + 0.279^{+0.256}_{-0.081}z)\nu"),
                  ("B13", "fit.tex", r"\nu &=& \exp(-4a^2)"),
                  ("B13", "paper.tex", r"f(x) & = & -\log_{10}(10^{\alpha x} + 1) + \delta \frac{(\log_{10}(1+\exp(x)))^\gamma}{1+\exp(10^{-x})}."),
                  ("B13", "paper.tex", r"We use the virial mass (as defined in \citealt{mvir_conv}) to define the halo mass of central galaxies"),
                  ("B13", "paper.tex", r"$\Omega_M = 0.27$, $\Omega_\Lambda = 0.73$, $h=0.7$")],
        meta=dict(arxiv=ARXIV["B13"], where="eq. 3; sec. 5 parameters (fit.tex)", imf="Chabrier", cosmo="Om=0.27, OL=0.73, h=0.7",
                  calib="halo Mvir (Bryan & Norman 1998)", validity="log Mvir = 10.5 to 15 drawn"))


def rel_C18(conv):
    """Catinella et al. (2018) xGASS H I fraction medians. arXiv:1802.02373, Table 1.

    Weighted medians of log(M_HI/M*) in bins of <log M*> = 9.14 ... 11.20; non-detections at
    their upper limits. Stellar masses: MPA-JHU DR7 (improved DR7 values; the paper labels
    them Chabrier and uses them as given). H0 = 70. Conversions: none. Drawn as a 'median'
    polyline through the nodes (resampled linearly to >= 60 points; nodes included)."""
    tab = _parse_rows("C18", "table_hi_avgs.tex", r"log \Mst", 4, 8)
    if tab is not None:
        mine = [(r[0], r[1], r[2]) for r in C18_TABLE1]
        theirs = [(r[0], r[1], r[3]) for r in tab]      # parsed: <x>, mean, err, median
        assert mine == theirs, f"C18 Table 1 copy differs from source: {theirs}"
    nx = np.array([r[0] for r in C18_TABLE1])
    ny = np.array([r[2] for r in C18_TABLE1])
    # the polyline must pass through every table median (verifier fix: a plain 85-point grid
    # hit only 2 of the 8 nodes and cut the corners by up to 0.011 dex)
    x = np.unique(np.concatenate([grid(nx[0], nx[-1], 85), nx]))
    return relation(
        "C18", "C18", "Catinella et al. (2018) xGASS H I gas fraction medians",
        "Catinella, B., et al. 2018, MNRAS, 476, 875", BIBCODE["C18"], "hi",
        {"logM": 1.0}, {"logfHI": 1.0}, "median", [curve(x, np.interp(x, nx, ny), "solid", nodes=list(zip(nx, ny)))],
        notes="Weighted medians of log(M_HI/M★) in bins of mass for the xGASS representative sample. "
              "Non-detections are set to their upper limits. "
              "Our H I data are ALFALFA detections only, so they lie above this curve at high mass.",
        conversions="None. The masses are MPA-JHU DR7 values.",
        source="arXiv:1802.02373 Table 1 (log M★ rows, weighted median column)",
        excerpts=[("C18", "table_hi_avgs.tex", r"log \Mst & 9.14 & $-$0.242$\pm$0.053 & $-$0.092 & 113"),
                  ("C18", "table_hi_avgs.tex", r"Weighted median of logarithm of gas fraction; \hi\ mass of non-detections set to upper limit."),
                  ("C18", "xgass.tex", r"Stellar masses are from the Max Planck Institute for Astrophysics (MPA)/Johns Hopkins University (JHU) value-added catalog based on SDSS DR7"),
                  ("C18", "xgass.tex", r"and assume a \citet{chabrier03} initial mass function.")],
        meta=dict(arxiv=ARXIV["C18"], where="Table 1, log M* block, column (b)", imf="MPA-JHU DR7 values (labelled Chabrier)",
                  cosmo="H0=70, Om=0.3, OL=0.7", calib="Arecibo H I; non-detections at upper limits", validity="<log M*> = 9.14 to 11.20"))


def rel_H12(conv):
    """Huang et al. (2012) ALFALFA H I-stellar mass relation. arXiv:1207.0523, eq. 1.

    <log M_HI> = 0.712 <log M*> + 3.117 (log M* <= 9); 0.276 <log M*> + 7.042 (log M* > 9),
    for alpha.40-SDSS-GALEX detections in 0.5-dex mass bins. Written as a gas fraction:
    log f_HI = -0.288 log M* + 3.117 or -0.724 log M* + 7.042. Masses from UV-optical SED fits,
    Chabrier IMF, h = 0.7. Conversions: log M* + 0.034 and log f_HI - 0.034 (Chabrier -> Kroupa)."""
    k = conv["imf_mass_chab_to_kroupa"]
    x = grid(7.0, 11.25)
    lmhi = np.where(x <= 9.0, 0.712 * x + 3.117, 0.276 * x + 7.042)
    return relation(
        "H12", "H12", "Huang et al. (2012) ALFALFA H I mass-stellar mass relation",
        "Huang, S., et al. 2012, ApJ, 756, 113", BIBCODE["H12"], "hi",
        {"logM": 1.0}, {"logfHI": 1.0}, "fit", [curve(x + k, lmhi - x - k, "dashed")],
        notes="Fit to the mean log M_HI in bins of mass for ALFALFA α.40 detections with SDSS and GALEX data. "
              "This matches the selection of our H I data, which are also ALFALFA detections. "
              "H12 masses come from their own SED fits with a Chabrier IMF.",
        conversions=f"log M★ {sg(k)} dex and log(M_HI/M★) {sg(-k)} dex (Chabrier to Kroupa).",
        source="arXiv:1207.0523 eq. 1 (sec. 4.2.1)",
        excerpts=[("H12", "draft120629.tex", r"0.712 \langle \log M_* \rangle + 3.117,~\log M_* \leq 9; \\"),
                  ("H12", "draft120629.tex", r"0.276 \langle \log M_* \rangle + 7.042,~\log M_* > 9."),
                  ("H12", "draft120629.tex", r"A \citet{Chabrier2003} IMF is adopted."),
                  ("H12", "draft120629.tex", r"we adopt a reduced Hubble constant $h = H_0/(100~{\rm km~s^{-1}~Mpc^{-1}}) = 0.7$")],
        meta=dict(arxiv=ARXIV["H12"], where="eq. 1", imf="Chabrier", cosmo="h=0.7", calib="ALFALFA alpha.40 detections; SED masses",
                  validity="log M* about 6.5 to 11.25 (bins of 0.5 dex)"))


RELATIONS = [rel_T04, rel_KE08, rel_AM13, rel_C20, rel_M10, rel_RP15, rel_S14, rel_S16, rel_Q11,
             rel_RP15s, rel_Q11s, rel_S03L, rel_S03E, rel_K03S, rel_Q11d, rel_B03, rel_K03, rel_K01,
             rel_S07, rel_Mo13, rel_B13, rel_Q11e, rel_C18, rel_H12]

# =========================================================================================
# independent verification (literature verifier, 2026-09-24)
# =========================================================================================
# Every source was fetched again with a separate client (curl, arXiv /src/) and compared byte
# for byte with the cache (all 26 identical). Each number below was then read again from the
# LaTeX, not from the excerpts above. The curves are checked against a second implementation of
# every formula (independent_check), and against the data (verify_plot). result is one of
# verified | corrected | removed; no relation was removed.
REVIEW_BY, REVIEW_DATE = "literature verifier", "2026-09-24"
REVIEW = {
    "T04": ("verified", "eq. 3 (−1.492, 1.847, −0.08026), 8.5 < log M★ < 11.5, Kroupa, H0 = 70 and Ωm = 0.3; Table 3 columns are P2.5, P16, P50, P84, P97.5 (the band is P16 to P84)."),
    "KE08": ("verified", "Table 2 PP04 O3N2 row (32.1488, −8.51258, 0.976384, −0.0359763). The column header is a, b, c, d; the table note misprints the form. Masses T04/K03a (Kroupa). Same O3N2 formula as our OH_PP04."),
    "AM13": ("verified", "eq. 5 and Table 4 row MZR (log M_TO = 8.901, asymptote 8.798, γ = 0.640, fit 7.4 to 10.5); MPA-JHU DR7 total masses. The direct (Te) O/H scale is drawn on OH_PP04, which is an axis approximation."),
    "C20": ("verified", "eq. 2 and its table (Z0 = 8.793, log M0 = 10.02, γ = 0.28, β = 1.2), trusted for 7.95 < log M★ < 11.85. C20 do not state their Kroupa to Chabrier factor. The MD14 factor (0.034 dex) is used; M10's 1.06 would give 0.025 dex."),
    "M10": ("corrected", "eq. 4 quartic with x = μ0.32 − 10; μ0.32 range 9.2 to 11.4 from the populated Table 1 bins; masses K03a/1.06; SFRs inside the fibre (sec. 2.1 and 4). The x conversion was corrected, see below."),
    "RP15": ("verified", "Ridge line log SFR = 0.76 log M★ − 7.64 (text below Fig. 3); SDSS DR7, 0.02 < z < 0.085, AGN excluded, no star forming preselection. The ridge of their Fig. 4 follows the formula. The IMF is not stated."),
    "S14": ("verified", "eq. 28 (the preferred 'mixed' fit); t is the age of the Universe in Gyr for (h, Ωm, ΩΛ) = (0.7, 0.3, 0.7), 12.166 Gyr at z = 0.1; fitted mass range 9.7 to 11.1; Kroupa. The fit spans z ≈ 0.25 to 2.75, so z = 0.1 is an extrapolation."),
    "S16": ("verified", "eq. 5 cubic; SDSS DR7 at 0.01 < z < 0.05; MPA-JHU masses; NUV + WISE SFRs scaled by 0.94 to Chabrier, which +0.027 dex undoes."),
    "Q11": ("verified", "W12 sec. 2.1: active and quenched split at sSFR = 10⁻¹¹ yr⁻¹ on the MPA-JHU DR7 SSFRs."),
    "RP15s": ("verified", "RP15 rewritten: log sSFR = −0.24 log M★ − 7.64."),
    "Q11s": ("verified", "as Q11."),
    "S03L": ("verified", "Table 1 row 'Figure 11' (α = 0.14, β = 0.39, γ = 0.10 kpc, M0 = 3.98 × 10¹⁰ M☉), z band Sérsic radii, n < 2.5, h = 0.7. The fit line of S03 Fig. 11, rendered from the source, gives 1.8 kpc at 10⁹ and 4.7 kpc at 10¹¹ M☉, as the formula does."),
    "S03E": ("verified", "Table 1 row 'Figure 11', a = 0.56, with the erratum b = 2.88 × 10⁻⁶ (printed 3.47 × 10⁻⁵). Independent check of the erratum: the early type fit line drawn in S03 Fig. 11 passes 4.2 kpc at 10¹¹ and 15 kpc at 10¹² M☉ (b ≈ 2.9 × 10⁻⁶), and the S03 z band size-luminosity fit (row 'Figure 10') gives about 3.9 kpc at 10¹¹ M☉ for M/L_z ≈ 1.8."),
    "K03S": ("verified", "μ★ ~ 3 × 10⁸ M☉ kpc⁻² (K03b sec. 5 and summary), with μ★ = 0.5 M★/(π R50,z²). The r/z radius ratio was measured again on an independent SkyServer sample of 8,000 galaxies (+0.0277 dex, against +0.0270)."),
    "Q11d": ("verified", "as Q11."),
    "B03": ("verified", "Table 2, orthogonal maximum likelihood, r*: a = 1.49, b = −0.75 (in log I), c = −8.778; μ = −2.5 log I; R in h70⁻¹ kpc; σ at R/8. c reproduces B03's own sample means (V* = 2.200, μ* = 19.87, R* = 0.490) to rounding."),
    "K03": ("verified", "eq. 1: 0.61/(x − 0.05) + 1.3."),
    "K01": ("verified", "eq. 5: 0.61/(x − 0.47) + 1.19."),
    "S07": ("verified", "eq. 1: 1.05 x + 0.45, drawn from its K01 intersection (−0.184, 0.257)."),
    "Mo13": ("verified", "eq. 2, the z/(z+1) evolution and Table 1; masses in M☉ for h = 0.704, M200c, Chabrier. The halo conversion was re-derived with a separate NFW and Duffy+08 code (+0.135 dex at 10¹² M☉)."),
    "B13": ("verified", "eq. 3 and the sec. 5 parameters; median M★ at fixed Mvir (Bryan & Norman), h = 0.7, Ωm = 0.27, Chabrier. Halo conversion re-derived (+0.059 dex at 10¹² M☉). B13's nuisance offset μ(z = 0.1) = −0.027 dex between measured and true M★ is not applied."),
    "Q11e": ("verified", "as Q11."),
    "C18": ("corrected", "Table 1 log M★ block, weighted medians with non-detections at their upper limits; MPA-JHU DR7 masses (labelled Chabrier, used as given). The drawn polyline was corrected, see below."),
    "H12": ("verified", "eq. 1 (0.712 and 3.117 below 10⁹, 0.276 and 7.042 above): mean log M_HI in 0.5 dex bins of log M★ for α.40 detections; Chabrier, h = 0.7."),
}

# =========================================================================================
# second independent review (literature verifier, second pass, 2026-09-24)
# =========================================================================================
# All 26 arXiv sources were downloaded again into a separate directory with curl and were
# byte-identical to pipeline/cache/literature_src. The erratum of Shen et al. (2007) was read
# again from OpenAlex and its bibliographic record checked on Crossref (MNRAS 379, 400). Every
# coefficient was read again in the LaTeX, and every curve was evaluated again by a third,
# separate implementation (own age integral, own NFW conversion by bisection, own S03 chain).
# third_max_dy: largest |y_json - y_third| over the stored points (the steep BPT branches are
# limited by the 1e-4 rounding of x). digest: checksum of the drawn content (x, y, kind,
# fitOffset, range, band, curve points and nodes) at review time; if a later build changes a
# curve, second_review.current becomes false and the build warns.
SECOND_REVIEW_BY = "literature verifier (second review)"
SECOND_REVIEW = {
    "T04": ("verified", "Eq. 3 and its range of 8.5 to 11.5 were read again, with the Kroupa IMF and H0 = 70. The Table 3 columns are P2.5, P16, P50, P84 and P97.5, and the band uses P16 and P84. T04 eq. 3 and the T04 row of KE08 Table 2 agree to 0.005 dex at 10¹⁰ and 10¹¹ M☉, so both use the same Kroupa masses.", 5.0e-5, "89128ce54fed"),
    "KE08": ("verified", "The PP04 O3N2 row of Table 2 was read again. The fit is y = a + bx + cx² + dx³ with x = log M in M☉, and the table note that prints 'bx²+bx³' is a misprint. The masses are the T04 and K03a masses with a Kroupa IMF, not Salpeter masses, because the T04 row of the same table reproduces T04 eq. 3.", 5.9e-5, "a52bd421f5d0"),
    "AM13": ("verified", "Eq. 5 and the MZR row of Table 4 were read again (8.901, 8.798, 0.640, fitted over 7.4 to 10.5). The masses are MPA-JHU DR7 total masses with no IMF change, and the cosmology is H0 = 70 and Ωm = 0.3.", 6.2e-5, "fb4d1e3ab954"),
    "C20": ("verified", "Eq. 2 and its table were read again (8.793, 10.02, 0.28, 1.2), with the trusted range of 7.95 to 11.85. Below M0 the formula is a power law of index γ, as C20 state. C20 rescaled the MPA-JHU masses to a Chabrier IMF without giving the factor, so the MD14 value of +0.034 dex is a fair way to undo it.", 5.1e-5, "7f9bc9708d7e"),
    "M10": ("verified", "Eq. 4 with x = μ0.32 − 10 was read again. M10 divided the MPA-JHU masses by 1.06 and used K98 Hα SFRs inside the fibre, and the populated Table 1 bins span μ0.32 = 9.23 to 11.43. M10 give their own sample counts in sec. 2.1. Of 927,552 DR7 galaxies, 47 % (436k) are emission line galaxies at 0.07 < z < 0.30, 43 % of these pass S/N(Hα) > 25, and 22 % are AGN. With the catalogue errors as given, our parent sample gives 405k to 450k galaxies, 41 to 45 % and 20 %. With the errors rescaled by 2.473 it gives 13 to 15 % and 15 %. This confirms the correction of the first review.", 6.5e-5, "cdfb39cec054"),
    "RP15": ("corrected", "The ridge line log SFR = 0.76 log M★ − 7.64 (text below Fig. 3) was read again. It is a fit to the ridge of the V/Vmax weighted number density in Fig. 4. In Fig. 4, which we rendered from the source, the ridge is visible from 10^8.3 to 10^10.5 M☉. The conversions text gave an IMF uncertainty about 40 times too large (see the correction). The curve is unchanged.", 8.0e-6, "8b6447b1fab4"),
    "S14": ("verified", "Eq. 28 (the 'Mixed' fit, which S14 prefer) was read again. The variable t is the age of the Universe in Gyr, and a separate integral gives 12.166 Gyr at z = 0.1 for (h, Ωm, ΩΛ) = (0.7, 0.3, 0.7). The IMF is Kroupa, the fitted mass range is 9.7 to 11.1, and the SDSS studies were left out of the fit.", 6.8e-5, "2569db9ce108"),
    "S16": ("verified", "Eq. 5 was read again. It is a cubic in x = log M★ with no constant term, fitted to galaxies at 0.01 < z < 0.05 with M★ > 10⁸ M☉. SFR_UV was calibrated for a Kroupa IMF and then scaled down by 6 % to Chabrier, and S16 quote all quantities for Chabrier, so +0.027 dex undoes the scaling. The masses are MPA-JHU values used as given, like ours.", 1.1e-4, "a08226eda712"),
    "Q11": ("verified", "W12 sec. 2.1 splits galaxies at SSFR = 10⁻¹¹ yr⁻¹, using the MPA-JHU DR7 SSFRs (B04 with the Salim+07 aperture corrections). In the SFR plane the line is log SFR = log M★ − 11.", 0.0, "75587832c217"),
    "RP15s": ("verified", "The RP15 ridge line was rewritten as log sSFR = −0.24 log M★ − 7.64. The conversions text now includes the IMF note of RP15, i.e., a change from Chabrier to Kroupa moves the line by +0.001 dex.", 8.0e-6, "f62d96d63696"),
    "Q11s": ("verified", "As Q11.", 0.0, "15b573d1090e"),
    "S03L": ("verified", "The 'Figure 11' row of Table 1 and eq. 18 were read again. The radii are Sérsic half-light radii in the z band, late types have n < 2.5, h = 0.7, and the masses are K03a masses. We rendered S03 Fig. 11 from fig11.ps, and its late type line passes 1.8 kpc at 10⁹ M☉ and 4.7 kpc at 10¹¹ M☉. We implemented the conversion again. We start from the Fig. 11 radius, add the r/z ratio, invert the Fig. 6 fit, apply the Petrosian flux fraction and then evaluate the Fig. 4 fit.", 6.1e-5, "cc41d93ee914"),
    "S03E": ("verified", "The 'Figure 11' row of Table 1 gives a = 0.56. We use the erratum value b = 2.88 × 10⁻⁶, after reading the erratum text again on OpenAlex and its record on Crossref. S03 Fig. 11 shows the fit line at 1.3 kpc at 10^10.1 M☉, 4.2 kpc at 10¹¹ M☉ and 13.6 kpc at 10^11.9 M☉, while the printed b = 3.47 × 10⁻⁵ would give 164 kpc at 10^11.9 M☉. The lowest early type point of S03 (10^10.1 M☉, about 1.7 kpc) lies about 0.12 dex above their power law, and our C ≥ 2.86 galaxies lie above the curve at low mass in the same way.", 6.4e-5, "7f67b39f1a56"),
    "K03S": ("verified", "K03b sec. 5 and its summary give a transition at μ★ ~ 3 × 10⁸ M☉ kpc⁻², with μ★ = 0.5 M★/[π R50(z)²], the Petrosian z band radius and a Kroupa IMF. Σ★ does not depend on h. In K03b Fig. 13, which we rendered, 50 % of galaxies have Dn4000 > 1.55 at log μ★ ≈ 8.55 to 8.6, so the quoted value of 3 × 10⁸ marks the lower part of the transition.", 2.1e-5, "30285acc7b3f"),
    "Q11d": ("verified", "As Q11.", 0.0, "bdc13032f49c"),
    "B03": ("verified", "The r* row of Table 2 (orthogonal fit, maximum likelihood) was read again (1.49, −0.75, −8.778), with eq. 2. The coefficient b multiplies log I, and μ = −2.5 log I, so the coefficient of μ is +0.30. R is in h70⁻¹ kpc and σ in km s⁻¹. The plane through the maximum likelihood means gives c = −8.749, which agrees within the rounding of b (±0.002 × 19.87 ≈ ±0.04).", 0.0, "230eadd3cdf0"),
    "K03": ("verified", "Eq. 1 of 'The Host Galaxies of AGN' was read again. A galaxy is an AGN if log([OIII]/Hβ) > 0.61/(log([NII]/Hα) − 0.05) + 1.3. Only the left branch (x < 0.05) is drawn, down to the lowest O3Hb value of the axis.", 6.1e-4, "9cae7227f153"),
    "K01": ("verified", "Eq. 5, log([OIII]/Hβ) = 0.61/(log([NII]/Hα) − 0.47) + 1.19, was read again. Only the left branch (x < 0.47) is drawn.", 4.1e-4, "3e7ec7aa66a1"),
    "S07": ("verified", "Eq. 1, log([OIII]/Hβ) = 1.05 log([NII]/Hα) + 0.45, was read again. It separates Seyferts from LINERs among AGN, so it is drawn from its intersection with K01 at (−0.184, 0.257).", 1.0e-4, "342a8c6d5e6b"),
    "Mo13": ("verified", "Eq. 2 and Table 1 were read again. Table 1 belongs to the evolution that is linear in (1 − a), not to the form that is quadratic in z in the earlier section. The table note says that all masses are in M☉. The halo mass is M200c, h = 0.704 (WMAP7) and the IMF is Chabrier. With a separate NFW conversion we get +0.135 dex at 10¹² M☉.", 1.4e-4, "e3b9a272369f"),
    "B13": ("verified", "Eq. 3, which gives the median M★ at fixed halo mass, and every coefficient of sec. 5 were read again. The halo mass is Mvir (Bryan & Norman, relative to the critical density), with Ωm = 0.27, h = 0.7 and a Chabrier IMF. With a separate NFW conversion we get +0.059 dex at 10¹² M☉.", 1.0e-4, "bf8ac000ae93"),
    "Q11e": ("verified", "As Q11.", 0.0, "dedf33951cbd"),
    "C18": ("verified", "The log M★ block of Table 1 was read again. The bin means run from 9.14 to 11.20, the weighted medians run from −0.092 to −1.785, and non-detections are set to their upper limits. The masses are the improved MPA-JHU DR7 masses, the same values as ours. The fix of the first review is confirmed, since all 8 medians are vertices of the polyline.", 1.1e-4, "e0390b6668c7"),
    "H12": ("verified", "Eq. 1 was read again, and it is continuous at 10⁹ M☉. It gives ⟨log M_HI⟩ in 0.5 dex bins for detections in the α.40, SDSS and GALEX sample. The IMF is Chabrier with h = 0.7, so we add 0.034 dex to the mass and subtract 0.034 dex from the gas fraction.", 6.5e-5, "67061ed5ff6c"),
}


def relation_digest(r):
    """Checksum of what the site draws for a relation (see SECOND_REVIEW)."""
    import hashlib
    core = {"x": r["x"], "y": r["y"], "kind": r["kind"], "fitOffset": r["fitOffset"], "range": r["range"],
            "band": r.get("band"), "curves": [[c["points"], c.get("nodes")] for c in r["curves"]]}
    return hashlib.sha1(json.dumps(core, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:12]


def second_review_corrections():
    """Before/after text for relations corrected in the second review."""
    new = rp15_imf_text()
    return {"RP15": ("The conversions text was 'None. RP15 do not state the IMF, so an offset of up to 0.03 dex is possible.' "
                     f"It is now '{new}' The curve is unchanged.")}


def independent_check(rels, conv, tol=1e-3):
    """Second implementation of every relation, typed again from the sources rather than
    reusing the rel_* code, including its own NFW halo conversion and its own S03
    Petrosian/Sersic inversion. Returns {id: max |y_json - y_second|} and stops if any value
    exceeds tol (JSON points are rounded to 1e-4; steep BPT sections reach 6e-4)."""
    from scipy.optimize import brentq
    from astropy.cosmology import FlatLambdaCDM
    c2k_m, c2k_s = math.log10(0.66 / 0.61), math.log10(0.67 / 0.63)      # MD14 sec. 3

    def om_z(z, om):
        a3 = (1.0 + z) ** 3
        return om * a3 / (om * a3 + 1.0 - om)

    def mu_nfw(s):
        return math.log(1.0 + s) - s / (1.0 + s)

    def m180m(lm, kind, h, om, z=Z_REF):     # Duffy+08 NFW full sample z = 0-2; Bryan & Norman 98
        A, B, C = {"200c": (5.71, -0.084, -0.47), "vir": (7.85, -0.081, -0.71)}[kind]
        xx = om_z(z, om) - 1.0
        d_src = 200.0 if kind == "200c" else 18.0 * math.pi ** 2 + 82.0 * xx - 39.0 * xx ** 2
        c = A * (10.0 ** lm * h / 2e12) ** B * (1.0 + z) ** C
        tgt = 180.0 * om_z(z, om) / d_src * mu_nfw(c) / c ** 3
        s = brentq(lambda s: mu_nfw(s) / s ** 3 - tgt, 1e-3 * c, 1e3 * c)
        return lm + math.log10(mu_nfw(s) / mu_nfw(c))

    def moster(lm, z=Z_REF):                 # Mo13 eq. 2, Table 1
        f = z / (1.0 + z)
        m1, nn = 11.590 + 1.195 * f, 0.0351 - 0.0247 * f
        be, ga = 1.376 - 0.826 * f, 0.608 + 0.329 * f
        q = 10.0 ** (lm - m1)
        return lm + math.log10(2.0 * nn / (q ** -be + q ** ga))

    def behroozi(lm, z=Z_REF):               # B13 eq. 3, sec. 5
        a = 1.0 / (1.0 + z)
        nu = math.exp(-4.0 * a * a)
        le = -1.777 + (-0.006 * (a - 1.0) - 0.000 * z) * nu - 0.119 * (a - 1.0)
        l1 = 11.514 + (-1.793 * (a - 1.0) - 0.251 * z) * nu
        al = -1.412 + 0.731 * (a - 1.0) * nu
        de = 3.508 + (2.608 * (a - 1.0) - 0.043 * z) * nu
        ga = 0.316 + (1.319 * (a - 1.0) + 0.279 * z) * nu
        f = lambda x: -math.log10(10.0 ** (al * x) + 1.0) + de * math.log10(1.0 + math.exp(x)) ** ga / (1.0 + math.exp(10.0 ** -x))
        return le + l1 + f(lm - l1) - f(0.0)

    def s03_petro_over_sersic(lr, early):    # S03 Table 1 rows 'Figure 4' (Petrosian) and 'Figure 6' (Sersic)
        flux = 0.80 if early else conv["petro_flux_fraction"]["1"]
        dm = 2.5 * math.log10(1.0 / flux)
        if early:
            ms = (-5.06 - lr) / 0.26
            return (-0.24 * (ms + dm) - 4.63) - lr
        f6 = lambda M: -0.104 * M + 0.25 * math.log10(1.0 + 10.0 ** (-0.4 * (M + 20.91))) - 1.71
        f4 = lambda M: -0.084 * M + 0.32 * math.log10(1.0 + 10.0 ** (-0.4 * (M + 20.52))) - 1.31
        ms = brentq(lambda M: f6(M) - lr, -27.0, -12.0)
        return f4(ms + dm) - lr

    def s03(x, early):
        rz = conv["r50_r_over_z"]["early" if early else "late"]
        out = []
        for m in x:
            lz = math.log10(2.88e-6) + 0.56 * m if early else math.log10(0.10 * 10.0 ** (0.14 * m) * (1.0 + 10.0 ** m / 3.98e10) ** 0.25)
            out.append(lz + rz + s03_petro_over_sersic(lz + rz, early))
        return np.array(out)

    t_age = float(FlatLambdaCDM(H0=70.0, Om0=0.3).age(Z_REF).value)
    d_mu = math.log10(1.06) - 0.32 * c2k_s - 0.32 * conv["m10_aperture"]["median"]
    c18 = np.array([(9.14, -0.092), (9.44, -0.320), (9.74, -0.656), (10.07, -0.854), (10.34, -1.278),
                    (10.65, -1.223), (10.95, -1.707), (11.20, -1.785)])
    inv = lambda f, lo, hi: (lambda xs: np.array([brentq(lambda v: f(v) - xi, lo, hi) for xi in xs]))
    mo_src = inv(lambda v: m180m(v, "200c", 0.704, 0.272) + math.log10(0.704 / H_OURS), 9.0, 17.0)
    b13_src = inv(lambda v: m180m(v, "vir", 0.7, 0.27), 9.0, 17.0)
    lmhi = lambda xc: np.where(xc <= 9.0, 0.712 * xc + 3.117, 0.276 * xc + 7.042)
    F = {
        "T04": lambda x: -1.492 + 1.847 * x - 0.08026 * x ** 2,
        "KE08": lambda x: 32.1488 - 8.51258 * x + 0.976384 * x ** 2 - 0.0359763 * x ** 3,
        "AM13": lambda x: 8.798 - np.log10(1.0 + (10.0 ** 8.901 / 10.0 ** x) ** 0.640),
        "C20": lambda x: 8.793 - 0.28 / 1.2 * np.log10(1.0 + (10.0 ** (x - c2k_m - 10.02)) ** -1.2),
        "M10": lambda x: (lambda t: 8.90 + 0.39 * t - 0.20 * t ** 2 - 0.077 * t ** 3 + 0.064 * t ** 4)(x - d_mu - 10.0),
        "RP15": lambda x: 0.76 * x - 7.64,
        "RP15s": lambda x: -0.24 * x - 7.64,
        "S14": lambda x: (0.84 - 0.026 * t_age) * x - (6.51 - 0.11 * t_age),
        "S16": lambda x: -2.332 * x + 0.4156 * x ** 2 - 0.01828 * x ** 3 + c2k_s,
        "Q11": lambda x: x - 11.0,
        "Q11s": lambda x: np.full_like(x, -11.0), "Q11e": lambda x: np.full_like(x, -11.0), "Q11d": lambda x: np.full_like(x, -11.0),
        "S03L": lambda x: s03(x, False), "S03E": lambda x: s03(x, True),
        "B03": lambda x: x - 8.778,
        "K03": lambda x: 0.61 / (x - 0.05) + 1.3,
        "K01": lambda x: 0.61 / (x - 0.47) + 1.19,
        "S07": lambda x: 1.05 * x + 0.45,
        "Mo13": lambda x: np.array([moster(v) for v in mo_src(x)]) + c2k_m + 2.0 * math.log10(0.704 / H_OURS),
        "B13": lambda x: np.array([behroozi(v) for v in b13_src(x)]) + c2k_m,
        "C18": lambda x: np.interp(x, c18[:, 0], c18[:, 1]),
        "H12": lambda x: lmhi(x - c2k_m) - x,
    }
    res = {}
    for r in rels:
        p = np.array(r["curves"][0]["points"], float)
        if r["id"] == "K03S":           # vertical line: check its position and its y span
            x0 = math.log10(3e8) - 2.0 * conv["r50_r_over_z"]["all"]
            dev = float(np.max(np.abs(p[:, 0] - x0)))
            assert p[:, 1].min() <= DIM_RANGE["logsSFR"][0] + 1e-9 and p[:, 1].max() >= DIM_RANGE["logsSFR"][1] - 1e-9, "K03S span"
        else:
            dev = float(np.max(np.abs(p[:, 1] - F[r["id"]](p[:, 0]))))
        if r["id"] == "C18":
            on = [bool(np.any(np.isclose(p[:, 0], a, atol=1e-6) & np.isclose(p[:, 1], b, atol=1e-6))) for a, b in c18]
            assert all(on), f"C18 polyline misses table nodes: {on}"
        assert dev <= tol, f"{r['id']}: second implementation differs by {dev:.2e}"
        res[r["id"]] = round(dev, 6)
    print(f"  independent check: all {len(res)} relations agree with the second implementation "
          f"(max |dy| = {max(res.values()):.1e})")
    return res


PRESETS_JS = ROOT / "site" / "js" / "config" / "presets.js"


def check_presets(rels):
    """Cross-check with site/js/config/presets.js (owned by the core/UI agents; warnings only):
    every id a preset lists exists, carries that preset as its view, and aligns with the preset
    axes (|v.p| >= 0.985 in standardized units, the full-opacity threshold of DESIGN.md section 10)."""
    if not PRESETS_JS.exists() or not MANIFEST.exists():
        return
    js = PRESETS_JS.read_text()
    dims = json.loads(MANIFEST.read_text())["dims"]
    keys, scale = [d["key"] for d in dims], {d["key"]: float(d["scale"]) for d in dims}
    combo = lambda s: {k: float(v) for k, v in re.findall(r"(\w+)\s*:\s*(-?[\d.]+)", s)}

    def uvec(c):
        v = np.zeros(len(keys))
        for k, a in c.items():
            v[keys.index(k)] = a * scale[k]
        return v / np.linalg.norm(v)
    R = {r["id"]: r for r in rels}
    listed, problems = set(), []
    for m in re.finditer(r"\{\s*id:\s*'(\w+)'.*?x:\s*\{([^}]*)\},\s*y:\s*\{([^}]*)\}.*?literature:\s*\[([^\]]*)\]", js, re.S):
        pid, cx, cy, lits = m.group(1), combo(m.group(2)), combo(m.group(3)), re.findall(r"'(\w+)'", m.group(4))
        px = uvec(cx)
        py = uvec(cy) - (uvec(cy) @ px) * px
        py /= np.linalg.norm(py)
        for rid in lits:
            listed.add(rid)
            if rid not in R:
                problems.append(f"{pid} lists unknown id {rid}")
                continue
            r = R[rid]
            al = min(abs(uvec(r["x"]) @ px), abs(uvec(r["y"]) @ py))
            if r["view"] != pid:
                problems.append(f"{rid} has view {r['view']} but is listed by preset {pid}")
            if al < 0.985:
                problems.append(f"{rid} aligns only {al:.3f} with preset {pid}")
    unlisted = sorted(set(R) - listed)
    print(f"  presets.js: {len(listed & set(R))} of {len(R)} relations listed"
          + (f"; unlisted: {unlisted}" if unlisted else "") + ("; " + "; ".join(problems) if problems else "; all aligned"))


def review_corrections(conv):
    """Before/after text for each corrected relation (numbers from the conversions)."""
    ap = conv["m10_aperture"]
    base = conv["m10_mass_factor_dex"] - 0.32 * conv["imf_sfr_chab_to_kroupa"]
    old = base - 0.32 * ap.get("median_rescaled", 0.2865)
    new = base - 0.32 * ap["median"]
    return {
        "M10": (f"μ0.32 shift {sg(old)} → {sg(new)} dex, so the curve moves {sg(new - old)} dex in x. The fibre to total SFR "
                f"offset came from an M10-like sample cut on the rescaled Hα errors (N = {ap.get('n_rescaled', 50144):,}, median "
                f"{ap.get('median_rescaled', 0.2865):.3f} dex). M10 cut on the catalogue errors as given; that cut gives "
                f"N = {ap['n']:,}, against the {ap.get('n_m10_paper', M10_N_FINAL):,} of M10, and a median of {ap['median']:.3f} dex."),
        "C18": ("The 85 point polyline passed through only 2 of the 8 Table 1 medians and cut the corners by up to 0.011 dex. "
                "The medians are now vertices of the polyline."),
    }

# preset views (DESIGN.md section 14) plus the recommended O3N2 MZR view, for the check plot
VIEWS = [
    ("mzr", "MZR (T04 scale)", {"logM": 1.0}, {"OH": 1.0}, None),
    ("mzr2", "MZR (PP04 O3N2 scale)", {"logM": 1.0}, {"OH_PP04": 1.0}, None),
    ("fmr", "FMR", {"logM": 1.0, "logSFR": -0.32}, {"OH_PP04": 1.0}, None),
    ("sfms", "SFMS", {"logM": 1.0}, {"logSFR": 1.0}, None),
    ("ssfr", "sSFR", {"logM": 1.0}, {"logsSFR": 1.0}, None),
    ("sigma", "Σ★", {"logSigma": 1.0}, {"logsSFR": 1.0}, None),
    ("size", "R–M", {"logM": 1.0}, {"logR50": 1.0}, None),
    ("fp", "FP (Galaxy Zoo ellipticals)", {"logSigV": 1.49, "mu50": 0.30}, {"logR50": 1.0}, ("morph", {1})),
    ("bpt", "BPT", {"N2Ha": 1.0}, {"O3Hb": 1.0}, None),
    ("shmr", "SHMR (centrals)", {"logMh": 1.0}, {"logM": 1.0}, ("env", {1, 2})),
    ("env", "ENV", {"logMh": 1.0}, {"logsSFR": 1.0}, None),
    ("hi", "H I", {"logM": 1.0}, {"logfHI": 1.0}, None),
]


# =========================================================================================
# build
# =========================================================================================
def refresh_dims_from_manifest():
    if not MANIFEST.exists():
        return
    try:
        man = json.loads(MANIFEST.read_text())
        for d in man.get("dims", []):
            if d["key"] in DIM_RANGE:
                DIM_RANGE[d["key"]] = (float(d["min"]), float(d["max"]))
            if d["key"] in DIM_SCALE:
                DIM_SCALE[d["key"]] = float(d["scale"])
    except Exception as e:
        print("  (manifest not used:", e, ")")


def build():
    refresh_dims_from_manifest()
    conv = derive_conversions()
    rels = [f(conv) for f in RELATIONS]
    ids = [r["id"] for r in rels]
    assert len(ids) == len(set(ids)), "relation ids must be unique"
    for r in rels:
        assert len(r["label"]) <= 6, r["id"]
        for c in r["curves"]:
            assert len(c["points"]) >= 60, (r["id"], len(c["points"]))
    # independent review (additive field verification.review; DESIGN.md section 19)
    corr = review_corrections(conv)
    assert set(REVIEW) == set(ids), f"review missing for {set(ids) ^ set(REVIEW)}"
    indep = independent_check(rels, conv)
    for r in rels:
        result, checked = REVIEW[r["id"]]
        rv = {"result": result, "by": REVIEW_BY, "date": REVIEW_DATE, "checked": checked,
              "second_implementation_max_dy": indep[r["id"]]}
        if r["id"] in corr:
            rv["correction"] = corr[r["id"]]
        r["verification"]["review"] = rv
    # second independent review (additive field verification.second_review; DESIGN.md section 19)
    corr2 = second_review_corrections()
    assert set(SECOND_REVIEW) == set(ids), f"second review missing for {set(ids) ^ set(SECOND_REVIEW)}"
    stale = []
    for r in rels:
        result, checked, dy3, dig = SECOND_REVIEW[r["id"]]
        current = relation_digest(r) == dig
        if not current:
            stale.append(r["id"])
        sr = {"result": result, "by": SECOND_REVIEW_BY, "date": REVIEW_DATE, "checked": checked,
              "third_implementation_max_dy": dy3, "digest": dig, "current": current}
        if r["id"] in corr2:
            sr["correction"] = corr2[r["id"]]
        r["verification"]["second_review"] = sr
    print(f"  second review: all {len(rels)} relations draw exactly what was reviewed" if not stale else
          f"  WARNING second review is not current for {stale} (the drawn content changed since 2026-09-24)")
    try:
        check_presets(rels)
    except Exception as e:      # presets.js belongs to another agent; never fail the build on it
        print(f"  (presets.js not checked: {e})")
    conv_ok, conv_rows = check_excerpts([(k, f or _find_tex(k), t) for k, f, t in CONVENTION_EXCERPTS])
    out = {"schema": 1, "created": BUILT,
           "conventions": "Kroupa IMF (MPA-JHU) masses and SFRs; H0=70, Om=0.3; R50 = Petrosian r-band; "
                          "sigma at R50/8; O/H on T04 (OH) or PP04 O3N2 (OH_PP04); M_h = Lim+17 M_180m in Msun (h=0.7).",
           "relations": [{k: v for k, v in r.items() if not k.startswith("_")} for r in rels]}
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    n_ok = sum(r["verification"]["status"] == "verified" for r in rels)
    print(f"wrote {OUT_JSON.relative_to(ROOT)}: {len(rels)} relations, {n_ok} verified, "
          f"{OUT_JSON.stat().st_size / 1024:.1f} kB")
    for r in rels:
        bad = [row for row in r["_meta"]["excerpt_rows"] if row[3] is not True]
        if bad:
            print("  UNVERIFIED", r["id"], [(b[0], b[1], b[2][:60], b[3]) for b in bad])
    if not conv_ok:
        print("  convention excerpts not all found:", [(r[0], r[1], r[2][:50], r[3]) for r in conv_rows if r[3] is not True])
    return rels, conv, conv_rows


# =========================================================================================
# check plot (native axes, over the data density)
# =========================================================================================
def _combo_eq(a, b):
    return set(a) == set(b) and all(abs(a[k] - b[k]) < 1e-9 for k in a)


def _combo_label(c):
    names = {"logM": "log M★", "logSFR": "log SFR", "logsSFR": "log sSFR", "OH": "12+log(O/H) T04",
             "OH_PP04": "12+log(O/H) O3N2", "logR50": "log R₅₀ [kpc]", "logSigma": "log Σ★", "logSigV": "log σ",
             "mu50": "μ₅₀", "N2Ha": "log [NII]/Hα", "O3Hb": "log [OIII]/Hβ", "logMh": "log M_h", "logfHI": "log M_HI/M★"}
    parts = []
    for k, v in c.items():
        parts.append((f"{v:+.2f} " if abs(v - 1) > 1e-9 else "+ ") + names.get(k, k))
    s = " ".join(parts)
    return s[2:] if s.startswith("+ ") else s


def _combine(df, combo):
    v = np.zeros(len(df))
    for k, c in combo.items():
        v = v + c * df[k].to_numpy(float)
    return v


def _running_median(x, y, lo, hi, nb=24, nmin=40):
    edges = np.linspace(lo, hi, nb + 1)
    xc, ym = [], []
    for a, b in zip(edges[:-1], edges[1:]):
        m = (x >= a) & (x < b)
        if m.sum() >= nmin:
            xc.append(np.median(x[m]))
            ym.append(np.median(y[m]))
    return np.array(xc), np.array(ym)


def _residual(rel, x, y):
    pts = np.array(rel["curves"][0]["points"])
    order = np.argsort(pts[:, 0])
    px, py = pts[order, 0], pts[order, 1]
    m = (x >= rel["range"][0]) & (x <= rel["range"][1]) & np.isfinite(x) & np.isfinite(y)
    if m.sum() < 30 or np.ptp(px) == 0:
        return None, int(m.sum())
    return float(np.median(y[m] - np.interp(x[m], px, py))), int(m.sum())


_GAL = None
VERIFY_PNG = CACHE / "literature_verify.png"


def _galaxies(cols):
    """Columns of pipeline/cache/galaxies.parquet (read once and cached; None if it is missing)."""
    global _GAL
    if not GALAXIES.exists():
        return None
    import pandas as pd
    need = [c for c in cols if _GAL is None or c not in _GAL.columns]
    if need:
        new = pd.read_parquet(GALAXIES, columns=need)
        _GAL = new if _GAL is None else pd.concat([_GAL, new], axis=1)
    return _GAL[cols]


def _ridge(x, y, centers, half=0.125, above=None, bw=0.08, nmin=150):
    """Mode of y in bins of x (0.02 histogram, Gaussian smoothing bw), optionally only for
    points with y > above(x). This is the 'ridge line' of RP15 (the mode at fixed mass)."""
    out = []
    for c in centers:
        m = (x >= c - half) & (x < c + half) & np.isfinite(y)
        if above is not None:
            m &= y > above(x)
        if m.sum() < nmin:
            out.append(np.nan)
            continue
        h, e = np.histogram(y[m], bins=np.arange(-6.0, 3.0, 0.02))
        k = np.exp(-0.5 * (np.arange(-15, 16) * 0.02 / bw) ** 2)
        hs = np.convolve(h, k / k.sum(), mode="same")
        out.append(0.5 * (e[np.argmax(hs)] + e[np.argmax(hs) + 1]))
    return np.array(out)


def verify_plot(rels, conv):
    """Verifier figure (pipeline/cache/literature_verify.png): data density per preset view with
    the curves exactly as drawn (fitOffset applied), plus targeted checks: the SF ridge by
    redshift slice against RP15, early type definitions against S03E, the Dn4000 transition
    against K03S, the M10 x mapping (old and corrected), and a residual summary.
    Returns the numbers quoted in LITERATURE.md."""
    cols = ["logM", "logSFR", "logsSFR", "OH", "OH_PP04", "logR50", "C", "logSigma", "logSigV", "mu50",
            "logfHI", "logMh", "N2Ha", "O3Hb", "env", "morph", "bpt", "z", "D4000", "petroMag_r", "modelMag_r"]
    df = _galaxies(cols)
    if df is None:
        print("  (no galaxies.parquet: verification plot skipped)")
        return {}
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import LogNorm
    R = {r["id"]: r for r in rels}
    bg, cream, cream2, line = "#0b0e13", "#efe6d2", "#b8af9a", "#273142"
    mustard, sky, teal, coral, orange, plum, olive = "#e2b23a", "#6fa8dc", "#3aa6a0", "#de5b52", "#e8743b", "#b07aa1", "#a3b35b"
    ls = {"solid": "-", "dashed": "--", "dotted": ":"}
    A = {k: df[k].to_numpy(float) for k in cols}
    st = {"resid": {}}

    def pts(rid, sort=True):
        p = np.array(R[rid]["curves"][0]["points"], float)
        return p[np.argsort(p[:, 0])] if sort else p

    def med_line(x, y, lo, hi, nb=28, nmin=40):
        e = np.linspace(lo, hi, nb + 1)
        xc, ym = [], []
        for a, b in zip(e[:-1], e[1:]):
            m = (x >= a) & (x < b) & np.isfinite(y)
            if m.sum() >= nmin:
                xc.append(np.median(x[m]))
                ym.append(np.median(y[m]))
        return np.array(xc), np.array(ym)

    def resid(rid, x, y):
        p = pts(rid)
        m = (x >= R[rid]["range"][0]) & (x <= R[rid]["range"][1]) & np.isfinite(x) & np.isfinite(y)
        return (float(np.median(y[m] - np.interp(x[m], p[:, 0], p[:, 1]))), int(m.sum())) if m.sum() > 30 else (None, int(m.sum()))

    def panel(ax, x, y, title, xl, yl, sel=None, q=(0.3, 99.7)):
        ax.set_facecolor(bg)
        for s in ax.spines.values():
            s.set_color(line)
        ax.tick_params(colors=cream2, labelsize=8)
        ok = np.isfinite(x) & np.isfinite(y) & (np.ones_like(x, bool) if sel is None else sel)
        x, y = x[ok], y[ok]
        lo_x, hi_x = np.percentile(x, q)
        lo_y, hi_y = np.percentile(y, q)
        ax.hist2d(x, y, bins=150, range=[[lo_x, hi_x], [lo_y, hi_y]], norm=LogNorm(), cmap="bone", cmin=1)
        mx, my = med_line(x, y, lo_x, hi_x)
        ax.plot(mx, my, color=sky, lw=1.1, label="data median")
        ax.set_xlim(lo_x, hi_x)
        ax.set_ylim(lo_y, hi_y)
        ax.set_title(title, color=cream, fontsize=10.5)
        ax.set_xlabel(xl, color=cream2, fontsize=8.5)
        ax.set_ylabel(yl, color=cream2, fontsize=8.5)
        return x, y

    def draw(ax, rid, x=None, y=None, color=mustard, lw=1.8, label=None, alpha=1.0, pts_override=None):
        r = R[rid]
        p = pts(rid, sort=r["kind"] != "threshold") if pts_override is None else pts_override
        off = 0.0
        if r["fitOffset"] and x is not None:
            e = (x >= p[:, 0].min()) & (x <= p[:, 0].max())
            off = float(np.median(y[e] - np.interp(x[e], p[:, 0], p[:, 1])))
        if r.get("band"):
            b = np.array(r["band"])
            ax.fill_between(b[:, 0], b[:, 1] + off, b[:, 2] + off, color=color, alpha=0.15, lw=0)
        ax.plot(p[:, 0], p[:, 1] + off, ls[r["curves"][0]["style"]], color=color, lw=lw, alpha=alpha,
                label=(label or r["label"]) + (f" (offset {off:+.2f})" if r["fitOffset"] else ""))
        nd = r["curves"][0].get("nodes")
        if nd:
            nd = np.array(nd)
            ax.plot(nd[:, 0], nd[:, 1], "o", color=color, ms=3)
        return off

    fig, axes = plt.subplots(6, 3, figsize=(16, 31), facecolor=bg)
    ax = axes.flat
    logM, OH, OHp, SFR, sSFR = A["logM"], A["OH"], A["OH_PP04"], A["logSFR"], A["logsSFR"]
    # 1 MZR (T04 scale)
    x, y = panel(ax[0], logM, OH, "MZR · T04 scale (OH)", "log M★", "12+log(O/H) T04")
    draw(ax[0], "T04")
    st["resid"]["T04"] = resid("T04", x, y)
    # 2 MZR (O3N2 scale)
    x, y = panel(ax[1], logM, OHp, "MZR · PP04 O3N2 scale (OH_PP04)", "log M★", "12+log(O/H) O3N2")
    for rid in ("KE08", "AM13", "C20"):
        draw(ax[1], rid)
        st["resid"][rid] = resid(rid, x, y)
    # 3 FMR: corrected and first-build M10 x shift
    mu = logM - 0.32 * SFR
    x, y = panel(ax[2], mu, OHp, "FMR · M10, corrected x shift", "log M★ − 0.32 log SFR", "12+log(O/H) O3N2")
    ap = conv["m10_aperture"]
    base = conv["m10_mass_factor_dex"] - 0.32 * conv["imf_sfr_chab_to_kroupa"]
    p_new = pts("M10")
    d_old = (base - 0.32 * ap.get("median_rescaled", 0.2865)) - (base - 0.32 * ap["median"])
    p_old = p_new.copy()
    p_old[:, 0] += d_old
    fm = {}
    for tag, p in (("new", p_new), ("old", p_old)):
        e = (x >= p[:, 0].min()) & (x <= p[:, 0].max())
        off = float(np.median(y[e] - np.interp(x[e], p[:, 0], p[:, 1])))
        mx, my = med_line(x[e], y[e], p[:, 0].min(), p[:, 0].max(), nb=20)
        rms = float(np.sqrt(np.mean((my - np.interp(mx, p[:, 0], p[:, 1]) - off) ** 2)))
        fm[tag] = {"shift": round(float(base - 0.32 * (ap["median"] if tag == "new" else ap.get("median_rescaled", 0.2865))), 4),
                   "offset": round(off, 3), "rms_vs_median": round(rms, 3)}
        ax[2].plot(p[:, 0], p[:, 1] + off, "-" if tag == "new" else "--", color=mustard, lw=1.8 if tag == "new" else 0.9,
                   alpha=1.0 if tag == "new" else 0.6, label=f"M10 {'corrected' if tag == 'new' else 'first build'} "
                   f"(x {fm[tag]['shift']:+.3f}, y {off:+.2f}; rms {rms:.3f})")
    st["m10"] = fm
    # 4 SFMS with ridge lines
    x, y = panel(ax[3], logM, SFR, "SFMS · ridge (mode) by redshift", "log M★", "log SFR")
    for rid in ("RP15", "S14", "S16", "Q11"):
        draw(ax[3], rid, lw=1.6 if rid != "Q11" else 1.0)
    cen = np.arange(8.75, 11.26, 0.25)
    noagn = ~np.isin(A["bpt"], [3, 4, 5])
    above = lambda xx: xx - 11.0
    ridges = {}
    for (z0, z1), col in (((0.02, 0.085), sky), ((0.01, 0.03), teal)):
        s = noagn & (A["z"] > z0) & (A["z"] < z1)
        rr = _ridge(logM[s], SFR[s], cen, above=above)
        ridges[f"{z0}-{z1}"] = rr
        ax[3].plot(cen, rr, "o", color=col, ms=4, label=f"SF ridge, {z0} < z < {z1}")
    st["ridge"] = {"centers": cen.round(2).tolist(), **{k: np.round(v, 3).tolist() for k, v in ridges.items()}}
    # 5 sSFR
    x, y = panel(ax[4], logM, sSFR, "sSFR · M★", "log M★", "log sSFR")
    draw(ax[4], "RP15s")
    draw(ax[4], "Q11s", lw=1.0)
    # 6 Sigma*: K03S and the data's Dn4000 = 1.55 crossing (K03b Fig. 13 divider)
    x, y = panel(ax[5], A["logSigma"], sSFR, "Σ★ · K03 transition", "log Σ★", "log sSFR")
    draw(ax[5], "K03S", lw=1.4)
    draw(ax[5], "Q11d", lw=1.0)
    e = np.arange(7.8, 9.3, 0.05)
    md4 = np.array([np.nanmedian(A["D4000"][(A["logSigma"] >= a) & (A["logSigma"] < a + 0.05)]) for a in e])
    k = int(np.where((md4[:-1] < 1.55) & (md4[1:] >= 1.55))[0][0])
    x155 = float(np.interp(1.55, [md4[k], md4[k + 1]], [e[k] + 0.025, e[k + 1] + 0.025]))
    ax[5].axvline(x155, color=orange, lw=1.0, ls="-", label=f"data median Dn4000 = 1.55 at {x155:.2f}")
    st["k03_d4000_155"] = round(x155, 3)
    st["k03_line"] = pts("K03S", sort=False)[0, 0]
    # 7 size: class definitions
    x, y = panel(ax[6], logM, A["logR50"], "R–M · S03 by class", "log M★", "log R₅₀ [kpc]")
    for lab, sel, col in (("C < 2.86", A["C"] < 2.86, teal), ("C ≥ 2.86", A["C"] >= 2.86, coral), ("GZ1 elliptical", A["morph"] == 1, orange)):
        mx, my = med_line(logM[sel], A["logR50"][sel], 8.5, 12.0)
        ax[6].plot(mx, my, color=col, lw=1.0, label=f"median {lab}")
    draw(ax[6], "S03L")
    draw(ax[6], "S03E")
    st["resid"]["S03L"] = resid("S03L", logM[A["C"] < 2.86], A["logR50"][A["C"] < 2.86])
    st["resid"]["S03E"] = resid("S03E", logM[A["C"] >= 2.86], A["logR50"][A["C"] >= 2.86])
    st["resid"]["S03E (GZ1 E)"] = resid("S03E", logM[A["morph"] == 1], A["logR50"][A["morph"] == 1])
    # second review: light missed by Petrosian magnitudes (S03 and K03 masses scale the Petrosian
    # z band luminosity; ours come from fits to the total, i.e. model, magnitudes)
    dmag = A["petroMag_r"] - A["modelMag_r"]
    okm = np.isfinite(dmag) & (A["modelMag_r"] < 20)
    st["petro_minus_model"] = {k: round(float(np.median(dmag[okm & sel])), 3)
                               for k, sel in (("late", A["C"] < 2.86), ("early", A["C"] >= 2.86))}
    # 8 FP, Galaxy Zoo ellipticals
    ell = A["morph"] == 1
    fpx = 1.49 * A["logSigV"] + 0.30 * A["mu50"]
    x, y = panel(ax[7], fpx, A["logR50"], "FP · GZ1 ellipticals", "1.49 log σ + 0.30 μ₅₀", "log R₅₀ [kpc]", sel=ell)
    st["b03_offset"] = round(draw(ax[7], "B03", x, y), 4)
    st["resid"]["B03"] = resid("B03", x, y)
    # 9 BPT
    panel(ax[8], A["N2Ha"], A["O3Hb"], "BPT", "log [NII]/Hα", "log [OIII]/Hβ")
    for rid in ("K03", "K01", "S07"):
        draw(ax[8], rid, lw=1.5)
    # 10 SHMR centrals
    cen_sel = np.isin(A["env"], [1, 2])
    x, y = panel(ax[9], A["logMh"], logM, "SHMR · centrals", "log M_h [M☉]", "log M★", sel=cen_sel)
    st["shmr_at"] = {}
    for rid in ("Mo13", "B13"):
        draw(ax[9], rid)
        st["resid"][rid] = resid(rid, x, y)
        p = pts(rid)
        st["shmr_at"][rid] = {f"{c:.1f}": round(float(np.median(y[np.abs(x - c) < 0.05]) - np.interp(c, p[:, 0], p[:, 1])), 3)
                              for c in (11.5, 12.0, 12.5, 13.0, 13.5, 14.0)}
    # 11 ENV
    panel(ax[10], A["logMh"], sSFR, "ENV", "log M_h [M☉]", "log sSFR")
    draw(ax[10], "Q11e", lw=1.0)
    # 12 H I
    x, y = panel(ax[11], logM, A["logfHI"], "H I · ALFALFA detections", "log M★", "log M_HI/M★")
    for rid in ("C18", "H12"):
        draw(ax[11], rid)
        st["resid"][rid] = resid(rid, x, y)
    # 13 SF ridge minus RP15 by redshift slice (the Malmquist test)
    a = ax[12]
    a.set_facecolor(bg)
    for s in a.spines.values():
        s.set_color(line)
    a.tick_params(colors=cream2, labelsize=8)
    for (z0, z1), col in (((0.01, 0.03), teal), ((0.03, 0.05), olive), ((0.05, 0.085), plum), ((0.02, 0.085), sky)):
        s = noagn & (A["z"] > z0) & (A["z"] < z1)
        rr = _ridge(logM[s], SFR[s], cen, above=above)
        a.plot(cen, rr - (0.76 * cen - 7.64), "o-", color=col, ms=3, lw=1, label=f"{z0} < z < {z1}")
    a.axhline(0, color=mustard, lw=1.2)
    a.set_ylim(-0.6, 0.8)
    a.set_title("SF ridge − RP15, by redshift slice", color=cream, fontsize=10.5)
    a.set_xlabel("log M★", color=cream2, fontsize=8.5)
    a.set_ylabel("Δ log SFR", color=cream2, fontsize=8.5)
    # 14 M10 mapping between M10's mu (fibre SFR, Chabrier) and ours
    a = ax[13]
    a.set_facecolor(bg)
    for s in a.spines.values():
        s.set_color(line)
    a.tick_params(colors=cream2, labelsize=8)
    im = ap.get("inv_map", {})
    if im:
        kx = np.array([float(k) for k in im])
        a.plot(kx, [im[k] for k in im], "o-", color=sky, ms=4, lw=1, label="μ_tot − median μ_M10 at fixed μ_tot")
        dev = max(abs(v - fm["new"]["shift"]) for v in im.values())
        st["m10_inv_dev"] = round(float(dev), 3)
        st["m10_inv_range"] = [float(kx.min()), float(kx.max())]
    a.axhline(fm["new"]["shift"], color=mustard, lw=1.6, label=f"corrected constant {fm['new']['shift']:+.3f}")
    a.axhline(fm["old"]["shift"], color=mustard, lw=0.9, ls="--", alpha=0.6, label=f"first build {fm['old']['shift']:+.3f}")
    a.set_ylim(-0.3, 0.0)
    a.set_title("M10 · x mapping (M10-like sample)", color=cream, fontsize=10.5)
    a.set_xlabel("our μ0.32 (total SFR)", color=cream2, fontsize=8.5)
    a.set_ylabel("μ_tot − μ_M10", color=cream2, fontsize=8.5)
    # 15 residual summary
    a = ax[14]
    a.set_facecolor(bg)
    for s in a.spines.values():
        s.set_color(line)
    a.tick_params(colors=cream2, labelsize=8)
    rp = [(k, v[0]) for k, v in st["resid"].items() if v[0] is not None]
    rr_ = ridges["0.02-0.085"]
    for rid in ("RP15", "S14", "S16"):
        p = pts(rid)
        ok = np.isfinite(rr_) & (cen >= p[:, 0].min()) & (cen <= p[:, 0].max())
        v = float(np.median(rr_[ok] - np.interp(cen[ok], p[:, 0], p[:, 1])))
        st["resid"][rid + " (ridge)"] = (v, int(ok.sum()))
        rp.append((rid + " (ridge)", v))
    yy = np.arange(len(rp))
    a.barh(yy, [v for _, v in rp], color=[coral if abs(v) > 0.1 else teal for _, v in rp], height=0.6)
    a.set_yticks(yy)
    a.set_yticklabels([k for k, _ in rp], color=cream2, fontsize=7)
    a.axvline(0, color=cream2, lw=0.8)
    a.set_title("median(data − curve), before fitOffset", color=cream, fontsize=10.5)

    # ---- row 6: second review ------------------------------------------------------------
    def frame(a, title, xl, yl):
        a.set_facecolor(bg)
        for s in a.spines.values():
            s.set_color(line)
        a.tick_params(colors=cream2, labelsize=8)
        a.set_title(title, color=cream, fontsize=10.5)
        a.set_xlabel(xl, color=cream2, fontsize=8.5)
        a.set_ylabel(yl, color=cream2, fontsize=8.5)

    # 16 M10 sample reconstruction: raw vs rescaled Halpha errors against M10's own numbers
    a = ax[15]
    frame(a, "M10 · which S/N(Hα) > 25 cut is M10's?", "", "fraction")
    rec = ap.get("reconstruction")
    if rec:
        labels = ["S/N > 25 among\nemission-line gals", "AGN-like among\nS/N > 25"]
        for k, (tag, col) in enumerate((("raw", teal), ("rescaled", coral))):
            r_ = rec[tag]
            lo, hi = sorted([r_["pass_el_sn2"], r_["pass_el_sn3"]])
            a.bar(0 + (k - 0.5) * 0.35, hi, width=0.33, color=col, alpha=0.9,
                  label=f"{tag} errors (N(S/N>25) = {r_['n_sn25']:,})")
            a.plot([0 + (k - 0.5) * 0.35] * 2, [lo, hi], color=bg, lw=2)
            a.bar(1 + (k - 0.5) * 0.35, r_["agn"], width=0.33, color=col, alpha=0.9)
        for xpos, val in ((0, rec["m10"]["pass_sn25"]), (1, rec["m10"]["agn"])):
            a.plot([xpos - 0.4, xpos + 0.4], [val, val], color=mustard, lw=2)
        a.plot([], [], color=mustard, lw=2, label="M10 sec. 2.1 (43 %, 22 %)")
        a.set_xticks([0, 1])
        a.set_xticklabels(labels, color=cream2, fontsize=8)
        a.set_ylim(0, 0.6)
    # 17 r/z Petrosian R50 ratio by angular size (the conversion behind S03 and K03S)
    a = ax[16]
    frame(a, "log(R50,r / R50,z) by angular size", "petroR50_r bin [arcsec]", "median log ratio")
    bs = conv["r50_r_over_z"].get("by_size")
    if bs:
        keys = list(bs)
        xx = np.arange(len(keys))
        a.plot(xx, [bs[k]["late"] for k in keys], "o-", color=teal, lw=1, ms=4, label="C < 2.86")
        a.plot(xx, [bs[k]["early"] for k in keys], "o-", color=coral, lw=1, ms=4, label="C ≥ 2.86")
        for v, col, lab in ((conv["r50_r_over_z"]["late"], teal, "used, late"), (conv["r50_r_over_z"]["early"], coral, "used, early"),
                            (conv["r50_r_over_z"]["all"], mustard, "used, K03S")):
            a.axhline(v, color=col, lw=0.9, ls="--", label=f"{lab} {v:+.4f}")
        a.set_xticks(xx)
        a.set_xticklabels(keys, color=cream2, fontsize=8)
    # 18 K03b Fig. 13 on our axis: fraction with Dn4000 > 1.55 vs log Sigma in mass bins
    a = ax[17]
    frame(a, "K03S · fraction with Dn4000 > 1.55 (cf. K03b Fig. 13)", "log Σ★ (ours)", "fraction")
    e = np.arange(7.6, 9.6, 0.1)
    st["k03_frac50"] = {}
    for (lo, hi), col in (((9, 10), sky), ((10, 11), teal), ((11, 12), plum)):
        mm = (A["logM"] >= lo) & (A["logM"] < hi) & np.isfinite(A["D4000"]) & np.isfinite(A["logSigma"])
        fr = []
        for s0 in e:
            b = mm & (A["logSigma"] >= s0) & (A["logSigma"] < s0 + 0.1)
            fr.append(float((A["D4000"][b] > 1.55).mean()) if b.sum() >= 100 else np.nan)
        fr = np.array(fr)
        a.plot(e + 0.05, fr, "o-", color=col, ms=3, lw=1, label=f"log M★ {lo}–{hi}")
        k = np.where((fr[:-1] < 0.5) & (fr[1:] >= 0.5))[0]
        if len(k):
            st["k03_frac50"][f"{lo}-{hi}"] = round(float(np.interp(0.5, fr[k[0]:k[0] + 2], e[k[0]:k[0] + 2] + 0.05)), 2)
    x0 = st["k03_line"]
    a.axvline(x0, color=mustard, lw=1.4, ls="--", label=f"K03S line {x0:.2f}")
    shift = -2.0 * conv["r50_r_over_z"]["all"]
    a.axvspan(8.55 + shift, 8.60 + shift, color=mustard, alpha=0.2, lw=0, label="K03b Fig. 13: 50 % (to our axis)")
    a.axhline(0.5, color=cream2, lw=0.6, ls=":")
    a.set_ylim(0, 1)
    for axx in axes.flat:
        if axx.get_legend_handles_labels()[0]:
            lg = axx.legend(fontsize=6.5, loc="best", facecolor="#11161f", edgecolor=line, labelcolor=cream)
            lg.get_frame().set_alpha(0.85)
    fig.suptitle("literature verifier · curves as drawn (fitOffset applied) over the data · row 6: second review",
                 color=cream, fontsize=12, y=0.997)
    fig.tight_layout(rect=(0, 0, 1, 0.99))
    fig.savefig(VERIFY_PNG, dpi=72, facecolor=bg)
    plt.close(fig)
    print(f"wrote {VERIFY_PNG.relative_to(ROOT)}")
    return st


def check_plot(rels):
    """Curves in native axes over the data density. Returns per-relation residual stats."""
    if not GALAXIES.exists():
        print("  (no galaxies.parquet yet; check plot drawn without data)")
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import LogNorm
    cols = ["logM", "logSFR", "logsSFR", "OH", "OH_PP04", "logR50", "C", "logSigma", "logSigV", "mu50",
            "logfHI", "logMh", "N2Ha", "O3Hb", "env", "morph", "bpt"]
    df = _galaxies(cols)
    stats = {}
    bg, cream, mustard = "#0b0e13", "#efe6d2", "#e2b23a"
    fig, axes = plt.subplots(4, 3, figsize=(16, 21), facecolor=bg)
    styles = {"solid": "-", "dashed": "--", "dotted": ":"}
    for ax, (vid, title, xc, yc, filt) in zip(axes.flat, VIEWS):
        ax.set_facecolor(bg)
        for s in ax.spines.values():
            s.set_color("#273142")
        ax.tick_params(colors="#b8af9a", labelsize=8)
        mine = [r for r in rels if _combo_eq(r["x"], xc) and _combo_eq(r["y"], yc)]
        x = y = sub = None
        if df is not None:
            sub = df
            if filt:
                sub = sub[sub[filt[0]].isin(filt[1])]
            x, y = _combine(sub, xc), _combine(sub, yc)
            ok = np.isfinite(x) & np.isfinite(y)
            x, y, sub = x[ok], y[ok], sub[ok]
            if len(x):
                lo_x, hi_x = np.percentile(x, [0.3, 99.7])
                lo_y, hi_y = np.percentile(y, [0.3, 99.7])
                ax.hist2d(x, y, bins=160, range=[[lo_x, hi_x], [lo_y, hi_y]], norm=LogNorm(), cmap="bone", cmin=1)
                mx, my = _running_median(x, y, lo_x, hi_x)
                ax.plot(mx, my, color="#6fa8dc", lw=1.2, ls="-", alpha=0.9, label="data median")
                if vid == "size":
                    for cmask, lab, colr in [(sub.C.to_numpy() < 2.86, "C<2.86", "#3aa6a0"), (sub.C.to_numpy() >= 2.86, "C≥2.86", "#de5b52")]:
                        mx, my = _running_median(x[cmask], y[cmask], lo_x, hi_x)
                        ax.plot(mx, my, color=colr, lw=1.0, alpha=0.9, label=f"data median {lab}")
                ax.set_xlim(lo_x, hi_x)
                ax.set_ylim(lo_y, hi_y)
        for r in mine:
            off = 0.0
            res = None
            if x is not None and r["kind"] in ("fit", "median"):
                res, nres = _residual(r, x, y)
                if vid == "size" and sub is not None:   # compare S03 with its own morphological class
                    cm = sub.C.to_numpy() < 2.86 if r["id"] == "S03L" else sub.C.to_numpy() >= 2.86
                    res, nres = _residual(r, x[cm], y[cm])
                stats[r["id"]] = {"median_resid": None if res is None else round(res, 3), "n": nres, "view": vid}
                if r["fitOffset"] and res is not None:
                    off = res
            if r.get("band"):
                b = np.array(r["band"])
                ax.fill_between(b[:, 0], b[:, 1] + off, b[:, 2] + off, color=mustard, alpha=0.18, lw=0)
            for c in r["curves"]:
                p = np.array(c["points"])
                lab = r["label"] + (f" (fitOffset {off:+.2f})" if r["fitOffset"] else "") + ("" if res is None else f"  Δ={res:+.2f}")
                ax.plot(p[:, 0], p[:, 1] + off, styles[c["style"]], color=mustard, lw=1.8, label=lab)
                if r["fitOffset"]:
                    ax.plot(p[:, 0], p[:, 1], styles[c["style"]], color=mustard, lw=0.7, alpha=0.5)
                if c.get("nodes"):
                    nd = np.array(c["nodes"])
                    ax.plot(nd[:, 0], nd[:, 1], "o", color=mustard, ms=3)
        ax.set_title(title, color=cream, fontsize=11)
        ax.set_xlabel(_combo_label(xc), color="#b8af9a", fontsize=9)
        ax.set_ylabel(_combo_label(yc), color="#b8af9a", fontsize=9)
        leg = ax.legend(fontsize=7, loc="best", facecolor="#11161f", edgecolor="#273142", labelcolor=cream)
        leg.get_frame().set_alpha(0.85)
    fig.suptitle("literature relations in native axes (Δ = median data − curve within the relation's range)",
                 color=cream, fontsize=12, y=0.995)
    fig.tight_layout(rect=(0, 0, 1, 0.99))
    fig.savefig(CHECK_PNG, dpi=80, facecolor=bg)
    plt.close(fig)
    print(f"wrote {CHECK_PNG.relative_to(ROOT)}")
    for k, v in stats.items():
        print(f"  {k:6s} {v['view']:9s} median(data - curve) = {v['median_resid']}  (n = {v['n']})")
    return stats


# =========================================================================================
# LITERATURE.md
# =========================================================================================
def _md_combo(c):
    return " + ".join((f"{v:g}·" if v != 1 else "") + k for k, v in c.items()).replace("+ -", "− ")


CONV_SHORT = {
    "T04": "none", "KE08": "none", "AM13": "none (drawn on OH_PP04)", "C20": "M★ Chabrier→Kroupa (drawn on OH_PP04)",
    "M10": "μ: IMF and fibre→total SFR; y offset fit", "RP15": "none", "S14": "none (t at z = 0.1)",
    "S16": "SFR Chabrier→Kroupa", "Q11": "none", "RP15s": "none", "Q11s": "none",
    "S03L": "R: Sérsic z→Petrosian r", "S03E": "R: Sérsic z→Petrosian r; b from erratum",
    "K03S": "Σ: z→r band radius", "Q11d": "none", "B03": "zero point fit", "K03": "none", "K01": "none",
    "S07": "none (above K01 only)", "Mo13": "M_h: M200c→M180m, h; M★: IMF, h", "B13": "M_h: Mvir→M180m; M★: IMF",
    "Q11e": "none", "C18": "none", "H12": "M★ and f_HI: IMF",
}


def _fp_alignment():
    """|cos| between the B03 and HB09 native x axes in our standardised units (manifest scales)."""
    sc = {"logSigV": 0.192, "mu50": 0.735}
    if MANIFEST.exists():
        for d in json.loads(MANIFEST.read_text()).get("dims", []):
            if d["key"] in sc:
                sc[d["key"]] = float(d["scale"])
    v1 = np.array([1.49 * sc["logSigV"], 0.30 * sc["mu50"]])
    v2 = np.array([1.434 * sc["logSigV"], 0.315 * sc["mu50"]])
    c = float(v1 @ v2 / np.linalg.norm(v1) / np.linalg.norm(v2))
    return c, math.degrees(math.acos(min(1.0, c)))


def combined_result(r):
    """Result of both reviews: corrected if either corrected it, removed if either removed it."""
    v = r["verification"]
    rs = [v["review"]["result"], v.get("second_review", {}).get("result", "verified")]
    return "removed" if "removed" in rs else "corrected" if "corrected" in rs else "verified"


def _second_review_md(rels, conv, vs):
    """LITERATURE.md section for the second independent review (plain style)."""
    ap = conv["m10_aperture"]
    rec = ap.get("reconstruction") or {}
    rz = conv["r50_r_over_z"]
    bs = rz.get("by_size") or {}
    srs = {r["id"]: r["verification"]["second_review"] for r in rels}
    n2 = {k: sum(v["result"] == k for v in srs.values()) for k in ("verified", "corrected", "removed")}
    nc = {k: sum(combined_result(r) == k for r in rels) for k in ("verified", "corrected", "removed")}
    steep = ("K03", "K01")
    mx = max(v["third_implementation_max_dy"] for k, v in srs.items() if k not in steep)
    mxs = max(srs[k]["third_implementation_max_dy"] for k in steep)
    first_fixed = [r["id"] for r in rels if r["verification"]["review"]["result"] == "corrected"]
    count = lambda n: "none is" if n == 0 else ("1 is" if n == 1 else f"{n} are")
    L = ["## Independent verification, second review", "",
         f"On {REVIEW_DATE} a second verifier checked all {len(rels)} relations again against the primary sources and tried "
         "to refute each number. The second verifier did not use the excerpts that the first two agents stored.", "",
         "How it was done:", "",
         "- All 26 arXiv sources were downloaded again with curl into a separate directory. All 26 files are byte for byte "
         "the same as the cache.",
         "- The erratum of Shen et al. (2007) was read again on OpenAlex, and its record was checked on Crossref "
         "(MNRAS 379, 400).",
         "- Each number and each definition was read again in the LaTeX.",
         "- Every curve was evaluated again with a third implementation that shares no code with the script. "
         f"The largest difference is {mx:.1e} dex. On the steep parts of the K03 and K01 hyperbolas the difference reaches "
         f"{mxs:.1e} dex, which comes from the rounding of x to 1e-4.",
         "- S03 Fig. 11, RP15 Fig. 4 and K03b Fig. 13 were rendered from the source files and compared with the formulas.",
         "- Each relation now carries `verification.second_review` with the result and a checksum (`digest`) of what the "
         "site draws. If a curve changes after this review, `current` is set to false and a warning is printed during the "
         "build.", "",
         f"In this review {n2['verified']} relations are verified, {count(n2['corrected'])} corrected and "
         f"{count(n2['removed'])} removed. The first review corrected {' and '.join(first_fixed)}, and this review "
         f"confirms {'both corrections' if len(first_fixed) == 2 else 'its corrections'}. Counting both reviews, "
         f"{nc['verified']} relations are verified, {count(nc['corrected'])} corrected and {count(nc['removed'])} removed. "
         "No curve changed in this review.", "",
         "### Correction in this review", ""]
    for rid, txt in second_review_corrections().items():
        why = ""
        if rid == "RP15":
            why = (f"A change from Chabrier to Kroupa moves each galaxy by {sg(DEX_C2K_MASS)} dex in mass and by "
                   f"{sg(DEX_C2K_SFR)} dex in SFR. Along a line of slope 0.76 the two shifts nearly cancel, so the line moves "
                   f"by {sg(DEX_C2K_SFR - 0.76 * DEX_C2K_MASS)} dex. ")
        L.append(f"- {rid}. {why}{txt}" + (" RP15s now carries the same note." if rid == "RP15" else ""))
    L += ["", "### New evidence and caveats", ""]
    if rec:
        raw, res, m10 = rec["raw"], rec["rescaled"], rec["m10"]
        pct = lambda v: f"{100 * v:.1f}"
        rng = lambda r_, k: sorted([r_[f"{k}_sn2"], r_[f"{k}_sn3"]])
        L.append("- M10 sample. M10 (sec. 2.1) give counts for their sample. Of 927,552 DR7 galaxies, 47 percent (about "
                 f"{round(m10['n_el'], -3):,}) are emission line galaxies at 0.07 < z < 0.30. Of these, "
                 f"{100 * m10['pass_sn25']:.0f} percent pass S/N(Hα) > 25, and {100 * m10['agn']:.0f} percent of the sample "
                 "are AGN. We took galaxies with S/N(Hα) above "
                 "2 or above 3 as emission line galaxies. With the catalogue errors as given, our parent sample has "
                 f"{rng(raw, 'n_el')[0]:,} to {rng(raw, 'n_el')[1]:,} such galaxies. Of these, {pct(rng(raw, 'pass_el')[0])} to "
                 f"{pct(rng(raw, 'pass_el')[1])} percent pass the cut, and {pct(raw['agn'])} percent of those are AGN. With the "
                 f"errors rescaled by {ap['ha_err_scale']}, only {pct(rng(res, 'pass_el')[0])} to {pct(rng(res, 'pass_el')[1])} "
                 f"percent pass, and {pct(res['agn'])} percent are AGN. So M10 cut on the catalogue errors, which supports the "
                 f"correction of the first review. One number points the other way. M10 give log M_tot − log M_fib = "
                 f"{m10['mtot_mfib']:.2f} ± 0.15, and our raw and rescaled selections give {raw['mtot_mfib_median']:.3f} and "
                 f"{res['mtot_mfib_median']:.3f}. That difference is small compared with the spread of 0.15.")
        k98 = rec.get("k98_fibre_minus_mpa_fibre") or {}
        if k98:
            vals = sorted(-v for v in k98.values())
            lo, hi = vals[0], vals[-1]
            L.append("- M10 fibre SFRs. M10 computed their own fibre SFRs from Hα with the Kennicutt (1998) formula. We rebuilt "
                     "such SFRs from the catalogue fibre fluxes, with a Balmer decrement correction and the Cardelli et al. (1989) "
                     f"law. They lie {lo:.2f} to {hi:.2f} dex below the MPA-JHU fibre SFRs moved to Chabrier. The value depends on "
                     "the factor that moves the Kennicutt (1998) SFRs from Salpeter to Chabrier (1/0.63, 1.7 or 1.8), and M10 do "
                     "not give it. We assume that the two fibre SFRs agree. If they do not, the μ0.32 shift of M10 is "
                     f"too small by {0.32 * lo:.2f} to {0.32 * hi:.2f} dex. That is small compared with the other uncertainties "
                     "of the M10 curve, so we did not change it.")
    if bs:
        big = [bs[k] for k in bs if float(k.split("-")[0]) >= 3.0]
        big_lo = min(min(b["late"], b["early"]) for b in big)
        big_hi = max(max(b["late"], b["early"]) for b in big)
        first = bs[next(iter(bs))]
        L.append("- S03 and the r/z ratio. The median log(R50,r/R50,z) grows with angular size. For late types it is "
                 f"{sg(first['late'], 3)} below 1.5 arcsec and {sg(bs[list(bs)[-1]]['late'], 3)} above 5 arcsec, because "
                 f"seeing blurs small galaxies in both bands. We use the median over all sizes, {sg(rz['late'], 3)} "
                 f"for late types and {sg(rz['early'], 3)} for early types. This is the right value for K03S, whose radii are "
                 "Petrosian radii. For the Sérsic radii of S03, which are corrected for seeing, the ratio of large galaxies "
                 f"({sg(big_lo, 2)} to {sg(big_hi, 2)} above 3 arcsec) may apply instead. That would raise both S03 curves by "
                 "about 0.02 dex. This is inside the stated uncertainty of the S03 conversion, so we did not change it.")
    L.append("- S03E at low mass. The lowest early type point in S03 Fig. 11 (10^10.1 M☉, about 1.7 kpc) lies about 0.12 dex "
             "above their own power law (1.3 kpc). So most of the offset between our C ≥ 2.86 galaxies and S03E below about "
             "10^10.5 M☉ is already present in the S03 data.")
    pm = vs.get("petro_minus_model") if vs else None
    if pm:
        L.append("- Mass definitions. S03 and K03 multiplied the Petrosian z band luminosity by a model mass to light ratio. "
                 "Our MPA-JHU DR7 masses come from fits to the total (model) magnitudes. For C ≥ 2.86 galaxies in our sample, "
                 f"the median of petroMag_r − modelMag_r is {sg(pm['early'], 3)} mag, which is {0.4 * pm['early']:.3f} dex in "
                 f"luminosity. For C < 2.86 it is {sg(pm['late'], 3)} mag ({0.4 * pm['late']:.3f} dex). The MPA-JHU comparison "
                 "of the two mass methods (mass_comp.html on the MPA-JHU DR7 site) gives a median offset of −0.01 dex, with "
                 "larger offsets at low mass. So S03E and K03S would move by about 0.03 dex at most because of the mass "
                 "definition. That is less than the 0.1 dex given in the first build.")
    kf = vs.get("k03_frac50") if vs else None
    if kf and "10-11" in kf and "9-10" in kf:
        L.append("- K03S. On our axis, the fraction of galaxies with Dn4000 > 1.55 reaches 50 percent at log Σ★ = "
                 f"{kf['10-11']:.2f} for 10 < log M★ < 11 and at {kf['9-10']:.2f} for 9 < log M★ < 10. In K03b Fig. 13 it "
                 f"reaches 50 percent at log μ★ ≈ 8.55 to 8.6, which is {8.55 - 2 * rz['all']:.2f} to {8.60 - 2 * rz['all']:.2f} "
                 f"on our axis. The K03S line at {vs['k03_line']:.2f} is the value that K03b quote in their text (3 × 10⁸ M☉ "
                 "kpc⁻²). In both figures that value lies in the lower part of the transition.")
    L += ["", "The sixth row of `pipeline/cache/literature_verify.png` shows the M10 sample test, the r/z ratio by angular "
          "size and the K03S transition.", "",
          "### Per relation, second review", "",
          "| id | result | what was checked again | third implementation max abs dy | current |", "|---|---|---|---|---|"]
    for r in rels:
        s = srs[r["id"]]
        L.append(f"| {r['id']} | {s['result']} | {s['checked']} | {s['third_implementation_max_dy']:.1e} | "
                 f"{'yes' if s['current'] else 'no'} |")
    L.append("")
    return L


def write_markdown(rels, conv, conv_rows, stats, vs=None):
    vs = vs or {}
    L = []
    ap = conv["m10_aperture"]
    rz = conv["r50_r_over_z"]
    L += ["# Literature relations", "",
          "This file lists the literature scaling relations that the site draws. "
          "The script `pipeline/literature.py` writes this file and `site/data/literature.json`. "
          f"It was last built on {BUILT}.", "",
          "## How the numbers were checked", "",
          "We downloaded the arXiv LaTeX source of every paper (`python3 pipeline/literature.py --fetch` "
          "puts them in `pipeline/cache/literature_src/`). For each relation, the script keeps short excerpts "
          "copied from the source, e.g. the table row that holds the coefficients. Every build searches for each "
          "excerpt in the cached source, after removing LaTeX comments and collapsing white space. A relation is "
          "marked `verified` only if all of its excerpts are found. The script also parses the two tables it uses "
          "(T04 Table 3 and C18 Table 1) and stops if they differ from the copies in the code.", "",
          "Two independent verifiers then checked every relation against the primary sources. Their results are in the "
          "verification column of the summary table and in the two sections on independent verification.", "",
          "One number is not in the arXiv source. The early type size coefficient b of Shen et al. (2003) is "
          "wrong in their Table 1, and their 2007 erratum gives the correct value. The publisher page of the "
          "erratum is behind a bot check, so we read the erratum text from its OpenAlex record, which the script "
          "caches and checks in the same way.", "",
          "## Our data conventions", "",
          "Literature values are converted to these conventions (DESIGN.md section 9).", "",
          "- Stellar masses and SFRs use the Kroupa IMF, as in MPA-JHU.",
          "- The cosmology is H0 = 70 and Ωm = 0.3.",
          "- R₅₀ is the Petrosian r band half-light radius in kpc.",
          "- σ is corrected to an aperture of R₅₀/8, and μ₅₀ is defined as in DESIGN.md section 6.",
          "- O/H is on the T04 scale (`OH`) or the PP04 O3N2 scale (`OH_PP04`).",
          "- Halo mass is the Lim et al. (2017) group mass M180m (180 times the mean density) in M☉ with h = 0.7.", "",
          "## Conversion numbers", "",
          f"- Chabrier to Kroupa stellar mass is {sg(conv['imf_mass_chab_to_kroupa'], 4)} dex, and Chabrier to Kroupa SFR is "
          f"{sg(conv['imf_sfr_chab_to_kroupa'], 4)} dex. Madau & Dickinson (2014) divide masses by 0.61 (Chabrier) and "
          "0.66 (Kroupa) to get Salpeter masses, and they divide SFRs by 0.63 and 0.67.",
          f"- M10 divided the MPA-JHU masses by 1.06, which is {conv['m10_mass_factor_dex']:.4f} dex.",
          f"- M10 used SFRs inside the fibre. For MPA-JHU galaxies selected as in M10 (BPT classes 1 and 2, "
          f"0.07 < z < 0.30, Hα S/N > 25 after the ×{ap['ha_err_scale']} error rescaling, N = {ap['n']:,}), the median "
          f"log SFR(total) − log SFR(fibre) is {ap['median']:.3f} dex, with 16th and 84th percentiles of {ap['p16']} "
          f"and {ap['p84']}. It depends on mass. " + " ".join(f"It is {sg(v)} dex for log M★ = {k.replace('-', ' to ')}." for k, v in ap["by_mass"].items()),
          f"- For the r band versus z band size, we took {rz['n']:,} SDSS DR17 Main Galaxy Sample galaxies from one "
          f"SkyServer query (`R50_SQL` in the script). The median log(petroR50_r/petroR50_z) is {sg(rz['late'], 4)} for "
          f"C < 2.86 (N = {rz['n_late']:,}), {sg(rz['early'], 4)} for C ≥ 2.86 (N = {rz['n_early']:,}), and {sg(rz['all'], 4)} "
          "for all galaxies. The ratio grows with angular size because seeing blurs small galaxies.",
          f"- For a Sérsic profile without seeing, the SDSS Petrosian R₅₀ divided by the true half-light radius is "
          f"{conv['petro_r50_over_re']['1']:.3f} for n = 1 and {conv['petro_r50_over_re']['4']:.3f} for n = 4, and the "
          f"Petrosian flux fraction is {conv['petro_flux_fraction']['1']:.3f} and {conv['petro_flux_fraction']['4']:.3f}. "
          "S03 quote about 70 percent and about 80 percent for n = 4. Real SDSS radii are blurred by seeing, which the "
          "Blanton et al. (2003) Sérsic radii used by S03 correct and the Petrosian radii do not. So we do not use the "
          "profile values for S03. Instead we compare the S03 size-luminosity fits for Petrosian radii (Table 1 row "
          "Figure 4) and for Sérsic radii (row Figure 6) at the same galaxy. This gives log(R_Petrosian/R_Sérsic) of "
          + ", ".join(f"{sg(v)} at 10^{k}" for k, v in conv["s03_petro_minus_sersic"]["late"].items()) +
          " for late types and " + ", ".join(f"{sg(v)} at 10^{k}" for k, v in conv["s03_petro_minus_sersic"]["early"].items()) +
          " for early types.",
          f"- The age of the universe at z = {Z_REF} for h = 0.7 and Ωm = 0.3 is {conv['age_z0p1_gyr_S14']:.3f} Gyr (used for S14).",
          "- Halo masses are converted to M180m for NFW haloes with the Duffy et al. (2008) concentrations "
          "(NFW, full sample, z = 0 to 2). The virial overdensity is from Bryan & Norman (1998). "
          "log M180m − log M200c for Mo13 is " + ", ".join(f"{sg(v)} at 10^{k}" for k, v in conv["halo_m180m_minus_m200c_Mo13"].items()) +
          ". log M180m − log Mvir for B13 is " + ", ".join(f"{sg(v)} at 10^{k}" for k, v in conv["halo_m180m_minus_mvir_B13"].items()) +
          f". Using Ωm = 0.30 instead of 0.27 changes the B13 value at 10^12 by {sg(conv['halo_om_sensitivity_B13_at_12'])} dex.", ""]
    # summary table
    L += ["## Summary", "",
          "The status column is the automatic excerpt check. The verification column combines the two independent reviews "
          f"of {REVIEW_DATE}. A relation is marked corrected if either review corrected it, and removed if a review removed "
          "it. Otherwise it is marked verified. The details are in the two sections on independent verification below.", "",
          "| id | view | x | y | kind | source | IMF | conversions | status | verification |",
          "|---|---|---|---|---|---|---|---|---|---|"]
    for r in rels:
        m = r["_meta"]
        L.append(f"| {r['id']} | {r['view']} | `{_md_combo(r['x'])}` | `{_md_combo(r['y'])}` | {r['kind']}"
                 f"{' (fitOffset)' if r['fitOffset'] else ''} | [arXiv:{m['arxiv']}](https://arxiv.org/abs/{m['arxiv']}) {m['where']} "
                 f"| {m['imf']} | {CONV_SHORT.get(r['id'], '')} | {r['verification']['status']} "
                 f"| {combined_result(r)} |")
    L.append("")
    # independent verification
    corr = review_corrections(conv)
    res_count = {k: sum(r["verification"]["review"]["result"] == k for r in rels) for k in ("verified", "corrected", "removed")}
    max_dy = max(r["verification"]["review"]["second_implementation_max_dy"] for r in rels)
    rz = conv["r50_r_over_z"]
    L += ["## Independent verification, first review", "",
          f"On {REVIEW_DATE} a second agent, the literature verifier, re-derived every relation from its primary source and "
          "tried to refute each number. It fetched the arXiv sources again with a separate client; all 26 are byte for byte "
          "the same as the cache. It then read each coefficient, sign, log base, unit, IMF, cosmology and variable definition "
          "again in the LaTeX, not in the stored excerpts. It rendered two figures from the source files. S03 Fig. 11 confirms "
          "the erratum value of b without relying on the erratum text, and the ridge in RP15 Fig. 4 follows the RP15 formula.", "",
          "Every build now also checks each curve in `literature.json` against a second implementation of the formulas and "
          "conversions (`independent_check` in the script). It has its own NFW halo mass conversion and its own inversion of "
          f"the S03 size relations. The largest difference is {max_dy:.1e} dex, which comes from the rounding of the stored "
          "points on the steep part of the BPT curves.", "",
          "The conversion inputs were measured again. The r/z Petrosian radius ratio from an independent SkyServer sample "
          "(8,000 galaxies, objID mod 31 = 17) is +0.0297 (C < 2.86), +0.0241 (C ≥ 2.86) and +0.0277 (all), against "
          f"{sg(rz['late'], 4)}, {sg(rz['early'], 4)} and {sg(rz['all'], 4)} from the cached sample. The M10 aperture offset "
          "was measured again from the MPA-JHU catalogue and corrected (below).", "",
          f"Result: {res_count['verified']} relations verified, {res_count['corrected']} corrected, {res_count['removed']} removed.", "",
          "### Corrections", ""]
    for rid, txt in corr.items():
        L.append(f"- {rid}: {txt}")
    L += ["", "### Checks against the data", "",
          "The figure `pipeline/cache/literature_verify.png` shows every preset view with the curves exactly as drawn, "
          "with fitOffset applied.", ""]
    if vs:
        rr, cen = vs.get("ridge", {}), vs.get("ridge", {}).get("centers", [])

        def ridge_at(key, m):
            if key in rr and m in cen:
                v = rr[key][cen.index(m)]
                return v - (0.76 * m - 7.64)
            return float("nan")
        L.append(f"- RP15: in the most complete slice (0.01 < z < 0.03), the star forming ridge (the mode of log SFR at fixed "
                 f"mass) of our data lies {sg(ridge_at('0.01-0.03', 9.25), 2)} and {sg(ridge_at('0.01-0.03', 9.75), 2)} dex from "
                 f"RP15 at log M★ = 9.25 and 9.75. Over RP15's own range, 0.02 < z < 0.085 without their V/Vmax weights, it "
                 f"lies {sg(ridge_at('0.02-0.085', 9.25), 2)} dex off at 9.25, because the flux limit keeps only the brighter "
                 f"galaxies at low mass. At log M★ = 10.75 it lies {sg(ridge_at('0.02-0.085', 10.75), 2)} dex off.")
        rs = vs.get("resid", {})
        fmt = lambda k: sg(rs[k][0], 3) if k in rs and rs[k][0] is not None else "n/a"
        L.append(f"- S03E: the median of (data − curve) is {fmt('S03E (GZ1 E)')} dex for Galaxy Zoo ellipticals and "
                 f"{fmt('S03E')} dex for C ≥ 2.86, so the low mass end depends on the early type definition. S03L: {fmt('S03L')} "
                 "dex for C < 2.86.")
        if "k03_d4000_155" in vs:
            L.append(f"- K03S: the median Dn4000 of our data reaches 1.55, the divider of K03b Fig. 13, at log Σ★ = "
                     f"{vs['k03_d4000_155']:.2f}. That is {sg(vs['k03_d4000_155'] - vs['k03_line'], 2)} dex above the K03S line "
                     f"at {vs['k03_line']:.2f}. K03b quote the transition as '~3 × 10⁸', and our DR7 total masses are larger than "
                     "the Petrosian based masses of K03 for concentrated galaxies.")
        if "m10" in vs:
            fm = vs["m10"]
            L.append(f"- M10: after fitOffset ({sg(fm['new']['offset'], 2)} dex), the rms difference between M10 and the running "
                     f"median of our O3N2 data is {fm['new']['rms_vs_median']:.3f} dex with the corrected shift and "
                     f"{fm['old']['rms_vs_median']:.3f} dex with the first build's shift. The data do not decide between them, "
                     "because M10 uses a different O/H calibration. The correction rests on reproducing the M10 sample.")
        L.append(f"- B03: the median offset before fitOffset is {sg(vs.get('b03_offset', float('nan')), 3)} dex for Galaxy Zoo "
                 "ellipticals.")
        sh = vs.get("shmr_at", {})
        if sh:
            L.append("- SHMR, centrals: the median over the range is " + f"{fmt('Mo13')} dex for Mo13 and {fmt('B13')} dex for B13, "
                     "but that hides a shape difference. At log M_h = " + ", ".join(sh["Mo13"]) + " the data minus Mo13 is "
                     + ", ".join(f"{sg(v, 2)}" for v in sh["Mo13"].values()) + " dex, and minus B13 "
                     + ", ".join(f"{sg(v, 2)}" for v in sh["B13"].values()) + " dex. Lim+17 assign single-member halo masses "
                     "from a stellar mass proxy, so the data relation is steep at low M_h.")
        L.append(f"- H I: C18 {fmt('C18')} dex (xGASS includes non-detections, ours are ALFALFA detections) and "
                 f"H12 {fmt('H12')} dex.")
        L.append(f"- MZR: T04 {fmt('T04')}, KE08 {fmt('KE08')}, AM13 {fmt('AM13')} and C20 {fmt('C20')} dex.")
    L += ["", "### Per relation, first review", "", "| id | verification | what was checked in the source | second implementation max abs dy |",
          "|---|---|---|---|"]
    for r in rels:
        rv = r["verification"]["review"]
        L.append(f"| {r['id']} | {rv['result']} | {rv['checked']} | {rv['second_implementation_max_dy']:.1e} |")
    L.append("")
    L += _second_review_md(rels, conv, vs)
    # per relation
    L += ["## Relations", ""]
    for r in rels:
        m = r["_meta"]
        L += [f"### {r['id']}: {r['name']}", "",
              f"- Citation: [{r['cite']}]({r['url']}), [arXiv:{m['arxiv']}](https://arxiv.org/abs/{m['arxiv']}).",
              f"- Where: {m['where']}. Validity: {m['validity']}. Drawn over native x = {r['range'][0]} to {r['range'][1]}.",
              f"- Native axes: x = `{_md_combo(r['x'])}`, y = `{_md_combo(r['y'])}`. Kind: {r['kind']}. fitOffset: {str(r['fitOffset']).lower()}.",
              f"- IMF: {m['imf']}. Cosmology: {m['cosmo']}. Band, aperture and calibration: {m['calib']}.",
              f"- Conversions: {r['conversions']}",
              f"- Notes: {r['notes']}",
              f"- Verification ({r['verification']['review']['date']}): {r['verification']['review']['result']}. "
              f"{r['verification']['review']['checked']}"
              + (f" Correction: {r['verification']['review']['correction']}" if "correction" in r["verification"]["review"] else ""),
              f"- Second review ({r['verification']['second_review']['date']}): {r['verification']['second_review']['result']}. "
              f"{r['verification']['second_review']['checked']}"
              + (f" Correction: {r['verification']['second_review']['correction']}" if "correction" in r["verification"]["second_review"] else "")]
        if r["id"] in stats and stats[r["id"]]["median_resid"] is not None:
            s = stats[r["id"]]
            L.append(f"- Check against our data: the median of (data − curve) inside the range is {sg(s['median_resid'])} dex "
                     f"(N = {s['n']:,}{', galaxies of the matching concentration class' if r['id'] in ('S03L', 'S03E') else ''}).")
        L += ["", "Excerpts from the source (status per excerpt):", "", "```text"]
        for key, fname, text, found in m["excerpt_rows"]:
            L.append(f"[{'found' if found else 'NOT FOUND' if found is False else 'no source'}] {key}/{fname}: {text}")
        L += ["```", ""]
    # conventions
    L += ["## Sources used for the conventions", "", "```text"]
    for key, fname, text, found in conv_rows:
        L.append(f"[{'found' if found else 'NOT FOUND' if found is False else 'no source'}] {key}/{fname}: {text}")
    L += ["```", ""]
    fp_cos, fp_deg = _fp_alignment()
    m10_shift = conv["m10_mass_factor_dex"] - 0.32 * conv["imf_sfr_chab_to_kroupa"] - 0.32 * ap["median"]
    inv_map = ap.get("inv_map") or {"?": m10_shift}
    m10_dev = max(abs(v - m10_shift) for v in inv_map.values())
    m10_rng = (min(inv_map, key=float), max(inv_map, key=float)) if "?" not in inv_map else ("?", "?")
    k98 = (ap.get("reconstruction") or {}).get("k98_fibre_minus_mpa_fibre") or {"-": -0.06}
    k98_lo, k98_hi = sorted(-v for v in k98.values())[0], sorted(-v for v in k98.values())[-1]
    d_am = (float(_t04(9.0) - _am13(9.0)), float(_t04(11.0) - _am13(11.0)))
    d_c20 = (float(_t04(9.0) - _c20(9.0, conv)), float(_t04(11.0) - _c20(11.0, conv)))
    L += ["## Choices and recommendations", "",
          "- MZR axes. T04 is drawn on `OH` because MPA-JHU `OH_P50` uses the T04 method. AM13 and C20 are drawn on "
          "`OH_PP04`. Their O/H scales rest on electron temperature (direct) abundances, and PP04 O3N2 is an empirical "
          f"calibration against H II regions with mostly direct abundances. On the T04 axis, AM13 would sit {d_am[0]:.2f} dex "
          f"(at 10^9) to {d_am[1]:.2f} dex (at 10^11) below T04, and C20 {d_c20[0]:.2f} to {d_c20[1]:.2f} dex below. That gap "
          "comes from the calibration, not from the galaxies. On `OH_PP04`, both lie within 0.03 dex of our data median "
          "(see the checks above). KE08 gives the MZR for PP04 O3N2 itself, so it is also drawn on `OH_PP04`.",
          "- The MZR on the O3N2 scale has its own preset, `mzr2` (code `MZRᴾ`, x = `{logM:1}`, y = `{OH_PP04:1}`, "
          "color `logSFR`, literature `KE08, AM13, C20`), added by the core agent on this recommendation. The `mzr` preset "
          "lists `T04` only. KE08, AM13 and C20 carry view `mzr2`, the preset they belong to.",
          "- FMR. M10 goes on `OH_PP04` (the FMR preset y) with fitOffset true. M10 used the Maiolino et al. (2008) "
          "calibrations, whose zero point and range differ from PP04 O3N2. The x conversion (IMF and fibre SFR) is "
          "applied to the curve. The fibre to total SFR offset comes from an M10-like sample cut on the raw Hα errors, "
          "which reproduces the size of the M10 sample.",
          "- Presets. The literature lists in `site/js/config/presets.js` (read on 2026-09-24) name only ids that exist, "
          "and each relation's native axes match its preset's axes, so every listed relation is drawn at full opacity in "
          "its preset.",
          "- FP. The verified B03 r band coefficients are a = 1.49 and b = −0.75 in log I, so b′ = −0.4 b = 0.30 in μ. "
          "The preset combo `{logSigV:1.49, mu50:0.30}` is correct as it is. Hyde & Bernardi (2009) find a = 1.434 and "
          f"b = 0.315 for the r band orthogonal fit. In our standardized units the two x axes differ by {fp_deg:.1f} degrees "
          f"(alignment {fp_cos:.4f}), so the two curves would draw almost on top of each other. We draw only B03.",
          "- The sSFR = 10⁻¹¹ yr⁻¹ threshold of W12 has one entry per view, because each entry has its own native axes. "
          "The ids are `Q11` (sfms), `Q11s` (ssfr), `Q11e` (env) and `Q11d` (sigma). `Q11d` and `RP15s` are additions "
          "to the preset table.",
          "- H I. C18 describes the representative xGASS sample with non-detections. H12 describes ALFALFA detections, "
          "which is how our H I data were selected. We suggest both for the `hi` preset.", "",
          "## Known limits", "",
          "- T04, KE08, S03 and K03 used the Kauffmann et al. (2003) masses from DR2 and DR4. In those masses a model mass to "
          "light ratio is multiplied by the Petrosian z band luminosity. Our MPA-JHU DR7 masses come from fits to the total "
          "magnitudes. The MPA-JHU comparison of the two methods gives a median offset of −0.01 dex, with larger offsets at "
          "low mass. For concentrated galaxies (C ≥ 2.86) the Petrosian magnitude misses "
          + (f"{0.4 * vs['petro_minus_model']['early']:.2f} dex" if vs.get("petro_minus_model") else "a few hundredths of a dex")
          + " of the total light. We apply no correction for this.",
          "- The Sérsic to Petrosian size factor for S03 comes from two median relations of slightly different samples "
          "(early types are c > 2.86 in one and n > 2.5 in the other). A de Vaucouleurs profile without seeing would put "
          "the early type curve about 0.1 dex lower, so the early type curve is uncertain by about that much.",
          "- The r/z radius ratio used for S03 is the median over all angular sizes. For the Sérsic radii of S03, which are "
          "corrected for seeing, the ratio of large galaxies may apply instead. That would raise both S03 curves by about "
          "0.02 dex (see the second review).",
          "- M10 computed their fibre SFRs from Hα with the Kennicutt (1998) formula, and we use the MPA-JHU fibre "
          f"SFRs in their place. SFRs rebuilt in the M10 way lie {k98_lo:.2f} to {k98_hi:.2f} dex lower, so the M10 curve may "
          f"need to move a further {0.32 * k98_lo:.2f} to {0.32 * k98_hi:.2f} dex to lower μ0.32 (see the second review).",
          f"- The fibre SFR correction for M10 is one median value ({ap['median']:.3f} dex). In bins of our μ0.32, the median "
          f"of μ_tot − μ_M10 for the M10-like sample stays within {m10_dev:.3f} dex of the constant shift over μ0.32 = "
          f"{m10_rng[0]} to {m10_rng[1]}, so a constant is adequate there. M10's O/H calibration (Maiolino et al. 2008) "
          f"also has a different dynamic range from PP04 O3N2, so after fitOffset only the zero point is matched and the "
          f"shape is a guide.",
          "- The SHMR conversions change only the halo mass definition. The halo mass function and cosmology behind "
          "each abundance matching also differ, by a few hundredths of a dex. Lim et al. (2017) halo masses come from "
          "abundance matching of group proxies, so part of the SHMR is built into the data.",
          "- S14 at z = 0.1 extends their fit beyond the redshifts they fit (z ≈ 0.25 to 2.75).",
          "- B13 relate the true stellar mass to halo mass. Their nuisance offset between measured and true masses, "
          "μ(z = 0.1) = −0.027 dex, is not applied, because our MPA-JHU masses are not on their calibration.", ""]
    OUT_MD.write_text("\n".join(L))
    print(f"wrote {OUT_MD.relative_to(ROOT)}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fetch", action="store_true", help="download sources (arXiv, OpenAlex erratum, SkyServer sample)")
    ap.add_argument("--no-plot", action="store_true", help="skip the check plot")
    ap.add_argument("keys", nargs="*", help="with --fetch: only these source keys")
    a = ap.parse_args()
    if a.fetch:
        fetch_sources(a.keys or None)
        if not a.keys or "S03err" in a.keys:
            if not S03_ERRATUM_JSON.exists():
                fetch_s03_erratum()
        if not a.keys or "R50" in a.keys:
            if not R50_SAMPLE_CSV.exists():
                fetch_r50_sample()
        return
    rels, conv, conv_rows = build()
    stats = {} if a.no_plot else check_plot(rels)
    vstats = {} if a.no_plot else verify_plot(rels, conv)
    write_markdown(rels, conv, conv_rows, stats, vstats)


if __name__ == "__main__":
    main()
