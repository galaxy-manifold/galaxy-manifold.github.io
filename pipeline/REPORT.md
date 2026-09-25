# Data pipeline report

This file is written by `python3 pipeline/export_web.py report`. It reads `pipeline/cache/build_stats.json`, `pipeline/cache/export_stats.json` and `site/data/manifest.json`, so the numbers match the latest run. The export described here was made on 2026-09-24.

## Result

- The export has 657,057 galaxies. Each galaxy has 20 dimensions, 3 categories and 5 metadata columns.
- The dimension files take 20.58 MB after gzip. All of `site/data` takes 28.92 MB, before the thumbnails and `literature.json` are added.
- The export uses the full sample. No subsample was needed (see "File sizes").
- The round trip check passed. An independent decoder read every file back and compared it with `pipeline/cache/galaxies.parquet`.
- `pipeline/cache/galaxies.parquet` has the same rows in the same order as `site/data`. The thumbnails step reads it.

## How to rebuild

```
python3 pipeline/fetch_skyserver.py     # SkyServer DR17, cached; rerun until it prints COMPLETE
python3 pipeline/build_catalog.py       # merge and compute: pipeline/cache/catalog.parquet
python3 pipeline/export_web.py all      # site/data, galaxies.parquet, verify, quicklook, report
```

The SkyServer step sends about 290 queries, 2 at a time. The first run took about 3 minutes. Every result is cached in `pipeline/cache/skyserver/`, so a second run sends no queries. The other two steps take about 30 seconds together. Each subcommand of `export_web.py` (`export`, `verify`, `quicklook`, `report`) can also run on its own.

## Sample selection

| Step | Galaxies left | Removed | Why they were removed |
|---|---:|---:|---|
| Parent sample, `catalog/mgs_parent.parquet` | 725,250 | | |
| Redshift 0.005 to 0.30 | 723,796 | 1,454 | All of them have z below 0.005. |
| Finite log M★ above 6 | 723,182 | 614 | MPA-JHU gives no stellar mass for them. |
| DR17 photometry found | 718,442 | 4,740 | DR17 has no photometric object for the spectrum. |
| `petroMag_r - extinction_r` at most 17.77 | 659,194 | 59,248 | 59,206 are fainter than 17.77 in DR17. 42 have no Petrosian magnitude. |
| One spectrum per DR17 objID | 657,057 | 2,137 | Repeat spectra of one galaxy. We kept the spectrum with the higher median S/N. |

The 4,740 spectra without DR17 photometry have photometric IDs from the DR7 imaging reduction (rerun 40). SkyServer lists `bestObjID = 0` for them, and DR17 has no primary photometric object within 2 arcsec of their fibers.

The magnitude cut removes two groups of galaxies.

- 33,260 are on SDSS special plates, e.g., the southern survey plates. These plates targeted galaxies fainter than the Main Galaxy Sample limit. The DR8 `PRIMTARGET` of these spectra has the MGS GALAXY bit set, so `mgs_parent` includes them. Only 5,131 of the 38,396 special plate spectra are bright enough to stay.
- 25,946 are on regular plates. 11,083 of them are within 0.03 mag of the limit. They were brighter than 17.77 in the photometry used for targeting and are slightly fainter in DR17. Another 7,270 are more than 0.13 mag fainter than the limit. For 95% of these the DR17 model magnitude is also fainter than 17.77, and 35% have R50 below 1 arcsec. DR17 measures a fainter or smaller object for them than the targeting photometry did. A one-time check of 120 of them on SkyServer found the GALAXY target bit set for 99%.

The repeat spectra come from overlapping plates. The parent sample removed repeats by DR7 `PHOTOID`. In some overlap regions the two spectra of one galaxy were tied to different DR7 imaging runs, so both stayed. DR17 ties both spectra to one photometric object. The two redshifts differ by a median of 0.00003.

## Match rates

| Source | Matched | Rate | How |
|---|---:|---:|---|
| SkyServer DR17 photometry | 718,442 | 99.34% | plate, mjd and fiber (rate before the magnitude cut) |
| Galaxy Zoo 1, `zooSpec` | 633,229 | 96.37% | 601,509 by specObjID, then 31,720 more by objID |
| Lim+17 SDSS(M) groups | 564,534 | 85.92% | 564,533 by exact objID, 1 by position |
| Lim+17, z ≤ 0.2 only | | 90.59% | |
| Lim+17, z ≤ 0.2 and 60 < RA < 300 | | 99.59% | |
| ALFALFA α.100, `log_fgas` | 15,878 | 2.42% | taken from `mgs_parent` |
| Local 160 px cutouts | 251,586 | 38.29% | 246,003 in `images-sdss`, 5,583 more in `images-extra` |

The rates are fractions of the final sample, except for the SkyServer row.

SkyServer. The first pass asked for every spectrum with the MGS target bits in `legacy_target1`, in 67 chunks of 30 plates, and found 771,457 spectra. It missed 43,918 parent spectra. Of these, 38,872 are on special plates, where DR17 keeps the target flags in `special_target1`. A second pass asked for the missed spectra by plate, mjd and fiber. It found all of them except the 5,046 with `bestObjID = 0`. The DR17 redshift agrees with the DR8 redshift for every matched spectrum. No spectrum differs by more than 0.001. In the final sample the DR17 photometric position agrees with the fiber position to 0.05 arcsec at the median and 2.0 arcsec at most.

Imaging sample. The sample has 242,741 galaxies from the imaging sample, which is the only part of `mgs_parent` with its own photometry. For 100.0% of them, the `petroMag_r` in `mgs_parent` agrees with the DR17 `petroMag_r` to 0.01 mag. Neither value has the extinction correction. Their image file names use the DR17 objID in every case.

Galaxy Zoo 1. 23,828 galaxies have no Galaxy Zoo 1 entry. 20% of them are special plate spectra, which are 0.8% of the whole sample.

Lim+17. The Lim+17 SDSS catalog covers only the contiguous northern Galactic cap. Every galaxy at z ≤ 0.2 without a Lim+17 match lies in the southern stripes, at RA 300 to 60 degrees. Away from those stripes the match rate at z ≤ 0.2 is 99.59%. In the imaging sample the exact objID match rate is 94.2%. The positional match (within 2 arcsec, with redshifts within 0.01) added only 1 galaxy, so DR13 and DR17 use the same objIDs. In the Lim+17 galaxy file, 12 survey IDs appear twice. For those we kept the entry closest in redshift.

ALFALFA. `log_fgas` comes from `mgs_parent`. It is log M_HI minus log M★ for ALFALFA α.100 detections with H I code 1 or 2 and no brighter galaxy at the same velocity inside the beam. 16,189 galaxies have an H I mass, and 15,878 of them pass these checks.

## Dimensions

"Valid" counts values inside the section 6 range. "Out of range" counts finite values outside it, which we set to missing.

| Key | Range | Valid | Missing | Out of range | Other reasons for missing | Source |
|---|---|---:|---:|---:|---|---|
| `logM` | 7 to 12.5 | 656,863 | 194 | 194 |  | mpajhu |
| `logSFR` | -4 to 2.5 | 645,294 | 11,763 | 38 |  | mpajhu |
| `logsSFR` | -14 to -8 | 641,917 | 15,140 | 46 |  | mpajhu |
| `D4000` | 0.8 to 2.6 | 656,256 | 801 | 229 | 572 with D4000_N_ERR ≤ 0 (all of them also outside the range) | mpajhu |
| `HdA` | -6 to 12 | 655,173 | 1,884 | 657 | 1,227 with LICK_HD_A_ERR = -1 (value stored as exactly 0) | mpajhu |
| `gr` | -0.2 to 1.4 | 562,275 | 94,782 | 1 | 2,258 Lim+17 placeholder colors; no Lim+17 match for the rest | lim17 |
| `OH` | 7.6 to 9.5 | 147,799 | 509,258 | 0 | MPA-JHU gives it for star-forming galaxies only | mpajhu |
| `OH_PP04` | 7.8 to 9.2 | 147,422 | 509,635 | 0 | MPA class 1 with S/N > 3 in all four lines; 447 outside -1 < O3N2 < 1.9 | pp04 |
| `logR50` | -1 to 2 | 657,020 | 37 | 37 |  | sdss |
| `C` | 1.2 to 4.5 | 656,566 | 491 | 491 |  | sdss |
| `logSigma` | 5.5 to 11 | 656,845 | 212 | 212 |  | mpajhu |
| `ba` | 0 to 1 | 657,057 | 0 | 0 |  | sdss |
| `pEl` | 0 to 1 | 633,229 | 23,828 | 0 | no Galaxy Zoo 1 match | gz1 |
| `logSigV` | 1.3 to 2.8 | 570,743 | 86,314 | 0 | fiber σ outside 40 to 500 km/s, or error above 0.3σ (16,446 have σ = 0) | mpajhu |
| `mu50` | 16 to 26 | 657,039 | 18 | 18 |  | sdss |
| `logfHI` | -3 to 2.5 | 15,860 | 641,197 | 18 | ALFALFA detections only | alfalfa |
| `logMh` | 10 to 15.5 | 564,534 | 92,523 | 0 | no Lim+17 match | lim17 |
| `N2Ha` | -2.5 to 1 | 379,654 | 277,403 | 0 | S/N ≤ 3 in [NII] or Hα | mpajhu |
| `O3Hb` | -1.5 to 1.5 | 213,140 | 443,917 | 0 | S/N ≤ 3 in [OIII] or Hβ | mpajhu |
| `z` | 0 to 0.3 | 657,057 | 0 | 0 |  | sdss |

The J95 aperture correction to R50/8 changes log σ by a median of 0.030 dex.

## Categories

`bpt` (BPT class): 1 SF 150,231, 2 SF low-S/N 141,160, 3 Composite 40,670, 4 Seyfert 11,071, 5 LINER 9,356, 6 LINER low-S/N 65,672, 7 Unclassifiable 238,897, 0 missing 0.

`env` (environment): 1 isolated 338,018, 2 group central 68,297, 3 satellite 158,219, 0 missing 92,523.

`morph` (Galaxy Zoo 1): 1 elliptical 60,035, 2 spiral 184,341, 3 uncertain 388,853, 0 missing 23,828.

MPA-JHU class 4 has 20,427 galaxies. The Schawinski et al. (2007) line splits them into 11,071 Seyferts and 9,356 LINERs. For 11 of them one of our line ratios is missing, because the rescaled S/N of [NII] or Hα is below 3. For those we used the ratio of the measured fluxes. MPA-JHU already required S/N above 3 in all four lines to put them in class 4. No class 4 galaxy was left without a ratio.

The PP04 metallicity uses MPA-JHU class 1 as the star-forming selection. No class 2 galaxy passes S/N above 3 in all four lines once the errors are rescaled. No class 1 galaxy with four good lines lies above the Kauffmann et al. (2003) line in our own ratios.

Every Lim+17 group with one member has that galaxy as its central (0 exceptions). Every Galaxy Zoo 1 match has exactly one of the three flags set (0 exceptions).

## File sizes

| File | MB |
|---|---:|
| `cats/bpt.u8.gz` | 0.221 |
| `cats/env.u8.gz` | 0.171 |
| `cats/morph.u8.gz` | 0.147 |
| `dims/C.u16.gz` | 1.235 |
| `dims/D4000.u16.gz` | 1.247 |
| `dims/HdA.u16.gz` | 1.247 |
| `dims/N2Ha.u16.gz` | 0.861 |
| `dims/O3Hb.u16.gz` | 0.625 |
| `dims/OH.u16.gz` | 0.476 |
| `dims/OH_PP04.u16.gz` | 0.474 |
| `dims/ba.u16.gz` | 1.289 |
| `dims/gr.u16.gz` | 0.927 |
| `dims/logM.u16.gz` | 1.219 |
| `dims/logMh.u16.gz` | 1.167 |
| `dims/logR50.u16.gz` | 1.178 |
| `dims/logSFR.u16.gz` | 1.226 |
| `dims/logSigV.u16.gz` | 1.164 |
| `dims/logSigma.u16.gz` | 1.186 |
| `dims/logfHI.u16.gz` | 0.084 |
| `dims/logsSFR.u16.gz` | 1.246 |
| `dims/mu50.u16.gz` | 1.181 |
| `dims/pEl.u16.gz` | 1.278 |
| `dims/z.u16.gz` | 1.272 |
| `manifest.json` | 0.028 |
| `meta/dec.f32.gz` | 2.400 |
| `meta/fiber.u16.gz` | 0.963 |
| `meta/mjd.u16.gz` | 1.041 |
| `meta/plate.u16.gz` | 1.089 |
| `meta/ra.f32.gz` | 2.278 |
| dims total | 20.582 |
| all of `site/data` from this step | 28.921 |

Section 16 asks for dimension files of about 20 MB or less. The full sample needs 20.58 MB, which is 3% over 20 MB. We kept the full sample instead of removing about 5% of the galaxies at random. The export subsamples only above 21 MB (`DIMS_GZ_TOLERANCE` in `config.py`). The dimension files use zlib level 9 with memLevel 9 and the Z_FILTERED strategy. This is a standard gzip stream, and it is about 1% smaller than the default settings. All gzip files have a zero timestamp, so a rebuild from the same inputs gives identical bytes.

## Verification

Round trip. `python3 pipeline/export_web.py verify` decodes every file in `site/data` with its own reader, written from the text of section 5. It compares the result with `galaxies.parquet`. For each dimension it checks that the missing values agree and that the decoded values are within half a quantization step. It also checks the counts, the medians and the 101 quantiles in the manifest.

```
dim logM      n_valid  656,863 max|err| 4.2e-05 (step/2 4.2e-05) OK
dim logSFR    n_valid  645,294 max|err| 4.96e-05 (step/2 4.96e-05) OK
dim logsSFR   n_valid  641,917 max|err| 4.58e-05 (step/2 4.58e-05) OK
dim D4000     n_valid  656,256 max|err| 1.37e-05 (step/2 1.37e-05) OK
dim HdA       n_valid  655,173 max|err| 0.000137 (step/2 0.000137) OK
dim gr        n_valid  562,275 max|err| 1.22e-05 (step/2 1.22e-05) OK
dim OH        n_valid  147,799 max|err| 1.45e-05 (step/2 1.45e-05) OK
dim OH_PP04   n_valid  147,422 max|err| 1.07e-05 (step/2 1.07e-05) OK
dim logR50    n_valid  657,020 max|err| 2.29e-05 (step/2 2.29e-05) OK
dim C         n_valid  656,566 max|err| 2.52e-05 (step/2 2.52e-05) OK
dim logSigma  n_valid  656,845 max|err| 4.2e-05 (step/2 4.2e-05) OK
dim ba        n_valid  657,057 max|err| 7.63e-06 (step/2 7.63e-06) OK
dim pEl       n_valid  633,229 max|err| 7.63e-06 (step/2 7.63e-06) OK
dim logSigV   n_valid  570,743 max|err| 1.14e-05 (step/2 1.14e-05) OK
dim mu50      n_valid  657,039 max|err| 7.63e-05 (step/2 7.63e-05) OK
dim logfHI    n_valid   15,860 max|err| 4.2e-05 (step/2 4.2e-05) OK
dim logMh     n_valid  564,534 max|err| 4.19e-05 (step/2 4.2e-05) OK
dim N2Ha      n_valid  379,654 max|err| 2.67e-05 (step/2 2.67e-05) OK
dim O3Hb      n_valid  213,140 max|err| 2.29e-05 (step/2 2.29e-05) OK
dim z         n_valid  657,057 max|err| 2.29e-06 (step/2 2.29e-06) OK
cat bpt       codes {0: 0, 1: 150231, 2: 141160, 3: 40670, 4: 11071, 5: 9356, 6: 65672, 7: 238897} OK
cat env       codes {0: 92523, 1: 338018, 2: 68297, 3: 158219, 4: 0, 5: 0, 6: 0, 7: 0} OK
cat morph     codes {0: 23828, 1: 60035, 2: 184341, 3: 388853, 4: 0, 5: 0, 6: 0, 7: 0} OK
meta ra       max|err| 0.0549 arcsec OK
meta dec      max|err| 0.0137 arcsec OK
meta plate    range 266..2974 OK
meta mjd      range 51602..54592 OK
meta fiber    range 1..640 OK
prefix check: median z first 10% 0.10005 vs all 0.10024
objid: 19-digit strings OK
```

Quicklook. `pipeline/cache/quicklook.png` shows 12 density plots of the main relations. The numbers below come from the same run. Scatter is 1.4826 times the median absolute deviation.

- MZR. The T04 metallicity levels off at 12+log(O/H) = 9.10 for log M★ 10.75 to 11.25. Tremonti et al. (2004) find a plateau near 9.1. At log M★ = 9 the median is 8.58.
- FMR. The scatter of the PP04 metallicity is 0.075 dex around the median in log M★ and 0.072 dex around the median in log M★ - 0.32 log SFR.
- SFMS. The median log SFR of MPA-JHU class 1 galaxies rises with a slope of 0.80 between log M★ 9 and 11. Renzini and Peng (2015) find 0.76 for the ridge line of the same MPA-JHU data.
- Mass and size. Galaxies with C < 2.6 and C ≥ 2.6 form two size sequences. Their median slopes between log M★ 10.3 and 11.3 are 0.31 and 0.44.
- BPT. The plot shows the star-forming branch and the AGN branch on either side of the Kauffmann et al. (2003) line.
- SHMR. For Lim+17 centrals, the median log M★ is 9.25, 10.30, 11.07 and 11.47 at log M_h 11.5, 12, 13 and 14.
- Fundamental plane. For 59,657 Galaxy Zoo 1 ellipticals, log R50 follows 1.49 log σ + 0.30 μ50 with a scatter of 0.092 dex. The median slope is 0.79 rather than 1. Bernardi et al. (2003) fit de Vaucouleurs radii with a correction for the flux limit, and we use Petrosian radii without one.
- H I. The median H I fraction of the ALFALFA detections falls with a slope of -0.68 in log M★.
- Dn4000 and HδA are anticorrelated. HδA peaks near Dn4000 = 1.2.
- Σ★ and sSFR. The median sSFR drops sharply at log Σ★ of about 8.5 to 9. Kauffmann et al. (2003) find that galaxies above 3 × 10^8 M☉ kpc⁻² have old stellar populations.

## Problems found and decisions

- Line errors. `mgs_parent` stores the raw MPA-JHU flux errors. We multiply them by the factors on the MPA-JHU DR7 data page before every S/N test. The factors are 1.882 for Hβ, 1.566 for [OIII]5007, 2.473 for Hα and 2.039 for [NII]6584. We checked them at https://wwwmpa.mpa-garching.mpg.de/SDSS/DR7/raw_data.html.
- HδA failures. 1,227 galaxies have LICK_HD_A exactly 0 with an error of -1, which marks a failed measurement. We read LICK_HD_A_ERR and D4000_N_ERR from `data/galSpecIndx-dr8.fits` and require a positive error.
- Lim+17 placeholder colors. Lim+17 gives galaxies far from the color and luminosity relation a fixed color. The values 0.832 and 0.889 appear 2,783 and 2,565 times in Lim+17, while the neighboring values appear about 800 and 1,270 times. At those two values we set the color to missing when the galaxy's own DR17 model g-r differs by more than 0.2 mag. This removed 2,258 colors, close to the excess of about 2,230 in our sample.
- Repeat spectra. 2,137 galaxies had two spectra in the parent sample. See "Sample selection".
- Special plates. 38,872 parent spectra are on special plates. See "Sample selection".
- Duplicate column. The dimension `z` is the redshift column itself. The values are all inside its range.
- T04 metallicity bands. The MPA-JHU OH_P50 values cluster on the model grid, so the MZR plot shows faint horizontal bands. This is in the input data, and we did not change it.

## Caveats

- The sample is flux-limited (r < 17.77), so scaling relations show Malmquist bias. Filter in z to explore it.
- Fiber spectra (3″) cover different fractions of galaxies at different z, which affects O/H, SFR and Dn4000.
- The SFR dependence of the FMR depends on the metallicity calibration. With T04 Bayesian O/H it is weak or even reversed at high mass, so compare `OH` with `OH_PP04`.
- Petrosian R₅₀ underestimates the true half-light radius of concentrated (n≈4) profiles.
- H I fractions are ALFALFA detections only, which biases them gas-rich at fixed M★.
- Lim+17 halo masses come from abundance matching on group proxies, so the SHMR is partly built in by construction.
- Galaxy Zoo 1 fractions are debiased vote fractions, not ground truth.
- Lim+17 quantities (M_h, environment, ⁰·¹(g−r)) exist only in the northern cap at z ≤ 0.2.
- T04 O/H values cluster on the MPA-JHU model grid, which shows as faint horizontal bands.
- The DR17 magnitude cut removes 25,946 regular MGS targets that are fainter than 17.77 in DR17. Near the flux limit the sample is slightly smaller than the original target list.
- 46% of the Lim+17 matches are in groups outside the completeness volume (`i-o` = 0). Lim+17 gives those groups the mean halo mass for their proxy. The flag is kept as `lim_io` in `galaxies.parquet`.
- 61% of the Galaxy Zoo 1 matches have the "uncertain" flag, because the flags need a debiased fraction above 0.8.
- The metadata `ra` and `dec` are DR17 photometric positions, not fiber positions.

## Notes for the other steps

- `pipeline/cache/galaxies.parquet` has one row per exported galaxy, in export order. Its main columns are listed here.
    - `row`, the export row index.
    - `objid` and `specobjid`, as strings. `objid` always has 19 digits.
    - `plate`, `mjd` and `fiber`.
    - `ra` and `dec`, the DR17 photometric position. `ra_spec` and `dec_spec` are the MPA-JHU fiber position.
    - `z`, `petroR50_r` and `petroR90_r`. The radii are in arcsec.
    - `local_image`, the path of an existing 160 px cutout relative to the project root, or an empty string.
    - The 20 dimension columns in physical units, with NaN when missing.
    - `bpt`, `env` and `morph` as uint8 codes, with 0 for missing.
    - Match details such as `lim_match`, `lim_io`, `lim_nmem`, `gz1_match` and `phot_query`.
- The manifest has fields that section 5.2 does not list. These are `sample`, `caveats`, and the category fields other than `key`, `label` and `codes`. A category entry has the form `{key, label, file, dtype, missing, codes: [{code, label, name, color, n}], nmissing, desc, source}`.
- When `export_web.py` runs again with the same row order, it keeps an existing `thumbs` block in the manifest. It checks the order with a hash of the objID sequence that it stores in `export_stats.json`. If the order changes, it resets `thumbs` to null and prints a warning, and `thumbs.py` must run again.
