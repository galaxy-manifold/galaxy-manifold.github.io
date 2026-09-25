#!/usr/bin/env python3
"""Representative galaxy thumbnails for mosaic mode (DESIGN.md section 8 and the thumbs parts
of section 5).

    python3 pipeline/thumbs.py select     k-means representatives -> cache/thumbs_select.npz
    python3 pipeline/thumbs.py estimate   how many cutouts have to be downloaded
    python3 pipeline/thumbs.py fetch      download the missing cutouts (resumable, <=6 at once)
    python3 pipeline/thumbs.py build      QA + substitutions, 64 px JPEGs, index/crop, manifest
    python3 pipeline/thumbs.py sheets     contact sheets for eyeballing
    python3 pipeline/thumbs.py verify     re-read everything and check it is consistent
    python3 pipeline/thumbs.py all        select (if needed), fetch, build, sheets, verify

Selection. MiniBatchKMeans with K = 16,000 clusters on the standardized features
[logM, logsSFR, logR50, C, gr, D4000, z] (u = (x - center) / scale, the manifest's center
and scale). Each cluster's members are ranked by distance to the centroid. The nearest one
represents the cluster, except that among the 5 nearest a member with a local cutout is
preferred when it lies within 1.5x the nearest distance. `gr` (Lim+17) is missing for 14% of
the sample (the southern stripes and everything at z > 0.2). For the clustering only, those
galaxies get a colour predicted from their DR17 extinction-corrected model g-r and z (a
cubic-by-quadratic polynomial fit to the galaxies that have both, robust scatter 0.001 mag).
No exported value changes.

Sources. Local cutouts (data/images-sdss, data/images-extra) are 160x160 px at 0.262"/px
from the Legacy Survey viewer's `sdss` layer. The rest are fetched from the same service
with the same parameters into pipeline/cache/cutouts/<plate>-<mjd>-<fiber>.jpg.

Rejections. A representative whose cutout cannot be fetched, or whose cutout fails the
quality checks in QA_RULES (blank or no-data fill, a tinted or washed-out sky, stellar glare,
paler scattered-light haze or one side of the crop tinted by a star just outside it, a
satellite or asteroid trail across the crop, a bright star
or much brighter neighbour, nothing at the centre, or a brightness peak that is not at the
centre), is replaced by the next-best member of its cluster under the same rule.
Every rejection is kept in pipeline/cache/thumbs_rejects.json, so each step can be re-run and
picks up where it stopped. Rate-limit answers (HTTP 429) never count against a galaxy.

Thumbnails. A centred square of side clip(3 petroR90_r, 12", 42") (capped at the 160 px
source, 41.92"), Lanczos-resized to 64x64 and saved as JPEG q=88 without metadata, at
site/data/thumbs/<k // 1000>/<k>.jpg. Thumbnails are numbered in ascending row order, so,
like the rows themselves, any prefix of them is a random subsample.
thumbs/index.u32.gz holds the row of each thumbnail and thumbs/crop.f32.gz its crop side in
arcsec (little-endian, gzip level 9, mtime 0).
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import os
import random
import shutil
import sys
import threading
import time
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config as C  # noqa: E402

# ---------------------------------------------------------------------------------------
# constants (DESIGN.md section 8)
# ---------------------------------------------------------------------------------------
K_TARGET = 16000
FEATURES = ["logM", "logsSFR", "logR50", "C", "gr", "D4000", "z"]
N_PREFER = 5              # among the 5 nearest members ...
PREFER_FACTOR = 1.5       # ... prefer one with a local cutout within 1.5x the nearest distance

KMEANS = dict(batch_size=16384, n_init=3, max_iter=60, max_no_improvement=40, tol=0.0,
              reassignment_ratio=0.01)

SRC_SIZE = 160            # px
PIXSCALE = 0.262          # arcsec / px
CROP_FACTOR = 3.0         # x petroR90_r
CROP_MIN, CROP_MAX = 12.0, 42.0
THUMB = 64
JPEG_QUALITY = 88
SHARD = 1000

CUTOUT_URL = "https://www.legacysurvey.org/viewer/cutout.jpg"
LAYER = "sdss"
MIN_BYTES = 1000          # the viewer sometimes answers 200 with a truncated body
WORKERS = 4               # concurrent requests (DESIGN.md allows <= 6; the viewer is shared)
RATE = 2.0                # requests / s to start with; AIMD between RATE_MIN and RATE_MAX
RATE_MIN, RATE_MAX = 0.3, 2.5
COOLDOWN = 20.0           # s of global pause after a 429/503 (doubling while they continue)
RETRIES = 6               # attempts per cutout, not counting rate-limit answers
MAX_THROTTLED = 25        # 429/503 answers for one cutout before giving up for this run
TIMEOUT = 60
USER_AGENT = ("galaxy-manifold-viz/0.1 thumbnail builder (research use; <=4 concurrent, "
              "<=2.5 requests/s, backs off on 429; python-requests)")
BREAKER = 30              # consecutive network failures -> stop and retry later

CUTOUT_DIR = C.CACHE / "cutouts"
SELECT_NPZ = C.CACHE / "thumbs_select.npz"
REJECTS_JSON = C.CACHE / "thumbs_rejects.json"
FETCH_LEDGER = C.CACHE / "thumbs_fetch_failures.json"
FETCH_LOG = C.CACHE / "thumbs_fetch.log"
QA_PARQUET = C.CACHE / "thumbs_qa.parquet"
STATS_JSON = C.CACHE / "thumbs_stats.json"
CONTACT_PNG = C.CACHE / "thumbs_contact.png"
CONTACT_SIZE_PNG = C.CACHE / "thumbs_contact_size.png"
REJECTS_PNG = C.CACHE / "thumbs_rejects.png"
OUT = C.SITE_DATA / "thumbs"
MANIFEST = C.SITE_DATA / "manifest.json"

THUMBS_BLOCK = {
    "count": None, "size": THUMB, "shard": SHARD,
    "index": "thumbs/index.u32.gz", "crop": "thumbs/crop.f32.gz",
    "url": "thumbs/{shard}/{k}.jpg", "pixscale": PIXSCALE,
    "source": "SDSS gri via Legacy Survey viewer (layer=sdss)",
}

CATALOG_COLS = ["objid", "plate", "mjd", "fiber", "ra", "dec", "z", "petroR50_r",
                "petroR90_r", "local_image", "modelMag_g", "modelMag_r", "extinction_g",
                "extinction_r"] + [f for f in FEATURES if f != "z"]


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def gz(data: bytes) -> bytes:
    return gzip.compress(data, compresslevel=9, mtime=0)


def read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def write_json(path: Path, obj) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(obj, indent=1, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


# ---------------------------------------------------------------------------------------
# catalogue
# ---------------------------------------------------------------------------------------
def order_hash(objid: pd.Series) -> str:
    """Same hash export_web.py stores in export_stats.json."""
    return hashlib.sha1("\n".join(objid.astype(str)).encode()).hexdigest()


def load_catalog() -> pd.DataFrame:
    df = pd.read_parquet(C.GALAXIES_PARQUET, columns=CATALOG_COLS)
    stats = read_json(C.EXPORT_STATS, {})
    h = order_hash(df["objid"])
    if stats.get("order_hash") != h:
        raise SystemExit(f"galaxies.parquet order hash {h} does not match export_stats.json "
                         f"({stats.get('order_hash')}); re-run export_web.py first")
    man = read_json(MANIFEST, {})
    if man.get("n") != len(df):
        raise SystemExit(f"manifest n={man.get('n')} but galaxies.parquet has {len(df)} rows")
    df["local_image"] = df["local_image"].fillna("")
    df.attrs["order_hash"] = h
    return df


def dim_specs() -> dict:
    return {d["key"]: d for d in read_json(MANIFEST, {})["dims"]}


def cutout_path(plate: int, mjd: int, fiber: int) -> Path:
    return CUTOUT_DIR / f"{int(plate)}-{int(mjd)}-{int(fiber)}.jpg"


def source_path(df: pd.DataFrame, row: int) -> tuple[Path, str]:
    """(path, kind) of the 160 px cutout for a row: a local file if there is one, else the
    fetch cache location (which may not exist yet)."""
    li = df.at[row, "local_image"]
    if li:
        return C.ROOT / li, ("local-extra" if "images-extra" in li else "local-sdss")
    return cutout_path(df.at[row, "plate"], df.at[row, "mjd"], df.at[row, "fiber"]), "fetched"


# ---------------------------------------------------------------------------------------
# colour imputation (clustering features only)
# ---------------------------------------------------------------------------------------
def _gr_design(c: np.ndarray, z: np.ndarray) -> np.ndarray:
    c = np.clip(c, -0.5, 2.5)
    t = np.clip(z, 0.0, 0.3) - 0.1
    return np.stack([np.ones_like(c), c, c ** 2, c ** 3, t, t * c, t * c ** 2, t * c ** 3,
                     t ** 2, t ** 2 * c, t ** 2 * c ** 2], axis=1)


def impute_gr(df: pd.DataFrame) -> tuple[np.ndarray, np.ndarray, dict]:
    """Lim+17 0.1(g-r) where present; elsewhere a prediction from the DR17 extinction-corrected
    model colour and z. Returns (gr_filled, imputed_mask, fit_info)."""
    gro = ((df["modelMag_g"] - df["extinction_g"])
           - (df["modelMag_r"] - df["extinction_r"])).to_numpy(np.float64)
    z = df["z"].to_numpy(np.float64)
    gr = df["gr"].to_numpy(np.float64)
    both = np.isfinite(gro) & np.isfinite(gr) & np.isfinite(z) & (gro > -0.5) & (gro < 2.5)
    X, y = _gr_design(gro[both], z[both]), gr[both]
    keep = np.ones(len(y), bool)
    for _ in range(4):
        beta, *_ = np.linalg.lstsq(X[keep], y[keep], rcond=None)
        res = y - X @ beta
        sig = 1.4826 * np.median(np.abs(res[keep]))
        keep = np.abs(res) < 5 * sig
    fill = ~np.isfinite(gr) & np.isfinite(gro) & np.isfinite(z)
    out = gr.copy()
    out[fill] = _gr_design(gro[fill], z[fill]) @ beta
    info = {"n_fit": int(keep.sum()), "robust_sigma_mag": round(float(sig), 5),
            "coef": [round(float(b), 6) for b in beta], "n_imputed": int(fill.sum())}
    return out, fill, info


# ---------------------------------------------------------------------------------------
# select
# ---------------------------------------------------------------------------------------
def cmd_select(args) -> None:
    from sklearn.cluster import MiniBatchKMeans

    t0 = time.time()
    df = load_catalog()
    spec = dim_specs()
    gr_fill, imputed, gr_info = impute_gr(df)
    X = np.stack([gr_fill if k == "gr" else df[k].to_numpy(np.float64) for k in FEATURES], 1)
    r90 = df["petroR90_r"].to_numpy(np.float64)
    ok = np.isfinite(X).all(1) & np.isfinite(r90) & (r90 > 0)
    rows = np.flatnonzero(ok)
    center = np.array([spec[k]["center"] for k in FEATURES])
    scale = np.array([spec[k]["scale"] for k in FEATURES])
    U = (X[ok] - center) / scale
    log(f"select: {ok.sum():,} of {len(df):,} galaxies have all {len(FEATURES)} features "
        f"({(imputed & ok).sum():,} with imputed gr); K = {K_TARGET}")

    km = MiniBatchKMeans(n_clusters=K_TARGET, random_state=C.SEED, compute_labels=False,
                         **KMEANS)
    km.fit(U)
    log(f"  MiniBatchKMeans: {km.n_iter_} epochs, {km.n_steps_} steps, "
        f"{time.time() - t0:.0f} s")
    centers = km.cluster_centers_
    lab = km.predict(U)
    dist = np.linalg.norm(U - centers[lab], axis=1)
    inertia = float((dist ** 2).sum())

    # keep non-empty clusters, renumbered 0..K-1 in their original order
    counts = np.bincount(lab, minlength=K_TARGET)
    live = np.flatnonzero(counts > 0)
    remap = np.full(K_TARGET, -1)
    remap[live] = np.arange(len(live))
    lab = remap[lab]
    order = np.lexsort((dist, lab))
    ptr = np.searchsorted(lab[order], np.arange(len(live) + 1))
    np.savez_compressed(
        SELECT_NPZ,
        rows=rows[order].astype(np.int64), dist=dist[order].astype(np.float32),
        ptr=ptr.astype(np.int64), centers=centers[live].astype(np.float32),
        features=np.array(FEATURES), center=center, scale=scale,
        imputed_rows=np.flatnonzero(imputed & ok).astype(np.int64),
        order_hash=np.array(df.attrs["order_hash"]), seed=np.array(C.SEED))
    sizes = np.diff(ptr)
    info = {
        "k_target": K_TARGET, "k": int(len(live)), "empty_clusters": int(K_TARGET - len(live)),
        "n_features_valid": int(ok.sum()), "n_gr_imputed": int((imputed & ok).sum()),
        "gr_imputation": gr_info, "kmeans": dict(KMEANS, random_state=C.SEED,
                                                 n_iter=int(km.n_iter_),
                                                 n_steps=int(km.n_steps_)),
        "inertia_per_point": round(inertia / len(U), 5),
        "cluster_size_percentiles": {str(p): float(np.percentile(sizes, p))
                                     for p in (0, 1, 10, 50, 90, 99, 100)},
        "clusters_le2": int((sizes <= 2).sum()),
        "elapsed_s": round(time.time() - t0, 1),
    }
    stats = read_json(STATS_JSON, {})
    stats["select"] = info
    stats["order_hash"] = df.attrs["order_hash"]
    write_json(STATS_JSON, stats)
    log(f"  K = {len(live)} clusters (empty {K_TARGET - len(live)}), size median "
        f"{np.median(sizes):.0f}, <=2 members: {info['clusters_le2']}; wrote {SELECT_NPZ.name}")


def load_selection(df: pd.DataFrame) -> dict:
    if not SELECT_NPZ.exists():
        raise SystemExit("no selection yet: run `thumbs.py select` first")
    s = dict(np.load(SELECT_NPZ))
    if str(s["order_hash"]) != df.attrs["order_hash"]:
        raise SystemExit("thumbs_select.npz was made for a different row order; re-run select")
    return s


# ---------------------------------------------------------------------------------------
# choosing representatives
# ---------------------------------------------------------------------------------------
class LocalIndex:
    """Which rows have a readable local cutout (checked lazily, cached)."""

    def __init__(self, df: pd.DataFrame):
        self.li = df["local_image"].to_numpy()
        self.cache: dict[int, bool] = {}

    def __call__(self, row: int) -> bool:
        v = self.cache.get(row)
        if v is None:
            p = self.li[row]
            v = bool(p) and (C.ROOT / p).is_file()
            self.cache[row] = v
        return v


def choose(sel: dict, is_local: LocalIndex, rejected: set[int]) -> np.ndarray:
    """Representative row of every cluster (-1 when all members are rejected)."""
    rows, dist, ptr = sel["rows"], sel["dist"], sel["ptr"]
    K = len(ptr) - 1
    out = np.full(K, -1, dtype=np.int64)
    for c in range(K):
        a, b = ptr[c], ptr[c + 1]
        cand = [j for j in range(a, b) if int(rows[j]) not in rejected] if rejected else \
            range(a, b)
        if not len(cand):
            continue
        first = cand[0]
        pick = first
        if not is_local(int(rows[first])):
            lim = PREFER_FACTOR * float(dist[first])
            for j in list(cand)[:N_PREFER]:
                if float(dist[j]) <= lim and is_local(int(rows[j])):
                    pick = j
                    break
        out[c] = rows[pick]
    return out


def load_rejects() -> dict[str, dict]:
    return read_json(REJECTS_JSON, {})


def rejected_set(rej: dict) -> set[int]:
    return {int(k) for k in rej}


def current_choice(df: pd.DataFrame, sel: dict, is_local: LocalIndex | None = None):
    is_local = is_local or LocalIndex(df)
    rej = load_rejects()
    chosen = choose(sel, is_local, rejected_set(rej))
    return chosen, is_local, rej


def cmd_estimate(args) -> None:
    df = load_catalog()
    sel = load_selection(df)
    chosen, is_local, rej = current_choice(df, sel)
    live = chosen[chosen >= 0]
    loc = np.array([is_local(int(r)) for r in live])
    need = [int(r) for r, l in zip(live, loc) if not l]
    cached = sum(cutout_path(df.at[r, "plate"], df.at[r, "mjd"], df.at[r, "fiber"]).is_file()
                 for r in need)
    # how often the local preference changed the pick
    first = sel["rows"][sel["ptr"][:-1]]
    swapped = int((first != chosen).sum())
    log(f"estimate: K={len(live)}; local {loc.sum():,}, not local {len(need):,} "
        f"(already cached {cached:,}, to fetch {len(need) - cached:,}); "
        f"local preference replaced the nearest member in {swapped:,} clusters; "
        f"rejected so far {len(rej)}")
    stats = read_json(STATS_JSON, {})
    stats["estimate"] = {"k": int(len(live)), "local": int(loc.sum()), "not_local": len(need),
                         "cached": int(cached), "to_fetch": int(len(need) - cached),
                         "local_preferred_swaps": swapped}
    write_json(STATS_JSON, stats)


# ---------------------------------------------------------------------------------------
# fetch
# ---------------------------------------------------------------------------------------
def validate_jpeg(data: bytes) -> str:
    """'' if `data` is a complete 160x160 RGB JPEG, else the reason it is not."""
    if len(data) < MIN_BYTES:
        return f"short body ({len(data)} B)"
    if data[:2] != b"\xff\xd8":
        return "not a jpeg"
    if not data.endswith(b"\xff\xd9"):
        return "truncated (no end-of-image marker)"
    try:
        im = Image.open(io.BytesIO(data))
        im.load()
    except Exception as e:  # truncated or corrupt
        return f"decode error ({type(e).__name__})"
    if im.size != (SRC_SIZE, SRC_SIZE):
        return f"size {im.size}"
    if im.mode not in ("RGB", "L"):
        return f"mode {im.mode}"
    return ""


def valid_file(path: Path) -> bool:
    try:
        return path.is_file() and not validate_jpeg(path.read_bytes())
    except OSError:
        return False


class RateGate:
    """Pacing shared by all fetch workers: request starts are spaced 1/rate apart, a 429 or
    503 pauses everyone (Retry-After honoured, the pause doubling while they continue), and
    the rate adapts (additive increase on success, multiplicative decrease on throttling)."""

    def __init__(self, rate: float = RATE):
        self.rate = rate
        self.lock = threading.Lock()
        self.next_t = 0.0
        self.pause_until = 0.0
        self.cool = COOLDOWN
        self.epoch = 0            # bumped whenever a pause starts
        self.n_throttled = 0

    def wait(self) -> int:
        while True:
            with self.lock:
                now = time.monotonic()
                t = max(self.next_t, self.pause_until)
                if now >= t:
                    self.next_t = now + 1.0 / self.rate
                    return self.epoch
                delay = t - now
            time.sleep(min(delay, 1.0))

    def success(self) -> None:
        with self.lock:
            self.rate = min(RATE_MAX, self.rate + 0.01)
            self.cool = COOLDOWN

    def throttled(self, epoch: int, retry_after: float) -> None:
        with self.lock:
            self.n_throttled += 1
            if epoch != self.epoch:
                return            # a pause already started after this request was sent
            self.rate = max(RATE_MIN, self.rate * 0.7)
            self.pause_until = time.monotonic() + max(self.cool, retry_after) + random.random()
            self.cool = min(300.0, self.cool * 2)
            self.epoch += 1


class Fetcher:
    def __init__(self):
        import requests

        self.requests = requests
        self.local = threading.local()
        self.lock = threading.Lock()
        self.gate = RateGate()
        self.consecutive_transient = 0
        self.stop = threading.Event()

    def session(self):
        s = getattr(self.local, "s", None)
        if s is None:
            s = self.requests.Session()
            s.headers["User-Agent"] = USER_AGENT
            self.local.s = s
        return s

    def fetch(self, ra: float, dec: float, path: Path) -> tuple[str, str]:
        """-> (status, detail). status: 'ok' | 'cached' | 'failed' (the server answered but
        the content was bad every time: permanent) | 'transient' (network trouble) |
        'throttled' (rate-limited too often; says nothing about the galaxy) | 'stopped'."""
        if valid_file(path):
            return "cached", ""
        params = {"ra": f"{ra:.6f}", "dec": f"{dec:.6f}", "pixscale": PIXSCALE,
                  "layer": LAYER, "size": SRC_SIZE}
        last, answered, attempt, n429 = "", False, 0, 0
        while attempt < RETRIES:
            if self.stop.is_set():
                return "stopped", last
            epoch = self.gate.wait()
            try:
                r = self.session().get(CUTOUT_URL, params=params, timeout=TIMEOUT)
            except self.requests.RequestException as e:
                last, answered = type(e).__name__, False
                attempt += 1
                if attempt < RETRIES:
                    time.sleep(min(60.0, 2.0 ** attempt) + random.random())
                continue
            if r.status_code in (429, 503):
                n429 += 1
                hdr = r.headers.get("Retry-After", "").strip()
                self.gate.throttled(epoch, float(hdr) if hdr.isdigit() else 0.0)
                last = f"http {r.status_code}"
                if n429 >= MAX_THROTTLED:
                    return "throttled", last
                continue          # not an attempt: the gate now makes every worker wait
            if r.status_code == 200:
                why = validate_jpeg(r.content)
                if not why:
                    tmp = path.with_name(path.name + ".part")
                    tmp.write_bytes(r.content)
                    os.replace(tmp, path)
                    self.gate.success()
                    with self.lock:
                        self.consecutive_transient = 0
                    return "ok", ""
                last, answered = why, True
            else:
                last, answered = f"http {r.status_code}", r.status_code < 500
            attempt += 1
            if attempt < RETRIES:
                time.sleep(min(60.0, 2.0 ** attempt) + random.random())
        if answered:
            with self.lock:
                self.consecutive_transient = 0
            return "failed", last
        with self.lock:
            self.consecutive_transient += 1
            if self.consecutive_transient >= BREAKER:
                self.stop.set()
        return "transient", last


def fetch_rows(df: pd.DataFrame, rows: list[int], label: str = "fetch") -> dict:
    """Download cutouts for `rows` (skipping cached ones). Rows that fail permanently are added
    to the rejects file. Returns counts."""
    CUTOUT_DIR.mkdir(parents=True, exist_ok=True)
    ledger = read_json(FETCH_LEDGER, {})
    counts = {"ok": 0, "cached": 0, "failed": 0, "transient": 0, "throttled": 0,
              "stopped": 0}
    if not rows:
        return counts
    with open(FETCH_LOG, "a", encoding="utf-8") as logf:
        def w(msg):
            line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
            logf.write(line + "\n")
            logf.flush()
            print(line, flush=True)

        w(f"{label}: {len(rows):,} cutouts requested, {WORKERS} workers, "
          f"<= {RATE_MAX} req/s")
        f = Fetcher()
        t0 = time.time()
        done = 0
        rej = load_rejects()

        def job(r):
            p = cutout_path(df.at[r, "plate"], df.at[r, "mjd"], df.at[r, "fiber"])
            return r, *f.fetch(float(df.at[r, "ra"]), float(df.at[r, "dec"]), p)

        with ThreadPoolExecutor(max_workers=WORKERS) as ex:
            for r, status, detail in ex.map(job, rows):
                counts[status] += 1
                done += 1
                if status in ("failed", "transient"):
                    e = ledger.get(str(r), {"n": 0})
                    e = {"n": e["n"] + 1, "last": detail}
                    ledger[str(r)] = e
                    # permanent: the server answered with bad content every time, or the
                    # row has now failed in two separate runs
                    if status == "failed" or e["n"] >= 2:
                        rej[str(r)] = {"stage": "fetch", "reason": detail}
                    w(f"  row {r}: {status} ({detail})")
                elif status == "throttled":
                    w(f"  row {r}: throttled {MAX_THROTTLED}x; left for a later run")
                if done % 200 == 0 or done == len(rows):
                    el = time.time() - t0
                    new = counts["ok"] + counts["failed"] + counts["transient"]
                    rate = new / el if el > 0 else 0.0
                    eta = (len(rows) - done) / rate / 60 if rate > 0 else float("nan")
                    w(f"  {done:,}/{len(rows):,}  ok {counts['ok']:,}  cached "
                      f"{counts['cached']:,}  failed {counts['failed']}  transient "
                      f"{counts['transient']}  throttled {counts['throttled']}  "
                      f"429s {f.gate.n_throttled}  pace {f.gate.rate:.2f}/s  "
                      f"{rate:.2f}/s  eta {eta:.1f} min")
                    write_json(FETCH_LEDGER, ledger)
                    write_json(REJECTS_JSON, rej)
        write_json(FETCH_LEDGER, ledger)
        write_json(REJECTS_JSON, rej)
        if f.stop.is_set():
            w(f"{label}: stopped after {BREAKER} consecutive network failures; re-run later")
        w(f"{label}: done {counts}, {f.gate.n_throttled} rate-limit answers, "
          f"in {time.time() - t0:.0f} s")
    return counts


def needed_fetches(df: pd.DataFrame, chosen: np.ndarray, is_local: LocalIndex) -> list[int]:
    need = []
    for r in chosen:
        r = int(r)
        if r < 0 or is_local(r):
            continue
        if not cutout_path(df.at[r, "plate"], df.at[r, "mjd"], df.at[r, "fiber"]).is_file():
            need.append(r)
    return need


def cmd_fetch(args) -> None:
    df = load_catalog()
    sel = load_selection(df)
    if args.retry_failed:
        rej = {k: v for k, v in load_rejects().items() if v.get("stage") != "fetch"}
        write_json(REJECTS_JSON, rej)
        write_json(FETCH_LEDGER, {})
    is_local = LocalIndex(df)
    for rnd in range(10):
        chosen = choose(sel, is_local, rejected_set(load_rejects()))
        need = needed_fetches(df, chosen, is_local)
        if args.limit:
            need = need[:args.limit]
        log(f"fetch round {rnd}: {len(need):,} cutouts to download")
        if not need:
            break
        c = fetch_rows(df, need, label=f"fetch round {rnd}")
        # A later round retries this round's transient failures (a second failure rejects
        # them) and fetches the substitutes of rejected rows.
        if c["stopped"] or args.limit:
            break


# ---------------------------------------------------------------------------------------
# quality checks
# ---------------------------------------------------------------------------------------
_RR = None


def _radius_grid() -> np.ndarray:
    global _RR
    if _RR is None:
        yy, xx = np.mgrid[0:SRC_SIZE, 0:SRC_SIZE] + 0.5
        _RR = np.hypot(xx - SRC_SIZE / 2, yy - SRC_SIZE / 2)
    return _RR


def crop_side_arcsec(r90: float) -> float:
    """Crop side actually used: clip(3 R90, 12", 42"), capped at the 160 px source."""
    s = float(np.clip(CROP_FACTOR * r90, CROP_MIN, CROP_MAX))
    return min(s, SRC_SIZE * PIXSCALE)


QA_VERSION = 3            # bump when qa_metrics changes: cached metrics are then recomputed
_HOUGH_THETA = np.deg2rad(np.arange(0.0, 180.0, 1.5))


def edge_metrics(arr: np.ndarray, half: float) -> dict:
    """One-sided coloured light: scattered light from a bright star just outside the crop
    tints one side of the thumbnail. Take the 30th percentile per channel (robust to small
    sources) in the four edge strips of the crop (12% of its side), and compare the brightest
    strip with the darkest: `edge_ex` is the mean excess, `edge_chroma` its spread over the
    channels, `edge_rel` their ratio. A neighbour galaxy adds light of ordinary colour
    (edge_rel ~0.3-0.8); glare is dim but strongly coloured (edge_rel >~ 1)."""
    c0 = SRC_SIZE / 2
    lo, hi = max(int(round(c0 - half)), 0), min(int(round(c0 + half)), SRC_SIZE)
    w = max(3, int(round(0.12 * (hi - lo))))
    box = arr[lo:hi, lo:hi]
    strips = [box[:w], box[-w:], box[:, :w], box[:, -w:]]
    p = np.array([np.percentile(s.reshape(-1, 3), 30, axis=0) for s in strips])
    L = p.mean(axis=1)
    ex = p[int(np.argmax(L))] - p[int(np.argmin(L))]
    ex_l, ex_c = float(ex.mean()), float(ex.max() - ex.min())
    return {"edge_ex": ex_l, "edge_chroma": ex_c, "edge_rel": ex_c / max(ex_l, 1.0)}


def trail_metrics(arr: np.ndarray, half: float, r90px: float) -> dict:
    """A straight line in one or two colour channels: a satellite or asteroid trail, which
    SDSS records only in the bands exposed while it passed. A Hough transform (1.5 deg, 2 px
    bins) of the pixels where one channel's small-scale residual (image minus a 9 px median)
    stands > 4 sigma above the mean of the other two finds the strongest line. Its coverage
    is measured along the chord outside the galaxy (radius > max(8 px, R90)), where a trail
    keeps going and an edge-on disk does not."""
    from scipy.ndimage import gaussian_filter, median_filter

    S, c0 = SRC_SIZE, SRC_SIZE / 2
    sm = np.stack([gaussian_filter(arr[..., i], 1.0) for i in range(3)])
    t = np.stack([sm[i] - median_filter(sm[i], size=9) for i in range(3)])
    rgal = min(max(8.0, r90px), 60.0)
    cos, sin = np.cos(_HOUGH_THETA), np.sin(_HOUGH_THETA)
    s = np.arange(-S, S, 1.0)
    best = {"trail_votes": 0, "trail_cov_out": 0.0, "trail_n_out": 0, "trail_in_crop": False}
    best_score = -1.0
    for c in range(3):
        u = t[c] - 0.5 * (t[(c + 1) % 3] + t[(c + 2) % 3])
        sig = 1.4826 * float(np.median(np.abs(u - np.median(u)))) + 1e-3
        ys, xs = np.nonzero(u > 4 * sig)
        if len(xs) < 20:
            continue
        rho = np.outer(xs + 0.5 - c0, cos) + np.outer(ys + 0.5 - c0, sin)
        rb = np.round(rho / 2.0).astype(np.int64) + 60          # |rho| <= 113 px -> 3..117
        H = np.stack([np.bincount(rb[:, j], minlength=121)[:121] for j in range(len(cos))])
        j, k = np.unravel_index(int(np.argmax(H)), H.shape)
        th, r0 = float(_HOUGH_THETA[j]), (k - 60) * 2.0
        px = c0 + r0 * np.cos(th) - s * np.sin(th)
        py = c0 + r0 * np.sin(th) + s * np.cos(th)
        ins = (px >= 1) & (px < S - 1) & (py >= 1) & (py < S - 1)
        if ins.sum() < 20:
            continue
        px, py = px[ins], py[ins]
        ix, iy = px.astype(np.int64), py.astype(np.int64)
        vals = np.max([u[iy + dy, ix + dx] for dx in (-1, 0, 1) for dy in (-1, 0, 1)], axis=0)
        out = np.hypot(px - c0, py - c0) > rgal
        n_out = int(out.sum())
        cov_out = float((vals[out] > 3 * sig).mean()) if n_out >= 10 else 0.0
        score = H[j, k] * cov_out
        if score > best_score:
            best_score = score
            best = {"trail_votes": int(H[j, k]), "trail_cov_out": cov_out, "trail_n_out": n_out,
                    # the line |rho| = r0 meets the crop square iff |r0| <= h(|cos| + |sin|)
                    "trail_in_crop": bool(abs(r0) <= half * (abs(np.cos(th)) + abs(np.sin(th))))}
    return best


def qa_metrics(path: str, r50: float, r90: float) -> dict:
    """Image statistics used to reject bad cutouts. Luminance is the RGB mean (0-255)."""
    from scipy.ndimage import gaussian_filter, uniform_filter

    out = {"ok": False, "err": "", "qa_version": QA_VERSION}
    try:
        data = Path(path).read_bytes()
    except OSError as e:
        out["err"] = f"missing ({type(e).__name__})"
        return out
    why = validate_jpeg(data)
    if why:
        out["err"] = why
        return out
    arr = np.asarray(Image.open(io.BytesIO(data)).convert("RGB"), dtype=np.float32)
    L = arr.mean(axis=2)
    rr = _radius_grid()
    side_px = crop_side_arcsec(r90) / PIXSCALE
    half = side_px / 2
    c0 = SRC_SIZE / 2
    yy, xx = np.mgrid[0:SRC_SIZE, 0:SRC_SIZE] + 0.5
    inbox = (np.abs(xx - c0) <= half) & (np.abs(yy - c0) <= half)
    border = rr > 72                       # corners + outer ring of the 160 px cutout
    sky = float(np.median(L[border]))
    noise = float(1.4826 * np.median(np.abs(L[border] - sky)))
    r50px = max(r50 / PIXSCALE, 1.0)
    rc = max(2.5, 0.5 * r50px)             # central disk
    cen = float(L[rr <= rc].mean())
    Ls = gaussian_filter(L, sigma=1.5)
    rpk = max(3.0, r50px)
    cen_pk = float(Ls[rr <= rpk].max())
    roff = max(6.0, 1.5 * r50px, 0.25 * side_px)
    off = inbox & (rr > roff)
    off_pk = float(Ls[off].max()) if off.any() else sky
    # Outside the SDSS footprint the viewer paints a flat grey (22) that JPEG keeps exactly
    # flat, while real sky always has noise: flag dark pixels whose 5x5 neighbourhood is
    # flat. (Saturated galaxy cores are flat too, but bright.)
    m1 = uniform_filter(L, 5)
    lstd = np.sqrt(np.maximum(uniform_filter(L * L, 5) - m1 * m1, 0.0))
    flat = (lstd < 0.5) & (L < 100)
    satL = arr.min(axis=2) >= 250          # saturated in all three channels
    # Sky from the darkest of the four 24x24 corners: a galaxy that fills the frame rarely
    # reaches all four, while stellar glare and scattered light brighten and tint them all.
    q = 24
    corners = [arr[:q, :q], arr[:q, -q:], arr[-q:, :q], arr[-q:, -q:]]
    cmed = np.array([np.median(c.reshape(-1, 3), axis=0) for c in corners])
    dark = int(np.argmin(cmed.mean(axis=1)))
    sky_c = float(cmed[dark].mean())
    cast_c = float(cmed[dark].max() - cmed[dark].min())
    cL = corners[dark].mean(axis=2)
    noise_c = float(1.4826 * np.median(np.abs(cL - np.median(cL))))
    # Stellar glare: the viewer's SDSS rendering gives bright stars large green/red/magenta
    # halos. Count smoothed pixels in the crop, away from the target, that are both bright
    # and strongly coloured (galaxy light and sky noise are far less saturated in colour).
    sm = np.stack([gaussian_filter(arr[..., i], 2.0) for i in range(3)], axis=2)
    chroma = sm.max(axis=2) - sm.min(axis=2)
    away = inbox & (rr > max(6.0, 2.0 * r50px))
    smL = sm.mean(axis=2)
    glare = away & (smL > 50) & (chroma > np.maximum(45.0, 0.7 * smL))
    glare_frac = float(glare.sum() / max(away.sum(), 1))
    # Haze: the paler, pink/green/red scattered light of a nearby bright star, which misses
    # the glare test's strong-colour bar but covers much of the crop around the target.
    haze = away & (smL > 60) & (chroma > np.maximum(30.0, 0.35 * smL))
    haze_frac = float(haze.sum() / max(away.sum(), 1))
    # Saturated blobs that are not the target: a bright star (or a much brighter neighbour)
    # inside the crop, or just outside it, where its glare still reaches in.
    from scipy.ndimage import label as nd_label

    lab, nlab = nd_label(satL)
    star_area = 0
    if nlab:
        area = np.bincount(lab.ravel(), minlength=nlab + 1)[1:]
        rmin = np.full(nlab, np.inf)
        np.minimum.at(rmin, lab[lab > 0] - 1, rr[lab > 0])
        central = rmin <= max(3.0, 0.5 * r50px)
        margin = 8.0
        # nearest point of each blob to the crop box, in px (0 if inside)
        dx = np.maximum(np.abs(xx - c0) - half, 0.0)
        dy = np.maximum(np.abs(yy - c0) - half, 0.0)
        dbox = np.hypot(dx, dy)
        dmin = np.full(nlab, np.inf)
        np.minimum.at(dmin, lab[lab > 0] - 1, dbox[lab > 0])
        other = ~central & (dmin <= margin)
        if other.any():
            star_area = int(area[other].max())
    # Centring: a mean-shift from the image centre climbs to the nearest brightness peak.
    # For a well-centred galaxy it stays within a pixel or two; it walks away when the
    # target is a piece of something bigger (a shredded disk) or sits on a brighter source.
    wimg = np.maximum(Ls - sky - 2.0 * noise, 0.0)
    rs = max(4.0, 1.0 * r50px)
    px, py = c0, c0
    for _ in range(8):
        m = (xx - px) ** 2 + (yy - py) ** 2 <= rs * rs
        w = wimg[m]
        if w.sum() <= 0:
            break
        nx, ny = float((xx[m] * w).sum() / w.sum()), float((yy[m] * w).sum() / w.sum())
        if abs(nx - px) < 0.05 and abs(ny - py) < 0.05:
            px, py = nx, ny
            break
        px, py = nx, ny
    out.update({
        "ok": True,
        "mean": float(L.mean()), "std": float(L.std()),
        "sky": sky, "noise": noise,
        "cen": cen, "contrast": (cen - sky) / max(noise, 1.0),
        "cen_pk": cen_pk, "off_pk": off_pk,
        "off_ratio": (off_pk - sky) / max(cen_pk - sky, 1.0),
        "flat_frac": float(flat[inbox].mean()),
        "flat_frac_all": float(flat.mean()),
        "zero_frac": float((arr.max(axis=2)[inbox] <= 2).mean()),
        "sat_off": int((satL & inbox & (rr > max(4.0, r50px))).sum()),
        "sat_cen": int((satL & (rr <= max(4.0, r50px))).sum()),
        "shift_px": float(np.hypot(px - c0, py - c0)),
        "shift_r50": float(np.hypot(px - c0, py - c0) / r50px),
        "r50_px": r50px, "side_px": side_px,
        "sky_c": sky_c, "cast_c": cast_c, "noise_c": noise_c,
        "contrast_c": (cen - sky_c) / max(noise_c, 1.0),
        "star_area": star_area, "n_sat_blobs": int(nlab), "glare_frac": glare_frac,
        "haze_frac": haze_frac,
        # the crop is capped at the 160 px source: the galaxy fills the frame
        "crop_capped": bool(CROP_FACTOR * r90 >= SRC_SIZE * PIXSCALE),
    })
    out.update(trail_metrics(arr, half, r90 / PIXSCALE))
    out.update(edge_metrics(arr, half))
    return out


# Thresholds, set by ranking ~11,500 representative cutouts by each metric and looking at
# the extremes (a rejected galaxy is replaced by a near-identical member of its cluster, so a
# false positive costs little while a bad tile shows in every mosaic). The haze and trail
# rules (QA_VERSION 2) were set the same way on all 16,000 representatives: every line with
# >= 40 votes and >= 50% outer coverage was a trail, while the strongest edge-on disks and
# bright galaxies reached 38 votes; haze_frac > 0.53 picked 13 images, 12 with scattered light.
# The edge-glare rule (QA_VERSION 3) came from the contact sheets, where ~2% of the tiles
# still had one side tinted pink, red or purple by a star just outside the crop; on the
# 15,995 thumbnails of version 2 it picked 23, of which ~16 were tinted and the rest had a
# red star or blue companion at the edge (harmless: a near-identical galaxy replaces them).
QA_RULES = {
    "blank_std": 2.0,          # near-uniform image (the no-coverage fill is flat grey 22)
    "dark_mean": 3.0,          # essentially black
    "flat_frac": 0.02,         # >2% of the crop is flat dark fill (edge of the footprint)
    "cast_min": 20.0,          # darkest corner tinted: max-min channel > 20 ...
    "cast_rel": 0.4,           # ... and > 0.4 x its brightness (bad frame, scattered light)
    "glare_frac": 0.12,        # >12% of the crop around the target strongly coloured
    "bright_sky": 40.0,        # darkest corner brighter than this ...
    "bright_sky_contrast": 4.0,  # ... with the target barely above it
    "contrast_min": 1.0,       # centre not above the sky: nothing there
    "star_area": 100,          # a saturated blob >= 100 px other than the target ...
    "star_vs_target": 2.0,     # ... and > 2x the target's own saturated area
    "shift_min_px": 8.0,       # the brightness peak nearest the centre lies more than
    "shift_r50": 0.75,         # max(8 px, 0.75 R50) away: the target is not what is centred
    "haze_frac": 0.53,         # >53% of the crop around the target bright and coloured
    "trail_votes": 40,         # a straight one- or two-band line of >= 40 px that crosses
    "trail_cov_out": 0.5,      # the crop and is traced along >= 50% of >= 30 px of chord
    "trail_n_out": 30,         # outside the galaxy: a satellite or asteroid trail
    "edge_chroma": 24.0,       # one side of the crop tinted: colour spread of the excess
    "edge_rel": 0.95,          # >= 24 levels and >= 0.95 x its mean brightness excess,
    "edge_ex": 15.0,           # which is >= 15 levels (not applied to capped crops, where
}                              # the galaxy's own disk reaches the edges)


def qa_reason(m: dict) -> str:
    """'' if the cutout is usable, else why it is not."""
    if not m.get("ok"):
        return m.get("err") or "unreadable"
    R = QA_RULES
    if m["std"] < R["blank_std"] or m["mean"] < R["dark_mean"]:
        return "blank"
    if m["flat_frac"] > R["flat_frac"]:
        return "no data"
    if m["cast_c"] > R["cast_min"] and m["cast_c"] > R["cast_rel"] * m["sky_c"]:
        return "colour cast"
    if m["glare_frac"] > R["glare_frac"]:
        return "glare"
    if m["haze_frac"] > R["haze_frac"]:
        return "haze"
    if (m["trail_in_crop"] and m["trail_votes"] >= R["trail_votes"]
            and m["trail_cov_out"] >= R["trail_cov_out"] and m["trail_n_out"] >= R["trail_n_out"]):
        return "trail"
    if (not m["crop_capped"] and m["edge_chroma"] >= R["edge_chroma"]
            and m["edge_rel"] >= R["edge_rel"] and m["edge_ex"] >= R["edge_ex"]):
        return "edge glare"
    if m["sky_c"] > R["bright_sky"] and m["contrast_c"] < R["bright_sky_contrast"]:
        return "bright sky"
    if m["contrast_c"] < R["contrast_min"]:
        return "nothing at centre"
    if m["star_area"] >= R["star_area"] and m["star_area"] > R["star_vs_target"] * m["sat_cen"]:
        return "bright star"
    if m["shift_px"] > max(R["shift_min_px"], R["shift_r50"] * m["r50_px"]):
        return "off centre"
    return ""


def _qa_job(args):
    row, path, r50, r90 = args
    m = qa_metrics(path, r50, r90)
    m["row"] = row
    return m


def run_qa(df: pd.DataFrame, rows: list[int], cache: dict[int, dict]) -> dict[int, dict]:
    todo = [r for r in rows
            if r not in cache or str(cache[r].get("err", "")).startswith("missing")
            or cache[r].get("qa_version") != QA_VERSION]
    jobs = [(r, str(source_path(df, r)[0]), float(df.at[r, "petroR50_r"]),
             float(df.at[r, "petroR90_r"])) for r in todo]
    if jobs:
        with ProcessPoolExecutor(max_workers=min(16, os.cpu_count() or 4)) as ex:
            for m in ex.map(_qa_job, jobs, chunksize=64):
                cache[m["row"]] = m
    return cache


def load_qa_cache() -> dict[int, dict]:
    if not QA_PARQUET.exists():
        return {}
    q = pd.read_parquet(QA_PARQUET)
    out = {}
    for rec in q.to_dict("records"):
        rec = {k: v for k, v in rec.items() if not (isinstance(v, float) and np.isnan(v))}
        out[int(rec["row"])] = rec
    return out


def save_qa_cache(cache: dict[int, dict]) -> None:
    q = pd.DataFrame(list(cache.values()))
    q.to_parquet(QA_PARQUET, index=False)


# ---------------------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------------------
def make_thumb(src: Path, r90: float) -> tuple[bytes, float]:
    side = crop_side_arcsec(r90)
    h = side / PIXSCALE / 2
    c0 = SRC_SIZE / 2
    im = Image.open(src).convert("RGB")
    th = im.resize((THUMB, THUMB), Image.Resampling.LANCZOS, box=(c0 - h, c0 - h, c0 + h, c0 + h))
    buf = io.BytesIO()
    th.save(buf, "JPEG", quality=JPEG_QUALITY, optimize=True)
    return buf.getvalue(), side


def _thumb_job(args):
    k, src, r90 = args
    data, side = make_thumb(Path(src), r90)
    return k, data, side


def write_manifest_thumbs(count: int) -> None:
    """Set manifest.thumbs (DESIGN.md 5.2) and change nothing else in the file."""
    text = MANIFEST.read_text(encoding="utf-8")
    m = json.loads(text)
    before = {k: v for k, v in m.items() if k != "thumbs"}
    block = dict(THUMBS_BLOCK, count=int(count))
    m["thumbs"] = block
    new = json.dumps(m, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    # everything except the thumbs block must be unchanged
    chk = json.loads(new)
    assert {k: v for k, v in chk.items() if k != "thumbs"} == before
    assert list(chk.keys()) == list(json.loads(text).keys())
    tmp = MANIFEST.with_name(MANIFEST.name + ".tmp")
    tmp.write_text(new, encoding="utf-8")
    os.replace(tmp, MANIFEST)


def cmd_build(args) -> None:
    t0 = time.time()
    df = load_catalog()
    sel = load_selection(df)
    is_local = LocalIndex(df)
    qa = load_qa_cache() if not args.fresh_qa else {}
    if args.requalify:
        # forget earlier QA verdicts (e.g. after changing QA_RULES); metrics stay cached
        write_json(REJECTS_JSON, {k: v for k, v in load_rejects().items()
                                  if v.get("stage") != "qa"})
    n_qa_rejected = 0
    for rnd in range(25):
        rej = load_rejects()
        chosen = choose(sel, is_local, rejected_set(rej))
        need = needed_fetches(df, chosen, is_local)
        if need:
            if args.no_fetch:
                raise SystemExit(f"{len(need)} cutouts still missing; run `thumbs.py fetch`")
            log(f"build round {rnd}: fetching {len(need)} substitute cutouts")
            c = fetch_rows(df, need, label=f"build round {rnd}")
            if c["stopped"] or (c["transient"] and not (c["ok"] or c["failed"])):
                raise SystemExit("network trouble while fetching substitutes; re-run later")
            continue
        live = [int(r) for r in chosen if r >= 0]
        qa = run_qa(df, live, qa)
        bad = {r: qa_reason(qa[r]) for r in live}
        bad = {r: why for r, why in bad.items() if why}
        log(f"build round {rnd}: K={len(live)}, QA rejects this round {len(bad)}")
        if not bad:
            break
        for r, why in bad.items():
            rej[str(r)] = {"stage": "qa", "reason": why}
        n_qa_rejected += len(bad)
        write_json(REJECTS_JSON, rej)
    else:
        raise SystemExit("QA did not converge in 25 rounds")
    save_qa_cache(qa)

    rows = np.sort(np.array(live, dtype=np.int64))
    K = len(rows)
    # write into a fresh directory, then swap it in
    tmp_out = OUT.with_name("thumbs.tmp")
    if tmp_out.exists():
        shutil.rmtree(tmp_out)
    tmp_out.mkdir(parents=True)
    jobs = []
    kinds = {"local-sdss": 0, "local-extra": 0, "fetched": 0}
    for k, r in enumerate(rows):
        src, kind = source_path(df, int(r))
        kinds[kind] += 1
        jobs.append((k, str(src), float(df.at[int(r), "petroR90_r"])))
    crop = np.zeros(K, dtype="<f4")
    nbytes = 0
    with ProcessPoolExecutor(max_workers=min(16, os.cpu_count() or 4)) as ex:
        for k, data, side in ex.map(_thumb_job, jobs, chunksize=64):
            d = tmp_out / str(k // SHARD)
            d.mkdir(exist_ok=True)
            (d / f"{k}.jpg").write_bytes(data)
            crop[k] = side
            nbytes += len(data)
    (tmp_out / "index.u32.gz").write_bytes(gz(rows.astype("<u4").tobytes()))
    (tmp_out / "crop.f32.gz").write_bytes(gz(crop.tobytes()))
    if OUT.exists():
        shutil.rmtree(OUT)
    os.replace(tmp_out, OUT)
    write_manifest_thumbs(K)

    rej = load_rejects()
    by_reason: dict[str, int] = {}
    for v in rej.values():
        key = f"{v['stage']}: {v['reason']}"
        by_reason[key] = by_reason.get(key, 0) + 1
    first = sel["rows"][sel["ptr"][:-1]]
    base = choose(sel, is_local, set())
    final = choose(sel, is_local, rejected_set(rej))
    total = sum(p.stat().st_size for p in OUT.rglob("*") if p.is_file())
    info = {
        "k": K, "sources": kinds,
        "fetched_cutouts_on_disk": sum(1 for _ in CUTOUT_DIR.glob("*.jpg")),
        "rejected": len(rej), "rejected_by_reason": by_reason,
        # clusters whose pick changed because of a rejection / that ran out of members
        "clusters_substituted": int(((base != final) & (final >= 0)).sum()),
        "clusters_dropped": int((final < 0).sum()),
        # clusters where a local cutout within 1.5x the nearest distance won
        "local_preferred_swaps": int((base != first).sum()),
        "jpeg_bytes": int(nbytes), "jpeg_mean_bytes": round(nbytes / max(K, 1), 1),
        "thumbs_dir_bytes": int(total),
        "crop_arcsec_percentiles": {str(p): round(float(np.percentile(crop, p)), 3)
                                    for p in (0, 5, 50, 95, 100)},
        "crop_at_min": int((crop <= CROP_MIN + 1e-4).sum()),
        "crop_at_max": int((crop >= SRC_SIZE * PIXSCALE - 1e-3).sum()),
        "qa_rules": QA_RULES,
        "elapsed_s": round(time.time() - t0, 1),
    }
    stats = read_json(STATS_JSON, {})
    stats["build"] = info
    write_json(STATS_JSON, stats)
    log(f"build: K={K} ({kinds}), rejected {len(rej)} {by_reason}, "
        f"{total / 1e6:.2f} MB in {OUT}, {time.time() - t0:.0f} s")


# ---------------------------------------------------------------------------------------
# contact sheets
# ---------------------------------------------------------------------------------------
def read_index() -> tuple[np.ndarray, np.ndarray]:
    idx = np.frombuffer(gzip.decompress((OUT / "index.u32.gz").read_bytes()), dtype="<u4")
    crop = np.frombuffer(gzip.decompress((OUT / "crop.f32.gz").read_bytes()), dtype="<f4")
    return idx.astype(np.int64), crop


def thumb_file(k: int) -> Path:
    return OUT / str(k // SHARD) / f"{k}.jpg"


def contact_sheet(df_vals: pd.DataFrame, idx: np.ndarray, xkey: str, ykey: str,
                  xr: tuple, yr: tuple, path: Path, nx: int = 30, ny: int = 20,
                  title: str = "") -> int:
    """Grid of thumbnails: in each cell, the representative nearest the cell centre."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    x = df_vals[xkey].to_numpy()[idx]
    y = df_vals[ykey].to_numpy()[idx]
    ix = np.floor((x - xr[0]) / (xr[1] - xr[0]) * nx).astype(int)
    iy = np.floor((y - yr[0]) / (yr[1] - yr[0]) * ny).astype(int)
    fx = (x - xr[0]) / (xr[1] - xr[0]) * nx - ix - 0.5
    fy = (y - yr[0]) / (yr[1] - yr[0]) * ny - iy - 0.5
    d2 = fx ** 2 + fy ** 2
    inside = np.isfinite(d2) & (ix >= 0) & (ix < nx) & (iy >= 0) & (iy < ny)
    best: dict[tuple, tuple] = {}
    for k in np.flatnonzero(inside):
        key = (ix[k], iy[k])
        if key not in best or d2[k] < best[key][0]:
            best[key] = (d2[k], k)
    T, gap = THUMB, 2
    W, H = nx * (T + gap) + gap, ny * (T + gap) + gap
    canvas = np.full((H, W, 3), 17, dtype=np.uint8)
    for (cx, cy), (_, k) in best.items():
        im = np.asarray(Image.open(thumb_file(int(k))).convert("RGB"))
        x0 = gap + cx * (T + gap)
        y0 = gap + (ny - 1 - cy) * (T + gap)
        canvas[y0:y0 + T, x0:x0 + T] = im
    dpi = 100
    fig = plt.figure(figsize=(W / dpi + 1.3, H / dpi + 1.0), dpi=dpi, facecolor="#0b0e13")
    ax = fig.add_axes([0.9 / (W / dpi + 1.3), 0.7 / (H / dpi + 1.0),
                       (W / dpi) / (W / dpi + 1.3), (H / dpi) / (H / dpi + 1.0)])
    ax.imshow(canvas, extent=[xr[0], xr[1], yr[0], yr[1]], aspect="auto",
              interpolation="nearest")
    ax.set_facecolor("#0b0e13")
    for s in ax.spines.values():
        s.set_color("#7a7465")
    ax.tick_params(colors="#b8af9a", labelsize=11)
    ax.set_xlabel(xkey, color="#efe6d2", fontsize=13)
    ax.set_ylabel(ykey, color="#efe6d2", fontsize=13)
    if title:
        ax.set_title(title, color="#efe6d2", fontsize=13)
    fig.savefig(path, dpi=dpi, facecolor=fig.get_facecolor())
    plt.close(fig)
    return len(best)


def cmd_sheets(args) -> None:
    df = pd.read_parquet(C.GALAXIES_PARQUET, columns=["logM", "logsSFR", "logR50"])
    idx, _ = read_index()
    n1 = contact_sheet(df, idx, "logM", "logsSFR", (8.4, 12.0), (-13.0, -8.6), CONTACT_PNG,
                       title=f"{len(idx):,} representatives: log M* vs log sSFR")
    n2 = contact_sheet(df, idx, "logM", "logR50", (8.4, 12.0), (-0.2, 1.3), CONTACT_SIZE_PNG,
                       title=f"{len(idx):,} representatives: log M* vs log R50")
    log(f"sheets: {n1} and {n2} filled cells -> {CONTACT_PNG.name}, {CONTACT_SIZE_PNG.name}")


def cmd_rejects_sheet(args) -> None:
    """Montage of rejected cutouts (160 px sources, crop box drawn) for checking QA rules."""
    from PIL import ImageDraw

    df = load_catalog()
    rej = load_rejects()
    items = [(int(r), v) for r, v in rej.items() if v["stage"] == "qa"]
    items.sort(key=lambda t: (t[1]["reason"], t[0]))
    if args.reason:
        items = [t for t in items if t[1]["reason"] == args.reason]
    items = items[:args.max]
    ncol = 10
    nrow = max(1, (len(items) + ncol - 1) // ncol)
    sheet = Image.new("RGB", (ncol * 164, nrow * 176), (17, 22, 31))
    d = ImageDraw.Draw(sheet)
    for j, (r, v) in enumerate(items):
        src, _ = source_path(df, r)
        try:
            im = Image.open(src).convert("RGB")
        except OSError:
            continue
        di = ImageDraw.Draw(im)
        h = crop_side_arcsec(float(df.at[r, "petroR90_r"])) / PIXSCALE / 2
        di.rectangle([80 - h, 80 - h, 80 + h, 80 + h], outline=(232, 116, 59))
        x0, y0 = (j % ncol) * 164 + 2, (j // ncol) * 176 + 2
        sheet.paste(im, (x0, y0))
        d.text((x0, y0 + 160), f"{v['reason'][:22]}", fill=(239, 230, 210))
    sheet.save(REJECTS_PNG)
    log(f"rejects sheet: {len(items)} images -> {REJECTS_PNG.name}")


# ---------------------------------------------------------------------------------------
# verify
# ---------------------------------------------------------------------------------------
def cmd_verify(args) -> None:
    df = load_catalog()
    man = read_json(MANIFEST, {})
    th = man.get("thumbs")
    problems = []
    if not th:
        raise SystemExit("manifest.thumbs is null")
    expect = dict(THUMBS_BLOCK, count=th.get("count"))
    if th != expect or list(th.keys()) != list(THUMBS_BLOCK.keys()):
        problems.append(f"manifest.thumbs differs from DESIGN.md 5.2: {th}")
    idx, crop = read_index()
    K = len(idx)
    if th["count"] != K or len(crop) != K:
        problems.append(f"count {th['count']} vs index {K} vs crop {len(crop)}")
    if len(np.unique(idx)) != K:
        problems.append("duplicate rows in index")
    if K and (idx.min() < 0 or idx.max() >= len(df)):
        problems.append("index out of range")
    if np.any(np.diff(idx) <= 0):
        problems.append("index not strictly ascending")
    r90 = df["petroR90_r"].to_numpy()[idx]
    expect_crop = np.array([crop_side_arcsec(v) for v in r90], dtype="<f4")
    if not np.array_equal(expect_crop, crop):
        problems.append(f"crop mismatch in {(expect_crop != crop).sum()} entries")
    if not ((crop >= CROP_MIN - 1e-4) & (crop <= CROP_MAX + 1e-4)).all():
        problems.append("crop outside [12, 42] arcsec")
    # files: exactly K jpgs in the right shards, all 64x64 RGB baseline JPEGs, no metadata
    on_disk = {p.relative_to(OUT).as_posix() for p in OUT.rglob("*.jpg")}
    wanted = {f"{k // SHARD}/{k}.jpg" for k in range(K)}
    if on_disk != wanted:
        problems.append(f"jpg set mismatch: {len(on_disk - wanted)} extra, "
                        f"{len(wanted - on_disk)} missing")
    others = [p.name for p in OUT.iterdir() if p.is_file()]
    if sorted(others) != ["crop.f32.gz", "index.u32.gz"]:
        problems.append(f"unexpected files in thumbs/: {others}")
    hashes: dict[str, int] = {}
    sizes = []
    meta_bad = 0
    for k in range(K):
        p = thumb_file(k)
        if not p.is_file():
            continue
        data = p.read_bytes()
        sizes.append(len(data))
        try:
            im = Image.open(io.BytesIO(data))
            im.load()
        except Exception as e:
            problems.append(f"{p.name}: {type(e).__name__}")
            continue
        if im.size != (THUMB, THUMB) or im.mode != "RGB" or im.format != "JPEG":
            problems.append(f"{p.name}: {im.format} {im.size} {im.mode}")
        if any(key in im.info for key in ("exif", "icc_profile", "comment")):
            meta_bad += 1
        h = hashlib.md5(data).hexdigest()
        if h in hashes:
            problems.append(f"thumbnail {k} is byte-identical to {hashes[h]}")
        hashes[h] = k
    if meta_bad:
        problems.append(f"{meta_bad} thumbnails carry metadata")
    # every thumbnail must be exactly what its row's source cutout gives (the encoder is
    # deterministic), which ties index, crop and jpg together
    jobs = [(k, str(source_path(df, int(r))[0]), float(df.at[int(r), "petroR90_r"]))
            for k, r in enumerate(idx)]
    mismatch = 0
    with ProcessPoolExecutor(max_workers=min(16, os.cpu_count() or 4)) as ex:
        for k, data, side in ex.map(_thumb_job, jobs, chunksize=64):
            p = thumb_file(k)
            if not p.is_file() or p.read_bytes() != data or np.float32(side) != crop[k]:
                mismatch += 1
    if mismatch:
        problems.append(f"{mismatch} thumbnails differ from a rebuild from their source")
    # the representatives must satisfy the selection (all features present)
    sel = load_selection(df)
    member = np.zeros(len(df), bool)
    member[sel["rows"]] = True
    if not member[idx].all():
        problems.append("a thumbnail row is not a clustered galaxy")
    total = sum(p.stat().st_size for p in OUT.rglob("*") if p.is_file())
    site_total = sum(p.stat().st_size for p in C.SITE_DATA.rglob("*") if p.is_file())
    stats = read_json(STATS_JSON, {})
    stats["verify"] = {"passed": not problems, "problems": problems[:50], "k": int(K),
                       "jpeg_bytes_mean": round(float(np.mean(sizes)), 1) if sizes else 0,
                       "thumbs_dir_mb": round(total / 1e6, 3),
                       "site_data_mb": round(site_total / 1e6, 3)}
    write_json(STATS_JSON, stats)
    if problems:
        for p in problems[:50]:
            log(f"  PROBLEM: {p}")
        raise SystemExit(f"verify: {len(problems)} problems")
    log(f"verify: OK. K={K}, {len(on_disk)} jpgs (mean {np.mean(sizes):.0f} B), "
        f"thumbs/ {total / 1e6:.2f} MB, site/data {site_total / 1e6:.2f} MB")


# ---------------------------------------------------------------------------------------
def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("select")
    sub.add_parser("estimate")
    p = sub.add_parser("fetch")
    p.add_argument("--limit", type=int, default=0, help="fetch at most this many (testing)")
    p.add_argument("--retry-failed", action="store_true",
                   help="forget earlier fetch failures and try them again")
    p = sub.add_parser("build")
    p.add_argument("--no-fetch", action="store_true")
    p.add_argument("--fresh-qa", action="store_true", help="recompute all QA metrics")
    p.add_argument("--requalify", action="store_true",
                   help="drop earlier QA rejections and apply QA_RULES afresh")
    sub.add_parser("sheets")
    p = sub.add_parser("rejects")
    p.add_argument("--reason", default="")
    p.add_argument("--max", type=int, default=200)
    sub.add_parser("verify")
    p = sub.add_parser("all")
    p.add_argument("--reselect", action="store_true")
    args = ap.parse_args()
    if args.cmd == "all":
        if args.reselect or not SELECT_NPZ.exists():
            cmd_select(args)
        cmd_estimate(args)
        cmd_fetch(argparse.Namespace(limit=0, retry_failed=False))
        cmd_build(argparse.Namespace(no_fetch=False, fresh_qa=False, requalify=False))
        cmd_sheets(args)
        cmd_verify(args)
        return
    {"select": cmd_select, "estimate": cmd_estimate, "fetch": cmd_fetch, "build": cmd_build,
     "sheets": cmd_sheets, "rejects": cmd_rejects_sheet, "verify": cmd_verify}[args.cmd](args)


if __name__ == "__main__":
    main()
