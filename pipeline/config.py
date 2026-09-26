"""Paths, sample cuts, the dimension and category tables, and seeds for the data pipeline.

Everything here mirrors DESIGN.md sections 5-7 and 16. The dimension table (DIMS) is the
single place where keys, labels, units, groups and quantization ranges are defined for the
Python side; `export_web.py` copies it into site/data/manifest.json. Importing this module
has no side effects.
"""

from __future__ import annotations

from pathlib import Path

# ---------------------------------------------------------------------------------------
# paths
# ---------------------------------------------------------------------------------------
ROOT = Path(__file__).resolve().parent.parent
PIPE = ROOT / "pipeline"
CACHE = PIPE / "cache"
SKYSERVER_CACHE = CACHE / "skyserver"
SITE = ROOT / "site"
SITE_DATA = SITE / "data"

# read-only inputs (symlinks into ../sdss-predict-everything, and ~/Dropbox/data, which is
# /home/john/Dropbox/data on Linux and /Users/john/Dropbox/data on macOS)
DROPBOX_DATA = Path.home() / "Dropbox" / "data"
PARENT = ROOT / "catalog" / "mgs_parent.parquet"
IMAGES_SDSS = ROOT / "data" / "images-sdss"      # <objID>.jpg, 160 px, 0.262"/px
IMAGES_EXTRA = ROOT / "data" / "images-extra"    # p<plate>-<mjd>-<fiber>.jpg
# D4000/HdA errors and TAUV_CONT; the same DR8 file lives in both places
GALSPEC_INDX = next((p for p in (ROOT / "data" / "galSpecIndx-dr8.fits",
                                 DROPBOX_DATA / "sdss-mpajhu" / "galSpecIndx-dr8.fits")
                     if p.exists()), ROOT / "data" / "galSpecIndx-dr8.fits")
LIM_DIR = DROPBOX_DATA / "xSAGA" / "lim+2017" / "catalogs"
LIM_GALAXY = LIM_DIR / "SDSS(M) galaxy.dat"
LIM_GROUP = LIM_DIR / "SDSS(M) group.dat"

# intermediates (all under pipeline/cache/, gitignored)
PHOTO_PARQUET = CACHE / "skyserver_photo.parquet"   # SpecObjAll x PhotoObjAll, one row/spectrum
ZOO_PARQUET = CACHE / "skyserver_zoo.parquet"       # the full zooSpec table
LIM_PARQUET = CACHE / "lim17_sdss_m.parquet"        # parsed Lim+17 galaxies joined to groups
CATALOG_PARQUET = CACHE / "catalog.parquet"         # build_catalog.py output (parent order)
BUILD_STATS = CACHE / "build_stats.json"            # counts for REPORT.md
GALAXIES_PARQUET = CACHE / "galaxies.parquet"       # export row order (thumbnails agent reads)
EXPORT_STATS = CACHE / "export_stats.json"
QUICKLOOK_PNG = CACHE / "quicklook.png"
REPORT_MD = PIPE / "REPORT.md"

# ---------------------------------------------------------------------------------------
# conventions, cuts, seeds
# ---------------------------------------------------------------------------------------
SEED = 20260924
CREATED = "2026-09-24"
COSMO = {"H0": 70.0, "Om0": 0.3}
H_LITTLE = 0.7                     # Lim+17 h^-1 Msun -> Msun

Z_MIN, Z_MAX = 0.005, 0.30         # inclusive
LOGM_MIN = 6.0                     # finite log_mstar > 6
R_PETRO_MAX = 17.77                # (petroMag_r - extinction_r) <= 17.77, DR17 photometry

LIM_POS_MATCH_ARCSEC = 2.0         # positional fallback for galaxies without an exact objID match
LIM_POS_MATCH_DZ = 0.01            # sanity check on |z_CMB(Lim) - z(SDSS)| for positional matches
# Lim+17 gives galaxies > 3 sigma off the color-luminosity median a fixed color. Two values
# carry that excess (0.832: 2,783 vs ~800 in neighboring 0.001 bins; 0.889: 2,565 vs ~1,270).
# At those values a color is treated as a placeholder (missing) when the galaxy's own DR17
# extinction-corrected model g-r differs from it by more than this.
LIM_COLOR_PLACEHOLDERS = (0.832, 0.889)
LIM_COLOR_PLACEHOLDER_TOL = 0.2

# MPA-JHU recommended line-flux error rescalings (verified 2026-09-24 against
# https://wwwmpa.mpa-garching.mpg.de/SDSS/DR7/raw_data.html, "Scale uncertainty by").
# mgs_parent carries the raw galSpecLine FLUX_ERR values.
LINE_ERR_SCALE = {"hb": 1.882, "oiii": 1.566, "ha": 2.473, "nii": 2.039}
LINE_SNR_MIN = 3.0
# A_V = 2.5 log10(e) tau_V for the MPA-JHU continuum-fit optical depth TAUV_CONT
TAUV_TO_AV = 1.0857

# PP04 O3N2 (Pettini & Pagel 2004): 12+log(O/H) = 8.73 - 0.32 O3N2, valid for -1 < O3N2 < 1.9
PP04_A, PP04_B = 8.73, -0.32
PP04_O3N2_RANGE = (-1.0, 1.9)
# Schawinski et al. (2007) Seyfert/LINER line in the [NII]/Ha BPT plane
S07_SLOPE, S07_ICPT = 1.05, 0.45
# Jorgensen et al. (1995) aperture correction to R50/8; SDSS fiber radius 1.5"
J95_EXP = 0.04
FIBER_RADIUS_ARCSEC = 1.5
SIGV_MIN, SIGV_MAX, SIGV_MAXFRACERR = 40.0, 500.0, 0.3

# section 16 size budget: "dims (gz) around 24 MB or less" (raised from 20 MB when the dust
# dims were added). Subsample only when the full sample overshoots by more than 5%; then
# subsample to the budget itself.
DIMS_GZ_BUDGET_MB = 24.0
DIMS_GZ_TOLERANCE = 1.05
SITE_DATA_BUDGET_MB = 90.0

# ---------------------------------------------------------------------------------------
# SkyServer DR17
# ---------------------------------------------------------------------------------------
SKYSERVER_URL = "https://skyserver.sdss.org/dr17/SkyServerWS/SearchTools/SqlSearch"
USER_AGENT = ("galaxy-manifold-viz data pipeline (STScI research; low-rate cached bulk "
              "queries; python-requests)")
PLATES_PER_CHUNK = 30              # ~19k SpecObjAll rows per chunk with the MGS target bits
ZOO_RA_STEP = 10.0                 # zooSpec chunks in RA (deg)
MGS_TARGET_BITS = 0x40 | 0x80 | 0x100   # GALAXY | GALAXY_BIG | GALAXY_BRIGHT_CORE = 448

# ---------------------------------------------------------------------------------------
# sources (manifest "sources"; each DimSpec/CatSpec "source" is one of these keys)
# ---------------------------------------------------------------------------------------
SOURCES = [
    {"key": "sdss", "label": "SDSS DR7 / DR17",
     "cite": "Abazajian, K. N., et al. 2009, ApJS, 182, 543 (DR7); Abdurro'uf, et al. 2022, "
             "ApJS, 259, 35 (DR17); Strauss, M. A., et al. 2002, AJ, 124, 1810 (MGS)",
     "url": "https://skyserver.sdss.org/dr17/"},
    {"key": "mpajhu", "label": "MPA-JHU DR8",
     "cite": "Kauffmann, G., et al. 2003, MNRAS, 341, 33; Kauffmann, G., et al. 2003, MNRAS, "
             "346, 1055; Brinchmann, J., et al. 2004, MNRAS, 351, 1151; Tremonti, C. A., et al. "
             "2004, ApJ, 613, 898; Salim, S., et al. 2007, ApJS, 173, 267",
     "url": "https://www.sdss3.org/dr8/spectro/galspec.php"},
    {"key": "lim17", "label": "Lim+17 SDSS(M) groups",
     "cite": "Lim, S. H., Mo, H. J., Lu, Y., Wang, H., & Yang, X. 2017, MNRAS, 470, 2982",
     "url": "https://ui.adsabs.harvard.edu/abs/2017MNRAS.470.2982L"},
    {"key": "alfalfa", "label": "ALFALFA α.100",
     "cite": "Haynes, M. P., et al. 2018, ApJ, 861, 49",
     "url": "https://ui.adsabs.harvard.edu/abs/2018ApJ...861...49H"},
    {"key": "gz1", "label": "Galaxy Zoo 1",
     "cite": "Lintott, C. J., et al. 2008, MNRAS, 389, 1179; Lintott, C., et al. 2011, MNRAS, "
             "410, 166",
     "url": "https://data.galaxyzoo.org/"},
    {"key": "pp04", "label": "PP04 O3N2",
     "cite": "Pettini, M., & Pagel, B. E. J. 2004, MNRAS, 348, L59",
     "url": "https://ui.adsabs.harvard.edu/abs/2004MNRAS.348L..59P"},
    {"key": "s07", "label": "Schawinski+07",
     "cite": "Schawinski, K., et al. 2007, MNRAS, 382, 1415",
     "url": "https://ui.adsabs.harvard.edu/abs/2007MNRAS.382.1415S"},
    {"key": "j95", "label": "Jørgensen+95",
     "cite": "Jørgensen, I., Franx, M., & Kjærgaard, P. 1995, MNRAS, 276, 1341",
     "url": "https://ui.adsabs.harvard.edu/abs/1995MNRAS.276.1341J"},
    {"key": "legacy", "label": "Legacy Surveys viewer",
     "cite": "Dey, A., et al. 2019, AJ, 157, 168",
     "url": "https://www.legacysurvey.org/viewer"},
]

# ---------------------------------------------------------------------------------------
# caveats (manifest "caveats", one line each): DESIGN.md section 18 verbatim, then two that
# the data build found
# ---------------------------------------------------------------------------------------
CAVEATS = [
    "The sample is flux-limited (r < 17.77), so scaling relations show Malmquist bias. "
    "Filter in z to explore it.",
    "Fiber spectra (3″) cover different fractions of galaxies at different z, which affects "
    "O/H, SFR and Dn4000.",
    "The SFR dependence of the FMR depends on the metallicity calibration. With T04 Bayesian "
    "O/H it is weak or even reversed at high mass, so compare `OH` with `OH_PP04`.",
    "Petrosian R₅₀ underestimates the true half-light radius of concentrated (n≈4) profiles.",
    "H I fractions are ALFALFA detections only, which biases them gas-rich at fixed M★.",
    "Lim+17 halo masses come from abundance matching on group proxies, so the SHMR is partly "
    "built in by construction.",
    "Galaxy Zoo 1 fractions are debiased vote fractions, not ground truth.",
    "Lim+17 quantities (M_h, environment, ⁰·¹(g−r)) exist only in the northern cap at z ≤ 0.2.",
    "T04 O/H values cluster on the MPA-JHU model grid, which shows as faint horizontal bands.",
]

# ---------------------------------------------------------------------------------------
# dimensions: DESIGN.md section 6, canonical order = manifest order
#   col: the column in pipeline/cache/catalog.parquet that holds the physical value
# ---------------------------------------------------------------------------------------
DIMS = [
    dict(key="logM", label="log M★", short="M★", unit="M☉", group="stars", min=7.0, max=12.5,
         source="mpajhu",
         desc="Stellar mass, MPA-JHU LGM_TOT_P50 (total, SED fits to ugriz), Kroupa IMF"),
    dict(key="logSFR", label="log SFR", short="SFR", unit="M☉ yr⁻¹", group="sf", min=-4.0,
         max=2.5, source="mpajhu",
         desc="Star formation rate, MPA-JHU SFR_TOT_P50 (B04 in-fiber + Salim+07 out-of-fiber), "
              "Kroupa IMF"),
    dict(key="logsSFR", label="log sSFR", short="sSFR", unit="yr⁻¹", group="sf", min=-14.0,
         max=-8.0, source="mpajhu",
         desc="Specific SFR, MPA-JHU SPECSFR_TOT_P50"),
    dict(key="D4000", label="Dₙ4000", short="D4k", unit="", group="stars", min=0.8, max=2.6,
         source="mpajhu",
         desc="Narrow 4000 Å break (Balogh+99), MPA-JHU D4000_N, 3″ fiber"),
    dict(key="HdA", label="HδA", short="Hδ", unit="Å", group="stars", min=-6.0, max=12.0,
         source="mpajhu",
         desc="Lick HδA absorption index, MPA-JHU LICK_HD_A, 3″ fiber"),
    dict(key="gr", label="⁰·¹(g−r)", short="g−r", unit="mag", group="stars", min=-0.2,
         max=1.4, source="lim17",
         desc="g−r color K-corrected to z=0.1, Lim+17 SDSS(M) galaxy catalog (northern cap, "
              "z≤0.2)"),
    dict(key="OH", label="12+log(O/H)", short="O/H", unit="", group="chem", min=7.6, max=9.5,
         source="mpajhu",
         desc="Gas-phase metallicity, MPA-JHU OH_P50 (T04 Bayesian), star-forming galaxies only"),
    dict(key="OH_PP04", label="12+log(O/H)ᴼ³ᴺ²", short="O/Hᴾ", unit="", group="chem", min=7.8,
         max=9.2, source="pp04",
         desc="PP04 O3N2 metallicity, 8.73 − 0.32·O3N2, MPA BPT-SF with S/N>3 (rescaled errors) "
              "in Hβ, [OIII]5007, Hα, [NII]6584, −1<O3N2<1.9"),
    dict(key="logR50", label="log R₅₀", short="R₅₀", unit="kpc", group="struct", min=-1.0,
         max=2.0, source="sdss",
         desc="Petrosian r-band half-light radius petroR50_r (DR17) in kpc, flat ΛCDM H0=70 "
              "Ωm=0.3"),
    dict(key="C", label="R₉₀/R₅₀", short="C", unit="", group="struct", min=1.2, max=4.5,
         source="sdss",
         desc="Concentration petroR90_r / petroR50_r, SDSS DR17 r band"),
    dict(key="logSigma", label="log Σ★", short="Σ★", unit="M☉ kpc⁻²", group="struct",
         min=5.5, max=11.0, source="mpajhu",
         desc="Stellar surface density log M★ − log(2π R₅₀²), MPA-JHU mass, DR17 Petrosian R₅₀"),
    dict(key="ba", label="b/a", short="b/a", unit="", group="struct", min=0.0, max=1.0,
         source="sdss",
         desc="r-band axis ratio: expAB_r if fracDeV_r<0.5 else deVAB_r, SDSS DR17"),
    dict(key="pEl", label="P(E)", short="P(E)", unit="", group="struct", min=0.0, max=1.0,
         source="gz1",
         desc="Galaxy Zoo 1 debiased elliptical vote fraction p_el_debiased"),
    dict(key="logSigV", label="log σ", short="σ", unit="km s⁻¹", group="kin", min=1.3,
         max=2.8, source="mpajhu",
         desc="Stellar velocity dispersion V_DISP × (1.5″/(R₅₀/8))^0.04 (J95 aperture "
              "correction); 40<σ<500, err<0.3σ"),
    dict(key="mu50", label="⟨μ⟩₅₀", short="μ₅₀", unit="mag arcsec⁻²", group="struct",
         min=16.0, max=26.0, source="sdss",
         desc="Mean r-band surface brightness within R₅₀, (petroMag_r − A_r) + 2.5 log(2π R₅₀²) "
              "− 10 log(1+z), no K-correction"),
    dict(key="logfHI", label="log M_HI/M★", short="f_HI", unit="", group="gas", min=-3.0,
         max=2.5, source="alfalfa",
         desc="H I gas fraction, ALFALFA α.100 detections (code 1-2, unconfused) over MPA-JHU M★"),
    dict(key="logMh", label="log M_h", short="M_h", unit="M☉", group="env", min=10.0,
         max=15.5, source="lim17",
         desc="Host group halo mass, Lim+17 SDSS(M) (northern cap, z≤0.2), h⁻¹M☉ → M☉ with h=0.7 "
              "(+0.155 dex)"),
    dict(key="N2Ha", label="log [NII]/Hα", short="N2", unit="", group="lines", min=-2.5,
         max=1.0, source="mpajhu",
         desc="log [NII]6584/Hα, MPA-JHU fiber fluxes, S/N>3 in both (rescaled errors)"),
    dict(key="O3Hb", label="log [OIII]/Hβ", short="O3", unit="", group="lines", min=-1.5,
         max=1.5, source="mpajhu",
         desc="log [OIII]5007/Hβ, MPA-JHU fiber fluxes, S/N>3 in both (rescaled errors)"),
    dict(key="z", label="z", short="z", unit="", group="obs", min=0.0, max=0.3,
         source="sdss",
         desc="Spectroscopic redshift (heliocentric), SDSS / MPA-JHU"),
    # appended after z (not grouped by position) so frames in old share links stay valid
    dict(key="AV", label="A_V", short="A_V", unit="mag", group="dust", min=-1.0, max=4.0,
         source="mpajhu",
         desc="Stellar V-band attenuation 1.086 × TAUV_CONT, MPA-JHU fit to the 3″ fiber "
              "continuum; values below 0 are fit noise and are kept"),
    dict(key="HaHb", label="log Hα/Hβ", short="Hα/Hβ", unit="", group="dust", min=0.2,
         max=1.2, source="mpajhu",
         desc="Balmer decrement log Hα/Hβ, MPA-JHU fiber fluxes, S/N>3 in both (rescaled "
              "errors); 0.456 is Case B with no dust"),
]
DIM_KEYS = [d["key"] for d in DIMS]
MAX_DIMS = 28   # the client supports up to 7 x vec4

# ---------------------------------------------------------------------------------------
# categories: DESIGN.md section 7 (uint8 codes, 0 = missing)
# ---------------------------------------------------------------------------------------
CATS = [
    dict(key="bpt", label="BPT class", source="mpajhu",
         desc="MPA-JHU BPTCLASS (B04); MPA class 4 split into Seyfert/LINER by the "
              "Schawinski+07 line",
         codes=[
             dict(code=1, label="SF", name="star-forming (MPA 1)", color="#6fa8dc"),
             dict(code=2, label="SF low-S/N", name="low-S/N star-forming (MPA 2)",
                  color="#9cc3e4"),
             dict(code=3, label="Composite", name="composite (MPA 3)", color="#3aa6a0"),
             dict(code=4, label="Seyfert",
                  name="Seyfert (MPA 4, log[OIII]/Hβ > 1.05 log[NII]/Hα + 0.45)",
                  color="#de5b52"),
             dict(code=5, label="LINER", name="LINER (MPA 4, below the S07 line)",
                  color="#e8743b"),
             dict(code=6, label="LINER low-S/N", name="low-S/N LINER (MPA 5)", color="#e2b23a"),
             dict(code=7, label="Unclassifiable", name="unclassifiable (MPA -1)",
                  color="#7a7465"),
         ]),
    dict(key="env", label="environment", source="lim17",
         desc="Lim+17 SDSS(M) group membership (northern cap, z≤0.2, r≤17.7)",
         codes=[
             dict(code=1, label="isolated", name="isolated central (N_mem = 1)",
                  color="#efe6d2"),
             dict(code=2, label="group central", name="group central (N_mem ≥ 2, cen ID)",
                  color="#e2b23a"),
             dict(code=3, label="satellite", name="satellite", color="#b07aa1"),
         ]),
    dict(key="morph", label="Galaxy Zoo 1", source="gz1",
         desc="Galaxy Zoo 1 debiased classification flags (0.8 threshold)",
         codes=[
             dict(code=1, label="elliptical", name="elliptical (GZ1 flag)", color="#de5b52"),
             dict(code=2, label="spiral", name="spiral (GZ1 flag)", color="#6fa8dc"),
             dict(code=3, label="uncertain", name="uncertain (GZ1 flag)", color="#7a7465"),
         ]),
]
CAT_KEYS = [c["key"] for c in CATS]
