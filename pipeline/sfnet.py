#!/usr/bin/env python3
"""Sparse feature network (SFNet) activations from Wu (2025, ApJ, 980, 183), joined by objID.

The paper trains a ResNet18 with a top-k (k = 4) layer before its linear head to predict the
[NII]6584, Halpha, [OIII]5007 and Hbeta fluxes from 144 px gri cutouts, for the 250,207 SDSS
galaxies with S/N > 3 in all four lines. Its Table 1, Figure 2 and Figure 3 study the four
most frequently active features, SL 17, SL 138, SL 157 and SL 322, on the 20% validation set.
`activations.npy` in the sparse-feature-networks results holds those validation activations
(50,041 x 512, in validation-loader order), and this module joins them to the sample.

Validation order. The paper's fastai `RandomSplitter(0.2, seed=256)` calls
`torch.manual_seed(256)` and takes the first int(0.2 n) entries of `torch.randperm(n)` as
the validation set, in that order. On the CPU, `torch.randperm` is a Fisher-Yates shuffle
driven by the 32-bit MT19937 stream: element i swaps with i + (r_i mod (n - i)). numpy's
legacy `RandomState(256)` seeds MT19937 the same way, so the permutation is rebuilt here
without torch. `check()` confirms it against the sibling project's own feature-17 catalog.

Values. A_SL = activation / max over the validation set, the paper's 0-1 "scaled activation
strength" (Section 3; Figure 2 draws it from 0 to 1; Figure 3's equations use it). Zero means
the feature is off. Following the paper, these are the 512 pooled features before the top-k
step (its Table 1 percentages count them), so a galaxy can show more than four non-zero
features. The top-k step would zero 9-27% of each feature's non-zero values, all of them weak.

The published weights (resnet18-topk_4-bpt_lines.pth, also on Zenodo record 14712542) do not
reproduce activations.npy: the same eight features fire, but per-feature correlations with
the saved activations are only 0.3 to 0.8 under every input normalization tried. The weights
are probably those of a sibling training run. So only the paper's validation galaxies have
values here; inference on the training galaxies would show a different model's features.

    python3 pipeline/sfnet.py     run the checks and print the join summary
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config as C  # noqa: E402

LINES = [("nii_6584_flux", "nii_6584_flux_err"), ("h_alpha_flux", "h_alpha_flux_err"),
         ("oiii_5007_flux", "oiii_5007_flux_err"), ("h_beta_flux", "h_beta_flux_err")]


def log(msg: str) -> None:
    print(msg, flush=True)


def paper_sample() -> pd.DataFrame:
    """The paper's 250,207 galaxies, in galaxies.csv order (sparse-feature-networks
    src/dataloader.py `prepare_data` for target bpt_lines)."""
    df = pd.read_csv(C.SFNET_GALAXIES, dtype={"objID": str, "DR7ObjID": str, "specObjID": str})
    keep = np.ones(len(df), dtype=bool)
    for flux, err in LINES:
        keep &= (df[flux] / df[err] > 3) & (df[flux] < 1e5)
    return df[keep].reset_index(drop=True)


def randperm(n: int, seed: int) -> np.ndarray:
    """torch.manual_seed(seed); torch.randperm(n) on the CPU, with numpy."""
    r = np.random.RandomState(seed).randint(0, 2**32, size=n - 1, dtype=np.uint64)
    j = np.arange(n - 1, dtype=np.uint64)
    z = (r % (np.uint64(n) - j)).astype(np.int64) + np.arange(n - 1)
    p = np.arange(n)
    for i in range(n - 1):
        k = z[i]
        p[i], p[k] = p[k], p[i]
    return p


def validation_set() -> tuple[pd.DataFrame, int]:
    """The paper's validation galaxies, in the order of the rows of activations.npy, and the
    size of the whole paper sample."""
    src = paper_sample()
    nval = int(C.SFNET_VALID_PCT * len(src))
    return src.iloc[randperm(len(src), C.SFNET_SEED)[:nval]].reset_index(drop=True), len(src)


def load() -> tuple[pd.DataFrame, dict, pd.DataFrame]:
    """objid plus one A_SL column per feature (keys from config.SFNET_FEATURES), one row per
    validation galaxy; the numbers REPORT.md quotes; and the validation rows themselves."""
    valid, n_paper = validation_set()
    act = np.load(C.SFNET_ACTIVATIONS)
    if act.shape[0] != len(valid):
        raise RuntimeError(f"activations.npy has {act.shape[0]} rows, the split gives "
                           f"{len(valid)}")
    top4 = np.argsort(-act, axis=1)[:, :4]
    out = pd.DataFrame({"objid": valid["objID"].to_numpy()})
    stats = {"paper_sample": n_paper, "validation": int(len(valid)), "features": {}}
    for key, f in C.SFNET_FEATURES.items():
        a = act[:, f].astype(np.float64)
        on = a > 0
        out[key] = a / a.max()
        # how often the top-k step would zero the feature (the paper's numbers do not apply it)
        cut = on & ~(top4 == f).any(axis=1)
        stats["features"][key] = {
            "index": f, "raw_max": round(float(a.max()), 6), "active": int(on.sum()),
            "f_active": round(float(on.mean()), 4), "zeroed_by_topk": int(cut.sum()),
            "zeroed_by_topk_median_A": round(float(np.median(out[key].to_numpy()[cut])), 4)
            if cut.any() else 0.0}
    return out, stats, valid


def check(out: pd.DataFrame, stats: dict, valid: pd.DataFrame) -> dict:
    """Independent confirmations that the rows line up with the paper's validation set."""
    res = {}
    # Table 1 activation fractions
    want = C.SFNET_TABLE1_FACTIVE
    got = {k: round(100 * v["f_active"], 1) for k, v in stats["features"].items()}
    res["table1_f_active"] = {"paper": want, "here": got, "ok": got == want}
    # the sibling project's own catalog of feature 17 (objID, scaled activation), when present
    if C.SFNET_CHECK.exists():
        chk = pd.read_csv(C.SFNET_CHECK, dtype={"objID": str},
                          usecols=["objID", "activation_17_norm"])
        m = chk.merge(out[["objid", "SL17"]], left_on="objID", right_on="objid", how="left")
        diff = np.abs(m["SL17"].to_numpy() - m["activation_17_norm"].to_numpy())
        res["feature17_catalog"] = {"rows": int(len(chk)),
                                    "matched": int(np.isfinite(diff).sum()),
                                    "max_abs_diff": float(np.nanmax(diff)),
                                    "ok": bool(np.isfinite(diff).all() and np.nanmax(diff) < 1e-5)}
    # the four activations predict the BPT line ratios only if each row is the right galaxy
    # (a linear fit gives R2 ~0.75 and ~0.44; a misaligned join would give ~0)
    X = np.column_stack([np.ones(len(out))] + [out[k].to_numpy() for k in C.SFNET_FEATURES])
    r2 = {}
    for name, num, den in [("N2Ha", "nii_6584_flux", "h_alpha_flux"),
                           ("O3Hb", "oiii_5007_flux", "h_beta_flux")]:
        y = np.log10(valid[num].to_numpy() / valid[den].to_numpy())
        beta, *_ = np.linalg.lstsq(X, y, rcond=None)
        r2[name] = round(float(1 - np.var(y - X @ beta) / np.var(y)), 3)
    res["line_ratio_r2"] = {"here": r2, "ok": r2["N2Ha"] > 0.5 and r2["O3Hb"] > 0.25}
    res["ok"] = all(x["ok"] for x in res.values() if isinstance(x, dict))
    return res


def main() -> int:
    out, stats, valid = load()
    res = check(out, stats, valid)
    for k, v in res.items():
        log(f"  {k}: {v}")
    for k, v in stats["features"].items():
        log(f"  {k}: {v}")
    if C.GALAXIES_PARQUET.exists():
        g = pd.read_parquet(C.GALAXIES_PARQUET, columns=["objid"])
        log(f"  in the exported sample: {out['objid'].isin(set(g['objid'])).sum():,} of "
            f"{len(out):,}")
    log("SFNET CHECKS " + ("PASSED" if res["ok"] else "FAILED"))
    return 0 if res["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
