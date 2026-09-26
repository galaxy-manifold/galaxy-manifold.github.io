"""Merge the MGS parent sample with SkyServer DR17 photometry, Galaxy Zoo 1 and the Lim+17
group catalog, apply the sample cuts, and compute every dimension (DESIGN.md section 6)
and category (section 7).

Output: pipeline/cache/catalog.parquet (parent order, sample rows only) and
pipeline/cache/build_stats.json (counts for REPORT.md). export_web.py permutes the rows and
writes the web files plus pipeline/cache/galaxies.parquet in export order.

Conventions
  * Physical values are NaN when missing; values outside the section-6 range are set to NaN
    and counted per dimension ("out of range").
  * SDSS objID / specObjID are strings end to end.
  * Line S/N uses the MPA-JHU recommended error rescalings (config.LINE_ERR_SCALE).
  * Cosmology: astropy FlatLambdaCDM(H0=70, Om0=0.3).

Usage:  python3 pipeline/build_catalog.py
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
from astropy.cosmology import FlatLambdaCDM
from scipy.spatial import cKDTree

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config as C  # noqa: E402

KEY = ["plate", "mjd", "fiber"]
ARCSEC = np.pi / 648000.0


def log(msg: str) -> None:
    print(msg, flush=True)


# ---------------------------------------------------------------------------------------
# inputs
# ---------------------------------------------------------------------------------------
def load_lim() -> pd.DataFrame:
    """Lim+17 SDSS(M) galaxies joined to their groups (cached as parquet)."""
    src_mtime = max(C.LIM_GALAXY.stat().st_mtime, C.LIM_GROUP.stat().st_mtime)
    if C.LIM_PARQUET.exists() and C.LIM_PARQUET.stat().st_mtime > src_mtime:
        return pd.read_parquet(C.LIM_PARQUET)
    names = ["lim_galaxy_id", "lim_survey_id", "lim_group_id", "lim_ra", "lim_dec", "lim_l",
             "lim_b", "lim_zcmb", "lim_zedd", "lim_zcomp", "lim_zsrc", "lim_distnn",
             "lim_logL", "lim_logMs", "lim_color"]
    gal = pd.read_csv(C.LIM_GALAXY, sep=r"\s+", comment="#", header=None, names=names,
                      dtype={"lim_survey_id": str}, engine="c")
    if gal.shape[1] != 15:
        raise RuntimeError(f"unexpected Lim galaxy columns: {gal.shape}")
    rows, skipped = [], 0
    with open(C.LIM_GROUP) as f:
        for line in f:
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            parts = s.split(maxsplit=9)   # field 10 ('known as') is free text with spaces
            try:
                rows.append((int(parts[0]), int(parts[1]), float(parts[2]), float(parts[3]),
                             float(parts[4]), float(parts[5]), int(parts[6]), float(parts[7]),
                             int(parts[8])))
            except (ValueError, IndexError):
                skipped += 1   # the multi-line header comment has one line without '#'
    grp = pd.DataFrame(rows, columns=["lim_group_id", "lim_cen_id", "lim_grp_ra",
                                      "lim_grp_dec", "lim_grp_z", "lim_logMh_h", "lim_nmem",
                                      "lim_fedge", "lim_io"])
    log(f"  Lim+17: {len(gal):,} galaxies, {len(grp):,} groups ({skipped} non-data lines "
        f"skipped)")
    lim = gal.merge(grp, on="lim_group_id", how="left", validate="many_to_one")
    if lim["lim_cen_id"].isna().any():
        raise RuntimeError("Lim galaxies without a group")
    lim = lim.drop(columns=["lim_l", "lim_b", "lim_zedd", "lim_distnn"])
    lim.to_parquet(C.LIM_PARQUET, index=False)
    return lim


def load_index_errors() -> pd.DataFrame:
    """D4000_N_ERR and LICK_HD_A_ERR from galSpecIndx (mgs_parent carries only the values),
    plus the continuum optical depth TAUV_CONT. A failed HdA measurement is stored as exactly
    0 with error -1."""
    from astropy.io import fits
    with fits.open(C.GALSPEC_INDX, memmap=True) as h:
        d = h[1].data
        out = pd.DataFrame({
            "plate": np.asarray(d["PLATEID"]).astype(np.int64),
            "mjd": np.asarray(d["MJD"]).astype(np.int64),
            "fiber": np.asarray(d["FIBERID"]).astype(np.int64),
            "d4000_n_err": np.asarray(d["D4000_N_ERR"]).astype(np.float64),
            "hdelta_a_err": np.asarray(d["LICK_HD_A_ERR"]).astype(np.float64),
            "tauv_cont": np.asarray(d["TAUV_CONT"]).astype(np.float64)})
    return out.drop_duplicates(KEY)


def unit_vectors(ra_deg, dec_deg) -> np.ndarray:
    ra, dec = np.radians(ra_deg), np.radians(dec_deg)
    return np.column_stack([np.cos(dec) * np.cos(ra), np.cos(dec) * np.sin(ra), np.sin(dec)])


# ---------------------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------------------
def snr(df: pd.DataFrame, line: str) -> np.ndarray:
    """S/N with the MPA-JHU rescaled error; 0 where the error is not positive."""
    f = df[f"f_{line}"].to_numpy(float)
    e = df[f"e_{line}"].to_numpy(float) * C.LINE_ERR_SCALE[line]
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where((e > 0) & np.isfinite(f) & np.isfinite(e), f / e, 0.0)


def log_ratio(num: np.ndarray, den: np.ndarray, ok: np.ndarray) -> np.ndarray:
    out = np.full(len(num), np.nan)
    ok = ok & (num > 0) & (den > 0) & np.isfinite(num) & np.isfinite(den)
    out[ok] = np.log10(num[ok] / den[ok])
    return out


def finite_or_nan(x, lo=-np.inf, hi=np.inf) -> np.ndarray:
    """SDSS/MPA sentinels (-9999, -999, ...) and non-finite values become NaN."""
    x = np.asarray(x, dtype=float)
    return np.where(np.isfinite(x) & (x > lo) & (x < hi), x, np.nan)


# ---------------------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------------------
def build() -> tuple[pd.DataFrame, dict]:
    stats: dict = {"created": C.CREATED}
    t0 = time.time()
    par = pd.read_parquet(C.PARENT)
    stats["parent"] = int(len(par))
    log(f"parent: {len(par):,} galaxies ({C.PARENT.name})")

    # --- cut 1: redshift -------------------------------------------------------------
    z = par["z"].to_numpy(float)
    m_z = np.isfinite(z) & (z >= C.Z_MIN) & (z <= C.Z_MAX)
    stats["cut_z"] = {"rule": f"{C.Z_MIN} <= z <= {C.Z_MAX}", "drop": int((~m_z).sum()),
                      "drop_low": int((z < C.Z_MIN).sum()), "drop_high": int((z > C.Z_MAX).sum()),
                      "keep": int(m_z.sum())}
    par = par[m_z].reset_index(drop=True)

    # --- cut 2: stellar mass ---------------------------------------------------------
    lm = par["log_mstar"].to_numpy(float)
    m_m = np.isfinite(lm) & (lm > C.LOGM_MIN)
    stats["cut_logm"] = {"rule": f"finite log_mstar > {C.LOGM_MIN}", "drop": int((~m_m).sum()),
                         "drop_nan": int((~np.isfinite(lm)).sum()), "keep": int(m_m.sum())}
    par = par[m_m].reset_index(drop=True)
    log(f"  after z cut {stats['cut_z']['keep']:,}; after log M cut {len(par):,}")

    # --- SkyServer photometry ----------------------------------------------------------
    photo = pd.read_parquet(C.PHOTO_PARQUET)
    photo = photo.drop_duplicates(KEY).rename(columns={"ra": "ra_phot", "dec": "dec_phot"})
    # mgs_parent's own photometric columns exist only for the core sample; DR17 replaces them
    par = par.rename(columns={c: f"core_{c}" for c in
                              ["modelMag_u", "modelMag_g", "modelMag_r", "modelMag_i",
                               "modelMag_z", "petroMag_r", "petroR50_r", "petroR90_r"]})
    df = par.merge(photo, on=KEY, how="left", validate="one_to_one")
    has_phot = df["objid"].notna().to_numpy()
    for c in ["petroMag_r", "petroR50_r", "petroR90_r", "modelMag_u", "modelMag_g",
              "modelMag_r", "modelMag_i", "modelMag_z", "extinction_u", "extinction_g",
              "extinction_r", "extinction_i", "extinction_z", "deVAB_r", "expAB_r",
              "fracDeV_r"]:
        df[c] = finite_or_nan(df[c], lo=-1000)
    df["r_petro_corr"] = df["petroMag_r"] - df["extinction_r"]
    stats["skyserver_match"] = {"matched": int(has_phot.sum()), "unmatched": int((~has_phot).sum()),
                                "rate": float(has_phot.mean())}
    dz = np.abs(df["z_dr17"].to_numpy(float) - df["z"].to_numpy(float))
    stats["skyserver_match"]["z_dr17_vs_dr8"] = {
        "median_abs_dz": float(np.nanmedian(dz)), "n_abs_dz_gt_1e-3": int(np.nansum(dz > 1e-3))}

    # --- cut 3: Petrosian r (extinction corrected, DR17) --------------------------------
    r = df["r_petro_corr"].to_numpy(float)
    m_r = np.isfinite(r) & (r <= C.R_PETRO_MAX)
    stats["cut_r"] = {"rule": f"petroMag_r - extinction_r <= {C.R_PETRO_MAX} (DR17)",
                      "drop": int((~m_r).sum()),
                      "drop_no_skyserver": int((~has_phot).sum()),
                      "drop_no_petromag": int((has_phot & ~np.isfinite(r)).sum()),
                      "drop_fainter": int((np.isfinite(r) & (r > C.R_PETRO_MAX)).sum()),
                      "fainter_17p77_17p80": int((np.isfinite(r) & (r > 17.77) & (r <= 17.80)).sum()),
                      "keep": int(m_r.sum())}
    # special plates (found only by the explicit follow-up queries) vs regular MGS plates
    special = (df["phot_query"] == "followup").to_numpy()
    faint = np.isfinite(r) & (r > C.R_PETRO_MAX)
    rm = (df["modelMag_r"] - df["extinction_r"]).to_numpy(float)
    stats["cut_r"].update({
        "special_plate_spectra": int(special.sum()),
        "special_plate_kept": int((special & m_r).sum()),
        "drop_fainter_special_plates": int((faint & special).sum()),
        "drop_fainter_regular_plates": int((faint & ~special).sum()),
        "regular_17p77_17p80": int((faint & ~special & (r <= 17.80)).sum()),
        "regular_fainter_17p9": int((faint & ~special & (r > 17.9)).sum()),
        "regular_fainter_17p9_model_r_also_faint": float(np.mean(
            rm[faint & ~special & (r > 17.9)] > C.R_PETRO_MAX)),
        "regular_fainter_17p9_r50_lt_1arcsec": float(np.mean(
            df["petroR50_r"].to_numpy(float)[faint & ~special & (r > 17.9)] < 1.0))})
    # compare to the core-sample photometry where both exist (diagnostic only)
    both = np.isfinite(df["core_petroMag_r"].to_numpy(float)) & np.isfinite(r)
    if both.any():
        d_raw = df["core_petroMag_r"].to_numpy(float)[both] - df["petroMag_r"].to_numpy(float)[both]
        d_cor = df["core_petroMag_r"].to_numpy(float)[both] - r[both]
        stats["core_vs_dr17_petroMag_r"] = {
            "n": int(both.sum()),
            "median(core - petroMag_r)": float(np.median(d_raw)),
            "median(core - (petroMag_r - A_r))": float(np.median(d_cor)),
            "frac |core-(petroMag_r-A_r)| < 0.01": float(np.mean(np.abs(d_cor) < 0.01)),
            "frac |core-petroMag_r| < 0.01": float(np.mean(np.abs(d_raw) < 0.01))}
    df = df[m_r].reset_index(drop=True)
    log(f"  SkyServer match {has_phot.mean():.4%}; after r cut {len(df):,}")

    # --- cut 4: one spectrum per DR17 photometric object ------------------------------
    # mgs_parent is unique by DR7 PHOTOID, but repeat spectra on overlapping plates were
    # sometimes tied to different DR7 imaging runs; DR17 resolves both to one objID.
    # Keep the higher-S/N spectrum, the same rule sr_parent.py uses.
    dup = df["objid"].duplicated(keep=False).to_numpy()
    dz_dup = (df[dup].groupby("objid")["z"].agg(lambda s: s.max() - s.min())
              if dup.any() else pd.Series(dtype=float))
    n_before = len(df)
    df = (df.sort_values("sn_median", ascending=False, kind="mergesort")
          .drop_duplicates("objid", keep="first").sort_index().reset_index(drop=True))
    stats["cut_unique_objid"] = {
        "rule": "one spectrum per DR17 objID (highest sn_median)",
        "objids_with_repeats": int(dz_dup.size), "drop": int(n_before - len(df)),
        "median_dz_between_repeats": float(dz_dup.median()) if dz_dup.size else None,
        "max_dz_between_repeats": float(dz_dup.max()) if dz_dup.size else None,
        "keep": int(len(df))}
    n = len(df)
    stats["sample"] = n
    log(f"  unique DR17 objID: {n:,} ({n_before - n:,} repeat spectra removed)")

    z = df["z"].to_numpy(float)
    cosmo = FlatLambdaCDM(H0=C.COSMO["H0"], Om0=C.COSMO["Om0"])
    zg = np.linspace(0.0, 0.32, 3201)
    da_kpc = cosmo.angular_diameter_distance(zg).to("kpc").value
    kpc_per_arcsec = np.interp(z, zg, da_kpc) * ARCSEC
    df["kpc_per_arcsec"] = kpc_per_arcsec

    # --- Galaxy Zoo 1 ----------------------------------------------------------------
    zoo = pd.read_parquet(C.ZOO_PARQUET)
    zoo_cols = ["p_el_debiased", "p_cs_debiased", "spiral", "elliptical", "uncertain", "nvote",
                "p_el", "p_cs"]
    zs = zoo.drop_duplicates("specobjid").set_index("specobjid")[zoo_cols]
    m1 = df[["specobjid"]].join(zs, on="specobjid")
    hit_spec = m1["nvote"].notna().to_numpy()
    zo = (zoo.sort_values("nvote", ascending=False).drop_duplicates("objid")
          .set_index("objid")[zoo_cols])
    m2 = df[["objid"]].join(zo, on="objid")
    hit_obj = m2["nvote"].notna().to_numpy() & ~hit_spec
    for c in zoo_cols:
        df[f"gz1_{c}"] = np.where(hit_spec, m1[c].to_numpy(float), m2[c].to_numpy(float))
    df.loc[~(hit_spec | hit_obj), [f"gz1_{c}" for c in zoo_cols]] = np.nan
    df["gz1_match"] = np.where(hit_spec, "specobjid", np.where(hit_obj, "objid", ""))
    stats["gz1_match"] = {"by_specobjid": int(hit_spec.sum()), "by_objid": int(hit_obj.sum()),
                          "total": int((hit_spec | hit_obj).sum()),
                          "rate": float((hit_spec | hit_obj).mean()),
                          "zoospec_rows": int(len(zoo))}
    log(f"  GZ1: {hit_spec.sum():,} by specObjID + {hit_obj.sum():,} by objID")

    # --- Lim+17 ----------------------------------------------------------------------
    lim = load_lim().reset_index(drop=True)
    lim_cols = [c for c in lim.columns if c != "lim_survey_id"]
    lim["lim_row"] = np.arange(len(lim))
    ours = pd.DataFrame({"row": np.arange(n), "objid": df["objid"].to_numpy(), "z": z})
    ex = ours.merge(lim[["lim_survey_id", "lim_row", "lim_zcmb"]], left_on="objid",
                    right_on="lim_survey_id", how="inner")
    # 12 survey IDs appear twice in Lim+17; keep the counterpart closest in redshift
    ex["_dz"] = np.abs(ex["lim_zcmb"] - ex["z"])
    n_dup = int(ex["row"].duplicated().sum())
    ex = ex.sort_values("_dz").drop_duplicates("row").sort_values("row")
    matched = np.zeros(n, bool)
    matched[ex["row"].to_numpy()] = True
    lim_used = np.zeros(len(lim), bool)
    lim_used[ex["lim_row"].to_numpy()] = True
    # positional fallback for the rest: nearest unused Lim galaxy within 2", |dz| < 0.01
    rest = np.flatnonzero(~matched)
    cand = np.flatnonzero(~lim_used)
    tree = cKDTree(unit_vectors(lim["lim_ra"].to_numpy()[cand], lim["lim_dec"].to_numpy()[cand]))
    chord = 2 * np.sin(C.LIM_POS_MATCH_ARCSEC * ARCSEC / 2)
    dist, idx = tree.query(unit_vectors(df["ra_phot"].to_numpy()[rest],
                                        df["dec_phot"].to_numpy()[rest]),
                           k=1, distance_upper_bound=chord)
    ok = np.isfinite(dist)
    sep_arcsec = np.full(len(rest), np.nan)
    sep_arcsec[ok] = 2 * np.arcsin(dist[ok] / 2) / ARCSEC
    pos_rows, pos_lim = rest[ok], cand[idx[ok]]
    dzp = np.abs(lim["lim_zcmb"].to_numpy()[pos_lim] - z[pos_rows])
    good = dzp < C.LIM_POS_MATCH_DZ
    n_pos_bad_dz = int((~good).sum())
    pos_rows, pos_lim, pos_sep = pos_rows[good], pos_lim[good], sep_arcsec[ok][good]
    # one-to-one: if two of ours hit one Lim galaxy, keep the closer
    order = np.argsort(pos_sep)
    _, first = np.unique(pos_lim[order], return_index=True)
    keep = order[first]
    n_pos_dup = int(len(pos_rows) - len(keep))
    pos_rows, pos_lim, pos_sep = pos_rows[keep], pos_lim[keep], pos_sep[keep]
    # assemble
    lim_idx = np.full(n, -1, np.int64)
    lim_idx[ex["row"].to_numpy()] = ex["lim_row"].to_numpy()
    lim_idx[pos_rows] = pos_lim
    has_lim = lim_idx >= 0
    for c in lim_cols:
        v = lim[c].to_numpy()
        col = np.full(n, np.nan)
        col[has_lim] = v[lim_idx[has_lim]]
        df[c] = col
    df["lim_match"] = np.where(matched, "objid", "")
    df.loc[pos_rows, "lim_match"] = "position"
    df["lim_sep_arcsec"] = np.nan
    df.loc[pos_rows, "lim_sep_arcsec"] = pos_sep
    zle = z <= 0.2
    stats["lim_match"] = {
        "exact_objid": int(matched.sum()), "positional": int(len(pos_rows)),
        "total": int(has_lim.sum()), "rate": float(has_lim.mean()),
        "rate_z_le_0.2": float(has_lim[zle].mean()),
        "rate_z_le_0.2_r_le_17.7": float(has_lim[zle & (df["r_petro_corr"].to_numpy() <= 17.7)].mean()),
        "exact_rate_z_le_0.2": float(matched[zle].mean()),
        "duplicate_survey_ids_resolved": n_dup,
        "positional_rejected_dz": n_pos_bad_dz, "positional_rejected_not_unique": n_pos_dup,
        "positional_median_sep_arcsec": float(np.median(pos_sep)) if len(pos_sep) else None,
        "lim_galaxies": int(len(lim))}
    log(f"  Lim+17: {matched.sum():,} exact + {len(pos_rows):,} positional "
        f"({has_lim.mean():.2%} of sample, {has_lim[zle].mean():.2%} at z<=0.2)")

    # --- ALFALFA -------------------------------------------------------------------
    stats["alfalfa"] = {"log_mhi": int(df["log_mhi"].notna().sum()),
                        "log_fgas": int(df["log_fgas"].notna().sum())}

    # =============================================================================
    # dimensions (physical units; NaN = missing)
    # =============================================================================
    D: dict[str, np.ndarray] = {}
    D["logM"] = df["log_mstar"].to_numpy(float)
    D["logSFR"] = finite_or_nan(df["log_sfr"])
    D["logsSFR"] = finite_or_nan(df["log_ssfr"])
    # continuum indices: valid only with a positive MPA error (HdA = 0, err = -1 on failure)
    ie = df[KEY].merge(load_index_errors(), on=KEY, how="left")
    df["d4000_n_err"] = ie["d4000_n_err"].to_numpy(float)
    df["hdelta_a_err"] = ie["hdelta_a_err"].to_numpy(float)
    df["tauv_cont"] = ie["tauv_cont"].to_numpy(float)
    d4 = finite_or_nan(df["d4000_n"])
    hd = finite_or_nan(df["hdelta_a"])
    ok_d4 = df["d4000_n_err"].to_numpy(float) > 0
    ok_hd = df["hdelta_a_err"].to_numpy(float) > 0
    D["D4000"] = np.where(ok_d4, d4, np.nan)
    D["HdA"] = np.where(ok_hd, hd, np.nan)
    stats["index_errors"] = {
        "d4000_err_nonpositive": int((~ok_d4).sum()),
        "d4000_err_nonpositive_in_range": int((~ok_d4 & (d4 >= 0.8) & (d4 <= 2.6)).sum()),
        "hda_err_nonpositive": int((~ok_hd).sum()),
        "hda_err_nonpositive_in_range": int((~ok_hd & (hd >= -6) & (hd <= 12)).sum()),
        "hda_exact_zero_with_bad_err": int((~ok_hd & (hd == 0)).sum())}
    # Lim+17 color, minus the fixed placeholder colors given to photometric outliers
    lc = finite_or_nan(df["lim_color"])
    gr_obs = ((df["modelMag_g"] - df["extinction_g"]) - (df["modelMag_r"] - df["extinction_r"])
              ).to_numpy(float)
    at_ph = np.isin(np.rint(lc * 1000), np.rint(np.array(C.LIM_COLOR_PLACEHOLDERS) * 1000))
    placeholder = at_ph & ~(np.abs(gr_obs - lc) <= C.LIM_COLOR_PLACEHOLDER_TOL)
    df["lim_color_placeholder"] = placeholder
    D["gr"] = np.where(placeholder, np.nan, lc)
    stats["lim_color_placeholders"] = {
        "values": list(C.LIM_COLOR_PLACEHOLDERS), "at_placeholder_values": int(at_ph.sum()),
        "set_missing": int(placeholder.sum()),
        "kept_consistent_with_own_colour": int((at_ph & ~placeholder).sum())}
    D["OH"] = finite_or_nan(df["oh"])

    # lines (rescaled errors)
    sn = {s: snr(df, s) for s in C.LINE_ERR_SCALE}
    f = {s: df[f"f_{s}"].to_numpy(float) for s in C.LINE_ERR_SCALE}
    ok_n2 = (sn["nii"] > C.LINE_SNR_MIN) & (sn["ha"] > C.LINE_SNR_MIN)
    ok_o3 = (sn["oiii"] > C.LINE_SNR_MIN) & (sn["hb"] > C.LINE_SNR_MIN)
    n2ha = log_ratio(f["nii"], f["ha"], ok_n2)
    o3hb = log_ratio(f["oiii"], f["hb"], ok_o3)
    D["N2Ha"], D["O3Hb"] = n2ha, o3hb

    # dust: stellar continuum attenuation and the Balmer decrement (both 3" fiber)
    tauv = finite_or_nan(df["tauv_cont"], lo=-1000)
    D["AV"] = C.TAUV_TO_AV * tauv
    ok_bd = (sn["ha"] > C.LINE_SNR_MIN) & (sn["hb"] > C.LINE_SNR_MIN)
    D["HaHb"] = log_ratio(f["ha"], f["hb"], ok_bd)
    stats["dust"] = {"tauv_finite": int(np.isfinite(tauv).sum()),
                     "tauv_negative": int((tauv < 0).sum()),
                     "balmer_sn": int(ok_bd.sum()),
                     "balmer_below_case_b": int((D["HaHb"] < np.log10(2.86)).sum())}

    # PP04 O3N2 for MPA BPT-SF galaxies with S/N>3 (rescaled) in all four lines
    bptc = df["bptclass"].to_numpy(float)
    o3n2 = o3hb - n2ha
    k03 = np.full(n, False)
    fin = np.isfinite(n2ha) & np.isfinite(o3hb)
    k03[fin] = (n2ha[fin] < 0.05) & (o3hb[fin] < 0.61 / (n2ha[fin] - 0.05) + 1.3)
    m_pp = ((bptc == 1) & np.isfinite(o3n2) & (o3n2 > C.PP04_O3N2_RANGE[0])
            & (o3n2 < C.PP04_O3N2_RANGE[1]))
    D["OH_PP04"] = np.where(m_pp, C.PP04_A + C.PP04_B * o3n2, np.nan)
    stats["pp04"] = {
        "mpa_sf": int((bptc == 1).sum()),
        "mpa_sf_with_4line_sn": int(((bptc == 1) & fin).sum()),
        "o3n2_out_of_validity": int(((bptc == 1) & fin & ~m_pp).sum()),
        "mpa_sf_4line_but_above_K03_on_rescaled": int(((bptc == 1) & fin & ~k03).sum()),
        "mpa_sf2_with_4line_sn": int(((bptc == 2) & fin).sum()),
        "value": int(m_pp.sum())}

    r50 = finite_or_nan(df["petroR50_r"], lo=0.0)
    r90 = finite_or_nan(df["petroR90_r"], lo=0.0)
    r50_kpc = r50 * kpc_per_arcsec
    with np.errstate(divide="ignore", invalid="ignore"):
        D["logR50"] = np.log10(r50_kpc)
        D["C"] = r90 / r50
        D["logSigma"] = D["logM"] - np.log10(2 * np.pi * r50_kpc ** 2)
    frac = df["fracDeV_r"].to_numpy(float)
    ba = np.where(frac < 0.5, df["expAB_r"].to_numpy(float), df["deVAB_r"].to_numpy(float))
    D["ba"] = np.where(np.isfinite(frac), ba, np.nan)
    D["pEl"] = finite_or_nan(df["gz1_p_el_debiased"], lo=-1)

    # velocity dispersion: validity on the fiber measurement, then the J95 correction
    vd = df["v_disp"].to_numpy(float)
    vde = df["v_disp_err"].to_numpy(float)
    ok_v = ((vd > C.SIGV_MIN) & (vd < C.SIGV_MAX) & (vde > 0) & (vde < C.SIGV_MAXFRACERR * vd)
            & np.isfinite(r50))
    with np.errstate(divide="ignore", invalid="ignore"):
        sig_corr = vd * (C.FIBER_RADIUS_ARCSEC / (r50 / 8.0)) ** C.J95_EXP
        D["logSigV"] = np.where(ok_v, np.log10(sig_corr), np.nan)
        D["mu50"] = (df["r_petro_corr"].to_numpy(float) + 2.5 * np.log10(2 * np.pi * r50 ** 2)
                     - 10 * np.log10(1 + z))
    stats["sigv"] = {"v_disp_zero": int((vd <= 0).sum()), "valid_fibre": int(ok_v.sum()),
                     "median_correction_dex": float(np.nanmedian(np.log10(
                         (C.FIBER_RADIUS_ARCSEC / (r50[ok_v] / 8.0)) ** C.J95_EXP)))}
    D["logfHI"] = finite_or_nan(df["log_fgas"])
    D["logMh"] = finite_or_nan(df["lim_logMh_h"]) - np.log10(C.H_LITTLE)
    D["z"] = z.copy()

    # range cuts
    dim_stats = {}
    for spec in C.DIMS:
        k = spec["key"]
        x = D[k]
        fin = np.isfinite(x)
        inr = fin & (x >= spec["min"]) & (x <= spec["max"])
        dim_stats[k] = {"finite": int(fin.sum()), "valid": int(inr.sum()),
                        "out_of_range": int((fin & ~inr).sum()),
                        "below": int((fin & (x < spec["min"])).sum()),
                        "above": int((fin & (x > spec["max"])).sum())}
        df[k] = np.where(inr, x, np.nan)
    stats["dims"] = dim_stats

    # =============================================================================
    # categories
    # =============================================================================
    # bpt: MPA 1,2,3 -> 1,2,3; MPA 4 -> 4 Seyfert / 5 LINER by Schawinski+07; 5 -> 6; -1 -> 7
    bpt = np.zeros(n, np.uint8)
    bpt[bptc == 1] = 1
    bpt[bptc == 2] = 2
    bpt[bptc == 3] = 3
    bpt[bptc == 5] = 6
    bpt[bptc == -1] = 7
    is4 = bptc == 4
    # split with our rescaled-S/N ratios; where one is missing (rescaled S/N < 3) fall back to
    # the ratio of the measured fluxes, which MPA already required at S/N > 3 to call it AGN
    n2_split = np.where(np.isfinite(n2ha), n2ha, log_ratio(f["nii"], f["ha"], np.ones(n, bool)))
    o3_split = np.where(np.isfinite(o3hb), o3hb, log_ratio(f["oiii"], f["hb"], np.ones(n, bool)))
    can = is4 & np.isfinite(n2_split) & np.isfinite(o3_split)
    sey = can & (o3_split > C.S07_SLOPE * n2_split + C.S07_ICPT)
    bpt[is4 & sey] = 4
    bpt[is4 & can & ~sey] = 5
    bpt[is4 & ~can] = 7   # never happens in DR8 (all class-4 fluxes are positive); kept safe
    stats["bpt_split"] = {
        "mpa4": int(is4.sum()),
        "mpa4_with_rescaled_ratios": int((is4 & np.isfinite(n2ha) & np.isfinite(o3hb)).sum()),
        "mpa4_split_on_raw_flux_ratio": int((is4 & can & ~(np.isfinite(n2ha) & np.isfinite(o3hb))).sum()),
        "mpa4_unsplittable_to_7": int((is4 & ~can).sum()),
        "seyfert": int((bpt == 4).sum()), "liner": int((bpt == 5).sum())}
    df["bpt"] = bpt

    env = np.zeros(n, np.uint8)
    nmem = df["lim_nmem"].to_numpy(float)
    iscen = df["lim_galaxy_id"].to_numpy(float) == df["lim_cen_id"].to_numpy(float)
    env[has_lim & (nmem == 1)] = 1
    env[has_lim & (nmem >= 2) & iscen] = 2
    env[has_lim & (nmem >= 2) & ~iscen] = 3
    # a sole member is its group's central by construction (verified: 0 exceptions in Lim+17)
    stats["env_anomalies"] = {"nmem1_not_central": int((has_lim & (nmem == 1) & ~iscen).sum())}
    df["env"] = env

    morph = np.zeros(n, np.uint8)
    el = df["gz1_elliptical"].to_numpy(float) == 1
    sp = df["gz1_spiral"].to_numpy(float) == 1
    un = df["gz1_uncertain"].to_numpy(float) == 1
    has_gz = df["gz1_match"].to_numpy() != ""
    nflags = el.astype(int) + sp.astype(int) + un.astype(int)
    morph[has_gz & el & (nflags == 1)] = 1
    morph[has_gz & sp & (nflags == 1)] = 2
    morph[has_gz & (un | (nflags != 1))] = 3
    stats["morph_anomalies"] = {"flags_not_exactly_one": int((has_gz & (nflags != 1)).sum())}
    df["morph"] = morph

    stats["cats"] = {c["key"]: {str(k): int((df[c["key"]].to_numpy() == k).sum())
                                for k in range(0, 8)} for c in C.CATS}

    # local 160 px cutouts (exact filenames; a set from os.listdir, not a stat per file)
    import os
    if not C.IMAGES_SDSS.exists() and not C.IMAGES_EXTRA.exists() and C.CATALOG_PARQUET.exists():
        # this machine has no cutouts: keep the previous build's paths rather than erase them
        prev = pd.read_parquet(C.CATALOG_PARQUET, columns=["objid", "local_image"])
        df["local_image"] = (df[["objid"]].merge(prev.drop_duplicates("objid"), on="objid",
                                                 how="left")["local_image"].fillna("").to_numpy())
        prev_stats = (json.loads(C.BUILD_STATS.read_text()).get("local_images", {})
                      if C.BUILD_STATS.exists() else {})
        stats["local_images"] = {**prev_stats, "carried_over_from_previous_build": True}
        log(f"  no image directories here: carried over {(df['local_image'] != '').sum():,} "
            "local_image paths from the previous catalog")
        return _finish(df, stats, t0)
    sdss_files = set(os.listdir(C.IMAGES_SDSS)) if C.IMAGES_SDSS.exists() else set()
    extra_files = set(os.listdir(C.IMAGES_EXTRA)) if C.IMAGES_EXTRA.exists() else set()
    f_sdss = df["objid"].astype(str) + ".jpg"
    f_extra = ("p" + df["plate"].astype(str) + "-" + df["mjd"].astype(str) + "-"
               + df["fiber"].astype(str) + ".jpg")
    in_sdss = f_sdss.isin(sdss_files).to_numpy()
    in_extra = f_extra.isin(extra_files).to_numpy()
    rel_sdss = "data/images-sdss/" + f_sdss
    rel_extra = "data/images-extra/" + f_extra
    df["local_image"] = np.where(in_sdss, rel_sdss, np.where(in_extra, rel_extra, ""))
    stats["local_images"] = {"images_sdss_files": len(sdss_files),
                             "images_extra_files": len(extra_files),
                             "matched_sdss": int(in_sdss.sum()),
                             "matched_extra_only": int((in_extra & ~in_sdss).sum()),
                             "total": int((in_sdss | in_extra).sum())}

    return _finish(df, stats, t0)


def _finish(df: pd.DataFrame, stats: dict, t0: float) -> tuple[pd.DataFrame, dict]:
    # image_id cross-check: the core sample's objID must equal the DR17 objID
    core = df["in_core"].to_numpy(bool)
    stats["core_objid_agrees"] = {
        "core": int(core.sum()),
        "image_id_equals_dr17_objid": int((df["image_id"].astype(str) == df["objid"]).to_numpy()[core].sum())}
    stats["elapsed_s"] = round(time.time() - t0, 1)
    return df, stats


def main() -> None:
    df, stats = build()
    keep = (["objid", "specobjid", "plate", "mjd", "fiber", "ra_phot", "dec_phot", "ra", "dec",
             "z", "z_dr17", "photoid", "phot_query", "in_core", "in_imaging", "image_id",
             "local_image",
             "petroMag_r", "extinction_r", "r_petro_corr", "petroR50_r", "petroR90_r",
             "modelMag_u", "modelMag_g", "modelMag_r", "modelMag_i", "modelMag_z",
             "extinction_u", "extinction_g", "extinction_i", "extinction_z",
             "deVAB_r", "expAB_r", "fracDeV_r", "kpc_per_arcsec",
             "v_disp", "v_disp_err", "sn_median", "bptclass", "d4000_n_err", "hdelta_a_err",
             "tauv_cont",
             "lim_color_placeholder",
             "log_mstar", "log_sfr", "log_ssfr", "oh", "log_mhi", "log_fgas", "hi_w50", "agc",
             "gz1_match", "gz1_nvote", "gz1_p_el_debiased", "gz1_p_cs_debiased", "gz1_elliptical",
             "gz1_spiral", "gz1_uncertain",
             "lim_match", "lim_sep_arcsec", "lim_galaxy_id", "lim_group_id", "lim_cen_id",
             "lim_nmem", "lim_logMh_h", "lim_io", "lim_fedge", "lim_zcmb", "lim_logMs",
             "lim_color"]
            + C.DIM_KEYS + C.CAT_KEYS)
    keep = list(dict.fromkeys(keep))   # the 'z' dimension is the redshift column itself
    out = df[keep].rename(columns={"ra": "ra_spec", "dec": "dec_spec"})
    out = out.rename(columns={"ra_phot": "ra", "dec_phot": "dec"})
    for c in ["lim_galaxy_id", "lim_group_id", "lim_cen_id", "lim_nmem", "lim_io"]:
        out[c] = out[c].astype("Int64")
    out["agc"] = out["agc"].astype("Int64")
    out.to_parquet(C.CATALOG_PARQUET, index=False)
    C.BUILD_STATS.write_text(json.dumps(stats, indent=1))
    log(f"wrote {C.CATALOG_PARQUET} ({len(out):,} rows, {out.shape[1]} columns) in "
        f"{stats['elapsed_s']}s")
    for k, v in stats["dims"].items():
        log(f"  {k:9s} valid {v['valid']:>8,}  out-of-range {v['out_of_range']:>7,}")


if __name__ == "__main__":
    main()
