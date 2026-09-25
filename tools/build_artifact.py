#!/usr/bin/env python3
"""Package site/ as a multi-file claude.ai Artifact in dist/artifact/.

An Artifact differs from GitHub Pages in four ways that matter here:

- A version holds at most 255 files and 64 MB. The individual thumbnails are packed into
  16 x 16 JPEG atlases (manifest.thumbs.atlas), and data/thumbs/<shard>/ is left out.
- Only web media types are served (no .gz), so the gzip columns ship as base64 .b64.txt.
- The host wraps the page in its own <html>/<head>/<body> skeleton. index.html is unwrapped:
  the title and stylesheet links come first, then the body markup.
- The CSP blocks every external host except Google Fonts, so hot-linked Legacy Survey
  images cannot load. manifest.host tells the app to use the local thumbnail instead.
- Only a bare #anchor reaches location.hash, so view-state share links cannot work there.
  manifest.host also tells the app to hide the share button.

Writes dist/artifact/files.json, the {published path: source path} map for the Artifact
tool's `files` argument. Run from the project root:  python3 tools/build_artifact.py
"""

from __future__ import annotations

import argparse
import base64
import gzip
import json
import re
import shutil
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"
OUT = ROOT / "dist" / "artifact"

MAX_FILES, MAX_TOTAL = 255, 64 * 1024**2
MAX_TEXT, MAX_BINARY = 16 * 1024**2, 15 * 1024**2
TEXT_EXT = {".html", ".css", ".js", ".json", ".md", ".txt", ".svg"}

ATLAS_COLS = 16                     # 16 x 16 thumbnails per atlas
ATLAS_PER = ATLAS_COLS * ATLAS_COLS

# The artifact skeleton pads :root by the safe-area insets and pins a light color-scheme.
# #app is a fixed full-viewport grid, so it takes the insets and the 16 px side gutter itself.
ARTIFACT_CSS = """<style>
  :root { color-scheme: dark; }
  html, body { background: #0b0e13; }
  #app {
    top: env(safe-area-inset-top, 0px);
    bottom: env(safe-area-inset-bottom, 0px);
    left: 16px;
    right: 16px;
  }
</style>"""


def build_atlases(manifest: dict, quality: int) -> list[str]:
    th = manifest["thumbs"]
    k_total, size, shard = th["count"], th["size"], th.get("shard", 1000)
    url = th["url"]
    n_atlas = -(-k_total // ATLAS_PER)
    out_dir = OUT / "data" / "thumbs" / "atlas"
    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    for a in range(n_atlas):
        sheet = Image.new("RGB", (ATLAS_COLS * size, ATLAS_COLS * size), (11, 14, 19))
        for p in range(ATLAS_PER):
            k = a * ATLAS_PER + p
            if k >= k_total:
                break
            src = SITE / "data" / url.replace("{shard}", str(k // shard)).replace("{k}", str(k))
            with Image.open(src) as im:
                im = im.convert("RGB")
                if im.size != (size, size):
                    im = im.resize((size, size), Image.LANCZOS)
                sheet.paste(im, ((p % ATLAS_COLS) * size, (p // ATLAS_COLS) * size))
        dst = out_dir / f"{a}.jpg"
        sheet.save(dst, "JPEG", quality=quality, optimize=True)
        written.append(str(dst.relative_to(OUT)))
    th["atlas"] = {"url": "thumbs/atlas/{a}.jpg", "per": ATLAS_PER, "cols": ATLAS_COLS,
                   "tile": size, "count": n_atlas, "quality": quality}
    return written


def to_base64_text(manifest: dict) -> None:
    """Artifacts serve no generic binary type, so every .gz column ships as base64 text.

    data/x.u16.gz becomes data/x.u16.gz.b64.txt (text/plain), and loader.fetchBytes decodes
    it back to the same gzip bytes. Every manifest reference is renamed to match.
    """
    for gz in sorted((OUT / "data").rglob("*.gz")):
        txt = gz.with_name(gz.name + ".b64.txt")
        txt.write_text(base64.b64encode(gz.read_bytes()).decode("ascii"))
        gz.unlink()

    def rename(node):
        if isinstance(node, dict):
            for key, val in node.items():
                if isinstance(val, str) and val.endswith(".gz") and key in ("file", "index", "crop"):
                    node[key] = val + ".b64.txt"
                else:
                    rename(val)
        elif isinstance(node, list):
            for val in node:
                rename(val)
    rename(manifest)


def unwrap_index(html: str) -> str:
    """Keep <title> and body-safe <link>s from <head>, then the <body> contents."""
    head = re.search(r"<head>(.*?)</head>", html, re.S | re.I).group(1)
    body = re.search(r"<body[^>]*>(.*?)</body>", html, re.S | re.I).group(1)
    title = re.search(r"<title>.*?</title>", head, re.S | re.I).group(0)
    keep = []
    for tag in re.findall(r"<link\b[^>]*>|<script\b[^>]*>\s*</script>", head, re.S | re.I):
        rel = re.search(r'rel="([^"]+)"', tag)
        # rel=icon is not allowed in <body>; the Artifact's own icon replaces it
        if tag.lower().startswith("<link") and rel and rel.group(1) not in (
                "stylesheet", "preconnect", "modulepreload", "preload", "dns-prefetch"):
            continue
        keep.append(tag)
    return "\n".join([title, ARTIFACT_CSS, *keep, body.strip(), ""])


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--quality", type=int, default=82, help="atlas JPEG quality")
    args = ap.parse_args()

    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)

    manifest = json.loads((SITE / "data" / "manifest.json").read_text())
    if not manifest.get("thumbs"):
        raise SystemExit("manifest.thumbs is null: run pipeline/thumbs.py first")

    # static app files (no tests, no dev data, no docs)
    for sub in ("css", "js"):
        for src in sorted((SITE / sub).rglob("*")):
            if src.is_file() and src.suffix in {".css", ".js"}:
                dst = OUT / src.relative_to(SITE)
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)

    # data columns, literature, thumbnail index/crop (not the individual jpgs)
    for rel in ["data/literature.json", "data/thumbs/index.u32.gz", "data/thumbs/crop.f32.gz"]:
        dst = OUT / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SITE / rel, dst)
    for sub in ("dims", "cats", "meta"):
        for src in sorted((SITE / "data" / sub).glob("*.gz")):
            dst = OUT / src.relative_to(SITE)
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)

    build_atlases(manifest, args.quality)
    to_base64_text(manifest)
    manifest["host"] = {"kind": "artifact", "externalImages": False, "shareLinks": False}
    (OUT / "data" / "manifest.json").write_text(json.dumps(manifest, separators=(",", ":")))

    (OUT / "index.html").write_text(unwrap_index((SITE / "index.html").read_text()))

    # sanity: the thumbnail index still decodes and matches the atlas count
    idx_txt = (OUT / "data" / manifest["thumbs"]["index"]).read_text()
    idx = np.frombuffer(gzip.decompress(base64.b64decode(idx_txt)), "<u4")
    assert idx.size == manifest["thumbs"]["count"], (idx.size, manifest["thumbs"]["count"])

    files, total = {}, 0
    for f in sorted(OUT.rglob("*")):
        if not f.is_file() or f.name in ("index.html", "files.json"):
            continue
        rel = str(f.relative_to(OUT))
        size = f.stat().st_size
        limit = MAX_TEXT if f.suffix in TEXT_EXT else MAX_BINARY
        assert size <= limit, f"{rel} is {size / 1e6:.1f} MB, over the per-file limit"
        files[rel] = str(f)
        total += size
    total += (OUT / "index.html").stat().st_size
    (OUT / "files.json").write_text(json.dumps(files, indent=1))

    n_atlas = manifest["thumbs"]["atlas"]["count"]
    print(f"{len(files)} supporting files + index.html, {total / 1024**2:.1f} MB "
          f"({n_atlas} thumbnail atlases)")
    assert len(files) < MAX_FILES, "too many files for one Artifact version"
    assert total <= MAX_TOTAL, "over the 64 MB Artifact version limit"


if __name__ == "__main__":
    main()
