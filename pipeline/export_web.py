"""Write the web data contract (DESIGN.md section 5) from pipeline/cache/catalog.parquet.

  site/data/manifest.json
  site/data/dims/<key>.u16.gz     u16-shuffle-gzip (section 5.3), 0 = missing
  site/data/cats/<key>.u8.gz      uint8 codes, gzip, 0 = missing
  site/data/meta/{ra,dec}.f32.gz  float32 degrees (DR17 photometric position)
  site/data/meta/{plate,mjd,fiber}.u16.gz   uint16 (mjd stored minus 50000)
  pipeline/cache/galaxies.parquet every catalog column, in EXPORT ROW ORDER, plus 'row'

Rows are a random permutation (numpy default_rng(20260924).permutation), so any prefix is a
uniform random subsample. If the gzipped dims exceed the section-16 budget the export keeps
all H I detections plus a random subsample of the rest, and says so.

Usage:
  python3 pipeline/export_web.py            # export
  python3 pipeline/export_web.py verify     # independent round-trip check of site/data
  python3 pipeline/export_web.py quicklook  # pipeline/cache/quicklook.png
  python3 pipeline/export_web.py all        # all three
"""

from __future__ import annotations

import gzip
import hashlib
import json
import sys
import time
import zlib
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config as C  # noqa: E402

QMAX = 65534


def log(msg: str) -> None:
    print(msg, flush=True)


def sig(x: float, digits: int = 6) -> float:
    return float(f"{x:.{digits}g}")


def gz(data: bytes, filtered: bool = False) -> bytes:
    """gzip level 9, byte-stable (mtime 0). For the byte-shuffled dims, memLevel 9 with the
    Z_FILTERED strategy is ~1% smaller than gzip's default and still a plain gzip stream."""
    if not filtered:
        return gzip.compress(data, compresslevel=9, mtime=0)
    c = zlib.compressobj(level=9, method=zlib.DEFLATED, wbits=31, memLevel=9,
                         strategy=zlib.Z_FILTERED)
    return c.compress(data) + c.flush()


# ---------------------------------------------------------------------------------------
# encoding
# ---------------------------------------------------------------------------------------
def quantize(x: np.ndarray, lo: float, hi: float) -> np.ndarray:
    x = np.asarray(x, dtype=np.float64)
    ok = np.isfinite(x) & (x >= lo) & (x <= hi)
    v = np.zeros(len(x), dtype=np.uint16)
    q = 1.0 + np.rint((x[ok] - lo) / (hi - lo) * QMAX)
    v[ok] = np.clip(q, 1, 65535).astype(np.uint16)
    return v


def shuffle_u16(v: np.ndarray) -> bytes:
    v = v.astype("<u2", copy=False)
    return (v & 0xFF).astype(np.uint8).tobytes() + (v >> 8).astype(np.uint8).tobytes()


def dim_stats(x: np.ndarray) -> dict:
    v = x[np.isfinite(x)]
    center = float(np.median(v))
    mad = float(np.median(np.abs(v - center)))
    scale = 1.4826 * mad
    fallback = False
    if not np.isfinite(scale) or scale < 1e-9 * max(1.0, abs(center)):
        scale, fallback = float(np.std(v)), True
    qs = np.quantile(v, np.linspace(0.0, 1.0, 101))
    return {"center": sig(center), "scale": sig(scale), "nvalid": int(v.size),
            "quantiles": [sig(q) for q in qs], "_scale_fallback_std": fallback}


def encode_dim(x: np.ndarray, d: dict) -> bytes:
    return gz(shuffle_u16(quantize(x, d["min"], d["max"])), filtered=True)


def choose_rows(cat: pd.DataFrame, stats: dict) -> np.ndarray:
    """Section 16: all rows if the dims fit the budget, else keep all H I detections plus a
    random subsample of the rest sized to fit. Sizes are measured in export (permuted) order,
    which compresses slightly worse than the parent order."""
    perm = np.random.default_rng(C.SEED).permutation(len(cat))
    total = sum(len(encode_dim(cat[d["key"]].to_numpy(float)[perm], d)) for d in C.DIMS) / 1e6
    stats["dims_gz_mb_full_sample"] = round(total, 3)
    log(f"  dims gz for the full sample ({len(cat):,} rows): {total:.2f} MB "
        f"(budget ~{C.DIMS_GZ_BUDGET_MB} MB, subsample above "
        f"{C.DIMS_GZ_BUDGET_MB * C.DIMS_GZ_TOLERANCE:.1f} MB)")
    if total <= C.DIMS_GZ_BUDGET_MB * C.DIMS_GZ_TOLERANCE:
        stats["subsample"] = None
        return np.arange(len(cat))
    rng = np.random.default_rng(C.SEED + 1)
    hi = np.isfinite(cat["logfHI"].to_numpy(float))
    frac = C.DIMS_GZ_BUDGET_MB / total * 0.98
    rest = np.flatnonzero(~hi)
    n_rest = int(round(frac * len(cat))) - int(hi.sum())
    keep = np.sort(np.concatenate([np.flatnonzero(hi), rng.choice(rest, n_rest, replace=False)]))
    stats["subsample"] = {"reason": f"dims gz {total:.1f} MB > {C.DIMS_GZ_BUDGET_MB} MB",
                          "kept": int(len(keep)), "of": int(len(cat)),
                          "hi_detections_kept": int(hi.sum())}
    log(f"  SUBSAMPLING to {len(keep):,} rows (all {hi.sum():,} H I detections kept)")
    return keep


def export() -> None:
    t0 = time.time()
    cat = pd.read_parquet(C.CATALOG_PARQUET)
    build_stats = json.loads(C.BUILD_STATS.read_text())
    stats: dict = {}
    log(f"catalog: {len(cat):,} rows")
    rows = choose_rows(cat, stats)
    cat = cat.iloc[rows].reset_index(drop=True)
    perm = np.random.default_rng(C.SEED).permutation(len(cat))
    cat = cat.iloc[perm].reset_index(drop=True)
    cat.insert(0, "row", np.arange(len(cat), dtype=np.int64))
    n = len(cat)

    out = C.SITE_DATA
    for sub in ("dims", "cats", "meta"):
        (out / sub).mkdir(parents=True, exist_ok=True)
    sizes: dict[str, int] = {}

    def write(rel: str, data: bytes) -> None:
        (out / rel).write_bytes(data)
        sizes[rel] = len(data)

    # dims
    dim_specs = []
    for d in C.DIMS:
        x = cat[d["key"]].to_numpy(float)
        v = quantize(x, d["min"], d["max"])
        rel = f"dims/{d['key']}.u16.gz"
        write(rel, gz(shuffle_u16(v), filtered=True))
        valid = x[v > 0]
        st = dim_stats(valid)
        spec = {"key": d["key"], "label": d["label"], "short": d["short"], "unit": d["unit"],
                "group": d["group"], "file": rel, "min": d["min"], "max": d["max"],
                "center": st["center"], "scale": st["scale"], "nvalid": st["nvalid"],
                "quantiles": st["quantiles"], "desc": d["desc"], "source": d["source"]}
        if st["_scale_fallback_std"]:
            log(f"  {d['key']}: MAD ~ 0, scale = std")
        dim_specs.append(spec)

    # categories
    cat_specs = []
    for c in C.CATS:
        codes = cat[c["key"]].to_numpy().astype(np.uint8)
        rel = f"cats/{c['key']}.u8.gz"
        write(rel, gz(codes.tobytes()))
        counts = np.bincount(codes, minlength=8)
        cat_specs.append({
            "key": c["key"], "label": c["label"], "file": rel, "dtype": "u8", "missing": 0,
            "codes": [dict(cc, n=int(counts[cc["code"]])) for cc in c["codes"]],
            "nmissing": int(counts[0]), "desc": c["desc"], "source": c["source"]})

    # meta
    write("meta/ra.f32.gz", gz(cat["ra"].to_numpy().astype("<f4").tobytes()))
    write("meta/dec.f32.gz", gz(cat["dec"].to_numpy().astype("<f4").tobytes()))
    write("meta/plate.u16.gz", gz(cat["plate"].to_numpy().astype("<u2").tobytes()))
    mjd = cat["mjd"].to_numpy() - 50000
    assert mjd.min() >= 0 and mjd.max() < 65536
    write("meta/mjd.u16.gz", gz(mjd.astype("<u2").tobytes()))
    write("meta/fiber.u16.gz", gz(cat["fiber"].to_numpy().astype("<u2").tobytes()))

    # A thumbs block written later by thumbs.py indexes rows in this order. Keep it on a
    # re-export only when the row order is byte-for-byte the same objID sequence.
    order_hash = hashlib.sha1("\n".join(cat["objid"].astype(str)).encode()).hexdigest()
    thumbs = None
    old_manifest = out / "manifest.json"
    if old_manifest.exists():
        try:
            prev = json.loads(old_manifest.read_text(encoding="utf-8"))
            prev_hash = (json.loads(C.EXPORT_STATS.read_text()).get("order_hash")
                         if C.EXPORT_STATS.exists() else None)
            if prev.get("thumbs") and prev_hash == order_hash and prev.get("n") == n:
                thumbs = prev["thumbs"]
                log("  row order unchanged: keeping the existing thumbs block")
            elif prev.get("thumbs"):
                log("  WARNING: row order changed; thumbs block reset to null (rerun thumbs.py)")
        except (json.JSONDecodeError, OSError):
            pass

    manifest = {
        "schema": 1,
        "title": "SDSS DR7 Main Galaxy Sample",
        "n": int(n),
        "seed": C.SEED,
        "created": C.CREATED,
        "cosmology": {"H0": C.COSMO["H0"], "Om0": C.COSMO["Om0"]},
        "encoding": {"dims": "u16-shuffle-gzip", "missing": 0},
        "dims": dim_specs,
        "categories": cat_specs,
        "meta": {
            "ra": {"file": "meta/ra.f32.gz", "dtype": "f32"},
            "dec": {"file": "meta/dec.f32.gz", "dtype": "f32"},
            "plate": {"file": "meta/plate.u16.gz", "dtype": "u16"},
            "mjd": {"file": "meta/mjd.u16.gz", "dtype": "u16", "offset": 50000},
            "fiber": {"file": "meta/fiber.u16.gz", "dtype": "u16"},
        },
        "thumbs": thumbs,
        "sources": C.SOURCES,
        "sample": {
            "parent": "SDSS Main Galaxy Sample spectra in MPA-JHU DR8, unique by PHOTOID",
            "cuts": [f"{C.Z_MIN} ≤ z ≤ {C.Z_MAX}", f"log M★ > {C.LOGM_MIN}",
                     f"petroMag_r − extinction_r ≤ {C.R_PETRO_MAX} (DR17)"],
            "n_parent": build_stats["parent"],
            "subsample": stats["subsample"],
            "radec": "DR17 photometric position (PhotoObjAll via bestObjID)",
        },
        "caveats": C.CAVEATS,
    }
    mtxt = json.dumps(manifest, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    (out / "manifest.json").write_text(mtxt, encoding="utf-8")
    sizes["manifest.json"] = len(mtxt.encode("utf-8"))

    # galaxies.parquet in export order (thumbnails agent reads this)
    cat.to_parquet(C.GALAXIES_PARQUET, index=False)

    dims_mb = sum(v for k, v in sizes.items() if k.startswith("dims/")) / 1e6
    stats.update({"n": int(n), "order_hash": order_hash, "sizes": sizes,
                  "dims_gz_mb": round(dims_mb, 3),
                  "cats_gz_mb": round(sum(v for k, v in sizes.items() if k.startswith("cats/")) / 1e6, 3),
                  "meta_gz_mb": round(sum(v for k, v in sizes.items() if k.startswith("meta/")) / 1e6, 3),
                  "total_mb": round(sum(sizes.values()) / 1e6, 3),
                  "elapsed_s": round(time.time() - t0, 1)})
    C.EXPORT_STATS.write_text(json.dumps(stats, indent=1))
    log(f"wrote {out}: n={n:,}, dims {dims_mb:.2f} MB, total {stats['total_mb']:.2f} MB "
        f"in {stats['elapsed_s']}s")
    for k, v in sorted(sizes.items()):
        log(f"  {k:24s} {v / 1e6:8.3f} MB")


# ---------------------------------------------------------------------------------------
# verification: an independent decoder written from the section-5 text, numpy only
# ---------------------------------------------------------------------------------------
def _read(path: Path) -> bytes:
    b = path.read_bytes()
    return gzip.decompress(b) if b[:2] == b"\x1f\x8b" else b


def verify() -> bool:
    man = json.loads((C.SITE_DATA / "manifest.json").read_text(encoding="utf-8"))
    g = pd.read_parquet(C.GALAXIES_PARQUET)
    n = man["n"]
    ok = True
    report = []
    assert len(g) == n, (len(g), n)
    assert (g["row"].to_numpy() == np.arange(n)).all()
    assert man["encoding"] == {"dims": "u16-shuffle-gzip", "missing": 0}
    assert [d["key"] for d in man["dims"]] == C.DIM_KEYS
    for d in man["dims"]:
        s = np.frombuffer(_read(C.SITE_DATA / d["file"]), dtype=np.uint8)
        assert s.size == 2 * n, (d["key"], s.size)
        v = s[:n].astype(np.uint32) | (s[n:].astype(np.uint32) << 8)
        lo, hi = d["min"], d["max"]
        x = lo + (v.astype(np.float64) - 1.0) * (hi - lo) / 65534.0
        miss = v == 0
        ref = g[d["key"]].to_numpy(float)
        ref_miss = ~(np.isfinite(ref) & (ref >= lo) & (ref <= hi))
        step = (hi - lo) / 65534.0
        err = np.abs(x[~miss] - ref[~miss]) if (~miss).any() else np.array([0.0])
        good = (miss == ref_miss).all() and err.max() <= 0.5 * step * (1 + 1e-6) + 1e-12
        nvalid_ok = int((~miss).sum()) == d["nvalid"]
        vv = x[~miss]
        med_ok = abs(np.median(vv) - d["center"]) <= max(step, 1e-5 * abs(d["center"]) + 1e-6)
        q_ok = len(d["quantiles"]) == 101 and np.all(np.diff(d["quantiles"]) >= 0)
        good = good and nvalid_ok and q_ok and med_ok
        report.append(f"  dim {d['key']:9s} n_valid {int((~miss).sum()):>8,} max|err| "
                      f"{err.max():.3g} (step/2 {0.5 * step:.3g}) "
                      f"{'OK' if good else 'FAIL'}")
        ok &= bool(good)
    for c in man["categories"]:
        codes = np.frombuffer(_read(C.SITE_DATA / c["file"]), dtype=np.uint8)
        ref = g[c["key"]].to_numpy().astype(np.uint8)
        good = codes.size == n and (codes == ref).all()
        cnt = np.bincount(codes, minlength=8)
        good = good and all(cnt[cc["code"]] == cc["n"] for cc in c["codes"])
        good = good and cnt[0] == c["nmissing"]
        report.append(f"  cat {c['key']:9s} codes {dict(enumerate(cnt.tolist()))} "
                      f"{'OK' if good else 'FAIL'}")
        ok &= bool(good)
    for k, spec in man["meta"].items():
        dt = {"f32": "<f4", "u16": "<u2", "u32": "<u4"}[spec["dtype"]]
        arr = np.frombuffer(_read(C.SITE_DATA / spec["file"]), dtype=dt)
        val = arr.astype(np.float64) + spec.get("offset", 0)
        ref = g[k].to_numpy()
        if spec["dtype"] == "f32":
            good = arr.size == n and (arr == ref.astype(np.float32)).all()
            err = float(np.max(np.abs(val - ref)) * 3600)
            extra = f"max|err| {err:.3g} arcsec"
        else:
            good = arr.size == n and (val == ref).all()
            extra = f"range {int(val.min())}..{int(val.max())}"
        report.append(f"  meta {k:8s} {extra} {'OK' if good else 'FAIL'}")
        ok &= bool(good)
    # prefix property: the first 10% should look like the whole (loose check on z)
    z = g["z"].to_numpy()
    k = n // 10
    report.append(f"  prefix check: median z first 10% {np.median(z[:k]):.5f} vs all "
                  f"{np.median(z):.5f}")
    # IDs stayed strings with 19 digits
    good = g["objid"].map(lambda s: isinstance(s, str) and len(s) == 19 and s.isdigit()).all()
    report.append(f"  objid: 19-digit strings {'OK' if good else 'FAIL'}")
    ok &= bool(good)
    log("round trip (independent decoder):\n" + "\n".join(report))
    log("VERIFY " + ("PASSED" if ok else "FAILED"))
    st = json.loads(C.EXPORT_STATS.read_text()) if C.EXPORT_STATS.exists() else {}
    st["verify"] = {"passed": bool(ok), "lines": report}
    C.EXPORT_STATS.write_text(json.dumps(st, indent=1))
    return ok


def main() -> int:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "export"
    if cmd in ("export", "all"):
        export()
    if cmd in ("verify", "all"):
        if not verify():
            return 1
    if cmd in ("quicklook", "all"):
        quicklook()
    if cmd in ("report", "all"):
        report()
    return 0


# ---------------------------------------------------------------------------------------
# quicklook: 2-D log-density histograms of the canonical relations (sanity check)
# ---------------------------------------------------------------------------------------
BG, BG2, LINE = "#0b0e13", "#11161f", "#273142"
CREAM, CREAM2, CREAM3 = "#efe6d2", "#b8af9a", "#7a7465"
ORANGE, MUSTARD, SKY = "#e8743b", "#e2b23a", "#6fa8dc"


def running_median(x, y, lo, hi, nb=24, min_n=30):
    e = np.linspace(lo, hi, nb + 1)
    c, m, p16, p84 = [], [], [], []
    idx = np.digitize(x, e) - 1
    for i in range(nb):
        s = y[idx == i]
        if s.size >= min_n:
            c.append(0.5 * (e[i] + e[i + 1]))
            m.append(np.median(s))
            p16.append(np.percentile(s, 16))
            p84.append(np.percentile(s, 84))
    return np.array(c), np.array(m), np.array(p16), np.array(p84)


def quicklook() -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import LinearSegmentedColormap

    g = pd.read_parquet(C.GALAXIES_PARQUET)
    cmap = LinearSegmentedColormap.from_list("ink", [BG2, "#2a2f38", "#6d6a60", CREAM2, CREAM])
    plt.rcParams.update({
        "figure.facecolor": BG, "axes.facecolor": BG, "savefig.facecolor": BG,
        "axes.edgecolor": LINE, "axes.labelcolor": CREAM2, "text.color": CREAM,
        "xtick.color": CREAM3, "ytick.color": CREAM3, "xtick.labelcolor": CREAM2,
        "ytick.labelcolor": CREAM2, "font.size": 9, "axes.titlesize": 10,
        "axes.titleweight": "bold", "legend.frameon": False, "legend.fontsize": 7.5,
        "font.family": "DejaVu Sans"})
    col = {k: g[k].to_numpy(float) for k in C.DIM_KEYS}
    bpt, env, morph = (g[k].to_numpy() for k in ("bpt", "env", "morph"))
    notes: dict[str, str] = {}
    vals: dict = {}

    fig, axs = plt.subplots(3, 4, figsize=(18.5, 13.2))
    axs = axs.ravel()

    def dens(ax, x, y, xr, yr, sel=None, nb=130, median=True, title="", xl="", yl="",
             yedges=None):
        m = np.isfinite(x) & np.isfinite(y)
        if sel is not None:
            m &= sel
        if yedges is None:
            H, xe, ye = np.histogram2d(x[m], y[m], bins=nb, range=[xr, yr])
        else:   # bins aligned to a value grid (avoids aliasing stripes)
            H, xe, ye = np.histogram2d(x[m], y[m], bins=[np.linspace(*xr, nb + 1), yedges])
            yr = (yedges[0], yedges[-1])
        Hm = np.ma.masked_where(H.T == 0, np.log10(np.maximum(H.T, 1)))
        ax.imshow(Hm, origin="lower", extent=[*xr, *yr], aspect="auto", cmap=cmap,
                  interpolation="nearest")
        ax.set_xlim(xr), ax.set_ylim(yr)
        ax.set_title(title, loc="left", color=CREAM)
        ax.set_xlabel(xl), ax.set_ylabel(yl)
        ax.text(0.98, 0.03, f"N {m.sum():,}", transform=ax.transAxes, ha="right", va="bottom",
                color=CREAM3, fontsize=8, family="DejaVu Sans Mono")
        for s in ax.spines.values():
            s.set_color(LINE)
        if median:
            c, med, p16, p84 = running_median(x[m], y[m], *xr)
            ax.plot(c, med, color=ORANGE, lw=1.8, label="running median")
            ax.plot(c, p16, color=ORANGE, lw=0.8, ls=":")
            ax.plot(c, p84, color=ORANGE, lw=0.8, ls=":")
            return m, (c, med)
        return m, None

    # 1 MZR (T04 O/H) + Tremonti+04 eq. 3 fit
    ax = axs[0]
    m, (c, med) = dens(ax, col["logM"], col["OH"], (8.0, 11.8), (8.0, 9.4), title="MZR (T04 O/H)",
                       xl="log M★ [M☉]", yl="12+log(O/H) (OH_P50)")
    xm = np.linspace(8.5, 11.5, 50)
    ax.plot(xm, -1.492 + 1.847 * xm - 0.08026 * xm ** 2, color=MUSTARD, lw=1.4, ls="--",
            label="T04 fit")
    ax.legend(loc="upper left")
    hi = (c > 10.75) & (c < 11.25)
    notes["MZR"] = (f"median O/H at logM 10.75-11.25: {np.median(med[hi]):.3f}; "
                    f"at logM 9.0: {np.interp(9.0, c, med):.3f}")
    vals["mzr_plateau"] = float(np.median(med[hi]))
    vals["mzr_at_9"] = float(np.interp(9.0, c, med))

    # 2 FMR: mu_0.32 vs PP04
    ax = axs[1]
    mu032 = col["logM"] - 0.32 * col["logSFR"]
    m, (c, med) = dens(ax, mu032, col["OH_PP04"], (8.0, 11.6), (8.0, 9.0),
                       title="FMR (PP04 O3N2)", xl="log M★ − 0.32 log SFR", yl="12+log(O/H) O3N2")
    ax.legend(loc="upper left")
    ok = np.isfinite(col["OH_PP04"]) & np.isfinite(mu032) & np.isfinite(col["logM"])

    def scat(xv, yv, lo, hi_):
        cc, mm, _, _ = running_median(xv, yv, lo, hi_, nb=30)
        r = yv - np.interp(xv, cc, mm)
        return 1.4826 * np.median(np.abs(r - np.median(r)))
    s_m = scat(col["logM"][ok], col["OH_PP04"][ok], 8.5, 11.5)
    s_f = scat(mu032[ok], col["OH_PP04"][ok], 8.3, 11.3)
    notes["FMR"] = f"robust scatter of PP04 O/H about median: vs logM {s_m:.4f}, vs mu0.32 {s_f:.4f}"
    vals["fmr_sig_m"], vals["fmr_sig_mu"] = float(s_m), float(s_f)
    ax.text(0.02, 0.80, f"σ(M) {s_m:.3f}  σ(μ₀.₃₂) {s_f:.3f}", transform=ax.transAxes,
            color=CREAM2, fontsize=8, family="DejaVu Sans Mono")

    # 3 SFMS
    ax = axs[2]
    m, _ = dens(ax, col["logM"], col["logSFR"], (8.0, 12.0), (-3.5, 2.0), title="SFMS",
                xl="log M★ [M☉]", yl="log SFR [M☉/yr]", median=False)
    sf = (bpt == 1) & np.isfinite(col["logSFR"]) & np.isfinite(col["logM"])
    c, med, _, _ = running_median(col["logM"][sf], col["logSFR"][sf], 9.0, 11.0, nb=10)
    slope, icpt = np.polyfit(c, med, 1)
    ax.plot(c, med, color=SKY, lw=1.8, label="median, BPT SF")
    xs = np.array([8.3, 11.5])
    ax.plot(xs, slope * xs + icpt, color=MUSTARD, lw=1.2, ls="--",
            label=f"fit 9–11: slope {slope:.2f}")
    ax.legend(loc="upper left")
    notes["SFMS"] = f"median logSFR vs logM for MPA SF (class 1), 9<logM<11: slope {slope:.3f}, icpt {icpt:.3f}"
    vals["sfms_slope"], vals["sfms_icpt"] = float(slope), float(icpt)

    # 4 sSFR-M
    ax = axs[3]
    dens(ax, col["logM"], col["logsSFR"], (8.0, 12.0), (-13.5, -8.5), title="sSFR – M★",
         xl="log M★ [M☉]", yl="log sSFR [1/yr]")
    ax.legend(loc="lower left")

    # 5 colour-mass
    ax = axs[4]
    dens(ax, col["logM"], col["gr"], (8.0, 12.0), (0.1, 1.2), title="colour – mass (Lim+17)",
         xl="log M★ [M☉]", yl="⁰·¹(g−r)", yedges=np.arange(0.0995, 1.2, 0.009))
    ax.legend(loc="upper left")

    # 6 mass-size split by C
    ax = axs[5]
    ax.set_title("mass – size by concentration", loc="left")
    xr, yr = (8.5, 12.0), (-0.3, 1.5)
    for s in ax.spines.values():
        s.set_color(LINE)
    for sel, colr, lab in [(col["C"] < 2.6, SKY, "C < 2.6"), (col["C"] >= 2.6, ORANGE, "C ≥ 2.6")]:
        mm = sel & np.isfinite(col["logM"]) & np.isfinite(col["logR50"])
        H, xe, ye = np.histogram2d(col["logM"][mm], col["logR50"][mm], bins=90, range=[xr, yr])
        H = H.T / H.max()
        ax.contour(0.5 * (xe[1:] + xe[:-1]), 0.5 * (ye[1:] + ye[:-1]), H,
                   levels=[0.05, 0.15, 0.35, 0.6, 0.85], colors=colr, linewidths=0.8, alpha=0.8)
        c, med, _, _ = running_median(col["logM"][mm], col["logR50"][mm], *xr)
        ax.plot(c, med, color=colr, lw=2.0, label=f"{lab} (N {mm.sum():,})")
        fit = (c > 10.3) & (c < 11.3)
        sl = np.polyfit(c[fit], med[fit], 1)[0]
        notes[f"size {lab}"] = f"median logR50 slope 10.3<logM<11.3: {sl:.3f}"
        vals["size_slope_late" if lab.startswith("C <") else "size_slope_early"] = float(sl)
    ax.set_xlim(xr), ax.set_ylim(yr)
    ax.set_xlabel("log M★ [M☉]"), ax.set_ylabel("log R₅₀ [kpc]")
    ax.legend(loc="upper left")

    # 7 BPT
    ax = axs[6]
    dens(ax, col["N2Ha"], col["O3Hb"], (-2.0, 0.8), (-1.3, 1.3), title="BPT",
         xl="log [NII]/Hα", yl="log [OIII]/Hβ", median=False)
    xk = np.linspace(-2.0, 0.0, 100)
    ax.plot(xk, 0.61 / (xk - 0.05) + 1.3, color=MUSTARD, lw=1.4, label="Kauffmann+03")
    xk1 = np.linspace(-2.0, 0.4, 100)
    ax.plot(xk1, 0.61 / (xk1 - 0.47) + 1.19, color=MUSTARD, lw=1.2, ls="--", label="Kewley+01")
    xs7 = np.linspace(-0.18, 0.8, 20)
    ax.plot(xs7, 1.05 * xs7 + 0.45, color=MUSTARD, lw=1.2, ls=":", label="Schawinski+07")
    ax.legend(loc="lower left")

    # 8 SHMR centrals
    ax = axs[7]
    cen = (env == 1) | (env == 2)
    m, (c, med) = dens(ax, col["logMh"], col["logM"], (11.0, 15.2), (8.5, 12.2), sel=cen,
                       title="SHMR (Lim+17 centrals)", xl="log M_h [M☉]", yl="log M★ [M☉]")
    ax.legend(loc="upper left")
    notes["SHMR"] = ("median logM* of centrals at logMh 11.5/12/13/14: "
                     + "/".join(f"{np.interp(v, c, med):.2f}" for v in (11.5, 12, 13, 14)))
    vals["shmr"] = [float(np.interp(v, c, med)) for v in (11.5, 12, 13, 14)]

    # 9 FP edge-on (GZ1 ellipticals)
    ax = axs[8]
    fpx = 1.49 * col["logSigV"] + 0.30 * col["mu50"]
    ell = morph == 1
    m, (c, med) = dens(ax, fpx, col["logR50"], (8.0, 10.8), (-0.2, 1.4), sel=ell, nb=110,
                       title="FP edge-on (GZ1 ellipticals)",
                       xl="1.49 log σ + 0.30 ⟨μ⟩₅₀", yl="log R₅₀ [kpc]")
    ok = m
    off = np.median(col["logR50"][ok] - fpx[ok])
    xs = np.array([8.0, 10.8])
    ax.plot(xs, xs + off, color=MUSTARD, lw=1.2, ls="--", label="slope 1 (B03), offset fit")
    r = col["logR50"][ok] - fpx[ok] - off
    fps = 1.4826 * np.median(np.abs(r - np.median(r)))
    sl = np.polyfit(c[(c > 8.8) & (c < 10.2)], med[(c > 8.8) & (c < 10.2)], 1)[0]
    ax.legend(loc="upper left")
    notes["FP"] = f"GZ1 E: offset {off:.3f}, robust scatter about slope-1 {fps:.3f} dex, median slope {sl:.3f}"
    vals["fp_offset"], vals["fp_scatter"], vals["fp_slope"] = float(off), float(fps), float(sl)
    vals["fp_n"] = int(ok.sum())

    # 10 H I fraction
    ax = axs[9]
    m, (c, med) = dens(ax, col["logM"], col["logfHI"], (7.5, 11.8), (-2.5, 2.0), nb=70,
                       title="H I fraction (ALFALFA det.)", xl="log M★ [M☉]", yl="log M_HI/M★")
    ax.legend(loc="upper right")
    fit = (c > 8.5) & (c < 10.8)
    notes["HI"] = f"median log fHI slope 8.5<logM<10.8: {np.polyfit(c[fit], med[fit], 1)[0]:.3f}"
    vals["hi_slope"] = float(np.polyfit(c[fit], med[fit], 1)[0])

    # 11 Dn4000 - HdA
    ax = axs[10]
    dens(ax, col["D4000"], col["HdA"], (0.9, 2.3), (-4.0, 9.0), title="Dₙ4000 – HδA",
         xl="Dₙ4000", yl="HδA [Å]")
    ax.legend(loc="upper right")

    # 12 Sigma* - sSFR
    ax = axs[11]
    dens(ax, col["logSigma"], col["logsSFR"], (6.5, 10.5), (-13.5, -8.5),
         title="Σ★ – sSFR", xl="log Σ★ [M☉/kpc²]", yl="log sSFR [1/yr]")
    ax.axvline(8.5, color=MUSTARD, lw=1.0, ls="--", label="log Σ★ = 8.5 (K03)")
    ax.legend(loc="lower left")

    fig.suptitle(f"Galaxy Manifold export quicklook · N {len(g):,} · log counts",
                 x=0.01, ha="left", color=CREAM, fontsize=12)
    fig.tight_layout(rect=[0, 0, 1, 0.975])
    fig.savefig(C.QUICKLOOK_PNG, dpi=100)
    plt.close(fig)
    log(f"wrote {C.QUICKLOOK_PNG}")
    for k, v in notes.items():
        log(f"  {k}: {v}")
    st = json.loads(C.EXPORT_STATS.read_text()) if C.EXPORT_STATS.exists() else {}
    st["quicklook"] = notes
    st["quicklook_values"] = vals
    C.EXPORT_STATS.write_text(json.dumps(st, indent=1))


# ---------------------------------------------------------------------------------------
# REPORT.md, generated from the stats files so the numbers always match the latest run
# ---------------------------------------------------------------------------------------
def report() -> None:
    b = json.loads(C.BUILD_STATS.read_text())
    e = json.loads(C.EXPORT_STATS.read_text())
    man = json.loads((C.SITE_DATA / "manifest.json").read_text(encoding="utf-8"))
    q = e.get("quicklook_values", {})
    g = pd.read_parquet(C.GALAXIES_PARQUET, columns=["ra", "dec", "ra_spec", "dec_spec", "z",
                                                     "gz1_match", "phot_query", "lim_match",
                                                     "lim_io", "morph", "in_core"])
    n = man["n"]
    f = lambda x: f"{int(x):,}"                       # noqa: E731
    pc = lambda x, d=2: f"{100 * x:.{d}f}%"           # noqa: E731
    cz, cm, cr, cu = b["cut_z"], b["cut_logm"], b["cut_r"], b["cut_unique_objid"]
    lm, gz1, al, li = b["lim_match"], b["gz1_match"], b["alfalfa"], b["local_images"]
    north = (g["ra"] > 60) & (g["ra"] < 300) & (g["z"] <= 0.2)
    lim_north = float((g.loc[north, "lim_match"] != "").mean())
    gz_um = g["gz1_match"] == ""
    gz_um_special = float((g.loc[gz_um, "phot_query"] == "followup").mean())
    special_frac = float((g["phot_query"] == "followup").mean())
    io0 = float((g.loc[g["lim_match"] != "", "lim_io"] == 0).mean())
    unc = float((g.loc[~gz_um, "morph"] == 3).mean())
    core_exact = float((g.loc[g["in_core"].astype(bool), "lim_match"] == "objid").mean())
    r1, d1, r2, d2 = (np.radians(g[k].to_numpy(float)) for k in ("ra", "dec", "ra_spec", "dec_spec"))
    sep = 2 * np.arcsin(np.sqrt(np.sin((d2 - d1) / 2) ** 2
                                + np.cos(d1) * np.cos(d2) * np.sin((r2 - r1) / 2) ** 2))
    sep = np.degrees(sep) * 3600
    zc = b["skyserver_match"]["z_dr17_vs_dr8"]
    sizes = e["sizes"]
    verify_ok = e.get("verify", {}).get("passed", False)
    pq_counts = pd.read_parquet(C.PHOTO_PARQUET, columns=["phot_query"])["phot_query"].value_counts()
    n_bits, n_follow = int(pq_counts.get("mgs_bits", 0)), int(pq_counts.get("followup", 0))
    par_keys = pd.read_parquet(C.PARENT, columns=["plate", "mjd", "fiber"])
    ph_keys = pd.read_parquet(C.PHOTO_PARQUET, columns=["plate", "mjd", "fiber"])
    n_nophot = int(len(par_keys) - len(par_keys.merge(ph_keys, on=["plate", "mjd", "fiber"])))
    n_chunks = len(list(C.SKYSERVER_CACHE.glob("photo_[0-9]*.csv.gz")))
    no = lambda k, one, many: (f"No {one}" if k == 0 else f"{f(k)} {many}")  # noqa: E731
    L: list[str] = []
    w = L.append

    w("# Data pipeline report\n")
    w("This file is written by `python3 pipeline/export_web.py report`. It reads "
      "`pipeline/cache/build_stats.json`, `pipeline/cache/export_stats.json` and "
      "`site/data/manifest.json`, so the numbers match the latest run. The export described "
      f"here was made on {man['created']}.\n")

    w("## Result\n")
    w(f"- The export has {f(n)} galaxies. Each galaxy has {len(man['dims'])} dimensions, "
      f"{len(man['categories'])} categories and {len(man['meta'])} metadata columns.")
    w(f"- The dimension files take {e['dims_gz_mb']:.2f} MB after gzip. All of `site/data` "
      f"takes {e['total_mb']:.2f} MB, before the thumbnails and `literature.json` are added.")
    if man["sample"]["subsample"] is None:
        w("- The export uses the full sample. No subsample was needed (see \"File sizes\").")
    else:
        s = man["sample"]["subsample"]
        w(f"- The export is a subsample of {f(s['kept'])} out of {f(s['of'])} galaxies. It "
          f"keeps all {f(s['hi_detections_kept'])} H I detections.")
    w("- The round trip check " + ("passed" if verify_ok else "FAILED") + ". An independent "
      "decoder read every file back and compared it with `pipeline/cache/galaxies.parquet`.")
    w("- `pipeline/cache/galaxies.parquet` has the same rows in the same order as "
      "`site/data`. The thumbnails step reads it.\n")

    w("## How to rebuild\n")
    w("```")
    w("python3 pipeline/fetch_skyserver.py     # SkyServer DR17, cached; rerun until it prints COMPLETE")
    w("python3 pipeline/build_catalog.py       # merge and compute: pipeline/cache/catalog.parquet")
    w("python3 pipeline/export_web.py all      # site/data, galaxies.parquet, verify, quicklook, report")
    w("```\n")
    w("The SkyServer step sends about 290 queries, 2 at a time. The first run took about 3 "
      "minutes. Every result is cached in `pipeline/cache/skyserver/`, so a second run sends "
      "no queries. The other two steps take about 30 seconds together. Each subcommand of "
      "`export_web.py` (`export`, `verify`, `quicklook`, `report`) can also run on its own.\n")

    w("## Sample selection\n")
    w("| Step | Galaxies left | Removed | Why they were removed |")
    w("|---|---:|---:|---|")
    w(f"| Parent sample, `catalog/mgs_parent.parquet` | {f(b['parent'])} | | |")
    w(f"| Redshift 0.005 to 0.30 | {f(cz['keep'])} | {f(cz['drop'])} | All of them have z "
      f"below 0.005. |")
    w(f"| Finite log M★ above 6 | {f(cm['keep'])} | {f(cm['drop'])} | MPA-JHU gives no "
      f"stellar mass for them. |")
    w(f"| DR17 photometry found | {f(b['skyserver_match']['matched'])} | "
      f"{f(cr['drop_no_skyserver'])} | DR17 has no photometric object for the spectrum. |")
    w(f"| `petroMag_r - extinction_r` at most 17.77 | {f(cr['keep'])} | "
      f"{f(cr['drop_fainter'] + cr['drop_no_petromag'])} | {f(cr['drop_fainter'])} are "
      f"fainter than 17.77 in DR17. {f(cr['drop_no_petromag'])} have no Petrosian "
      f"magnitude. |")
    w(f"| One spectrum per DR17 objID | {f(cu['keep'])} | {f(cu['drop'])} | Repeat spectra "
      f"of one galaxy. We kept the spectrum with the higher median S/N. |")
    w("")
    w(f"The {f(cr['drop_no_skyserver'])} spectra without DR17 photometry have photometric "
      "IDs from the DR7 imaging reduction (rerun 40). SkyServer lists `bestObjID = 0` for "
      "them, and DR17 has no primary photometric object within 2 arcsec of their fibers.\n")
    w("The magnitude cut removes two groups of galaxies.\n")
    w(f"- {f(cr['drop_fainter_special_plates'])} are on SDSS special plates, e.g., the "
      "southern survey plates. These plates targeted galaxies fainter than the Main Galaxy "
      "Sample limit. The DR8 `PRIMTARGET` of these spectra has the MGS GALAXY bit set, so "
      f"`mgs_parent` includes them. Only {f(cr['special_plate_kept'])} of the "
      f"{f(cr['special_plate_spectra'])} special plate spectra are bright enough to stay.")
    w(f"- {f(cr['drop_fainter_regular_plates'])} are on regular plates. "
      f"{f(cr['regular_17p77_17p80'])} of them are within 0.03 mag of the limit. They were "
      "brighter than 17.77 in the photometry used for targeting and are slightly fainter in "
      f"DR17. Another {f(cr['regular_fainter_17p9'])} are more than 0.13 mag fainter than the "
      f"limit. For {pc(cr['regular_fainter_17p9_model_r_also_faint'], 0)} of these the DR17 "
      f"model magnitude is also fainter than 17.77, and "
      f"{pc(cr['regular_fainter_17p9_r50_lt_1arcsec'], 0)} have R50 below 1 arcsec. DR17 "
      "measures a fainter or smaller object for them than the targeting photometry did. A "
      "one-time check of 120 of them on SkyServer found the GALAXY target bit set for 99%.\n")
    w("The repeat spectra come from overlapping plates. The parent sample removed repeats "
      "by DR7 `PHOTOID`. In some overlap regions the two spectra of one galaxy were tied to "
      "different DR7 imaging runs, so both stayed. DR17 ties both spectra to one photometric "
      f"object. The two redshifts differ by a median of "
      f"{cu['median_dz_between_repeats']:.5f}.\n")

    w("## Match rates\n")
    w("| Source | Matched | Rate | How |")
    w("|---|---:|---:|---|")
    w(f"| SkyServer DR17 photometry | {f(b['skyserver_match']['matched'])} | "
      f"{pc(b['skyserver_match']['rate'])} | plate, mjd and fiber (rate before the "
      "magnitude cut) |")
    w(f"| Galaxy Zoo 1, `zooSpec` | {f(gz1['total'])} | {pc(gz1['rate'])} | "
      f"{f(gz1['by_specobjid'])} by specObjID, then {f(gz1['by_objid'])} more by objID |")
    w(f"| Lim+17 SDSS(M) groups | {f(lm['total'])} | {pc(lm['rate'])} | "
      f"{f(lm['exact_objid'])} by exact objID, {f(lm['positional'])} by position |")
    w(f"| Lim+17, z ≤ 0.2 only | | {pc(lm['rate_z_le_0.2'])} | |")
    w(f"| Lim+17, z ≤ 0.2 and 60 < RA < 300 | | {pc(lim_north)} | |")
    w(f"| ALFALFA α.100, `log_fgas` | {f(al['log_fgas'])} | {pc(al['log_fgas'] / n)} | "
      "taken from `mgs_parent` |")
    w(f"| Local 160 px cutouts | {f(li['total'])} | {pc(li['total'] / n)} | "
      f"{f(li['matched_sdss'])} in `images-sdss`, {f(li['matched_extra_only'])} more in "
      "`images-extra` |")
    w("")
    w("The rates are fractions of the final sample, except for the SkyServer row.\n")
    w("SkyServer. The first pass asked for every spectrum with the MGS target bits in "
      f"`legacy_target1`, in {n_chunks} chunks of {C.PLATES_PER_CHUNK} plates, and found "
      f"{f(n_bits)} spectra. It missed {f(n_follow + n_nophot)} parent spectra. Of these, "
      f"{f(n_follow)} are on special plates, where DR17 keeps the target flags in "
      "`special_target1`. A second pass asked for the missed spectra by plate, mjd and fiber. "
      f"It found all of them except the {f(n_nophot)} with `bestObjID = 0`. "
      "The DR17 redshift agrees with the DR8 redshift for every matched spectrum. "
      f"{no(zc['n_abs_dz_gt_1e-3'], 'spectrum differs', 'spectra differ')} by more than "
      f"0.001. In the final sample the DR17 photometric position agrees with the fiber "
      f"position to {np.median(sep):.2f} arcsec at the median and {sep.max():.1f} arcsec at "
      "most.\n")
    cv = b["core_vs_dr17_petroMag_r"]
    w(f"Imaging sample. The sample has {f(b['core_objid_agrees']['core'])} galaxies from "
      "the imaging sample, which is the only part of `mgs_parent` with its own photometry. "
      f"For {pc(cv['frac |core-petroMag_r| < 0.01'], 1)} of them, the `petroMag_r` in "
      "`mgs_parent` agrees with the DR17 `petroMag_r` to 0.01 mag. Neither value has the "
      "extinction correction. Their image file names use the DR17 objID in every case.\n")
    w(f"Galaxy Zoo 1. {f(gz_um.sum())} galaxies have no Galaxy Zoo 1 entry. "
      f"{pc(gz_um_special, 0)} of them are special plate spectra, which are "
      f"{pc(special_frac, 1)} of the whole sample.\n")
    w("Lim+17. The Lim+17 SDSS catalogue covers only the contiguous northern Galactic cap. "
      "Every galaxy at z ≤ 0.2 without a Lim+17 match lies in the southern stripes, at RA 300 "
      f"to 60 degrees. Away from those stripes the match rate at z ≤ 0.2 is {pc(lim_north)}. "
      f"In the imaging sample the exact objID match rate is {pc(core_exact, 1)}. The positional match "
      "(within 2 arcsec, with redshifts within 0.01) added only "
      f"{f(lm['positional'])} galaxy, so DR13 and DR17 use the same objIDs. In the Lim+17 "
      f"galaxy file, {f(lm['duplicate_survey_ids_resolved'])} survey IDs appear twice. For "
      "those we kept the entry closest in redshift.\n")
    w(f"ALFALFA. `log_fgas` comes from `mgs_parent`. It is log M_HI minus log M★ for ALFALFA "
      "α.100 detections with H I code 1 or 2 and no brighter galaxy at the same velocity "
      f"inside the beam. {f(al['log_mhi'])} galaxies have an H I mass, and "
      f"{f(al['log_fgas'])} of them pass these checks.\n")

    w("## Dimensions\n")
    w("\"Valid\" counts values inside the section 6 range. \"Out of range\" counts finite "
      "values outside it, which we set to missing.\n")
    other = {
        "D4000": f"{f(b['index_errors']['d4000_err_nonpositive'])} with D4000_N_ERR ≤ 0 "
                 "(all of them also outside the range)",
        "HdA": f"{f(b['index_errors']['hda_err_nonpositive'])} with LICK_HD_A_ERR = -1 "
               "(value stored as exactly 0)",
        "gr": f"{f(b['lim_color_placeholders']['set_missing'])} Lim+17 placeholder colours; "
              "no Lim+17 match for the rest",
        "OH": "MPA-JHU gives it for star-forming galaxies only",
        "OH_PP04": f"MPA class 1 with S/N > 3 in all four lines; "
                   f"{f(b['pp04']['o3n2_out_of_validity'])} outside -1 < O3N2 < 1.9",
        "logSigV": f"fibre σ outside 40 to 500 km/s, or error above 0.3σ "
                   f"({f(b['sigv']['v_disp_zero'])} have σ = 0)",
        "logfHI": "ALFALFA detections only",
        "logMh": "no Lim+17 match",
        "pEl": "no Galaxy Zoo 1 match",
        "N2Ha": "S/N ≤ 3 in [NII] or Hα",
        "O3Hb": "S/N ≤ 3 in [OIII] or Hβ",
    }
    w("| Key | Range | Valid | Missing | Out of range | Other reasons for missing | Source |")
    w("|---|---|---:|---:|---:|---|---|")
    for d in man["dims"]:
        st = b["dims"][d["key"]]
        w(f"| `{d['key']}` | {d['min']:g} to {d['max']:g} | {f(st['valid'])} | "
          f"{f(n - st['valid'])} | {f(st['out_of_range'])} | {other.get(d['key'], '')} | "
          f"{d['source']} |")
    w("")
    w(f"The J95 aperture correction to R50/8 changes log σ by a median of "
      f"{b['sigv']['median_correction_dex']:.3f} dex.\n")

    w("## Categories\n")
    for c in man["categories"]:
        w(f"`{c['key']}` ({c['label']}): " + ", ".join(
            f"{cc['code']} {cc['label']} {f(cc['n'])}" for cc in c["codes"])
          + f", 0 missing {f(c['nmissing'])}.\n")
    bs = b["bpt_split"]
    w(f"MPA-JHU class 4 has {f(bs['mpa4'])} galaxies. The Schawinski et al. (2007) line splits "
      f"them into {f(bs['seyfert'])} Seyferts and {f(bs['liner'])} LINERs. For "
      f"{f(bs['mpa4_split_on_raw_flux_ratio'])} of them one of our line ratios is missing, "
      "because the rescaled S/N of [NII] or Hα is below 3. For those we used the ratio of the "
      "measured fluxes. MPA-JHU already required S/N above 3 in all four lines to put them in "
      f"class 4. {no(bs['mpa4_unsplittable_to_7'], 'class 4 galaxy was', 'class 4 galaxies were')} "
      "left without a ratio.\n")
    pp = b["pp04"]
    w("The PP04 metallicity uses MPA-JHU class 1 as the star-forming selection. "
      f"{no(pp['mpa_sf2_with_4line_sn'], 'class 2 galaxy passes', 'class 2 galaxies pass')} "
      "S/N above 3 in all four lines once the errors are rescaled. "
      f"{no(pp['mpa_sf_4line_but_above_K03_on_rescaled'], 'class 1 galaxy with four good lines lies', 'class 1 galaxies with four good lines lie')} "
      "above the Kauffmann et al. (2003) line in our own ratios.\n")
    w(f"Every Lim+17 group with one member has that galaxy as its central "
      f"({f(b['env_anomalies']['nmem1_not_central'])} exceptions). Every Galaxy Zoo 1 match "
      f"has exactly one of the three flags set ({f(b['morph_anomalies']['flags_not_exactly_one'])} "
      "exceptions).\n")

    w("## File sizes\n")
    w("| File | MB |")
    w("|---|---:|")
    for k in sorted(sizes):
        w(f"| `{k}` | {sizes[k] / 1e6:.3f} |")
    w(f"| dims total | {e['dims_gz_mb']:.3f} |")
    w(f"| all of `site/data` from this step | {e['total_mb']:.3f} |")
    w("")
    w(f"Section 16 asks for dimension files of about 20 MB or less. The full sample needs "
      f"{e['dims_gz_mb_full_sample']:.2f} MB, which is "
      f"{100 * (e['dims_gz_mb_full_sample'] / C.DIMS_GZ_BUDGET_MB - 1):.0f}% over 20 MB. We "
      "kept the full sample instead of removing about 5% of the galaxies at random. The "
      f"export subsamples only above {C.DIMS_GZ_BUDGET_MB * C.DIMS_GZ_TOLERANCE:.0f} MB "
      "(`DIMS_GZ_TOLERANCE` in `config.py`). The dimension files use zlib level 9 with "
      "memLevel 9 and the Z_FILTERED strategy. This is a standard gzip stream, and it is "
      "about 1% smaller than the default settings. All gzip files have a zero timestamp, so "
      "a rebuild from the same inputs gives identical bytes.\n")

    w("## Verification\n")
    w("Round trip. `python3 pipeline/export_web.py verify` decodes every file in `site/data` "
      "with its own reader, written from the text of section 5. It compares the result with "
      "`galaxies.parquet`. For each dimension it checks that the missing values agree and "
      "that the decoded values are within half a quantization step. It also checks the "
      "counts, the medians and the 101 quantiles in the manifest.\n")
    w("```")
    for line in e.get("verify", {}).get("lines", []):
        w(line.strip())
    w("```\n")
    w("Quicklook. `pipeline/cache/quicklook.png` shows 12 density plots of the main relations. "
      "The numbers below come from the same run. Scatter is 1.4826 times the median absolute "
      "deviation.\n")
    if q:
        w(f"- MZR. The T04 metallicity levels off at 12+log(O/H) = {q['mzr_plateau']:.2f} for "
          "log M★ 10.75 to 11.25. Tremonti et al. (2004) find a plateau near 9.1. At log M★ = "
          f"9 the median is {q['mzr_at_9']:.2f}.")
        w(f"- FMR. The scatter of the PP04 metallicity is {q['fmr_sig_m']:.3f} dex around the "
          f"median in log M★ and {q['fmr_sig_mu']:.3f} dex around the median in "
          "log M★ - 0.32 log SFR.")
        w(f"- SFMS. The median log SFR of MPA-JHU class 1 galaxies rises with a slope of "
          f"{q['sfms_slope']:.2f} between log M★ 9 and 11. Renzini and Peng (2015) find 0.76 "
          "for the ridge line of the same MPA-JHU data.")
        w(f"- Mass and size. Galaxies with C < 2.6 and C ≥ 2.6 form two size sequences. Their "
          f"median slopes between log M★ 10.3 and 11.3 are {q['size_slope_late']:.2f} and "
          f"{q['size_slope_early']:.2f}.")
        w("- BPT. The plot shows the star-forming branch and the AGN branch on either side of "
          "the Kauffmann et al. (2003) line.")
        sh = q["shmr"]
        w(f"- SHMR. For Lim+17 centrals, the median log M★ is {sh[0]:.2f}, {sh[1]:.2f}, "
          f"{sh[2]:.2f} and {sh[3]:.2f} at log M_h 11.5, 12, 13 and 14.")
        w(f"- Fundamental plane. For {f(q['fp_n'])} Galaxy Zoo 1 ellipticals, log R50 follows "
          f"1.49 log σ + 0.30 μ50 with a scatter of {q['fp_scatter']:.3f} dex. The median "
          f"slope is {q['fp_slope']:.2f} rather than 1. Bernardi et al. (2003) fit de "
          "Vaucouleurs radii with a correction for the flux limit, and we use Petrosian radii "
          "without one.")
        w(f"- H I. The median H I fraction of the ALFALFA detections falls with a slope of "
          f"{q['hi_slope']:.2f} in log M★.")
        w("- Dn4000 and HδA are anticorrelated. HδA peaks near Dn4000 = 1.2.")
        w("- Σ★ and sSFR. The median sSFR drops sharply at log Σ★ of about 8.5 to 9. "
          "Kauffmann et al. (2003) find that galaxies above 3 × 10^8 M☉ kpc⁻² have old "
          "stellar populations.\n")

    w("## Problems found and decisions\n")
    lc = b["lim_color_placeholders"]
    w("- Line errors. `mgs_parent` stores the raw MPA-JHU flux errors. We multiply them by "
      "the factors on the MPA-JHU DR7 data page before every S/N test. The factors are 1.882 "
      "for Hβ, 1.566 for [OIII]5007, 2.473 for Hα and 2.039 for [NII]6584. We checked them "
      "at https://wwwmpa.mpa-garching.mpg.de/SDSS/DR7/raw_data.html.")
    w(f"- HδA failures. {f(b['index_errors']['hda_exact_zero_with_bad_err'])} galaxies have "
      "LICK_HD_A exactly 0 with an error of -1, which marks a failed measurement. We read "
      "LICK_HD_A_ERR and D4000_N_ERR from `data/galSpecIndx-dr8.fits` and require a positive "
      "error.")
    w("- Lim+17 placeholder colours. Lim+17 gives galaxies far from the colour and luminosity "
      "relation a fixed colour. The values 0.832 and 0.889 appear 2,783 and 2,565 times in "
      "Lim+17, while the neighbouring values appear about 800 and 1,270 times. At those two "
      "values we set the colour to missing when the galaxy's own DR17 model g-r differs by "
      f"more than 0.2 mag. This removed {f(lc['set_missing'])} colours, close to the excess of "
      "about 2,230 in our sample.")
    w(f"- Repeat spectra. {f(cu['drop'])} galaxies had two spectra in the parent sample. See "
      "\"Sample selection\".")
    w("- Special plates. 38,872 parent spectra are on special plates. See \"Sample "
      "selection\".")
    w("- Duplicate column. The dimension `z` is the redshift column itself. The values are "
      "all inside its range.")
    w("- T04 metallicity bands. The MPA-JHU OH_P50 values cluster on the model grid, so the "
      "MZR plot shows faint horizontal bands. This is in the input data, and we did not "
      "change it.\n")

    w("## Caveats\n")
    for cv_ in man.get("caveats", []):
        w(f"- {cv_}")
    w(f"- The DR17 magnitude cut removes {f(cr['drop_fainter_regular_plates'])} regular MGS "
      "targets that are fainter than 17.77 in DR17. Near the flux limit the sample is "
      "slightly smaller than the original target list.")
    w(f"- {pc(io0, 0)} of the Lim+17 matches are in groups outside the completeness volume "
      "(`i-o` = 0). Lim+17 gives those groups the mean halo mass for their proxy. The flag is "
      "kept as `lim_io` in `galaxies.parquet`.")
    w(f"- {pc(unc, 0)} of the Galaxy Zoo 1 matches have the \"uncertain\" flag, because the "
      "flags need a debiased fraction above 0.8.")
    w("- The metadata `ra` and `dec` are DR17 photometric positions, not fiber positions.\n")

    w("## Notes for the other steps\n")
    w("- `pipeline/cache/galaxies.parquet` has one row per exported galaxy, in export order. "
      "Its main columns are listed here.")
    w("    - `row`, the export row index.")
    w("    - `objid` and `specobjid`, as strings. `objid` always has 19 digits.")
    w("    - `plate`, `mjd` and `fiber`.")
    w("    - `ra` and `dec`, the DR17 photometric position. `ra_spec` and `dec_spec` are the "
      "MPA-JHU fiber position.")
    w("    - `z`, `petroR50_r` and `petroR90_r`. The radii are in arcsec.")
    w("    - `local_image`, the path of an existing 160 px cutout relative to the project "
      "root, or an empty string.")
    w("    - The 20 dimension columns in physical units, with NaN when missing.")
    w("    - `bpt`, `env` and `morph` as uint8 codes, with 0 for missing.")
    w("    - Match details such as `lim_match`, `lim_io`, `lim_nmem`, `gz1_match` and "
      "`phot_query`.")
    w("- The manifest has fields that section 5.2 does not list. These are `sample`, "
      "`caveats`, and the category fields other than `key`, `label` and `codes`. A category "
      "entry has the form `{key, label, file, dtype, missing, codes: [{code, label, name, "
      "color, n}], nmissing, desc, source}`.")
    w("- When `export_web.py` runs again with the same row order, it keeps an existing "
      "`thumbs` block in the manifest. It checks the order with a hash of the objID sequence "
      "that it stores in `export_stats.json`. If the order changes, it resets `thumbs` to "
      "null and prints a warning, and `thumbs.py` must run again.")
    text = "\n".join(L) + "\n"
    bad = [ch for ch in ("—", "–") if ch in text]
    if bad:
        raise RuntimeError(f"report contains dashes {bad}")
    C.REPORT_MD.write_text(text, encoding="utf-8")
    log(f"wrote {C.REPORT_MD} ({len(text):,} chars)")


if __name__ == "__main__":
    sys.exit(main())
