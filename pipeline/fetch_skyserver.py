"""Pull MGS photometry and Galaxy Zoo 1 from the SDSS SkyServer DR17 SQL web service.

The MPA-JHU tables in mgs_parent.parquet carry no Petrosian photometry for the ~480k
galaxies outside the emission-line imaging sample, so this script fetches it for every
spectrum, keyed on (plate, mjd, fiber):

  1. photometry: SpecObjAll x PhotoObjAll (via bestObjID) in chunks of ~30 plates, keeping
     spectra with the MGS target bits (legacy_target1 & 448). Each chunk is cached as a
     gzipped CSV in pipeline/cache/skyserver/, so reruns are free.
  2. follow-up: any mgs_parent spectrum still unmatched is queried explicitly by
     plate/mjd/fiber without the target-bit filter.
  3. zooSpec: the whole Galaxy Zoo 1 table (667,944 rows) in RA chunks, so that
     build_catalog.py can join on specObjID and fall back to the photometric objID.

19-digit SDSS IDs are CAST to VARCHAR on the server and read as strings here; they never
pass through float64.

Usage:  python3 pipeline/fetch_skyserver.py [--workers 2] [--max-seconds 540] [--compile-only]
The script stops cleanly after --max-seconds and can be rerun until it reports completion.
"""

from __future__ import annotations

import argparse
import gzip
import io
import sys
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from pathlib import Path

import numpy as np
import pandas as pd
import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config as C  # noqa: E402

PHOTO_COLS = ["objid", "specobjid", "plate", "mjd", "fiber", "z_dr17", "ra", "dec",
              "petroMag_r", "petroR50_r", "petroR90_r",
              "modelMag_u", "modelMag_g", "modelMag_r", "modelMag_i", "modelMag_z",
              "extinction_u", "extinction_g", "extinction_r", "extinction_i", "extinction_z",
              "deVAB_r", "expAB_r", "fracDeV_r"]
ZOO_COLS = ["specobjid", "objid", "dr7objid", "ra", "dec", "nvote", "p_el", "p_cs",
            "p_el_debiased", "p_cs_debiased", "spiral", "elliptical", "uncertain"]
STR_COLS = {"objid": str, "specobjid": str, "dr7objid": str}

PHOTO_SELECT = """SELECT CAST(p.objID AS VARCHAR(20)) AS objid,
 CAST(s.specObjID AS VARCHAR(20)) AS specobjid,
 s.plate, s.mjd, s.fiberID AS fiber, s.z AS z_dr17, p.ra, p.dec,
 p.petroMag_r, p.petroR50_r, p.petroR90_r,
 p.modelMag_u, p.modelMag_g, p.modelMag_r, p.modelMag_i, p.modelMag_z,
 p.extinction_u, p.extinction_g, p.extinction_r, p.extinction_i, p.extinction_z,
 p.deVAB_r, p.expAB_r, p.fracDeV_r
FROM SpecObjAll s JOIN PhotoObjAll p ON s.bestObjID = p.objID"""

ZOO_SELECT = """SELECT CAST(specobjid AS VARCHAR(20)) AS specobjid,
 CAST(objid AS VARCHAR(20)) AS objid, CAST(dr7objid AS VARCHAR(20)) AS dr7objid,
 ra, dec, nvote, p_el, p_cs, p_el_debiased, p_cs_debiased, spiral, elliptical, uncertain
FROM zooSpec"""


class QueryError(RuntimeError):
    pass


_session = None


def session() -> requests.Session:
    global _session
    if _session is None:
        _session = requests.Session()
        _session.headers["User-Agent"] = C.USER_AGENT
    return _session


def run_sql(sql: str, expect_cols: list[str], tries: int = 6, timeout: int = 600) -> str:
    """Run one query; return the CSV text (after '#Table1'). Retries with backoff."""
    sql = " ".join(sql.split())
    delay = 15.0
    last = None
    for attempt in range(1, tries + 1):
        try:
            r = session().get(C.SKYSERVER_URL, params={"cmd": sql, "format": "csv"},
                              timeout=timeout)
            text = r.text
            if 400 <= r.status_code < 500 and r.status_code != 429:
                # e.g. IIS answers 404 to an over-long query string; retrying cannot help
                raise ValueError(f"HTTP {r.status_code} (not retried; query {len(sql)} chars)")
            if r.status_code != 200:
                raise QueryError(f"HTTP {r.status_code}: {text[:300]!r}")
            if not text.startswith("#Table1"):
                raise QueryError(f"unexpected body: {text[:300]!r}")
            body = text.split("\n", 1)[1] if "\n" in text else ""
            header = body.split("\n", 1)[0].strip().split(",")
            if header != expect_cols:
                raise QueryError(f"unexpected header {header[:6]}... body {text[:300]!r}")
            return body
        except (requests.RequestException, QueryError) as e:
            last = e
            if attempt == tries:
                break
            print(f"    attempt {attempt} failed ({str(e)[:160]}); retrying in {delay:.0f}s",
                  flush=True)
            time.sleep(delay)
            delay = min(delay * 2, 300)
    raise QueryError(f"giving up after {tries} attempts: {last}")


def write_chunk(path: Path, body: str) -> int:
    df = pd.read_csv(io.StringIO(body), dtype=STR_COLS)
    tmp = path.with_suffix(".tmp")
    with gzip.open(tmp, "wt", compresslevel=6) as f:
        f.write(body)
    tmp.rename(path)
    return len(df)


def read_chunk(path: Path) -> pd.DataFrame:
    with gzip.open(path, "rt") as f:
        return pd.read_csv(f, dtype=STR_COLS)


# ---------------------------------------------------------------------------------------
# chunk plans
# ---------------------------------------------------------------------------------------
def parent_keys() -> pd.DataFrame:
    return pd.read_parquet(C.PARENT, columns=["plate", "mjd", "fiber"])


def photo_chunks(parent: pd.DataFrame) -> list[tuple[str, str]]:
    plates = np.sort(parent["plate"].unique())
    out = []
    for i in range(0, len(plates), C.PLATES_PER_CHUNK):
        p0, p1 = int(plates[i]), int(plates[min(i + C.PLATES_PER_CHUNK, len(plates)) - 1])
        sql = (f"{PHOTO_SELECT} WHERE s.plate BETWEEN {p0} AND {p1} "
               f"AND (s.legacy_target1 & {C.MGS_TARGET_BITS}) > 0")
        out.append((f"photo_{p0:04d}_{p1:04d}.csv.gz", sql))
    return out


def zoo_chunks() -> list[tuple[str, str]]:
    out = []
    ra = 0.0
    while ra < 360.0:
        a, b = ra, ra + C.ZOO_RA_STEP
        cond = f"ra >= {a:g} AND ra < {b:g}" if b < 360 else f"ra >= {a:g}"
        out.append((f"zoo_{int(a):03d}_{int(b):03d}.csv.gz", f"{ZOO_SELECT} WHERE {cond}"))
        ra = b
    return out


def run_plan(plan, cols, workers: int, deadline: float) -> bool:
    """Fetch every missing chunk in the plan. Returns True when all are cached."""
    C.SKYSERVER_CACHE.mkdir(parents=True, exist_ok=True)
    todo = [(n, s) for n, s in plan if not (C.SKYSERVER_CACHE / n).exists()]
    print(f"  {len(plan) - len(todo)}/{len(plan)} chunks cached, {len(todo)} to fetch", flush=True)
    if not todo:
        return True
    done_all = True

    def job(name, sql):
        t = time.time()
        body = run_sql(sql, cols)
        n = write_chunk(C.SKYSERVER_CACHE / name, body)
        return name, n, time.time() - t

    workers = max(1, min(workers, 3))
    queue = list(todo)
    with ThreadPoolExecutor(max_workers=workers) as ex:
        running = {}
        while queue or running:
            # keep at most `workers` queries in flight; stop submitting after the deadline
            while queue and len(running) < workers and time.time() < deadline:
                name, sql = queue.pop(0)
                running[ex.submit(job, name, sql)] = name
            if not running:
                break
            finished, _ = wait(list(running), return_when=FIRST_COMPLETED)
            for f in finished:
                nm = running.pop(f)
                try:
                    _, n, dt = f.result()
                    print(f"    {nm}: {n:,} rows in {dt:.1f}s", flush=True)
                except Exception as e:  # noqa: BLE001
                    print(f"    {nm}: FAILED {e}", flush=True)
                    done_all = False
    remaining = [n for n, _ in plan if not (C.SKYSERVER_CACHE / n).exists()]
    return done_all and not remaining


def compile_photo() -> pd.DataFrame:
    """All cached photometry chunks. 'phot_query' records how a spectrum was found:
    'mgs_bits' (plate chunks with legacy_target1 & 448) or 'followup' (explicit
    plate/mjd/fiber; these are SDSS special plates whose DR17 targeting lives in
    special_target1)."""
    files = sorted(C.SKYSERVER_CACHE.glob("photo_*.csv.gz"))
    parts = []
    for f in files:
        part = read_chunk(f)
        if len(part):
            part["phot_query"] = "followup" if f.name.startswith("photo_followup_") else "mgs_bits"
            parts.append(part)
    df = pd.concat(parts, ignore_index=True)
    for c in ("plate", "mjd", "fiber"):
        df[c] = df[c].astype(np.int64)
    n0 = len(df)
    df = df.drop_duplicates(["plate", "mjd", "fiber"], keep="first").reset_index(drop=True)
    print(f"  photometry: {n0:,} rows from {len(files)} chunks, {len(df):,} unique spectra")
    return df


def followup_plan(parent: pd.DataFrame, photo: pd.DataFrame) -> list[tuple[str, str]]:
    """Explicit plate/mjd/fiber queries for parent spectra the target-bit chunks missed.

    The plan is built from the target-bit chunks alone, so it is the same on every run and
    its chunk names hit the cache (spectra that no query can find, bestObjID = 0, would
    otherwise be re-planned under new names and re-queried each time)."""
    key = ["plate", "mjd", "fiber"]
    if "phot_query" in photo.columns:
        photo = photo[photo["phot_query"] == "mgs_bits"]
    m = parent.merge(photo[key].assign(_hit=1), on=key, how="left")
    miss = m.loc[m["_hit"].isna(), key].sort_values(key).reset_index(drop=True)
    print(f"  parent spectra missed by the target-bit chunks: {len(miss):,}")
    # compact conditions, one per plate-mjd, packed until the SQL reaches ~1.6 kB
    conds = []
    for (p, j), g in miss.groupby(["plate", "mjd"]):
        fibers = g["fiber"].tolist()
        for i in range(0, len(fibers), 150):
            fl = ",".join(str(int(f)) for f in fibers[i:i + 150])
            conds.append(f"(s.plate={int(p)} AND s.mjd={int(j)} AND s.fiberID IN ({fl}))")
    out, cur = [], []
    for c in conds + [None]:
        if c is not None and (not cur or sum(len(x) for x in cur) + len(c) < 1600):
            cur.append(c)
            continue
        if cur:
            tag = cur[0].split(" AND ")[0].strip("(").replace("s.plate=", "")
            name = f"photo_followup_{int(tag):04d}_{len(out):03d}.csv.gz"
            out.append((name, f"{PHOTO_SELECT} WHERE {' OR '.join(cur)}"))
        cur = [c] if c is not None else []
    return out


def compile_zoo() -> pd.DataFrame:
    files = sorted(C.SKYSERVER_CACHE.glob("zoo_*.csv.gz"))
    parts = [p for p in (read_chunk(f) for f in files) if len(p)]   # some RA slices are empty
    df = pd.concat(parts, ignore_index=True)
    n0 = len(df)
    df = df.drop_duplicates("specobjid").reset_index(drop=True)
    print(f"  zooSpec: {n0:,} rows from {len(files)} chunks, {len(df):,} unique specobjid")
    return df


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=2, help="concurrent queries (<=3)")
    ap.add_argument("--max-seconds", type=float, default=1e9,
                    help="stop submitting new queries after this many seconds")
    ap.add_argument("--compile-only", action="store_true")
    args = ap.parse_args()
    deadline = time.time() + args.max_seconds

    parent = parent_keys()
    ok = True
    if not args.compile_only:
        print("photometry chunks (SpecObjAll x PhotoObjAll, MGS target bits)", flush=True)
        ok &= run_plan(photo_chunks(parent), PHOTO_COLS, args.workers, deadline)
        print("zooSpec chunks", flush=True)
        ok &= run_plan(zoo_chunks(), ZOO_COLS, args.workers, deadline)
        if ok:
            print("follow-up for unmatched spectra", flush=True)
            photo = compile_photo()
            ok &= run_plan(followup_plan(parent, photo), PHOTO_COLS, args.workers, deadline)
    if not ok:
        print("INCOMPLETE: rerun to continue (cached chunks are skipped)")
        return 2

    photo = compile_photo()
    key = ["plate", "mjd", "fiber"]
    still = len(parent) - len(parent.merge(photo[key], on=key))
    print(f"  parent spectra with no DR17 photometry at all (bestObjID = 0): {still:,}")
    photo.to_parquet(C.PHOTO_PARQUET, index=False)
    zoo = compile_zoo()
    zoo.to_parquet(C.ZOO_PARQUET, index=False)
    print(f"wrote {C.PHOTO_PARQUET} ({len(photo):,}) and {C.ZOO_PARQUET} ({len(zoo):,})")
    print("COMPLETE")
    return 0


if __name__ == "__main__":
    sys.exit(main())
