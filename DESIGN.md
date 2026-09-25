# Galaxy Manifold — design & build contract

This file is the single source of truth for everyone building this project. Every module,
data file, and agent builds against it. If you must deviate, record the deviation in §19 at
the bottom of this file, saying what changed and why.

---

## 1. What we are building

A static website (deployed on GitHub Pages) for exploring **galaxy scaling relations as
projections of a high-dimensional manifold** of galaxy properties.

- ~650k SDSS Main Galaxy Sample galaxies, each a point in a ~20-D space of standardized
  properties (stellar mass, SFR, sSFR, two metallicity calibrations, size, concentration,
  surface density, velocity dispersion, surface brightness, color, Dn4000, HδA, H I gas
  fraction, group halo mass, BPT line ratios, Galaxy Zoo morphology, redshift).
- The screen shows a **2-D linear projection** of that space. Users **rotate** it: a *grand
  tour* (smooth random rotation), a *manual tour* (drag a dimension's spoke on the
  "starburst" compass), or animated snaps to **canonical views** (MZR, FMR, SFMS,
  mass–size, the edge-on Fundamental Plane, BPT, SHMR, …). Every transition is a geodesic
  rotation through the high-D space, so the user watches one relation turn into another.
- Points render as a density "glow" whose **luminance = density** and whose
  **hue = mean of a third property** (or a category mix such as BPT class). This is
  exactly the classic "MZR colored by SFR" picture, available in every projection.
- **Literature relations** are drawn when the view matches their native axes. The data's own
  **running medians** are drawn in any view, split by the color variable.
- **Lasso** a subset; it stays highlighted as you rotate (linked brushing across projections).
- **Mosaic mode** tiles the plane with galaxy image cutouts: each grid cell shows the most
  typical galaxy in that cell, so morphological trends become visible in any projection.

## 2. Experience principles (non-negotiable)

1. **The data is the interface.** Full-bleed canvas. Controls live at the edges and never
   cover the data unless summoned.
2. **Explore, don't lecture.** No paragraphs anywhere in the main UI. Prefer symbols, numbers
   and shapes over words. Full names and units appear on hover (`title`/tooltip). Credits and
   caveats sit behind a single ⓘ button.
3. **Motion explains.** Changes of view animate (ease-in-out, ~0.9–1.4 s) as rotations through
   the high-D space. Never use a jump cut between projections.
4. **Direct manipulation.** Drag spokes to rotate, drag dimension tokens onto axes, lasso to
   select, and scroll or drag to zoom and pan. Every action should also have a one-click
   equivalent.
5. **Honest science.** Units, IMF and calibration conventions, and data sources are available
   on demand. Draw literature curves only where the current axes match their native axes.
   Surface caveats in §18 where relevant, briefly.

## 3. Visual design system — "mid-century mission control"

Mid-century modern × retrofuturism, dark mode. Think 1960s observatory instrument panels,
Braun/Rams hi-fi dials, atomic-age starburst clocks, NASA 1970s graphics standards, Saul Bass
geometry, and cream ink on midnight paper. The result should be warm, precise and tactile.
Avoid neon, glassmorphism, and generic dashboards.

### 3.1 Color tokens (CSS custom properties in `site/css/tokens.css`)

| token | value | use |
|---|---|---|
| `--bg` | `#0b0e13` | page / stage background (midnight ink) |
| `--bg-2` | `#11161f` | panels, console |
| `--bg-3` | `#18202c` | raised elements, hover |
| `--line` | `#273142` | hairlines, grid |
| `--cream` | `#efe6d2` | primary text & line art |
| `--cream-2` | `#b8af9a` | secondary text |
| `--cream-3` | `#7a7465` | tertiary / disabled |
| `--orange` | `#e8743b` | primary accent ("atomic orange"), active states |
| `--mustard` | `#e2b23a` | secondary accent, literature curves |
| `--teal` | `#3aa6a0` | accent |
| `--sky` | `#6fa8dc` | accent |
| `--coral` | `#de5b52` | accent / warnings |
| `--olive` | `#a3b35b` | accent |
| `--plum` | `#b07aa1` | accent (sparingly) |

Dimension **group colors** (tokens, compass spokes):
`stars`→orange, `sf`→sky, `chem`→mustard, `struct`→teal, `kin`→coral, `gas`→`#8fd0e8`,
`env`→plum, `lines`→olive, `obs`→cream-3, `learned`→cream (reserved for future embeddings).

### 3.2 Typography (Google Fonts)

- **Michroma** (Microgramma-like; the space-age face) for the wordmark, preset codes and tiny
  uppercase labels. Use it at small sizes (8–11 px) with letter-spacing 0.12–0.2em.
- **Jost** (Futura-like geometric sans) for UI text and tooltips, 12–13 px.
- **Space Mono** for all numbers, axis ticks, formulas and values. Use tabular spacing.

### 3.3 Motifs

- **Starburst compass**: the projection control is drawn as an atomic starburst clock (§13.3).
- Thin 1 px cream hairlines at 15–35% opacity, rounded corners of 8–12 px, and pill-shaped
  buttons. Use double-rule frames on key panels.
- Stage background: a faint engineering-paper grid (about 32 px, ≈3% opacity) plus a soft
  vignette. An optional, very faint film-grain overlay (≤3%) adds a printed feel.
- Custom inline SVG icons: 1.5 px strokes, round caps, geometric, mid-century line style.
  Use no emoji and no icon fonts.
- Motion: `cubic-bezier(.65,0,.35,1)` for view changes and 150–250 ms ease-out for UI
  affordances. Respect `prefers-reduced-motion`: shorten transitions and don't auto-play the
  tour.

### 3.4 Colormaps (hue carries the third variable; luminance carries density)

Colormaps must keep perceptual lightness L* ≥ ~45 over the whole range, so that sparse points
stay visible on `--bg`, and they must be monotone or clearly ordered.
- `redshift` (diverging): blue `#3e7cc4` → `#6fb1d9` → cream `#e9e1c9` → `#ee8a4c` → red
  `#d8433b`. Use it for quantities where "red means old, red or quenched" (the direction is
  set per dimension via `reverse`).
- `sunset` (sequential): `#5a6fd6` → `#9a6cc8` → `#d8699c` → `#f08a5d` → `#f6c85f`.
- `ember` (sequential): `#56708f` → `#3aa6a0` → `#a7c957` → `#e2b23a` → `#e8743b`.
- Category colors are given in §7.

## 4. Repository layout & ownership

```
galaxy-manifold-viz/
├── DESIGN.md                this contract
├── README.md                user-facing overview (written last)
├── catalog/ data/           symlinks into ../sdss-predict-everything (READ-ONLY, gitignored)
├── pipeline/                Python build (owner: data + thumbnails + literature agents)
│   ├── config.py            paths, cuts, dimension table (ranges), seeds
│   ├── fetch_skyserver.py   MGS photometry + Galaxy Zoo 1 from SkyServer DR17 (cached)
│   ├── build_catalog.py     merge → pipeline/cache/galaxies.parquet
│   ├── export_web.py        → site/data/{manifest.json, dims/, cats/, meta/}
│   ├── thumbs.py            representative subset → cutouts → site/data/thumbs/
│   ├── literature.py        verified relations → site/data/literature.json
│   ├── REPORT.md            counts, match rates, sizes, caveats (generated/hand-written)
│   ├── LITERATURE.md        relation table: equations, sources, conversions, verification
│   └── cache/               gitignored intermediates
├── site/                    the static web app = GitHub Pages root
│   ├── index.html
│   ├── css/  tokens.css core.css (core) · ui.css (UI) · overlays.css (overlays)
│   ├── js/   see §12
│   ├── data/ generated data (committed)
│   └── tests/
├── tools/                   dev helpers (synthetic data generator, local server notes)
└── .github/workflows/pages.yml
```

Rules:
- **Never write into `../sdss-predict-everything` or `/home/john/Dropbox/data`.** Read only.
- Each agent owns the files listed for it. You may make a small additive edit to a file you
  don't own only when unavoidable. Re-read the file immediately before editing it, and list
  the edit in your final report.
- Python: use the system `python3` (miniforge: numpy, scipy, pandas, pyarrow, astropy,
  scikit-learn, Pillow, requests, matplotlib). No new heavy dependencies.
- JS: **no build step, no npm dependencies**. Plain ES modules and WebGL2. Only fonts come
  from Google Fonts.

## 5. Data contract (`site/data/`)

All binary arrays are **little-endian**. Rows are in a **fixed random order** (a permutation
with seed `20260924`), so **any prefix of rows is a uniform random subsample**. The client
relies on this for fast approximate statistics.

### 5.1 Files

```
site/data/
  manifest.json
  dims/<key>.u16.gz        one per dimension (encoding §5.3)
  cats/<key>.u8.gz         one per category (uint8 codes; 0 = missing), gzip
  meta/ra.f32.gz meta/dec.f32.gz            float32 degrees, gzip
  meta/plate.u16.gz meta/mjd.u16.gz meta/fiber.u16.gz   uint16, gzip (mjd stored minus 50000)
  thumbs/index.u32.gz      uint32 row index of thumbnail k (length K), gzip
  thumbs/crop.f32.gz       float32 full side length (arcsec) of thumbnail k's crop, gzip
  thumbs/<floor(k/1000)>/<k>.jpg    64×64 JPEG thumbnails
  literature.json          §9
```

**Gzip handling on the client:** fetch → `ArrayBuffer`. If the first two bytes are
`0x1f 0x8b`, decompress with `DecompressionStream('gzip')`; otherwise treat the bytes as
already decompressed, since a server may have applied Content-Encoding.

### 5.2 `manifest.json`

```jsonc
{
  "schema": 1,
  "title": "SDSS DR7 Main Galaxy Sample",
  "n": 651234,
  "seed": 20260924,
  "created": "2026-09-24",
  "cosmology": {"H0": 70.0, "Om0": 0.3},
  "encoding": {"dims": "u16-shuffle-gzip", "missing": 0},
  "dims": [ /* DimSpec, in canonical order (§6) */ ],
  "categories": [ /* CatSpec (§7) */ ],
  "meta": {
    "ra":    {"file": "meta/ra.f32.gz",    "dtype": "f32"},
    "dec":   {"file": "meta/dec.f32.gz",   "dtype": "f32"},
    "plate": {"file": "meta/plate.u16.gz", "dtype": "u16"},
    "mjd":   {"file": "meta/mjd.u16.gz",   "dtype": "u16", "offset": 50000},
    "fiber": {"file": "meta/fiber.u16.gz", "dtype": "u16"}
  },
  "thumbs": {            // null until the thumbnail step has run
    "count": 16000, "size": 64, "shard": 1000,
    "index": "thumbs/index.u32.gz", "crop": "thumbs/crop.f32.gz",
    "url": "thumbs/{shard}/{k}.jpg", "pixscale": 0.262,
    "source": "SDSS gri via Legacy Survey viewer (layer=sdss)"
  },
  "sources": [ {"key": "mpajhu", "label": "MPA-JHU DR8", "cite": "…", "url": "…"}, … ]
}
```

**DimSpec**

```jsonc
{
  "key": "logM",             // stable identifier used everywhere (URL state, presets, literature)
  "label": "log M★",         // axis label (unicode, no LaTeX)
  "short": "M★",             // ≤5 visible chars: rail token / compass tip
  "unit": "M☉",              // "" if dimensionless
  "group": "stars",          // stars|sf|chem|struct|kin|gas|env|lines|obs|learned
  "file": "dims/logM.u16.gz",
  "min": 7.0, "max": 12.5,   // quantization range (physical units)
  "center": 10.62,           // median of valid values
  "scale": 0.58,             // 1.4826 × MAD of valid values (fallback: std)
  "nvalid": 650000,
  "quantiles": [/* 101 values: 0th..100th percentile of valid values */],
  "desc": "Stellar mass, MPA-JHU LGM_TOT_P50, Kroupa IMF",   // tooltip / about
  "source": "mpajhu"
}
```

### 5.3 `u16-shuffle-gzip` encoding (dimensions)

- Quantize: `v = 0` if the value is missing, non-finite, or outside `[min, max]`. Otherwise
  `v = 1 + round((x − min) / (max − min) × 65534)`, which gives `v ∈ [1, 65535]`.
- Decode: `x = min + (v − 1) × (max − min) / 65534`.
- Byte shuffle: for the `n` uint16 values, write **all n low bytes, then all n high bytes**
  (length 2n). Then gzip at level 9.
- Client: gunzip → `s` (Uint8Array, 2n) → `v[i] = s[i] | (s[n + i] << 8)`.

### 5.4 Categories (`u8`, gzip, no shuffle)

The code values are defined in §7. Code 0 means missing.

## 6. Dimensions (canonical order = manifest order)

Standardized coordinate: **u = (x − center) / scale**. All projection math happens in u-space.

| # | key | label | short | unit | group | definition | range |
|---|---|---|---|---|---|---|---|
| 0 | `logM` | log M★ | M★ | M☉ | stars | MPA-JHU `LGM_TOT_P50` (Kroupa) | 7.0–12.5 |
| 1 | `logSFR` | log SFR | SFR | M☉ yr⁻¹ | sf | `SFR_TOT_P50` | −4.0–2.5 |
| 2 | `logsSFR` | log sSFR | sSFR | yr⁻¹ | sf | `SPECSFR_TOT_P50` | −14.0– −8.0 |
| 3 | `D4000` | Dₙ4000 | D4k | | stars | `D4000_N` | 0.8–2.6 |
| 4 | `HdA` | HδA | Hδ | Å | stars | `LICK_HD_A` | −6–12 |
| 5 | `gr` | ⁰·¹(g−r) | g−r | mag | stars | Lim+17 k-corrected color at z=0.1 | −0.2–1.4 |
| 6 | `OH` | 12+log(O/H) | O/H | | chem | MPA-JHU `OH_P50` (T04 Bayesian; SF galaxies only) | 7.6–9.5 |
| 7 | `OH_PP04` | 12+log(O/H)ᴼ³ᴺ² | O/Hᴾ | | chem | PP04 O3N2: `8.73 − 0.32·O3N2` for BPT-SF galaxies with S/N>3 in Hβ, [OIII]5007, Hα, [NII]6584 and −1<O3N2<1.9 | 7.8–9.2 |
| 8 | `logR50` | log R₅₀ | R₅₀ | kpc | struct | Petrosian r-band `petroR50_r` × kpc/″ (H0=70, Ωm=0.3) | −1.0–2.0 |
| 9 | `C` | R₉₀/R₅₀ | C | | struct | `petroR90_r / petroR50_r` | 1.2–4.5 |
| 10 | `logSigma` | log Σ★ | Σ★ | M☉ kpc⁻² | struct | `logM − log(2π R50²)` | 5.5–11.0 |
| 11 | `ba` | b/a | b/a | | struct | `expAB_r` if `fracDeV_r` < 0.5 else `deVAB_r` | 0.0–1.0 |
| 12 | `pEl` | P(E) | P(E) | | struct | Galaxy Zoo 1 `p_el_debiased` | 0.0–1.0 |
| 13 | `logSigV` | log σ | σ | km s⁻¹ | kin | fiber `V_DISP` × (1.5″ / (R50″/8))^0.04 (Jørgensen+95 aperture correction). Valid if 40<σ<500 and 0<err<0.3σ | 1.3–2.8 |
| 14 | `mu50` | ⟨μ⟩₅₀ | μ₅₀ | mag arcsec⁻² | struct | `(petroMag_r − A_r) + 2.5 log(2π R50″²) − 10 log(1+z)` (no K-corr) | 16–26 |
| 15 | `logfHI` | log M_HI/M★ | f_HI | | gas | ALFALFA α.100 detections (`log_fgas` in mgs_parent) | −3.0–2.5 |
| 16 | `logMh` | log M_h | M_h | M☉ | env | Lim+17 SDSS(M) group halo mass, converted h⁻¹M☉→M☉ with h=0.7 (+0.155 dex) | 10.0–15.5 |
| 17 | `N2Ha` | log [NII]/Hα | N2 | | lines | [NII]6584/Hα, S/N>3 in both | −2.5–1.0 |
| 18 | `O3Hb` | log [OIII]/Hβ | O3 | | lines | [OIII]5007/Hβ, S/N>3 in both | −1.5–1.5 |
| 19 | `z` | z | z | | obs | spectroscopic redshift | 0.0–0.3 |

Notes:
- Line S/N uses the MPA-JHU recommended error rescalings. Check
  `../sdss-predict-everything/src/build_catalog.py` / `sr_parent.py` for how that project
  treated line errors, and follow the MPA-JHU DR7/DR8 documentation.
- The code must handle up to **24 dims** (6 × vec4) without changes, so future learned
  embeddings (group `learned`) can be appended to the manifest.

## 7. Categories

| key | label | codes |
|---|---|---|
| `bpt` | BPT class | 1 SF (MPA 1) · 2 SF low-S/N (MPA 2) · 3 Composite (MPA 3) · 4 Seyfert (MPA 4 and log[OIII]/Hβ > 1.05·log[NII]/Hα + 0.45, Schawinski+07) · 5 LINER (MPA 4, below that line) · 6 LINER low-S/N (MPA 5) · 7 Unclassifiable (MPA −1) |
| `env` | environment | 1 isolated central (N_mem=1) · 2 group central (N_mem≥2, galaxy is the group's `cen ID`) · 3 satellite · 0 no Lim+17 match |
| `morph` | Galaxy Zoo 1 | 1 elliptical · 2 spiral · 3 uncertain (GZ1 debiased flags) · 0 no GZ1 match |

Category colors (app config): bpt → 1 `#6fa8dc`, 2 `#9cc3e4`, 3 `#3aa6a0`, 4 `#de5b52`,
5 `#e8743b`, 6 `#e2b23a`, 7 `#7a7465`; env → 1 `#efe6d2`, 2 `#e2b23a`, 3 `#b07aa1`;
morph → 1 `#de5b52`, 2 `#6fa8dc`, 3 `#7a7465`.

## 8. Thumbnails

- **K ≈ 16,000** representatives, chosen with MiniBatchKMeans (K clusters) on standardized
  `[logM, logsSFR, logR50, C, gr, D4000, z]` over all galaxies with those values. Pick the
  member nearest each centroid. Among the 5 nearest, prefer one that already has a local
  cutout if it lies within 1.5× the nearest distance. k-means density (∝ ρ^(d/(d+2))) is the
  right compromise between density-proportional and uniform coverage.
- Local source cutouts are 160×160 px at 0.262″/px. `data/images-sdss/<objID>.jpg` covers the
  emission-line imaging sample, and `data/images-extra/p<plate>-<mjd>-<fiber>.jpg` covers the
  ALFALFA additions. Fetch missing ones from
  `https://www.legacysurvey.org/viewer/cutout.jpg?ra=…&dec=…&pixscale=0.262&layer=sdss&size=160`.
  That is the same source and format as the local set. Use ≤6 concurrent requests, retries
  with backoff, and reject bodies under 1 kB. Make the step resumable and cache the results
  in `pipeline/cache/cutouts/`.
- Crop: centered square with side `clip(3.0 × petroR90_r, 12″, 42″)`. Resize with Lanczos to
  64×64 and save as JPEG q=88 with no metadata. Record the crop side in arcsec in
  `thumbs/crop.f32.gz`.
- The inspector's large image is **not** stored. It is hot-linked at view time from the
  Legacy Survey viewer: `layer=ls-dr9`, 256 px, 0.262″/px, falling back to `layer=sdss`.

## 9. Literature relations (`site/data/literature.json`)

```jsonc
{
  "schema": 1,
  "relations": [
    {
      "id": "T04",                       // unique, short
      "label": "T04",                    // ≤6 chars, drawn at the curve end
      "name": "Tremonti et al. (2004) MZR",
      "cite": "Tremonti, C. A., et al. 2004, ApJ, 613, 898",
      "url": "https://ui.adsabs.harvard.edu/abs/2004ApJ...613..898T",
      "view": "mzr",                     // preset id it belongs to (for grouping in the UI)
      "x": {"logM": 1.0},                // native axis = Σ coef·dim, physical units
      "y": {"OH": 1.0},
      "kind": "fit",                     // fit | median | band | demarcation | threshold
      "curves": [
        {"id": "main", "label": null, "style": "solid",      // solid | dashed | dotted
         "points": [[8.5, 8.43], [8.55, 8.46], …]}            // [A_x, A_y] in native combined units
      ],
      "band": null,                      // optional [[A_x, lo, hi], …]
      "fitOffset": false,                // true → client shifts curves in y by median(data − curve)
      "range": [8.5, 11.5],
      "notes": "Kroupa IMF; T04 O/H scale = MPA-JHU OH_P50.",
      "conversions": "none",
      "verification": {"status": "verified", "source": "arXiv:astro-ph/0405537 eq. 3", "excerpt": "…"}
    }
  ]
}
```

- Native axis values are A = Σ κ_d x_d. A vertical threshold, such as a Σ★ threshold, is a
  curve with two points at the same A_x that span the y range.
- **Our data conventions** are what the literature has to be converted *to*: masses and SFRs
  use the Kroupa IMF (MPA-JHU), and cosmology is H0=70, Ωm=0.3. R₅₀ is the Petrosian
  **r-band** half-light radius in kpc. σ is aperture-corrected to R₅₀/8. μ₅₀ is defined as
  in §6. O/H is either T04 (`OH`) or PP04-O3N2 (`OH_PP04`). M_h is Lim+17 in M☉ (h=0.7).
  IMF conversions follow Madau & Dickinson (2014): M★(Salpeter)×0.61 = Chabrier and
  ×0.66 = Kroupa, so Chabrier → Kroupa is +0.034 dex. Cite the conversions you use.

## 10. Projection math (`site/js/math/frame.js`, pure, unit-tested)

- **Frame** F: D×2 matrix with orthonormal columns in u-space, stored column-major as a
  `Float64Array(2D)`: `[px_0..px_{D−1}, py_0..py_{D−1}]`.
  Projected coordinates: `X = Σ_d px_d u_d`, `Y = Σ_d py_d u_d`.
- **Axes from physical combos**: combo `{key: κ}` → u-vector `v_d = κ_d · scale_d`, then
  normalize. Build x first, then Gram–Schmidt y against x.
- **Axis labels (physical)**: for column p, `k_d = p_d / scale_d`. The reference dim is
  `r = argmax |p_d|`, and κ_d = k_d / k_r (so κ_r = 1). The physical axis value is
  `A = Σ κ_d x_d = (X + Σ k_d c_d) / k_r`, hence tick position `X = k_r A − Σ k_d c_d`.
  Show terms with |p_d| ≥ 0.08 and κ to 2 decimals, e.g. `log M★ − 0.32 log SFR`. With a
  single term, show the label and unit: `log M★ [M☉]`.
- **Manual tour** (Cook & Buja 1997). To drag dim j's spoke to target (a′, b′), with
  a′²+b′² ≤ 0.995:
  1. Let (a, b) = (px_j, py_j). Form m = e_j − F Fᵀ e_j. If |m| ≈ 0, e_j already lies in the
     plane; rotate in-plane instead.
  2. Take the orthonormal basis B = [f₁, f₂, m̂], where e_j = (a, b, c) with c = |m|.
  3. Set the target (a′, b′, c′) with c′ = √(1 − a′² − b′²). Take R ∈ SO(3) to be the minimal
     rotation (Rodrigues) that maps (a, b, c) → (a′, b′, c′).
  4. Then F′ = B · (R[0:2, :])ᵀ, i.e. the new frame columns are B·Rᵀ[:, 0] and B·Rᵀ[:, 1].
  5. Re-orthonormalize to control drift.
- **Geodesic interpolation** (grand tour & animated snaps; Buja et al. 2005): compute the
  principal angles from the SVD of F_aᵀF_b, and interpolate within the Grassmannian plus an
  in-plane rotation so that F(0)=F_a and F(1)=F_b exactly. If the in-plane map is a reflection,
  fall back to a linear blend of F_a and F_b followed by re-orthonormalization (polar
  decomposition). Unit tests must check orthonormality for t ∈ [0,1] and the endpoints.
- **Grand tour**: random targets are uniform random 2-frames restricted to the "tour set" of
  dims. Interpolate geodesically at a constant angular speed of about 0.35 rad/s × speed.
- **Missing values**: a missing u_d is replaced by 0 for positioning. A point's visibility is
  `Π_{d missing} clamp(1 − w_d/0.12, 0, 1)`, where `w_d = √(px_d² + py_d²)`. Points
  therefore fade out smoothly as a dimension they lack rotates in. Discard points with
  visibility < 0.01.
- **Alignment** of a native combo with a frame column is |v̂·p|. A literature relation is
  visible with opacity `smoothstep(0.90, 0.985, min(align_x, align_y))`.
- Mapping native curve points to screen: `X_native = (A_x − Σ κ_d c_d) / |v_x|`, and the
  same for y.

## 11. Rendering (`site/js/gl/`)

WebGL2 only. Show a graceful full-screen message if WebGL2 is unavailable.

- **Attributes:** `a_d0..a_d5` (vec4 from `UNSIGNED_SHORT`, normalized). Pack dims 4 per
  attribute and pad unused slots with 0, which reads as missing. Add `a_cats` (uvec4 from
  `UNSIGNED_BYTE`: bpt, env, morph, spare, via `vertexAttribIPointer`) and `a_sel` (u8
  selection flag).
- **Decode in the shader:** missing if `val < 0.5/65535`. Otherwise `u = A_d·val + B_d` with
  `A_d = 65535(max−min)/(65534·scale)` and `B_d = (min − (max−min)/65534 − center)/scale`.
  Pass these as uniform vec4 arrays.
- **Uniforms:** frame columns (6×vec4 each), per-dim missing-fade factors, color one-hot
  (6×vec4) + normalization range, z-filter range, required-dim one-hot (6×vec4), category
  bitmasks, camera, point size, gain,
  selection-active flag.
- **Pass 1 (accumulate)** into an offscreen float FBO: RGBA32F when `EXT_color_buffer_float`
  and `EXT_float_blend` are available, otherwise RGBA16F. Use additive blending and soft round
  point sprites of 1.5–4 px × DPR.
  - Continuous color: `R += vis·k`, `G += vis·k·c` (c = normalized color value ∈ [0,1]),
    `B += vis·k·hasColor`, `A += vis·k·selected`.
  - Categorical color: use MRT (2 attachments = 8 channels), one channel per class code 1–7,
    plus channel 8 for the selected count.
- **Pass 2 (composite)**, a full-screen triangle:
  - Luminance: `L = 1 − exp(−gain · count / ref)`, then γ≈0.8. Compute `ref` automatically from
    a CPU 2-D histogram of the visible subsample (the ~95th percentile of occupied-bin density,
    scaled to pixels).
  - Hue: `colormap(G/B)` for continuous color, or the count-weighted mix of class colors for
    categories. Pixels without color info get neutral cream.
  - With a selection active, unselected points dim to about 25% and selected ones get a warm
    cream/orange lift.
  - Background: `--bg`. An optional subtle bloom (the phosphor feel) is welcome if cheap.
- **Previews:** `renderer.renderPreview(frame, opts)` renders an offscreen image (about
  112×72 px) of any frame for the preset cartridges.
- **Targets:** 60 fps with ~650k points on a laptop iGPU during a tour, with no CPU work per
  frame beyond uniform updates.

## 12. App architecture & API (`site/js/`)

```
js/main.js            bootstrap: load manifest → createApp → initUI → initOverlays
js/app.js             creates `app` (also window.app); wires everything
js/state.js           Store: get(), set(patch, {source}), subscribe(fn)
js/events.js          Emitter: on(name, fn) → off, emit(name, payload)
js/config/presets.js  PRESETS (§14)
js/config/dims.js     per-dim UI config: colormap, reverse, tourDefault, format
js/config/style.js    group colors, category colors, colormap control points
js/data/loader.js     manifest + columns (fetch/gunzip/unshuffle), Dataset
js/data/thumbs.js     ThumbCache
js/math/frame.js      §10 (pure) · js/math/linalg.js · js/math/stats.js (quantiles, running
                      medians, 2-D hist) · js/math/cosmo.js (kpcPerArcsec(z), flat ΛCDM 70/0.3)
js/math/pursuit.js    projection pursuit "tighten" (overlays agent)
js/gl/renderer.js js/gl/shaders.js js/gl/colormaps.js
js/view/camera.js     pan/zoom transform
js/view/projection.js CPU projection cache + picking (Worker or time-sliced, never >50 ms jank)
js/view/interaction.js pointer handling + tool registry
js/view/overlays/*    overlays agent: index.js axes.js trends.js literature.js lasso.js mosaic.js
js/ui/*               UI agent: index.js header.js presets.js rail.js compass.js console.js
                      inspector.js hover.js about.js urlstate.js keys.js splash.js icons.js
```

### 12.1 `app` object (created by core; used by UI and overlays)

```js
app = {
  data,          // Dataset (below)
  store,         // Store with the state shape in §12.2
  events,        // Emitter; events listed in §12.3
  renderer, camera, proj, thumbs, interaction,
  config: { presets, dims, style },
  frame,         // current Float64Array(2D) (read-only; change via actions)
  layers: { gl, tiles, overlay, stageUI },  // canvases/elements in #stage
  requestRender(),                          // rAF-coalesced redraw of GL + 'render' event
  actions: {
    setFrame(F, {duration=0}={}),
    setAxes({x, y}, {duration=1100, fit=true}={}),   // x/y: physical combos {key: coef}
    applyPreset(id, {duration}={}),
    rotateDim(key, [ax, ay]),                          // manual-tour step (immediate)
    setColor(keyOrCatOrNull),                          // 'logSFR' | 'cat:bpt' | null
    setMode('glow' | 'mosaic'),
    setFilter(patch),                                  // {z:[lo,hi]} | {cats:{bpt:mask}}
    tour: { play(), pause(), toggle(), setSet(keys), setSpeed(v) },
    fit({duration=600}={}), resetView(),
    select(maskOrNull), inspect(indexOrNull), setTool('pan' | 'lasso'),
    setOverlay(name, bool),                            // 'trends' | 'literature' | 'axes'
    setRender(patch),                                  // {gain, pointSize}
    setMosaic(patch),                                  // {cell, scale:'fit'|'true'}
  },
  pursuit: { tighten(opts) },  // installed by overlays agent
}
```

**Dataset:** `n`, `dims` (DimSpec + `index`), `dimIndex(key)`, `raw[k]` (Uint16Array),
`value(i, k)` (physical or NaN), `ustd(i, k)`, `column(k)` (Float32Array physical, lazy,
NaN = missing), `cats[key]` (Uint8Array), `catSpec(key)`, `meta` (lazy; resolves after
`data:meta`), `thumbRows` (Uint32Array), `thumbCrop` (Float32Array), `rowToThumb`
(Int32Array(n), −1 = none), `manifest`.

**ProjectionCache (`app.proj`):** after each settle, `X`, `Y` (Float32Array n, u-space
projected) and `vis` (Uint8Array n, 0–255, including filters) are valid for the current frame.
It also provides `version`, `pick(sx, sy, rPx=10) → index | −1`, `projectRow(i, F?) → [X, Y]`,
and `sampleVisible(k) → Int32Array`.

**Camera:** `toScreen(X, Y) → [sx, sy]` in CSS px, `toData(sx, sy)`,
`fitBounds([x0, x1, y0, y1], {duration, pad})`, and `cx, cy, scale, width, height, dpr`.

**Interaction:** wheel zooms around the cursor, and drag pans when tool = 'pan'. Click picks a
galaxy and calls `inspect`. Hover emits `hover`, throttled, and never while animating.
Double-click fits the view. Tools and handlers are added with
`registerTool(name, {onDown, onMove, onUp, cursor})` and
`addClickHandler(fn, priority) → off`, where a handler returns `true` to consume the click.

**ThumbCache:** `url(k)`, `get(k) → HTMLImageElement | null` (starts loading, emits `thumb`
on load, at most 16 in flight), and `forRow(i) → k | −1`.

### 12.2 State shape

```js
{
  presetId: 'mzr' | null,
  color: 'logSFR' | 'cat:bpt' | null,
  mode: 'glow' | 'mosaic',
  overlays: { trends: true, literature: true, axes: true },
  filters: { z: [lo, hi] | null, cats: { bpt: 0xFF, env: 0xFF, morph: 0xFF },  // bitmask over codes 0..7
             needColor: false },  // hide galaxies without a value of the color variable
  tour: { playing: false, set: [...keys], speed: 1 },
  render: { gain: 1, pointSize: 2 },
  tool: 'pan' | 'lasso',
  selection: null | { mask: Uint8Array, count },
  inspected: null | rowIndex,
  mosaic: { cell: 56, scale: 'fit' | 'true' },
}
```

The frame is **not** in the store, because it changes every animation frame. It lives in
`app.frame` and is broadcast through the `frame` event.

### 12.3 Events

`data:ready`, `data:meta`, `thumb` (k), `frame` ({animating}), `camera`,
`settle` (emitted once motion stops for about 150 ms, after `proj` is refreshed),
`state` ({changed, state}), `hover` ({index, sx, sy}), `inspect` ({index}), `select`
({count}), `resize`, `render`.

### 12.4 Page DOM (core creates the containers; UI fills them)

```html
<div id="app">
  <header id="topbar"></header>      <!-- UI -->
  <nav id="rail"></nav>              <!-- UI -->
  <main id="stage">                  <!-- core -->
    <canvas id="gl"></canvas><canvas id="tiles"></canvas><canvas id="overlay"></canvas>
    <div id="stage-ui"></div>        <!-- UI mounts compass + hover card here -->
  </main>
  <aside id="inspector"></aside>     <!-- UI -->
  <footer id="console"></footer>     <!-- UI -->
</div>
<div id="splash"></div>              <!-- UI (core shows a minimal default) -->
```

Layout: header 52 px, rail 68 px on the left, console 56 px at the bottom. The inspector is
a 340 px drawer that slides over the stage from the right and is hidden by default. The stage
fills the rest. On narrow screens (<760 px), the rail becomes a horizontal strip, the compass
shrinks, and the inspector becomes a bottom sheet. It must remain usable and must not scroll
horizontally.

## 13. UI components

### 13.1 Top bar
The wordmark `GALAXY MANIFOLD` sits on the left in Michroma, with a small starburst glyph.
Next to it is a tiny data badge (`N 651,234` in Space Mono, `--cream-3`). The **preset
cartridges** sit center-right (§13.5). An ⓘ button on the far right opens the about overlay.

### 13.2 Rail (dimension tokens)
The rail is a vertical list of pill tokens (`short`), grouped by `group` with a thin
group-colored bar. Token states: *in-view* (weight w_d > 0.1: filled with the group color,
with fill opacity ∝ w_d), *in tour set* (outlined), and *color variable* (a small ◐ marker).
Hovering a token highlights its compass spoke and shows a tooltip with the full label, unit
and description.
- **Click** opens a tiny radial menu of icons only: → X, → Y, ◐ color, ⟲ tour-set toggle.
- **Drag** a token onto the X or Y ruler to set that axis (animated). **Drag** it onto the
  compass to bring the dimension into the view at the drop direction.
- Categories (bpt, env, morph) appear in a small separate block below as color-only tokens.

### 13.3 Starburst compass (manual tour), `#stage-ui` bottom-left, ~200 px
This is an SVG bezel with 60 ticks and a cream hairline ring. There is one spoke per dimension
with w_d > 0.03, running from the center to (px_d, −py_d)·R and ending in a knob (the group
color) with the `short` label. Dimensions not in view sit as small dots on a "parking" arc.
- **Drag a knob** → `actions.rotateDim(key, [ax, ay])` (manual tour, live).
- **Double-click a knob** rotates that dimension out of the view (target (0,0)).
- The small buttons next to it are ▶/❚❚ (tour), a speed dial, and ⊸ tighten
  (`app.pursuit.tighten`).
- The compass fades to 40% opacity when idle and returns to full on hover.

### 13.4 Console (bottom)
- A mode switch styled as a mid-century rocker: **✺ glow / ▦ mosaic**.
- A color-by dial: it shows the current symbol and a mini colorbar with min/max in mono.
  Clicking it opens a popover grid of all dims and categories. For categories, the legend chips
  toggle classes, which sets the filter bitmask. A funnel beside the legend hides every galaxy
  without a value of the color variable (`filters.needColor`).
- Toggles: trends ∿, literature (a small open-book glyph), lasso ◌, reset ⟲, and share (copies
  the URL).
- Knobs: gain ☼ and point size •, drawn as rotary controls. Drag vertically or scroll to turn.
- A z-filter mini histogram with two draggable handles.
- In mosaic mode, show a cell-size knob and a fit/true-scale toggle.

### 13.5 Preset cartridges
Each preset is a small rounded "cartridge" with a live preview image (renderer preview) above
a 3–4 character code in Michroma. The active one gets an orange underline or glow. When the
frame drifts away (alignment < 0.99), the active state fades. Number keys 1–9 and 0 select the
first 10 presets.

### 13.6 Inspector (right drawer)
- **One galaxy:** a large hot-linked image with a physical scale bar (e.g. 10 kpc, via
  `cosmo.kpcPerArcsec`), and a "percentile strip" for every dimension: a thin track with a dot
  at the galaxy's percentile, using the manifest quantiles. Values appear in mono on hover.
  Category chips are shown too. Icon links go to the SkyServer explorer (ra/dec), the Legacy
  viewer and the SDSS spectrum (plate/mjd/fiber).
- **Selection:** the count, a gallery of up to 48 thumbnails of selected galaxies (from the
  thumbnail subset, the most typical first), and percentile strips that overlay the
  selection's distribution against everyone's. This is the "what is special about these
  galaxies" view.

### 13.7 Hover card
After a 120 ms dwell, show the thumbnail if one exists (if a thumbnail galaxy lies within
12 px, prefer it) and 3 values: x, y and the color variable. It is small, cream-framed, and
never shown while animating.

### 13.8 Splash & about
The splash is the wordmark plus an animated starburst and orbit with a thin progress arc, and
no text. The about overlay holds a one-line description, data credits (SDSS, MPA-JHU,
Lim+17, ALFALFA α.100, Galaxy Zoo 1, Legacy Surveys), the literature references (generated
from literature.json), keyboard shortcuts, and a short caveats list (§18).

### 13.9 URL state
The hash encodes: preset id or frame (compact base64 of float32 or quantized int16), color,
mode, filters, overlays, and camera. Loading a URL restores the view, and a debounced
`history.replaceState` runs on change.

### 13.10 Keyboard
`1`–`9`, `0` presets · `space` tour · `L` lasso · `M` mode · `T` trends · `B` literature ·
`C` cycle color · `V` only galaxies with a color value · `F` fit · `Esc` clear selection /
close · `?` about.

## 14. Presets (`site/js/config/presets.js`)

Axes are physical combos. Each preset may set a color, a filter and literature ids.

| id | code | x | y | color | filter | literature |
|---|---|---|---|---|---|---|
| `mzr` | MZR | `{logM:1}` | `{OH:1}` | `logSFR` | – | T04, AM13, C20 |
| `fmr` | FMR | `{logM:1, logSFR:-0.32}` | `{OH_PP04:1}` | `logSFR` | – | M10 |
| `sfms` | SFMS | `{logM:1}` | `{logSFR:1}` | `D4000` | – | RP15, S14, S16, Q11 |
| `ssfr` | sSFR | `{logM:1}` | `{logsSFR:1}` | `cat:env` | – | Q11 |
| `cmr` | CMR | `{logM:1}` | `{gr:1}` | `logsSFR` | – | – |
| `size` | R–M | `{logM:1}` | `{logR50:1}` | `C` | – | S03L, S03E |
| `sigma` | Σ★ | `{logSigma:1}` | `{logsSFR:1}` | `logM` | – | K03S |
| `fp` | FP | `{logSigV:1.49, mu50:0.30}` | `{logR50:1}` | `D4000` | `morph∈{1}` | B03 (fitOffset) |
| `bpt` | BPT | `{N2Ha:1}` | `{O3Hb:1}` | `cat:bpt` | – | K03, K01, S07 |
| `shmr` | SHMR | `{logMh:1}` | `{logM:1}` | `logsSFR` | `env∈{1,2}` | Mo13, B13 |
| `env` | ENV | `{logMh:1}` | `{logsSFR:1}` | `cat:env` | – | Q11 |
| `hi` | H I | `{logM:1}` | `{logfHI:1}` | `logsSFR` | – | C18 |
| `d4k` | D4k | `{D4000:1}` | `{HdA:1}` | `logsSFR` | – | – |

The literature ids are indicative. The literature agent fixes the final ids, and presets must
reference ids that exist, or the UI simply ignores missing ones. The initial view on first
load is an animated arrival into **MZR** from a random frame.

Default tour set: `logM, logsSFR, OH, logR50, C, gr, D4000, logSigV, logMh`.

## 15. Overlays (overlays agent)

- **Axes:** bottom and left rulers with ticks in physical units (§10), plus formula titles
  in Space Mono, updated live during rotation. They are drop zones for rail tokens.
- **Trends:** the running median, with a 16–84% band, of Y in bins of X over a visible
  subsample. Use ≤60k points on settle and ≤15k during motion at ≤10 Hz. Require ≥30 points
  per bin. With a continuous color variable, draw 4 quantile-group median lines colored by the
  colormap. With a categorical color variable, draw one line per class with ≥200 points.
- **Literature:** draw each relation with alignment-based opacity (§10), in mustard, dashed or
  dotted per style, with a tiny label at the curve end. If `fitOffset` is set, shift the curve
  by the median residual of visible points within the range. The band, if present, is drawn
  translucent. The relation's name and citation appear on hover over the label.
- **Lasso:** the tool draws a freeform polygon. On release, the selection is computed from
  `proj` (point-in-polygon on X,Y), then `actions.select(mask)`. Shift adds to the selection
  and Alt subtracts.
- **Mosaic:** a grid of square cells with default side 56 CSS px. For each cell, the
  candidates are thumbnail galaxies that project into it with vis > 0.5. Choose the candidate
  closest, in full u-space over the dims valid for both, to the mean u-vector of the cell's
  candidates. Show a tile only if the cell holds ≥ 3 galaxies from the first-100k-row
  subsample. Tiles are drawn with a 1 px gap and a 2 px corner radius, and fade in with a slight
  stagger. In *true-scale* mode, each image is drawn at size ∝ crop″ × kpcPerArcsec(z) / 50 kpc
  relative to the cell and clipped to it. During motion, re-tile at ≤4 Hz using loaded images
  only. Clicking a tile calls `inspect`. The glow is dimmed to about 35% under tiles.
- **Tighten (pursuit):** keep y fixed and search x within the span of the current x dims
  plus the tour-set dims (excluding y's dims). Minimize the robust scatter (1.4826·MAD) of y
  about its running median in x over a 20k visible subsample. Nelder–Mead over ≤5 dims is
  enough. Then animate to the result. For example, starting from MZR (PP04) with SFR in the
  tour set, it should find an FMR-like α.

## 16. Performance & compatibility

- The first paint should come within about 3 s on broadband. Show loading progress on the
  splash. Meta columns (ra, dec, plate, mjd, fiber) load after the first paint.
- Support recent Chrome, Edge, Firefox and Safari. WebGL2 is required.
- Keep `site/data` under about 90 MB total, with dims (gz) around 20 MB or less. If the full
  sample exceeds that, the export may subsample randomly, keeping all H I detections, and must
  report what it did.

## 17. Testing

- `site/tests/frame.test.mjs` runs with `node --test site/tests/` and covers the pure math in
  §10.
- `site/tests/smoke.py` uses Python Playwright with the system Chromium (headless, SwiftShader
  WebGL2 works). It serves `site/` over HTTP, loads the app, asserts no console errors, cycles
  through the presets, toggles modes, and saves screenshots to `site/tests/screens/`
  (gitignored).
- Serve locally with `python3 -m http.server -d site 8000`. `fetch()` does not work on
  `file://`.
- Dev data: `tools/make_synth.py` writes a small synthetic dataset in the exact contract to
  `site/data-synth/`, including fake thumbnails. `?data=data-synth` selects it.

## 18. Scientific caveats (for the about overlay and tooltips; keep each to one line)

- The sample is flux-limited (r < 17.77), so scaling relations show Malmquist bias. Filter in
  z to explore it.
- Fiber spectra (3″) cover different fractions of galaxies at different z, which affects O/H,
  SFR and Dn4000.
- The SFR dependence of the FMR depends on the metallicity calibration. With T04 Bayesian O/H
  it is weak or even reversed at high mass, so compare `OH` with `OH_PP04`.
- Petrosian R₅₀ underestimates the true half-light radius of concentrated (n≈4) profiles.
- H I fractions are ALFALFA detections only, which biases them gas-rich at fixed M★.
- Lim+17 halo masses come from abundance matching on group proxies, so the SHMR is partly
  built in by construction.
- Galaxy Zoo 1 fractions are debiased vote fractions, not ground truth.

## 19. Deviations log

(Append entries: date · agent · what changed · why.)

- 2026-09-24 · data · Added a fourth sample cut, one spectrum per DR17 objID (keep the highest `sn_median`). `mgs_parent` is unique by DR7 PHOTOID, but 2,137 galaxies had two spectra tied to different DR7 imaging runs that DR17 resolves to one objID. The export has n = 657,057.
- 2026-09-24 · data · §16: the full sample is exported. Its dims take 20.58 MB gzipped, which is 3% over "about 20 MB", and dropping about 5% of galaxies to save 0.6 MB was not worth it. The export subsamples (keeping all H I detections) only above 21 MB (`DIMS_GZ_TOLERANCE` in `pipeline/config.py`). The dims use zlib level 9 with memLevel 9 and Z_FILTERED. This is a standard gzip stream and about 1% smaller. All gzip files have mtime 0, so rebuilds are byte-identical.
- 2026-09-24 · data · `HdA` and `D4000` also need a positive MPA-JHU error (LICK_HD_A_ERR, D4000_N_ERR from `data/galSpecIndx-dr8.fits`). This removes 1,227 failed HδA measurements that are stored as exactly 0 with error −1.
- 2026-09-24 · data · `gr`: Lim+17 gives photometric outliers a fixed placeholder color (0.832 or 0.889). At those two values the color is set missing when the galaxy's own DR17 model g−r differs by more than 0.2 mag (2,258 galaxies).
- 2026-09-24 · data · `bpt`: 11 MPA class-4 galaxies have a line ratio missing under the rescaled S/N, so they are split with the S07 line using their raw measured-flux ratios (MPA already required S/N>3 in all four lines). None falls to code 7. For `OH_PP04`, "BPT-SF" means MPA BPTCLASS 1. No class-2 galaxy passes rescaled S/N>3 in all four lines, and every class-1 galaxy with four good lines lies below K03.
- 2026-09-24 · data · Manifest additions (additive). CatSpec is `{key, label, file, dtype:"u8", missing:0, codes:[{code, label, name, color, n}], nmissing, desc, source}`. There are top-level `sample` (cuts, n_parent, subsample, radec) and `caveats` (§18 verbatim plus two data caveats: Lim+17 covers the northern cap at z≤0.2 only, and T04 O/H shows grid banding). `meta/ra`, `meta/dec` are DR17 photometric positions (fiber offsets: median 0.05″, max 2.0″). When the objID order hash is unchanged, `export_web.py` keeps a `thumbs` block written by `thumbs.py`.
- 2026-09-24 · data · Lim+17 SDSS covers only the contiguous northern cap, so `gr`, `logMh` and `env` are missing for all galaxies in the southern stripes. This is expected: the z≤0.2 match rate is 99.6% at 60°<RA<300° and 0% outside it.
- 2026-09-24 · literature · §14 MZR: AM13 and C20 are drawn on `OH_PP04`, not `OH`, and KE08 (the Kewley & Ellison 2008 MZR for PP04 O3N2) is added. All three carry view `mzr`. Their O/H scales rest on electron temperature abundances, which lie 0.1 to 0.3 dex below the T04 scale, while PP04 O3N2 is tied to such abundances. On `OH_PP04` they match our data median within 0.03 dex. The `mzr` preset keeps T04 only. We recommend a new preset `mzr2` (x `{logM:1}`, y `{OH_PP04:1}`, color `logSFR`, literature KE08, AM13, C20).
- 2026-09-24 · literature · §14 ids: `Q11` is split into `Q11` (sfms), `Q11s` (ssfr), `Q11e` (env) and a new `Q11d` (sigma), because ids must be unique and each entry has its own native axes. New entries `RP15s` (the RP15 ridge as sSFR, view ssfr) and `H12` (ALFALFA H I relation, view hi) are added. M10 has fitOffset true (Maiolino+08 O/H zero point differs from PP04). The fp combo `{logSigV:1.49, mu50:0.30}` is verified and unchanged.
- 2026-09-24 · literature · §9 schema, additive only: top-level `created` and `conventions` strings, and an optional `curves[].nodes` list (the measured points that a `median` curve joins, used by C18). Every curve has at least 60 points, so the vertical K03S threshold is 61 points at one A_x instead of 2.
- 2026-09-24 · core · §10 geodesic: when FaᵀFb has a negative determinant, the path uses the signed SVD (both outer factors are rotations), so one principal angle exceeds 90° and orientation is kept. An axis swap then animates as a flip about the diagonal. The §10 fallback (linear blend + polar) degenerates in exactly these cases: [e1,e2]→[e1,−e2] or →[e2,e1] pass through a rank-1 frame. `blendFrames` is kept for reference. Grand-tour legs drop the in-plane spin (target = Gb·Uᵀ, the random plane itself).
- 2026-09-24 · core · Camera: an `aspect` (y scale / x scale) is added to `scale`. Fits may stretch one axis up to 2.2× so a relation fills the stage; an isotropic u-space fit left the MZR at about a third of the stage width. `toScreen`/`toData` include the aspect, and rotations keep it. The grand tour eases to aspect 1 and re-fits the camera toward each leg's target plane, unless the user has zoomed or panned during the tour.
- 2026-09-24 · core · §11 categorical accumulation uses three MRT attachments (codes 0–3, codes 4–7, selected; the third is R-only where supported) instead of two. Code 0 (no class) needs its own channel so those galaxies still count toward density and render cream. An RGBA32F target over 192 MB falls back to RGBA16F.
- 2026-09-24 · core · §11 composite: besides L = 1 − exp(−gain·count/ref) with γ 0.8, a floor of 0.2·min(1, count/peak) keeps isolated galaxies visible. With a selection active, unselected light is ×0.25 and selected light gets a ×2.5 exposure boost and a warm lift. Sprite quads are 1.5·pointSize·DPR with the kernel (1−r²)², so `pointSize` is about the visible diameter. The state gains `render.bloom` (0.3, quarter-resolution bloom), `render.dim` and `render.mosaicDim` (0.35).
- 2026-09-24 · core · §11 exposure: ref = 0.6 × (95th percentile of occupied-bin density) × (sprite integral). Screen bins start at 8 px and merge 2×2 (up to 32 px) while the median occupied bin holds fewer than 10 galaxies, which avoids Poisson inflation in sparse subsamples. During motion it is computed in the projection worker and smoothed with τ = 0.15 s. A frame costs only uniform updates on the main thread: 0.2 ms of JS per frame measured during a 657k-galaxy tour.
- 2026-09-24 · core · §12 boot order is manifest → createApp → initUI → initOverlays → `app.load()` → `app.start()`, so the UI splash can show column progress through a new `load:progress` event. Also new: a `context` event ({lost}), `app.preview()` (async GPU readback, `canvas.ready`), and the helpers listed in site/js/API.md. `rotateDim` emits `frame {animating:true}`, and a final `frame {animating:false}` precedes `settle`. When the axis being kept is parallel to the new one, `setAxes` swaps the axes.
- 2026-09-24 · core · Column loading tolerates single failures: a missing dim or category reads as all-missing and is listed in `data.failed`. More than half of the dims failing is fatal.
- 2026-09-24 · core · §14 presets: `mzr2` is added after `mzr` (logM vs OH_PP04, color logSFR, literature KE08, AM13, C20), following the literature agent's recommendation above. `mzr` keeps T04 only. Number keys now run 1 = mzr … 0 = bpt, so SHMR, ENV, H I and D4k have none. Preset literature lists use the literature.json ids.
- 2026-09-24 · core · §17: Node ≥ 21 resolves `node --test site/tests/` as a module, so `site/tests/index.js` imports the test file. `node --test site/tests/*.test.mjs` also works.
- 2026-09-24 · literature verifier · §9 schema, additive only: each relation's `verification` gains `review` = {result: verified, corrected or removed; by; date; checked; second_implementation_max_dy; correction when there is one}. All 24 relations were re-derived from the primary sources: 22 verified, 2 corrected, none removed. M10: the fiber to total SFR offset now comes from an M10-like sample cut on the raw Hα errors, which reproduces the M10 sample (N = 140,574 against their 141,825; the ×2.473 rescaled cut gave 50,144), so μ0.32 shifts by −0.146 dex instead of −0.075. C18: the polyline now passes through all 8 table medians.
- 2026-09-24 · literature verifier · §9 `view`: KE08, AM13 and C20 now carry view `mzr2`, the preset that lists them (added by core), instead of `mzr`. The build now cross-checks `site/js/config/presets.js` (warnings only): all 24 ids are listed, each by the preset named in its `view`, and every one aligns with its preset axes at 1.000.
- 2026-09-24 · orchestrator · §14 default tour set is now `logM, logsSFR, D4000, logR50, C, mu50, pEl` (all ≥96% valid). The original set included OH (22% valid), logMh, gr and logSigV (≈86%). Under the §10 fade rule, every tour-set member carries weight during a tour, so the original set hid ≥78% of galaxies for most of it. Users can still add any dim to the tour from the rail.
- 2026-09-24 · thumbnails · §8 selection: `gr` (Lim+17) is missing for 14% of the sample (the southern stripes and z > 0.2). For the clustering only, those galaxies get a color predicted from their DR17 extinction-corrected model g−r and z (cubic in color times quadratic in z, fitted to the 562,019 galaxies that have both; robust scatter 0.001 mag). So 640,481 galaxies are clustered, 90,323 of them with a predicted color, instead of 550,158. Otherwise no galaxy at z > 0.2 or in the southern stripes could represent a cluster. No exported value changes.
- 2026-09-24 · thumbnails · §8 QA (additive): a representative is also replaced by the next-best member of its cluster, under the same local-cutout preference, when its cutout fails an image check (`QA_RULES` in `pipeline/thumbs.py`): blank or no-data fill, color cast, stellar glare, scattered-light haze, one side of the crop tinted by a star just outside it, a satellite or asteroid trail across the crop, washed-out sky, nothing at the center, a bright star or much brighter neighbor, or a brightness peak away from the center. 273 cutouts failed (115 of them color casts) and 204 clusters changed representative. Six small clusters (2 to 7 members) lost every member to bad frames or bright stars. Four of them have R₅₀ of 38 to 78 kpc, so their photometry is probably corrupt too. K is therefore 15,994.
- 2026-09-24 · thumbnails · §8 crop: the side is clip(3 R90, 12″, 42″) capped at the 160 px source, 41.92″ (615 thumbnails). `thumbs/crop.f32.gz` stores the side actually used. Thumbnails are numbered in ascending row order, so, like the rows, any prefix of them is a uniform random subsample.
- 2026-09-24 · literature verifier (second review) · §9 schema, additive only: each relation's `verification` also gains `second_review` = {result; by; date; checked; third_implementation_max_dy; digest; current; correction when there is one}. `digest` is a checksum of what the site draws (axes, kind, fitOffset, range, band, curve points and nodes), and `current` becomes false, with a build warning, if a curve changes after the review. The second review re-derived all 24 relations from freshly downloaded sources with a third implementation. 23 are verified, 1 is corrected and none is removed. The correction is to the RP15 conversions text, which said the unstated IMF could move the line by up to 0.03 dex. The mass and SFR shifts cancel to +0.001 dex, and no curve changed. The review confirms the first review's M10 and C18 corrections. M10's own sample counts (436k emission line galaxies at 0.07 < z < 0.30, 43 % of them with S/N(Hα) > 25, 22 % AGN) are reproduced with the catalog errors as given (41 to 45 %, 20 %) and not with the ×2.473 rescaled errors (13 to 15 %, 15 %).
- 2026-09-24 · ui · §13.1 badge: the N badge counts the galaxies in the current view (visibility of at least 50%, filters included) and updates at each settle. The sample total is in its tooltip. With a sparse axis such as O/H, the number of galaxies actually shown is the more useful figure.
- 2026-09-24 · ui · §13.1 and §12.4 responsive tiers: the wordmark text hides between 760 and 1150 px wide so that all 14 cartridges fit, and the starburst glyph stays. Below a viewport height of 810 px the rail tokens shrink (20 px, then 18 px below 700 px) so every token stays in view. The console compacts between 760 and 1000 px. Any strip that still overflows (console, rail, cartridge tray) scrolls behind soft edge fades.
- 2026-09-24 · ui · §13.6 inspector: the strips always show the value in mono beside the track, and the tooltip adds the unit and percentile. The category chips became a three-cell readout. The image has a DR9 or SDSS layer switch on top of the automatic fallback. When the inspected galaxy would sit under the drawer (or the phone sheet), the camera pans it into view. The phone sheet closes with a downward swipe on its grip or header. Selection strips spread each galaxy over the percentile interval of its quantized value, so values on a grid (T04 O/H) no longer show as spikes.
- 2026-09-24 · ui · §13.10 keys, additive: `R` resets the view and `Shift+C` cycles the color backwards.
- 2026-09-24 · ui · §13.9 URL hash, additive keys: `g` inspected row, `r` gain and point size, `mc` mosaic cell and scale, `ts` tour set, `sp` tour speed, and `pp` the last preset when the frame has drifted from it (so its fading cartridge and Reset survive a shared link). Round trips were checked for a preset view and for a free frame.
- 2026-09-24 · ui · §13.3 compass: it is 220 px (150 px on phones). It shows at 75% opacity while the tour plays, because its spokes explain the motion, and at 40% when idle. The parked dots form one tab stop, and the arrow keys walk along the arc.
- 2026-09-24 · ui · §13.8 splash: `#splash` in index.html holds the UI splash (starburst, two orbits, tick bezel, progress arc and the wordmark). The UI drives the arc from `load:progress`, so the core's `setProgress` in main.js, which targets `.core-splash`, has nothing to update.
- 2026-09-24 · ui · Additions: a rail token dropped on the color dial colors by it. Shift-click on a legend chip shows only that class. A reticle marks the inspected galaxy on the stage. A tab at the stage's top right reopens a selection. Hovering a cartridge shows a large preview with its axes and literature labels. The about overlay also lists every dimension with its definition and count.
- 2026-09-24 · overlays · §15 trends: with a color variable the grouped median lines are drawn and the overall 16–84% band stays as a faint dotted envelope. With a selection, the selected galaxies get their own dashed median line in the selection color (up to 60k selected visible galaxies on settle, 15k in motion), drawn only in bins holding at least 60 of them. A segment resting on few galaxies is drawn fainter, reaching full strength at about 150 per bin. Band edges are dotted lines, not a fill, because the overlay canvas sits above the glow and a fill would wash it out.
- 2026-09-24 · overlays · §15 literature: a band is a light diagonal hatch with dotted edges (edges only in mosaic mode). An end label carries a swatch of its curve's line style and takes the free spot near the curve end that covers the fewest curves, curve ends, axis titles and labels. A label that had to move away gets a hairline leader. fitOffset is the median y residual of up to 20,000 galaxies that pass the filters, have the relation's native dims and lie inside its range. It is recomputed when the filters change, but not while the view moves, and the tooltip shows it as Δy (M10: −0.246).
- 2026-09-24 · overlays · §15 mosaic: while the view moves, re-tiles (≤ 4 Hz) draw loaded images only, but the typical galaxies' images are queued (up to 96, center first). A cell whose typical galaxy is still loading shows its most typical loaded candidate or an empty frame, so a tour fills in as it turns. Pans and zooms re-tile only once the grid has drifted (zoom beyond ±35% or the view leaving the tiled area). Without thumbnails, dense cells are translucent empty frames over the dimmed glow.
- 2026-09-24 · overlays · §15 tighten: forward stepwise search (a 1-D screen per candidate, then Nelder–Mead over the chosen coefficients, then pruning). A dimension joins x only if it cuts the scatter by at least 3%, which keeps the formula readable. Excluded: y's own dims, dims in y's physical group, dims y is partly derived from (SFR from Dₙ4000; O/H from the line ratios), and x sets that complete a definitional identity with y. With log M★ in x, log sSFR is searched as log SFR, so results read log M★ − α log SFR. From `mzr2` with logSFR in the tour set (or the default set): x = log M★ − 0.518 log SFR, σ(O/H) 0.0755 → 0.0701 dex.
- 2026-09-24 · overlays · §15 axes: titles draw unicode super- and subscripts and the `_x` notation as raised or lowered text, because Space Mono lacks those glyphs. A multi-term label after a sign gets parentheses (`− 1.02 (12+log(O/H))`), trailing terms are dropped with `…` to fit, and a dark halo keeps titles legible over the glow. Rulers, titles and labels stop at the inspector drawer while it is open.
- 2026-09-24 · overlays · §12 API, additive: `app.overlays` (ruler drop zones, `highlightAxis`, `dropDim`, handles to the literature, trends, lasso and mosaic, `stats()`) and a `pursuit` event {phase, result}. See the header of `site/js/view/overlays/index.js`.
- 2026-09-25 · ui · §13.4 and §12.2, additive: `filters.needColor` hides galaxies without a value of the color variable (the color dim missing, or category code 0). It follows the color as it changes, so switching from O/H to log M★ shows everyone again. It is set by a funnel beside the legend, the `V` key and the `cv=1` URL key, and Reset clears it. While it is on with a category color, the legend hides the ∅ chip. `filterParams()` gains `need` (the required dim index), which the shader, the projection kernel, the prefix sample and the literature fitOffset all apply.
