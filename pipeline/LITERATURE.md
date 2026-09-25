# Literature relations

This file lists the literature scaling relations that the site draws. The script `pipeline/literature.py` writes this file and `site/data/literature.json`. It was last built on 2026-09-24.

## How the numbers were checked

We downloaded the arXiv LaTeX source of every paper (`python3 pipeline/literature.py --fetch` puts them in `pipeline/cache/literature_src/`). For each relation, the script keeps short excerpts copied from the source, e.g. the table row that holds the coefficients. Every build searches for each excerpt in the cached source, after removing LaTeX comments and collapsing white space. A relation is marked `verified` only if all of its excerpts are found. The script also parses the two tables it uses (T04 Table 3 and C18 Table 1) and stops if they differ from the copies in the code.

Two independent verifiers then checked every relation against the primary sources. Their results are in the verification column of the summary table and in the two sections on independent verification.

One number is not in the arXiv source. The early type size coefficient b of Shen et al. (2003) is wrong in their Table 1, and their 2007 erratum gives the correct value. The publisher page of the erratum is behind a bot check, so we read the erratum text from its OpenAlex record, which the script caches and checks in the same way.

## Our data conventions

Literature values are converted to these conventions (DESIGN.md section 9).

- Stellar masses and SFRs use the Kroupa IMF, as in MPA-JHU.
- The cosmology is H0 = 70 and Ωm = 0.3.
- R₅₀ is the Petrosian r band half-light radius in kpc.
- σ is corrected to an aperture of R₅₀/8, and μ₅₀ is defined as in DESIGN.md section 6.
- O/H is on the T04 scale (`OH`) or the PP04 O3N2 scale (`OH_PP04`).
- Halo mass is the Lim et al. (2017) group mass M180m (180 times the mean density) in M☉ with h = 0.7.

## Conversion numbers

- Chabrier to Kroupa stellar mass is +0.0342 dex, and Chabrier to Kroupa SFR is +0.0267 dex. Madau & Dickinson (2014) divide masses by 0.61 (Chabrier) and 0.66 (Kroupa) to get Salpeter masses, and they divide SFRs by 0.63 and 0.67.
- M10 divided the MPA-JHU masses by 1.06, which is 0.0253 dex.
- M10 used SFRs inside the fiber. For MPA-JHU galaxies selected as in M10 (BPT classes 1 and 2, 0.07 < z < 0.30, Hα S/N > 25 after the ×2.473 error rescaling, N = 140,574), the median log SFR(total) − log SFR(fiber) is 0.509 dex, with 16th and 84th percentiles of 0.125 and 0.854. It depends on mass. It is +0.414 dex for log M★ = 9.0 to 9.5. It is +0.565 dex for log M★ = 9.5 to 10.0. It is +0.483 dex for log M★ = 10.0 to 10.5. It is +0.513 dex for log M★ = 10.5 to 11.0. It is +0.572 dex for log M★ = 11.0 to 11.5.
- For the r band versus z band size, we took 25,931 SDSS DR17 Main Galaxy Sample galaxies from one SkyServer query (`R50_SQL` in the script). The median log(petroR50_r/petroR50_z) is +0.0289 for C < 2.86 (N = 17,115), +0.0237 for C ≥ 2.86 (N = 8,816), and +0.0270 for all galaxies. The ratio grows with angular size because seeing blurs small galaxies.
- For a Sérsic profile without seeing, the SDSS Petrosian R₅₀ divided by the true half-light radius is 0.994 for n = 1 and 0.713 for n = 4, and the Petrosian flux fraction is 0.993 and 0.817. S03 quote about 70 percent and about 80 percent for n = 4. Real SDSS radii are blurred by seeing, which the Blanton et al. (2003) Sérsic radii used by S03 correct and the Petrosian radii do not. So we do not use the profile values for S03. Instead we compare the S03 size-luminosity fits for Petrosian radii (Table 1 row Figure 4) and for Sérsic radii (row Figure 6) at the same galaxy. This gives log(R_Petrosian/R_Sérsic) of +0.032 at 10^9.0, +0.027 at 10^10.0, +0.036 at 10^11.0 for late types and −0.024 at 10^10.0, −0.045 at 10^10.5, −0.067 at 10^11.0, −0.088 at 10^11.5 for early types.
- The age of the universe at z = 0.1 for h = 0.7 and Ωm = 0.3 is 12.166 Gyr (used for S14).
- Halo masses are converted to M180m for NFW halos with the Duffy et al. (2008) concentrations (NFW, full sample, z = 0 to 2). The virial overdensity is from Bryan & Norman (1998). log M180m − log M200c for Mo13 is +0.124 at 10^11, +0.135 at 10^12, +0.148 at 10^13, +0.163 at 10^14, +0.179 at 10^15. log M180m − log Mvir for B13 is +0.054 at 10^11, +0.059 at 10^12, +0.065 at 10^13, +0.071 at 10^14, +0.078 at 10^15. Using Ωm = 0.30 instead of 0.27 changes the B13 value at 10^12 by −0.005 dex.

## Summary

The status column is the automatic excerpt check. The verification column combines the two independent reviews of 2026-09-24. A relation is marked corrected if either review corrected it, and removed if a review removed it. Otherwise it is marked verified. The details are in the two sections on independent verification below.

| id | view | x | y | kind | source | IMF | conversions | status | verification |
|---|---|---|---|---|---|---|---|---|---|
| T04 | mzr | `logM` | `OH` | fit | [arXiv:astro-ph/0405537](https://arxiv.org/abs/astro-ph/0405537) eq. 3; Table 3 | Kroupa (2001) | none | verified | verified |
| KE08 | mzr2 | `logM` | `OH_PP04` | fit | [arXiv:0801.1849](https://arxiv.org/abs/0801.1849) Table 2, PP04 O3N2 row | Kroupa (T04/K03a masses) | none | verified | verified |
| AM13 | mzr2 | `logM` | `OH_PP04` | fit | [arXiv:1211.3418](https://arxiv.org/abs/1211.3418) eq. 5; Table 4 row 'MZR' | MPA-JHU DR7 (Kroupa), unchanged | none (drawn on OH_PP04) | verified | verified |
| C20 | mzr2 | `logM` | `OH_PP04` | fit | [arXiv:1910.00597](https://arxiv.org/abs/1910.00597) eq. 2; Table 4 row 'Equation (2)' | Chabrier (MPA-JHU masses rescaled) | M★ Chabrier→Kroupa (drawn on OH_PP04) | verified | verified |
| M10 | fmr | `logM − 0.32·logSFR` | `OH_PP04` | fit (fitOffset) | [arXiv:1005.0006](https://arxiv.org/abs/1005.0006) eq. 4 (mu_0.32 quartic); eq. 2 is the fit in M* and SFR | Chabrier (masses = MPA-JHU / 1.06) | μ: IMF and fiber→total SFR; y offset fit | verified | corrected |
| RP15 | sfms | `logM` | `logSFR` | fit | [arXiv:1502.01027](https://arxiv.org/abs/1502.01027) sec. 2, text | not stated (Brinchmann+04 procedures, Kroupa) | none | verified | corrected |
| S14 | sfms | `logM` | `logSFR` | fit | [arXiv:1405.2041](https://arxiv.org/abs/1405.2041) eq. 28 (sec. 4.1) | Kroupa | none (t at z = 0.1) | verified | verified |
| S16 | sfms | `logM` | `logSFR` | fit | [arXiv:1607.05289](https://arxiv.org/abs/1607.05289) eq. 5 | Chabrier (SFR scaled by 0.94); MPA-JHU masses | SFR Chabrier→Kroupa | verified | verified |
| Q11 | sfms | `logM` | `logSFR` | threshold | [arXiv:1107.5311](https://arxiv.org/abs/1107.5311) sec. 2.1 | MPA-JHU (same as ours) | none | verified | verified |
| RP15s | ssfr | `logM` | `logsSFR` | fit | [arXiv:1502.01027](https://arxiv.org/abs/1502.01027) sec. 2, text (rewritten as sSFR) | as RP15 | none | verified | verified |
| Q11s | ssfr | `logM` | `logsSFR` | threshold | [arXiv:1107.5311](https://arxiv.org/abs/1107.5311) sec. 2.1 | MPA-JHU (same as ours) | none | verified | verified |
| S03L | size | `logM` | `logR50` | fit | [arXiv:astro-ph/0301527](https://arxiv.org/abs/astro-ph/0301527) Table 1 row 'Figure 11'; published eq. 18 | Kroupa (K03a masses) | R: Sérsic z→Petrosian r | verified | verified |
| S03E | size | `logM` | `logR50` | fit | [arXiv:astro-ph/0301527](https://arxiv.org/abs/astro-ph/0301527) Table 1 row 'Figure 11'; published eq. 17; erratum MNRAS 379, 400 (2007) | Kroupa (K03a masses) | R: Sérsic z→Petrosian r; b from erratum | verified | verified |
| K03S | sigma | `logSigma` | `logsSFR` | threshold | [arXiv:astro-ph/0205070](https://arxiv.org/abs/astro-ph/0205070) summary of sec. 5 (Dn4000 and HdA versus mu_*) | Kroupa (2001) | Σ: z→r band radius | verified | verified |
| Q11d | sigma | `logSigma` | `logsSFR` | threshold | [arXiv:1107.5311](https://arxiv.org/abs/1107.5311) sec. 2.1 | MPA-JHU (same as ours) | none | verified | verified |
| B03 | fp | `1.49·logSigV + 0.3·mu50` | `logR50` | fit (fitOffset) | [arXiv:astro-ph/0301626](https://arxiv.org/abs/astro-ph/0301626) Table 2 (orthogonal ML, r*); eq. 2 | - | zero point fit | verified | verified |
| K03 | bpt | `N2Ha` | `O3Hb` | demarcation | [arXiv:astro-ph/0304239](https://arxiv.org/abs/astro-ph/0304239) eq. 1 | - | none | verified | verified |
| K01 | bpt | `N2Ha` | `O3Hb` | demarcation | [arXiv:astro-ph/0106324](https://arxiv.org/abs/astro-ph/0106324) eq. 5 | - | none | verified | verified |
| S07 | bpt | `N2Ha` | `O3Hb` | demarcation | [arXiv:0709.3015](https://arxiv.org/abs/0709.3015) eq. 1 | - | none (above K01 only) | verified | verified |
| Mo13 | shmr | `logMh` | `logM` | fit | [arXiv:1205.5807](https://arxiv.org/abs/1205.5807) eq. 2; eqs. 11 to 14; Table 1 | Chabrier | M_h: M200c→M180m, h; M★: IMF, h | verified | verified |
| B13 | shmr | `logMh` | `logM` | fit | [arXiv:1207.6105](https://arxiv.org/abs/1207.6105) eq. 3; sec. 5 parameters (fit.tex) | Chabrier | M_h: Mvir→M180m; M★: IMF | verified | verified |
| Q11e | env | `logMh` | `logsSFR` | threshold | [arXiv:1107.5311](https://arxiv.org/abs/1107.5311) sec. 2.1 | MPA-JHU (same as ours) | none | verified | verified |
| C18 | hi | `logM` | `logfHI` | median | [arXiv:1802.02373](https://arxiv.org/abs/1802.02373) Table 1, log M* block, column (b) | MPA-JHU DR7 values (labeled Chabrier) | none | verified | corrected |
| H12 | hi | `logM` | `logfHI` | fit | [arXiv:1207.0523](https://arxiv.org/abs/1207.0523) eq. 1 | Chabrier | M★ and f_HI: IMF | verified | verified |

## Independent verification, first review

On 2026-09-24 a second agent, the literature verifier, re-derived every relation from its primary source and tried to refute each number. It fetched the arXiv sources again with a separate client; all 26 are byte for byte the same as the cache. It then read each coefficient, sign, log base, unit, IMF, cosmology and variable definition again in the LaTeX, not in the stored excerpts. It rendered two figures from the source files. S03 Fig. 11 confirms the erratum value of b without relying on the erratum text, and the ridge in RP15 Fig. 4 follows the RP15 formula.

Every build now also checks each curve in `literature.json` against a second implementation of the formulas and conversions (`independent_check` in the script). It has its own NFW halo mass conversion and its own inversion of the S03 size relations. The largest difference is 6.1e-04 dex, which comes from the rounding of the stored points on the steep part of the BPT curves.

The conversion inputs were measured again. The r/z Petrosian radius ratio from an independent SkyServer sample (8,000 galaxies, objID mod 31 = 17) is +0.0297 (C < 2.86), +0.0241 (C ≥ 2.86) and +0.0277 (all), against +0.0289, +0.0237 and +0.0270 from the cached sample. The M10 aperture offset was measured again from the MPA-JHU catalog and corrected (below).

Result: 22 relations verified, 2 corrected, 0 removed.

### Corrections

- M10: μ0.32 shift −0.075 → −0.146 dex, so the curve moves −0.071 dex in x. The fiber to total SFR offset came from an M10-like sample cut on the rescaled Hα errors (N = 50,144, median 0.286 dex). M10 cut on the catalog errors as given; that cut gives N = 140,574, against the 141,825 of M10, and a median of 0.509 dex.
- C18: The 85 point polyline passed through only 2 of the 8 Table 1 medians and cut the corners by up to 0.011 dex. The medians are now vertices of the polyline.

### Checks against the data

The figure `pipeline/cache/literature_verify.png` shows every preset view with the curves exactly as drawn, with fitOffset applied.

- RP15: in the most complete slice (0.01 < z < 0.03), the star forming ridge (the mode of log SFR at fixed mass) of our data lies +0.04 and 0.00 dex from RP15 at log M★ = 9.25 and 9.75. Over RP15's own range, 0.02 < z < 0.085 without their V/Vmax weights, it lies +0.24 dex off at 9.25, because the flux limit keeps only the brighter galaxies at low mass. At log M★ = 10.75 it lies −0.12 dex off.
- S03E: the median of (data − curve) is +0.050 dex for Galaxy Zoo ellipticals and +0.062 dex for C ≥ 2.86, so the low mass end depends on the early type definition. S03L: +0.011 dex for C < 2.86.
- K03S: the median Dn4000 of our data reaches 1.55, the divider of K03b Fig. 13, at log Σ★ = 8.57. That is +0.15 dex above the K03S line at 8.42. K03b quote the transition as '~3 × 10⁸', and our DR7 total masses are larger than the Petrosian based masses of K03 for concentrated galaxies.
- M10: after fitOffset (−0.24 dex), the rms difference between M10 and the running median of our O3N2 data is 0.077 dex with the corrected shift and 0.087 dex with the first build's shift. The data do not decide between them, because M10 uses a different O/H calibration. The correction rests on reproducing the M10 sample.
- B03: the median offset before fitOffset is +0.001 dex for Galaxy Zoo ellipticals.
- SHMR, centrals: the median over the range is −0.013 dex for Mo13 and −0.011 dex for B13, but that hides a shape difference. At log M_h = 11.5, 12.0, 12.5, 13.0, 13.5, 14.0 the data minus Mo13 is −0.47, −0.14, +0.01, +0.10, +0.13, +0.13 dex, and minus B13 −0.39, −0.11, 0.00, +0.09, +0.17, +0.23 dex. Lim+17 assign single-member halo masses from a stellar mass proxy, so the data relation is steep at low M_h.
- H I: C18 +0.686 dex (xGASS includes non-detections, ours are ALFALFA detections) and H12 +0.068 dex.
- MZR: T04 −0.009, KE08 +0.008, AM13 −0.031 and C20 −0.022 dex.

### Per relation, first review

| id | verification | what was checked in the source | second implementation max abs dy |
|---|---|---|---|
| T04 | verified | eq. 3 (−1.492, 1.847, −0.08026), 8.5 < log M★ < 11.5, Kroupa, H0 = 70 and Ωm = 0.3; Table 3 columns are P2.5, P16, P50, P84, P97.5 (the band is P16 to P84). | 5.0e-05 |
| KE08 | verified | Table 2 PP04 O3N2 row (32.1488, −8.51258, 0.976384, −0.0359763). The column header is a, b, c, d; the table note misprints the form. Masses T04/K03a (Kroupa). Same O3N2 formula as our OH_PP04. | 5.9e-05 |
| AM13 | verified | eq. 5 and Table 4 row MZR (log M_TO = 8.901, asymptote 8.798, γ = 0.640, fit 7.4 to 10.5); MPA-JHU DR7 total masses. The direct (Te) O/H scale is drawn on OH_PP04, which is an axis approximation. | 6.2e-05 |
| C20 | verified | eq. 2 and its table (Z0 = 8.793, log M0 = 10.02, γ = 0.28, β = 1.2), trusted for 7.95 < log M★ < 11.85. C20 do not state their Kroupa to Chabrier factor. The MD14 factor (0.034 dex) is used; M10's 1.06 would give 0.025 dex. | 5.1e-05 |
| M10 | corrected | eq. 4 quartic with x = μ0.32 − 10; μ0.32 range 9.2 to 11.4 from the populated Table 1 bins; masses K03a/1.06; SFRs inside the fiber (sec. 2.1 and 4). The x conversion was corrected, see below. | 6.5e-05 |
| RP15 | verified | Ridge line log SFR = 0.76 log M★ − 7.64 (text below Fig. 3); SDSS DR7, 0.02 < z < 0.085, AGN excluded, no star forming preselection. The ridge of their Fig. 4 follows the formula. The IMF is not stated. | 8.0e-06 |
| S14 | verified | eq. 28 (the preferred 'mixed' fit); t is the age of the Universe in Gyr for (h, Ωm, ΩΛ) = (0.7, 0.3, 0.7), 12.166 Gyr at z = 0.1; fitted mass range 9.7 to 11.1; Kroupa. The fit spans z ≈ 0.25 to 2.75, so z = 0.1 is an extrapolation. | 6.8e-05 |
| S16 | verified | eq. 5 cubic; SDSS DR7 at 0.01 < z < 0.05; MPA-JHU masses; NUV + WISE SFRs scaled by 0.94 to Chabrier, which +0.027 dex undoes. | 1.1e-04 |
| Q11 | verified | W12 sec. 2.1: active and quenched split at sSFR = 10⁻¹¹ yr⁻¹ on the MPA-JHU DR7 SSFRs. | 0.0e+00 |
| RP15s | verified | RP15 rewritten: log sSFR = −0.24 log M★ − 7.64. | 8.0e-06 |
| Q11s | verified | as Q11. | 0.0e+00 |
| S03L | verified | Table 1 row 'Figure 11' (α = 0.14, β = 0.39, γ = 0.10 kpc, M0 = 3.98 × 10¹⁰ M☉), z band Sérsic radii, n < 2.5, h = 0.7. The fit line of S03 Fig. 11, rendered from the source, gives 1.8 kpc at 10⁹ and 4.7 kpc at 10¹¹ M☉, as the formula does. | 5.5e-05 |
| S03E | verified | Table 1 row 'Figure 11', a = 0.56, with the erratum b = 2.88 × 10⁻⁶ (printed 3.47 × 10⁻⁵). Independent check of the erratum: the early type fit line drawn in S03 Fig. 11 passes 4.2 kpc at 10¹¹ and 15 kpc at 10¹² M☉ (b ≈ 2.9 × 10⁻⁶), and the S03 z band size-luminosity fit (row 'Figure 10') gives about 3.9 kpc at 10¹¹ M☉ for M/L_z ≈ 1.8. | 6.4e-05 |
| K03S | verified | μ★ ~ 3 × 10⁸ M☉ kpc⁻² (K03b sec. 5 and summary), with μ★ = 0.5 M★/(π R50,z²). The r/z radius ratio was measured again on an independent SkyServer sample of 8,000 galaxies (+0.0277 dex, against +0.0270). | 2.1e-05 |
| Q11d | verified | as Q11. | 0.0e+00 |
| B03 | verified | Table 2, orthogonal maximum likelihood, r*: a = 1.49, b = −0.75 (in log I), c = −8.778; μ = −2.5 log I; R in h70⁻¹ kpc; σ at R/8. c reproduces B03's own sample means (V* = 2.200, μ* = 19.87, R* = 0.490) to rounding. | 0.0e+00 |
| K03 | verified | eq. 1: 0.61/(x − 0.05) + 1.3. | 6.1e-04 |
| K01 | verified | eq. 5: 0.61/(x − 0.47) + 1.19. | 4.1e-04 |
| S07 | verified | eq. 1: 1.05 x + 0.45, drawn from its K01 intersection (−0.184, 0.257). | 1.0e-04 |
| Mo13 | verified | eq. 2, the z/(z+1) evolution and Table 1; masses in M☉ for h = 0.704, M200c, Chabrier. The halo conversion was re-derived with a separate NFW and Duffy+08 code (+0.135 dex at 10¹² M☉). | 1.4e-04 |
| B13 | verified | eq. 3 and the sec. 5 parameters; median M★ at fixed Mvir (Bryan & Norman), h = 0.7, Ωm = 0.27, Chabrier. Halo conversion re-derived (+0.059 dex at 10¹² M☉). B13's nuisance offset μ(z = 0.1) = −0.027 dex between measured and true M★ is not applied. | 1.0e-04 |
| Q11e | verified | as Q11. | 0.0e+00 |
| C18 | corrected | Table 1 log M★ block, weighted medians with non-detections at their upper limits; MPA-JHU DR7 masses (labeled Chabrier, used as given). The drawn polyline was corrected, see below. | 1.2e-04 |
| H12 | verified | eq. 1 (0.712 and 3.117 below 10⁹, 0.276 and 7.042 above): mean log M_HI in 0.5 dex bins of log M★ for α.40 detections; Chabrier, h = 0.7. | 6.5e-05 |

## Independent verification, second review

On 2026-09-24 a second verifier checked all 24 relations again against the primary sources and tried to refute each number. The second verifier did not use the excerpts that the first two agents stored.

How it was done:

- All 26 arXiv sources were downloaded again with curl into a separate directory. All 26 files are byte for byte the same as the cache.
- The erratum of Shen et al. (2007) was read again on OpenAlex, and its record was checked on Crossref (MNRAS 379, 400).
- Each number and each definition was read again in the LaTeX.
- Every curve was evaluated again with a third implementation that shares no code with the script. The largest difference is 1.4e-04 dex. On the steep parts of the K03 and K01 hyperbolas the difference reaches 6.1e-04 dex, which comes from the rounding of x to 1e-4.
- S03 Fig. 11, RP15 Fig. 4 and K03b Fig. 13 were rendered from the source files and compared with the formulas.
- Each relation now carries `verification.second_review` with the result and a checksum (`digest`) of what the site draws. If a curve changes after this review, `current` is set to false and a warning is printed during the build.

In this review 23 relations are verified, 1 is corrected and none is removed. The first review corrected M10 and C18, and this review confirms both corrections. Counting both reviews, 21 relations are verified, 3 are corrected and none is removed. No curve changed in this review.

### Correction in this review

- RP15. A change from Chabrier to Kroupa moves each galaxy by +0.034 dex in mass and by +0.027 dex in SFR. Along a line of slope 0.76 the two shifts nearly cancel, so the line moves by +0.001 dex. The conversions text was 'None. RP15 do not state the IMF, so an offset of up to 0.03 dex is possible.' It is now 'None. RP15 do not state the IMF. If their masses and SFRs were Chabrier values, moving both to Kroupa (+0.034 dex in mass, +0.027 dex in SFR) would move the line by only +0.001 dex, because the two shifts nearly cancel along its slope.' The curve is unchanged. RP15s now carries the same note.

### New evidence and caveats

- M10 sample. M10 (sec. 2.1) give counts for their sample. Of 927,552 DR7 galaxies, 47 percent (about 436,000) are emission line galaxies at 0.07 < z < 0.30. Of these, 43 percent pass S/N(Hα) > 25, and 22 percent of the sample are AGN. We took galaxies with S/N(Hα) above 2 or above 3 as emission line galaxies. With the catalog errors as given, our parent sample has 405,170 to 449,841 such galaxies. Of these, 40.5 to 45.0 percent pass the cut, and 20.2 percent of those are AGN. With the errors rescaled by 2.473, only 13.2 to 14.6 percent pass, and 15.0 percent are AGN. So M10 cut on the catalog errors, which supports the correction of the first review. One number points the other way. M10 give log M_tot − log M_fib = 0.50 ± 0.15, and our raw and rescaled selections give 0.548 and 0.502. That difference is small compared with the spread of 0.15.
- M10 fiber SFRs. M10 computed their own fiber SFRs from Hα with the Kennicutt (1998) formula. We rebuilt such SFRs from the catalog fiber fluxes, with a Balmer decrement correction and the Cardelli et al. (1989) law. They lie 0.03 to 0.09 dex below the MPA-JHU fiber SFRs moved to Chabrier. The value depends on the factor that moves the Kennicutt (1998) SFRs from Salpeter to Chabrier (1/0.63, 1.7 or 1.8), and M10 do not give it. We assume that the two fiber SFRs agree. If they do not, the μ0.32 shift of M10 is too small by 0.01 to 0.03 dex. That is small compared with the other uncertainties of the M10 curve, so we did not change it.
- S03 and the r/z ratio. The median log(R50,r/R50,z) grows with angular size. For late types it is +0.012 below 1.5 arcsec and +0.050 above 5 arcsec, because seeing blurs small galaxies in both bands. We use the median over all sizes, +0.029 for late types and +0.024 for early types. This is the right value for K03S, whose radii are Petrosian radii. For the Sérsic radii of S03, which are corrected for seeing, the ratio of large galaxies (+0.04 to +0.06 above 3 arcsec) may apply instead. That would raise both S03 curves by about 0.02 dex. This is inside the stated uncertainty of the S03 conversion, so we did not change it.
- S03E at low mass. The lowest early type point in S03 Fig. 11 (10^10.1 M☉, about 1.7 kpc) lies about 0.12 dex above their own power law (1.3 kpc). So most of the offset between our C ≥ 2.86 galaxies and S03E below about 10^10.5 M☉ is already present in the S03 data.
- Mass definitions. S03 and K03 multiplied the Petrosian z band luminosity by a model mass to light ratio. Our MPA-JHU DR7 masses come from fits to the total (model) magnitudes. For C ≥ 2.86 galaxies in our sample, the median of petroMag_r − modelMag_r is +0.074 mag, which is 0.030 dex in luminosity. For C < 2.86 it is +0.047 mag (0.019 dex). The MPA-JHU comparison of the two mass methods (mass_comp.html on the MPA-JHU DR7 site) gives a median offset of −0.01 dex, with larger offsets at low mass. So S03E and K03S would move by about 0.03 dex at most because of the mass definition. That is less than the 0.1 dex given in the first build.
- K03S. On our axis, the fraction of galaxies with Dn4000 > 1.55 reaches 50 percent at log Σ★ = 8.63 for 10 < log M★ < 11 and at 8.75 for 9 < log M★ < 10. In K03b Fig. 13 it reaches 50 percent at log μ★ ≈ 8.55 to 8.6, which is 8.50 to 8.55 on our axis. The K03S line at 8.42 is the value that K03b quote in their text (3 × 10⁸ M☉ kpc⁻²). In both figures that value lies in the lower part of the transition.

The sixth row of `pipeline/cache/literature_verify.png` shows the M10 sample test, the r/z ratio by angular size and the K03S transition.

### Per relation, second review

| id | result | what was checked again | third implementation max abs dy | current |
|---|---|---|---|---|
| T04 | verified | Eq. 3 and its range of 8.5 to 11.5 were read again, with the Kroupa IMF and H0 = 70. The Table 3 columns are P2.5, P16, P50, P84 and P97.5, and the band uses P16 and P84. T04 eq. 3 and the T04 row of KE08 Table 2 agree to 0.005 dex at 10¹⁰ and 10¹¹ M☉, so both use the same Kroupa masses. | 5.0e-05 | yes |
| KE08 | verified | The PP04 O3N2 row of Table 2 was read again. The fit is y = a + bx + cx² + dx³ with x = log M in M☉, and the table note that prints 'bx²+bx³' is a misprint. The masses are the T04 and K03a masses with a Kroupa IMF, not Salpeter masses, because the T04 row of the same table reproduces T04 eq. 3. | 5.9e-05 | yes |
| AM13 | verified | Eq. 5 and the MZR row of Table 4 were read again (8.901, 8.798, 0.640, fitted over 7.4 to 10.5). The masses are MPA-JHU DR7 total masses with no IMF change, and the cosmology is H0 = 70 and Ωm = 0.3. | 6.2e-05 | yes |
| C20 | verified | Eq. 2 and its table were read again (8.793, 10.02, 0.28, 1.2), with the trusted range of 7.95 to 11.85. Below M0 the formula is a power law of index γ, as C20 state. C20 rescaled the MPA-JHU masses to a Chabrier IMF without giving the factor, so the MD14 value of +0.034 dex is a fair way to undo it. | 5.1e-05 | yes |
| M10 | verified | Eq. 4 with x = μ0.32 − 10 was read again. M10 divided the MPA-JHU masses by 1.06 and used K98 Hα SFRs inside the fiber, and the populated Table 1 bins span μ0.32 = 9.23 to 11.43. M10 give their own sample counts in sec. 2.1. Of 927,552 DR7 galaxies, 47 % (436k) are emission line galaxies at 0.07 < z < 0.30, 43 % of these pass S/N(Hα) > 25, and 22 % are AGN. With the catalog errors as given, our parent sample gives 405k to 450k galaxies, 41 to 45 % and 20 %. With the errors rescaled by 2.473 it gives 13 to 15 % and 15 %. This confirms the correction of the first review. | 6.5e-05 | yes |
| RP15 | corrected | The ridge line log SFR = 0.76 log M★ − 7.64 (text below Fig. 3) was read again. It is a fit to the ridge of the V/Vmax weighted number density in Fig. 4. In Fig. 4, which we rendered from the source, the ridge is visible from 10^8.3 to 10^10.5 M☉. The conversions text gave an IMF uncertainty about 40 times too large (see the correction). The curve is unchanged. | 8.0e-06 | yes |
| S14 | verified | Eq. 28 (the 'Mixed' fit, which S14 prefer) was read again. The variable t is the age of the Universe in Gyr, and a separate integral gives 12.166 Gyr at z = 0.1 for (h, Ωm, ΩΛ) = (0.7, 0.3, 0.7). The IMF is Kroupa, the fitted mass range is 9.7 to 11.1, and the SDSS studies were left out of the fit. | 6.8e-05 | yes |
| S16 | verified | Eq. 5 was read again. It is a cubic in x = log M★ with no constant term, fitted to galaxies at 0.01 < z < 0.05 with M★ > 10⁸ M☉. SFR_UV was calibrated for a Kroupa IMF and then scaled down by 6 % to Chabrier, and S16 quote all quantities for Chabrier, so +0.027 dex undoes the scaling. The masses are MPA-JHU values used as given, like ours. | 1.1e-04 | yes |
| Q11 | verified | W12 sec. 2.1 splits galaxies at SSFR = 10⁻¹¹ yr⁻¹, using the MPA-JHU DR7 SSFRs (B04 with the Salim+07 aperture corrections). In the SFR plane the line is log SFR = log M★ − 11. | 0.0e+00 | yes |
| RP15s | verified | The RP15 ridge line was rewritten as log sSFR = −0.24 log M★ − 7.64. The conversions text now includes the IMF note of RP15, i.e., a change from Chabrier to Kroupa moves the line by +0.001 dex. | 8.0e-06 | yes |
| Q11s | verified | As Q11. | 0.0e+00 | yes |
| S03L | verified | The 'Figure 11' row of Table 1 and eq. 18 were read again. The radii are Sérsic half-light radii in the z band, late types have n < 2.5, h = 0.7, and the masses are K03a masses. We rendered S03 Fig. 11 from fig11.ps, and its late type line passes 1.8 kpc at 10⁹ M☉ and 4.7 kpc at 10¹¹ M☉. We implemented the conversion again. We start from the Fig. 11 radius, add the r/z ratio, invert the Fig. 6 fit, apply the Petrosian flux fraction and then evaluate the Fig. 4 fit. | 6.1e-05 | yes |
| S03E | verified | The 'Figure 11' row of Table 1 gives a = 0.56. We use the erratum value b = 2.88 × 10⁻⁶, after reading the erratum text again on OpenAlex and its record on Crossref. S03 Fig. 11 shows the fit line at 1.3 kpc at 10^10.1 M☉, 4.2 kpc at 10¹¹ M☉ and 13.6 kpc at 10^11.9 M☉, while the printed b = 3.47 × 10⁻⁵ would give 164 kpc at 10^11.9 M☉. The lowest early type point of S03 (10^10.1 M☉, about 1.7 kpc) lies about 0.12 dex above their power law, and our C ≥ 2.86 galaxies lie above the curve at low mass in the same way. | 6.4e-05 | yes |
| K03S | verified | K03b sec. 5 and its summary give a transition at μ★ ~ 3 × 10⁸ M☉ kpc⁻², with μ★ = 0.5 M★/[π R50(z)²], the Petrosian z band radius and a Kroupa IMF. Σ★ does not depend on h. In K03b Fig. 13, which we rendered, 50 % of galaxies have Dn4000 > 1.55 at log μ★ ≈ 8.55 to 8.6, so the quoted value of 3 × 10⁸ marks the lower part of the transition. | 2.1e-05 | yes |
| Q11d | verified | As Q11. | 0.0e+00 | yes |
| B03 | verified | The r* row of Table 2 (orthogonal fit, maximum likelihood) was read again (1.49, −0.75, −8.778), with eq. 2. The coefficient b multiplies log I, and μ = −2.5 log I, so the coefficient of μ is +0.30. R is in h70⁻¹ kpc and σ in km s⁻¹. The plane through the maximum likelihood means gives c = −8.749, which agrees within the rounding of b (±0.002 × 19.87 ≈ ±0.04). | 0.0e+00 | yes |
| K03 | verified | Eq. 1 of 'The Host Galaxies of AGN' was read again. A galaxy is an AGN if log([OIII]/Hβ) > 0.61/(log([NII]/Hα) − 0.05) + 1.3. Only the left branch (x < 0.05) is drawn, down to the lowest O3Hb value of the axis. | 6.1e-04 | yes |
| K01 | verified | Eq. 5, log([OIII]/Hβ) = 0.61/(log([NII]/Hα) − 0.47) + 1.19, was read again. Only the left branch (x < 0.47) is drawn. | 4.1e-04 | yes |
| S07 | verified | Eq. 1, log([OIII]/Hβ) = 1.05 log([NII]/Hα) + 0.45, was read again. It separates Seyferts from LINERs among AGN, so it is drawn from its intersection with K01 at (−0.184, 0.257). | 1.0e-04 | yes |
| Mo13 | verified | Eq. 2 and Table 1 were read again. Table 1 belongs to the evolution that is linear in (1 − a), not to the form that is quadratic in z in the earlier section. The table note says that all masses are in M☉. The halo mass is M200c, h = 0.704 (WMAP7) and the IMF is Chabrier. With a separate NFW conversion we get +0.135 dex at 10¹² M☉. | 1.4e-04 | yes |
| B13 | verified | Eq. 3, which gives the median M★ at fixed halo mass, and every coefficient of sec. 5 were read again. The halo mass is Mvir (Bryan & Norman, relative to the critical density), with Ωm = 0.27, h = 0.7 and a Chabrier IMF. With a separate NFW conversion we get +0.059 dex at 10¹² M☉. | 1.0e-04 | yes |
| Q11e | verified | As Q11. | 0.0e+00 | yes |
| C18 | verified | The log M★ block of Table 1 was read again. The bin means run from 9.14 to 11.20, the weighted medians run from −0.092 to −1.785, and non-detections are set to their upper limits. The masses are the improved MPA-JHU DR7 masses, the same values as ours. The fix of the first review is confirmed, since all 8 medians are vertices of the polyline. | 1.1e-04 | yes |
| H12 | verified | Eq. 1 was read again, and it is continuous at 10⁹ M☉. It gives ⟨log M_HI⟩ in 0.5 dex bins for detections in the α.40, SDSS and GALEX sample. The IMF is Chabrier with h = 0.7, so we add 0.034 dex to the mass and subtract 0.034 dex from the gas fraction. | 6.5e-05 | yes |

## Relations

### T04: Tremonti et al. (2004) mass-metallicity relation

- Citation: [Tremonti, C. A., et al. 2004, ApJ, 613, 898](https://ui.adsabs.harvard.edu/abs/2004ApJ...613..898T), [arXiv:astro-ph/0405537](https://arxiv.org/abs/astro-ph/0405537).
- Where: eq. 3; Table 3. Validity: 8.5 < log M* < 11.5. Drawn over native x = 8.5 to 11.5.
- Native axes: x = `logM`, y = `OH`. Kind: fit. fitOffset: false.
- IMF: Kroupa (2001). Cosmology: H0=70, Om=0.3, OL=0.7. Band, aperture and calibration: O/H from Bayesian CL01 photoionization-model fits (Charlot+04), the MPA-JHU OH_P50 method; masses Kauffmann+03a.
- Conversions: None.
- Notes: Fit to about 53,000 SDSS DR2 star-forming galaxies. T04 masses use a Kroupa IMF, as ours do. T04 O/H comes from the same Bayesian method as the MPA-JHU OH values on this axis. The band shows the 16th to 84th percentiles in bins of mass from T04 Table 3.
- Verification (2026-09-24): verified. eq. 3 (−1.492, 1.847, −0.08026), 8.5 < log M★ < 11.5, Kroupa, H0 = 70 and Ωm = 0.3; Table 3 columns are P2.5, P16, P50, P84, P97.5 (the band is P16 to P84).
- Second review (2026-09-24): verified. Eq. 3 and its range of 8.5 to 11.5 were read again, with the Kroupa IMF and H0 = 70. The Table 3 columns are P2.5, P16, P50, P84 and P97.5, and the band uses P16 and P84. T04 eq. 3 and the T04 row of KE08 Table 2 agree to 0.005 dex at 10¹⁰ and 10¹¹ M☉, so both use the same Kroupa masses.
- Check against our data: the median of (data − curve) inside the range is −0.009 dex (N = 144,614).

Excerpts from the source (status per excerpt):

```text
[found] T04/ms.tex: \textrm{12+log(O/H)} = -1.492 + 1.847 (\log \textrm{M}_{*}) - 0.08026 (\log \textrm{M}_{*})^2
[found] T04/ms.tex: This equation is valid over the range $8.5 < \log\textrm{M}_{*} < 11.5$.
[found] T04/ms.tex: Our masses assume a \citet{Kroupa_2001} Initial Mass Function (IMF).
[found] T04/tb3.tex: 8.57 & 8.18 & 8.25 & 8.44 & 8.64 & 8.77
```

### KE08: Kewley & Ellison (2008) mass-metallicity relation, PP04 O3N2

- Citation: [Kewley, L. J., & Ellison, S. L. 2008, ApJ, 681, 1183](https://ui.adsabs.harvard.edu/abs/2008ApJ...681.1183K), [arXiv:0801.1849](https://arxiv.org/abs/0801.1849).
- Where: Table 2, PP04 O3N2 row. Validity: bins centered at log M* = 8.6 to 11.0. Drawn over native x = 8.5 to 11.0.
- Native axes: x = `logM`, y = `OH_PP04`. Kind: fit. fitOffset: false.
- IMF: Kroupa (T04/K03a masses). Cosmology: masses from K03a/T04 (H0=70); paper adopts h=0.72, Om=0.29. Band, aperture and calibration: PP04 O3N2, same as our OH_PP04.
- Conversions: None.
- Notes: Robust cubic fit for the PP04 O3N2 calibration, which is also the calibration of our OH_PP04 axis. KE08 used SDSS DR4 star-forming galaxies and the Kauffmann et al. (2003) masses, which use a Kroupa IMF.
- Verification (2026-09-24): verified. Table 2 PP04 O3N2 row (32.1488, −8.51258, 0.976384, −0.0359763). The column header is a, b, c, d; the table note misprints the form. Masses T04/K03a (Kroupa). Same O3N2 formula as our OH_PP04.
- Second review (2026-09-24): verified. The PP04 O3N2 row of Table 2 was read again. The fit is y = a + bx + cx² + dx³ with x = log M in M☉, and the table note that prints 'bx²+bx³' is a misprint. The masses are the T04 and K03a masses with a Kroupa IMF, not Salpeter masses, because the T04 row of the same table reproduces T04 eq. 3.
- Check against our data: the median of (data − curve) inside the range is +0.008 dex (N = 141,809).

Excerpts from the source (status per excerpt):

```text
[found] KE08/ms.tex: PP04 O3N2 & 32.1488 & -8.51258 & 0.976384 & -0.0359763 & 0.10
[found] KE08/ms.tex: Robust fits are of the form $y=a+bx+bx^2+bx^3$ where $y=\log({\rm O/H})+12$ and $x=\log({\rm M})$
[found] KE08/ms.tex: centered at $\log({\rm M})=8.6,8.8,...,11$
[found] KE08/ms.tex: The SDSS stellar masses were derived by \citet{Tremonti04} and \citet{Kauffmann03a}
```

### AM13: Andrews & Martini (2013) direct-method mass-metallicity relation

- Citation: [Andrews, B. H., & Martini, P. 2013, ApJ, 765, 140](https://ui.adsabs.harvard.edu/abs/2013ApJ...765..140A), [arXiv:1211.3418](https://arxiv.org/abs/1211.3418).
- Where: eq. 5; Table 4 row 'MZR'. Validity: 7.4 < log M* < 10.5. Drawn over native x = 7.4 to 10.5.
- Native axes: x = `logM`, y = `OH_PP04`. Kind: fit. fitOffset: false.
- IMF: MPA-JHU DR7 (Kroupa), unchanged. Cosmology: H0=70, Om=0.3, OL=0.7. Band, aperture and calibration: direct Te method (T_e[OII] based) on stacks; drawn on OH_PP04.
- Conversions: None. The curve is drawn on the OH_PP04 axis, not the T04 axis.
- Notes: O/H from the direct (electron temperature) method in stacked SDSS DR7 spectra, binned by mass. Masses are the MPA-JHU DR7 total masses, the same as ours. The direct O/H scale is lower than the T04 scale, by 0.10 dex at 10⁹ M☉ and 0.33 dex at 10¹¹ M☉. We draw AM13 on the O3N2 axis because PP04 O3N2 is tied to direct O/H of H II regions.
- Verification (2026-09-24): verified. eq. 5 and Table 4 row MZR (log M_TO = 8.901, asymptote 8.798, γ = 0.640, fit 7.4 to 10.5); MPA-JHU DR7 total masses. The direct (Te) O/H scale is drawn on OH_PP04, which is an axis approximation.
- Second review (2026-09-24): verified. Eq. 5 and the MZR row of Table 4 were read again (8.901, 8.798, 0.640, fitted over 7.4 to 10.5). The masses are MPA-JHU DR7 total masses with no IMF change, and the cosmology is H0 = 70 and Ωm = 0.3.
- Check against our data: the median of (data − curve) inside the range is −0.031 dex (N = 119,351).

Excerpts from the source (status per excerpt):

```text
[found] AM13/tab4.tex: MZR & 8.901 & 8.798 & 0.640 & 7.4--10.5 & 0.18
[found] AM13/ms.tex: 12 + {\rm log(O/H)} = 12 + {\rm log(O/H)}_{\rm asm} - {\rm log}\left(1 + \left(\frac{M_{\rm TO}}{M_\star}\right)^\gamma\right),
[found] AM13/ms.tex: We adopt the total stellar mass \citep{kauffmann2003a} and the total SFR \citep{brinchmann2004, salim2007} values from the MPA-JHU
```

### C20: Curti et al. (2020) mass-metallicity relation, Te-based calibrations

- Citation: [Curti, M., et al. 2020, MNRAS, 491, 944](https://ui.adsabs.harvard.edu/abs/2020MNRAS.491..944C), [arXiv:1910.00597](https://arxiv.org/abs/1910.00597).
- Where: eq. 2; Table 4 row 'Equation (2)'. Validity: 7.95 < log M* < 11.85 (Chabrier). Drawn over native x = 7.9842 to 11.8842.
- Native axes: x = `logM`, y = `OH_PP04`. Kind: fit. fitOffset: false.
- IMF: Chabrier (MPA-JHU masses rescaled). Cosmology: not needed (MPA-JHU masses). Band, aperture and calibration: Curti+17 Te-based strong-line calibrations; drawn on OH_PP04.
- Conversions: log M★ +0.034 dex. C20 rescaled the MPA-JHU masses to a Chabrier IMF, and we undo that with the Madau & Dickinson (2014) factors 0.61 and 0.66.
- Notes: Fit to median O/H in bins of mass for about 150,000 SDSS DR7 galaxies. O/H comes from strong line calibrations that Curti et al. (2017) tied to electron temperature abundances. We draw it on the O3N2 axis for the same reason as AM13.
- Verification (2026-09-24): verified. eq. 2 and its table (Z0 = 8.793, log M0 = 10.02, γ = 0.28, β = 1.2), trusted for 7.95 < log M★ < 11.85. C20 do not state their Kroupa to Chabrier factor. The MD14 factor (0.034 dex) is used; M10's 1.06 would give 0.025 dex.
- Second review (2026-09-24): verified. Eq. 2 and its table were read again (8.793, 10.02, 0.28, 1.2), with the trusted range of 7.95 to 11.85. Below M0 the formula is a power law of index γ, as C20 state. C20 rescaled the MPA-JHU masses to a Chabrier IMF without giving the factor, so the MD14 value of +0.034 dex is a fair way to undo it.
- Check against our data: the median of (data − curve) inside the range is −0.022 dex (N = 146,712).

Excerpts from the source (status per excerpt):

```text
[found] C20/fmr_new_paper.tex: \text{Equation (2)} & 8.793 $\pm$ 0.005 & 10.02 $\pm$ 0.09 & 0.28 $\pm$ 0.02 & 1.2 $\pm$ 0.2
[found] C20/fmr_new_paper.tex: \text{12 + log(O/H)} = \text{Z}_{0} - \gamma/\beta * \text{log}\bigg(1 + \bigg(\frac{\text{M}}{\text{M}_{0}} \bigg)^{-\beta} \bigg)
[found] C20/fmr_new_paper.tex: Both stellar masses and SFRs estimates are re-scaled to a common \cite{Chabrier:2003aa} IMF.
[found] C20/fmr_new_paper.tex: trustworthy only in the $7.95 < $log(M$_{\star}$)$ < 11.85$ range
```

### M10: Mannucci et al. (2010) fundamental metallicity relation, μ0.32 projection

- Citation: [Mannucci, F., et al. 2010, MNRAS, 408, 2115](https://ui.adsabs.harvard.edu/abs/2010MNRAS.408.2115M), [arXiv:1005.0006](https://arxiv.org/abs/1005.0006).
- Where: eq. 4 (mu_0.32 quartic); eq. 2 is the fit in M* and SFR. Validity: mu_0.32 about 9.2 to 11.4 (M10 Table 1 grid). Drawn over native x = 9.0537 to 11.2537.
- Native axes: x = `logM − 0.32·logSFR`, y = `OH_PP04`. Kind: fit. fitOffset: true.
- IMF: Chabrier (masses = MPA-JHU / 1.06). Cosmology: MPA-JHU (H0=70). Band, aperture and calibration: Maiolino+08 (N2 and R23 average); fiber Halpha SFRs.
- Conversions: μ0.32 −0.146 dex in total. This is +0.025 for the mass IMF (M10 divided the MPA-JHU masses by 1.06), −0.32 × 0.027 for the SFR IMF, and −0.32 × 0.509 for fiber versus total SFR. The 0.509 dex is the median MPA-JHU aperture correction for galaxies selected as in M10, with the S/N(Hα) > 25 cut on the catalog errors as M10 applied it. This selection gives N = 140,574, close to the 141,825 of M10. It is 0.57 dex at log M★ = 11.0 to 11.5 and 0.41 dex at log M★ = 9.0 to 9.5.
- Notes: Projection of the fundamental metallicity relation onto μ0.32 = log M★ − 0.32 log SFR. M10 used the Maiolino et al. (2008) O/H calibrations, whose zero point and dynamic range differ from PP04 O3N2. For this reason the site shifts the curve in y to the median of the data, and the shape is only a guide. M10 used SFRs inside the 3 arcsec fiber, while our SFRs are totals.
- Verification (2026-09-24): corrected. eq. 4 quartic with x = μ0.32 − 10; μ0.32 range 9.2 to 11.4 from the populated Table 1 bins; masses K03a/1.06; SFRs inside the fiber (sec. 2.1 and 4). The x conversion was corrected, see below. Correction: μ0.32 shift −0.075 → −0.146 dex, so the curve moves −0.071 dex in x. The fiber to total SFR offset came from an M10-like sample cut on the rescaled Hα errors (N = 50,144, median 0.286 dex). M10 cut on the catalog errors as given; that cut gives N = 140,574, against the 141,825 of M10, and a median of 0.509 dex.
- Second review (2026-09-24): verified. Eq. 4 with x = μ0.32 − 10 was read again. M10 divided the MPA-JHU masses by 1.06 and used K98 Hα SFRs inside the fiber, and the populated Table 1 bins span μ0.32 = 9.23 to 11.43. M10 give their own sample counts in sec. 2.1. Of 927,552 DR7 galaxies, 47 % (436k) are emission line galaxies at 0.07 < z < 0.30, 43 % of these pass S/N(Hα) > 25, and 22 % are AGN. With the catalog errors as given, our parent sample gives 405k to 450k galaxies, 41 to 45 % and 20 %. With the errors rescaled by 2.473 it gives 13 to 15 % and 15 %. This confirms the correction of the first review.
- Check against our data: the median of (data − curve) inside the range is −0.245 dex (N = 140,157).

Excerpts from the source (status per excerpt):

```text
[found] M10/fmr4.tex: 12+log(O/H) = 8.90 + 0.39x -0.20x^2 - 0.077x^3 +0.064x^4
[found] M10/fmr4.tex: where $x=\mu_{0.32}-10$.
[found] M10/fmr4.tex: with a correction factor of 1.06 to scale the masses down from a \cite{Kroupa01} to a \cite{Chabrier03} initial mass function (IMF).
[found] M10/fmr4.tex: SFRs inside the spectroscopic aperture were measured from the \ha\ emission line flux corrected for dust extinction
[found] M10/fmr4.tex: We selected emission-line galaxies with redshift between 0.07 and 0.30
```

### RP15: Renzini & Peng (2015) star-forming main sequence (ridge line)

- Citation: [Renzini, A., & Peng, Y. 2015, ApJL, 801, L29](https://ui.adsabs.harvard.edu/abs/2015ApJ...801L..29R), [arXiv:1502.01027](https://arxiv.org/abs/1502.01027).
- Where: sec. 2, text. Validity: about 8.5 < log M* < 11. Drawn over native x = 8.5 to 11.0.
- Native axes: x = `logM`, y = `logSFR`. Kind: fit. fitOffset: false.
- IMF: not stated (Brinchmann+04 procedures, Kroupa). Cosmology: not stated (MPA-JHU-style values). Band, aperture and calibration: Halpha SFRs, SED masses.
- Conversions: None. RP15 do not state the IMF. If their masses and SFRs were Chabrier values, moving both to Kroupa (+0.034 dex in mass, +0.027 dex in SFR) would move the line by only +0.001 dex, because the two shifts nearly cancel along its slope.
- Notes: Ridge line, that is the peak of the SFR distribution at fixed mass, for SDSS DR7 galaxies at 0.02 < z < 0.085. RP15 did not preselect star-forming galaxies. Their SFRs and masses follow the Brinchmann et al. (2004) procedures, which use a Kroupa IMF.
- Verification (2026-09-24): verified. Ridge line log SFR = 0.76 log M★ − 7.64 (text below Fig. 3); SDSS DR7, 0.02 < z < 0.085, AGN excluded, no star forming preselection. The ridge of their Fig. 4 follows the formula. The IMF is not stated.
- Second review (2026-09-24): corrected. The ridge line log SFR = 0.76 log M★ − 7.64 (text below Fig. 3) was read again. It is a fit to the ridge of the V/Vmax weighted number density in Fig. 4. In Fig. 4, which we rendered from the source, the ridge is visible from 10^8.3 to 10^10.5 M☉. The conversions text gave an IMF uncertainty about 40 times too large (see the correction). The curve is unchanged. Correction: The conversions text was 'None. RP15 do not state the IMF, so an offset of up to 0.03 dex is possible.' It is now 'None. RP15 do not state the IMF. If their masses and SFRs were Chabrier values, moving both to Kroupa (+0.034 dex in mass, +0.027 dex in SFR) would move the line by only +0.001 dex, because the two shifts nearly cancel along its slope.' The curve is unchanged.
- Check against our data: the median of (data − curve) inside the range is −0.387 dex (N = 464,835).

Excerpts from the source (status per excerpt):

```text
[found] RP15/mainsequence_apj2b.tex: The best straight-line fit to the ridge line is log(SFR) = $(0.76\pm 0.01){\rm log}(M*/\msun) - 7.64\pm 0.02$
[found] RP15/mainsequence_apj2b.tex: release \citep{Abazajian07} for lying at $0.02<z<0.085$
[found] RP15/mainsequence_apj2b.tex: following the same procedures as in \cite{Brinchmann04} and P10
```

### S14: Speagle et al. (2014) main sequence at z = 0.1

- Citation: [Speagle, J. S., et al. 2014, ApJS, 214, 15](https://ui.adsabs.harvard.edu/abs/2014ApJS..214...15S), [arXiv:1405.2041](https://arxiv.org/abs/1405.2041).
- Where: eq. 28 (sec. 4.1). Validity: 9.7 < log M* < 11.1. Drawn over native x = 9.7 to 11.1.
- Native axes: x = `logM`, y = `logSFR`. Kind: fit. fitOffset: false.
- IMF: Kroupa. Cosmology: h=0.7, Om=0.3, OL=0.7. Band, aperture and calibration: compilation calibrated to common SFR/mass conventions.
- Conversions: None.
- Notes: Consensus main sequence from 25 studies, evaluated at the age of the universe at z = 0.1 (t = 12.2 Gyr in their cosmology). S14 left the local SDSS studies out of their fit, so this curve extends their fit to low redshift. S14 use a Kroupa IMF and h = 0.7, as we do. The fit covers log M★ = 9.7 to 11.1.
- Verification (2026-09-24): verified. eq. 28 (the preferred 'mixed' fit); t is the age of the Universe in Gyr for (h, Ωm, ΩΛ) = (0.7, 0.3, 0.7), 12.166 Gyr at z = 0.1; fitted mass range 9.7 to 11.1; Kroupa. The fit spans z ≈ 0.25 to 2.75, so z = 0.1 is an extrapolation.
- Second review (2026-09-24): verified. Eq. 28 (the 'Mixed' fit, which S14 prefer) was read again. The variable t is the age of the Universe in Gyr, and a separate integral gives 12.166 Gyr at z = 0.1 for (h, Ωm, ΩΛ) = (0.7, 0.3, 0.7). The IMF is Kroupa, the fitted mass range is 9.7 to 11.1, and the SDSS studies were left out of the fit.
- Check against our data: the median of (data − curve) inside the range is −0.666 dex (N = 456,038).

Excerpts from the source (status per excerpt):

```text
[found] S14/ms_emulateapj.tex: \log\psi(M_*,t) &= \left(0.84 \pm 0.02 - 0.026 \pm 0.003 \times t\right) \log M_* \nonumber \\ &- \left(6.51 \pm 0.24 - 0.11 \pm 0.03 \times t\right),
[found] S14/ms_emulateapj.tex: within the fitted mass range $\log M_* = 9.7$\,--\,$11.1$
[found] S14/ms_emulateapj.tex: $(h,\Omega_M,\Omega_\Lambda)=(0.7,0.3,0.7)$
[found] S14/ms_emulateapj.tex: a Kroupa \citep{kroupa01,kroupaweidner03} IMF
[found] S14/ms_emulateapj.tex: we decide not to include them at all rather than unduly overweight the fit towards results in the local Universe
```

### S16: Saintonge et al. (2016) main sequence

- Citation: [Saintonge, A., et al. 2016, MNRAS, 462, 1749](https://ui.adsabs.harvard.edu/abs/2016MNRAS.462.1749S), [arXiv:1607.05289](https://arxiv.org/abs/1607.05289).
- Where: eq. 5. Validity: fit to bins with M* > 10^8. Drawn over native x = 8.0 to 11.5.
- Native axes: x = `logM`, y = `logSFR`. Kind: fit. fitOffset: false.
- IMF: Chabrier (SFR scaled by 0.94); MPA-JHU masses. Cosmology: H0=70, Om=0.3, OL=0.7. Band, aperture and calibration: NUV + WISE SFRs.
- Conversions: log SFR +0.027 dex. S16 scaled their SFRs down by 6 percent to a Chabrier IMF, and we undo that (Madau & Dickinson 2014 factors 0.63 and 0.67).
- Notes: Cubic fit to the peak SFR of SDSS DR7 galaxies at 0.01 < z < 0.05 in bins of mass. The SFRs come from GALEX NUV and WISE data, not from MPA-JHU. The masses are MPA-JHU values.
- Verification (2026-09-24): verified. eq. 5 cubic; SDSS DR7 at 0.01 < z < 0.05; MPA-JHU masses; NUV + WISE SFRs scaled by 0.94 to Chabrier, which +0.027 dex undoes.
- Second review (2026-09-24): verified. Eq. 5 was read again. It is a cubic in x = log M★ with no constant term, fitted to galaxies at 0.01 < z < 0.05 with M★ > 10⁸ M☉. SFR_UV was calibrated for a Kroupa IMF and then scaled down by 6 % to Chabrier, and S16 quote all quantities for Chabrier, so +0.027 dex undoes the scaling. The masses are MPA-JHU values used as given, like ours.
- Check against our data: the median of (data − curve) inside the range is −0.577 dex (N = 625,422).

Excerpts from the source (status per excerpt):

```text
[found] S16/ms.tex: \log {\rm SFR} = -2.332 x + 0.4156 x^2 - 0.01828 x^3,
[found] S16/ms.tex: We extract all galaxies from the SDSS DR7 with $0.01<z<0.05$ and \mstar$>10^8$\msun
[found] S16/ms.tex: We finally apply a 6\% correction factor following \citet{madaudickinson14} to make \sfruv\ consistent with a Chabrier IMF.
[found] S16/ms.tex: Stellar masses derived based on the SDSS photometry method of \citet{salim07} are retrieved from the MPA/JHU catalog.
```

### Q11: Quiescence threshold, sSFR = 10⁻¹¹ yr⁻¹ (SFR view)

- Citation: [Wetzel, A. R., Tinker, J. L., & Conroy, C. 2012, MNRAS, 424, 232](https://ui.adsabs.harvard.edu/abs/2012MNRAS.424..232W), [arXiv:1107.5311](https://arxiv.org/abs/1107.5311).
- Where: sec. 2.1. Validity: all masses. Drawn over native x = 7.0 to 12.5.
- Native axes: x = `logM`, y = `logSFR`. Kind: threshold. fitOffset: false.
- IMF: MPA-JHU (same as ours). Cosmology: -. Band, aperture and calibration: MPA-JHU DR7 sSFR.
- Conversions: None.
- Notes: Line of constant sSFR = 10⁻¹¹ yr⁻¹. W12 call galaxies below it quenched and galaxies above it active. W12 used the MPA-JHU DR7 sSFRs, as we do.
- Verification (2026-09-24): verified. W12 sec. 2.1: active and quenched split at sSFR = 10⁻¹¹ yr⁻¹ on the MPA-JHU DR7 SSFRs.
- Second review (2026-09-24): verified. W12 sec. 2.1 splits galaxies at SSFR = 10⁻¹¹ yr⁻¹, using the MPA-JHU DR7 SSFRs (B04 with the Salim+07 aperture corrections). In the SFR plane the line is log SFR = log M★ − 11.

Excerpts from the source (status per excerpt):

```text
[found] W12/ms.tex: we divide galaxies into those with $\ssfr > 10^{-11}\yrinv$, referred to as `active', and those with $\ssfr < 10^{-11}\yrinv$, referred to as `quenched'.
```

### RP15s: Renzini & Peng (2015) main sequence, as sSFR

- Citation: [Renzini, A., & Peng, Y. 2015, ApJL, 801, L29](https://ui.adsabs.harvard.edu/abs/2015ApJ...801L..29R), [arXiv:1502.01027](https://arxiv.org/abs/1502.01027).
- Where: sec. 2, text (rewritten as sSFR). Validity: about 8.5 < log M* < 11. Drawn over native x = 8.5 to 11.0.
- Native axes: x = `logM`, y = `logsSFR`. Kind: fit. fitOffset: false.
- IMF: as RP15. Cosmology: as RP15. Band, aperture and calibration: as RP15.
- Conversions: None. The line is log SFR − log M★ from RP15. RP15 do not state the IMF. If their masses and SFRs were Chabrier values, moving both to Kroupa (+0.034 dex in mass, +0.027 dex in SFR) would move the line by only +0.001 dex, because the two shifts nearly cancel along its slope.
- Notes: The RP15 ridge line written as log sSFR = −0.24 log M★ − 7.64.
- Verification (2026-09-24): verified. RP15 rewritten: log sSFR = −0.24 log M★ − 7.64.
- Second review (2026-09-24): verified. The RP15 ridge line was rewritten as log sSFR = −0.24 log M★ − 7.64. The conversions text now includes the IMF note of RP15, i.e., a change from Chabrier to Kroupa moves the line by +0.001 dex.
- Check against our data: the median of (data − curve) inside the range is −0.437 dex (N = 461,576).

Excerpts from the source (status per excerpt):

```text
[found] RP15/mainsequence_apj2b.tex: The best straight-line fit to the ridge line is log(SFR) = $(0.76\pm 0.01){\rm log}(M*/\msun) - 7.64\pm 0.02$
```

### Q11s: Quiescence threshold, sSFR = 10⁻¹¹ yr⁻¹ (sSFR view)

- Citation: [Wetzel, A. R., Tinker, J. L., & Conroy, C. 2012, MNRAS, 424, 232](https://ui.adsabs.harvard.edu/abs/2012MNRAS.424..232W), [arXiv:1107.5311](https://arxiv.org/abs/1107.5311).
- Where: sec. 2.1. Validity: all masses. Drawn over native x = 7.0 to 12.5.
- Native axes: x = `logM`, y = `logsSFR`. Kind: threshold. fitOffset: false.
- IMF: MPA-JHU (same as ours). Cosmology: -. Band, aperture and calibration: MPA-JHU DR7 sSFR.
- Conversions: None.
- Notes: Line of constant sSFR = 10⁻¹¹ yr⁻¹. W12 call galaxies below it quenched and galaxies above it active. W12 used the MPA-JHU DR7 sSFRs, as we do.
- Verification (2026-09-24): verified. as Q11.
- Second review (2026-09-24): verified. As Q11.

Excerpts from the source (status per excerpt):

```text
[found] W12/ms.tex: we divide galaxies into those with $\ssfr > 10^{-11}\yrinv$, referred to as `active', and those with $\ssfr < 10^{-11}\yrinv$, referred to as `quenched'.
```

### S03L: Shen et al. (2003) size-mass relation, late types

- Citation: [Shen, S., et al. 2003, MNRAS, 343, 978](https://ui.adsabs.harvard.edu/abs/2003MNRAS.343..978S), [arXiv:astro-ph/0301527](https://arxiv.org/abs/astro-ph/0301527).
- Where: Table 1 row 'Figure 11'; published eq. 18. Validity: log M* about 8.75 to 11.75. Drawn over native x = 8.7 to 11.8.
- Native axes: x = `logM`, y = `logR50`. Kind: fit. fitOffset: false.
- IMF: Kroupa (K03a masses). Cosmology: h=0.7, Om=0.3, OL=0.7. Band, aperture and calibration: Sersic z-band R50 (Blanton+03), n<2.5.
- Conversions: log R₅₀ +0.056 to +0.078 dex, depending on mass. This is +0.029 dex for r band versus z band Petrosian radii (median for C < 2.86 in an SDSS DR17 sample) and +0.027 to +0.049 dex for Petrosian versus Sérsic radii. We get the second term from the S03 size-luminosity fits for Petrosian radii (their Figure 4) and Sérsic radii (their Figure 6), compared at the same galaxy.
- Notes: Median size of late type galaxies (Sérsic n < 2.5) as a function of stellar mass. S03 used Sérsic half-light radii in the z band, while our radii are Petrosian radii in the r band. S03 masses are the Kauffmann et al. (2003) values with a Kroupa IMF.
- Verification (2026-09-24): verified. Table 1 row 'Figure 11' (α = 0.14, β = 0.39, γ = 0.10 kpc, M0 = 3.98 × 10¹⁰ M☉), z band Sérsic radii, n < 2.5, h = 0.7. The fit line of S03 Fig. 11, rendered from the source, gives 1.8 kpc at 10⁹ and 4.7 kpc at 10¹¹ M☉, as the formula does.
- Second review (2026-09-24): verified. The 'Figure 11' row of Table 1 and eq. 18 were read again. The radii are Sérsic half-light radii in the z band, late types have n < 2.5, h = 0.7, and the masses are K03a masses. We rendered S03 Fig. 11 from fig11.ps, and its late type line passes 1.8 kpc at 10⁹ M☉ and 4.7 kpc at 10¹¹ M☉. We implemented the conversion again. We start from the Fig. 11 radius, add the r/z ratio, invert the Fig. 6 fit, apply the Petrosian flux fraction and then evaluate the Fig. 4 fit.
- Check against our data: the median of (data − curve) inside the range is +0.011 dex (N = 426,654, galaxies of the matching concentration class).

Excerpts from the source (status per excerpt):

```text
[found] S03/paper.tex: Figure 11& 0.56 & $3.47\times10^{-5}$ & & 0.14 & 0.39 & 0.10 & $3.98\times10^{10}\Msun$&
[found] S03/paper.tex: \bar{R}(\kpc)=\gamma\left(\frac{M}{\Msun}\right)^{\alpha} \left(1+\frac{M}{M_0}\right)^{\beta-\alpha}
[found] S03/paper.tex: Figure \ref{SRdisMassz} shows the results based on the $z$-band \Sersic half-light radii.
[found] S03/paper.tex: (here defined to be those with $n<2.5$), while the squares are for early-type galaxies (with $n>2.5$)
[found] S03/paper.tex: Figure 4 & 0.60 & $-4.63$ & & 0.21 & 0.53 & $-1.31$ & $-20.52$ &
[found] S03/paper.tex: Figure 6 & 0.65 & $-5.06$ & & 0.26 & 0.51 & $-1.71$ & $-20.91$ &
[found] S03/paper.tex: \Log(\bar{R}/\kpc)=-0.4aM+b\,,
[found] S03/paper.tex: \Log(\bar{R}/\kpc)=-0.4\alpha M+ (\beta-\alpha)\Log[1+10^{-0.4(M-M_0)}]+\gamma
[found] S03/paper.tex: median and dispersion of the distribution of Petrosian half-light radius $R_{50}$ (in the $r$-band), as functions of $r$-band Petrosian absolute magnitude
[found] S03/paper.tex: half-light radius $R_{50,S}$ (in the $r$-band) as functions of $r$-band absolute \Sersic magnitude.
[found] S03/paper.tex: Hubble's constant $h=0.7$
```

### S03E: Shen et al. (2003) size-mass relation, early types

- Citation: [Shen, S., et al. 2003, MNRAS, 343, 978; erratum 2007, MNRAS, 379, 400](https://ui.adsabs.harvard.edu/abs/2003MNRAS.343..978S), [arXiv:astro-ph/0301527](https://arxiv.org/abs/astro-ph/0301527).
- Where: Table 1 row 'Figure 11'; published eq. 17; erratum MNRAS 379, 400 (2007). Validity: log M* about 10.1 to 11.9. Drawn over native x = 10.0 to 11.9.
- Native axes: x = `logM`, y = `logR50`. Kind: fit. fitOffset: false.
- IMF: Kroupa (K03a masses). Cosmology: h=0.7, Om=0.3, OL=0.7. Band, aperture and calibration: Sersic z-band R50 (Blanton+03), n>2.5.
- Conversions: log R₅₀ 0.000 dex at 10¹⁰ M☉ to −0.082 dex at 10¹¹·⁹ M☉. This is +0.024 dex for r band versus z band Petrosian radii (median for C ≥ 2.86) plus −0.024 to −0.106 dex for Petrosian versus Sérsic radii. We get the second term from the S03 size-luminosity fits for Petrosian and Sérsic radii (their Figures 4 and 6), compared at the same galaxy, with the Petrosian flux fraction of 0.8 that S03 give. A de Vaucouleurs profile without seeing would give −0.147 dex.
- Notes: Median size of early type galaxies (Sérsic n > 2.5) as a function of stellar mass. We use b = 2.88 × 10⁻⁶ from the 2007 erratum, since Table 1 printed 3.47 × 10⁻⁵. The radius and mass caveats of S03L apply here too.
- Verification (2026-09-24): verified. Table 1 row 'Figure 11', a = 0.56, with the erratum b = 2.88 × 10⁻⁶ (printed 3.47 × 10⁻⁵). Independent check of the erratum: the early type fit line drawn in S03 Fig. 11 passes 4.2 kpc at 10¹¹ and 15 kpc at 10¹² M☉ (b ≈ 2.9 × 10⁻⁶), and the S03 z band size-luminosity fit (row 'Figure 10') gives about 3.9 kpc at 10¹¹ M☉ for M/L_z ≈ 1.8.
- Second review (2026-09-24): verified. The 'Figure 11' row of Table 1 gives a = 0.56. We use the erratum value b = 2.88 × 10⁻⁶, after reading the erratum text again on OpenAlex and its record on Crossref. S03 Fig. 11 shows the fit line at 1.3 kpc at 10^10.1 M☉, 4.2 kpc at 10¹¹ M☉ and 13.6 kpc at 10^11.9 M☉, while the printed b = 3.47 × 10⁻⁵ would give 164 kpc at 10^11.9 M☉. The lowest early type point of S03 (10^10.1 M☉, about 1.7 kpc) lies about 0.12 dex above their power law, and our C ≥ 2.86 galaxies lie above the curve at low mass in the same way.
- Check against our data: the median of (data − curve) inside the range is +0.062 dex (N = 216,294, galaxies of the matching concentration class).

Excerpts from the source (status per excerpt):

```text
[found] S03/paper.tex: Figure 11& 0.56 & $3.47\times10^{-5}$ &
[found] S03err/openalex.json: The value of fitting parameter b in equation (17) of fig. 11 given in table 1 is wrong. The correct value is 2.88 × 10−6.
[found] S03/paper.tex: \bar{R}(\kpc)=b\left(\frac{M}{\Msun}\right)^{a}\,.
[found] S03/paper.tex: the Petrosian magntitude includes about 80 percent of the total flux, while the Petrosian half-light radius is only about 70 percent of the real half-light radius.
[found] S03/paper.tex: Figure \ref{SRdisMassz} shows the results based on the $z$-band \Sersic half-light radii.
[found] S03/paper.tex: (here defined to be those with $n<2.5$), while the squares are for early-type galaxies (with $n>2.5$)
[found] S03/paper.tex: Figure 4 & 0.60 & $-4.63$ & & 0.21 & 0.53 & $-1.31$ & $-20.52$ &
[found] S03/paper.tex: Figure 6 & 0.65 & $-5.06$ & & 0.26 & 0.51 & $-1.71$ & $-20.91$ &
[found] S03/paper.tex: \Log(\bar{R}/\kpc)=-0.4aM+b\,,
[found] S03/paper.tex: \Log(\bar{R}/\kpc)=-0.4\alpha M+ (\beta-\alpha)\Log[1+10^{-0.4(M-M_0)}]+\gamma
[found] S03/paper.tex: median and dispersion of the distribution of Petrosian half-light radius $R_{50}$ (in the $r$-band), as functions of $r$-band Petrosian absolute magnitude
[found] S03/paper.tex: half-light radius $R_{50,S}$ (in the $r$-band) as functions of $r$-band absolute \Sersic magnitude.
[found] S03/paper.tex: Hubble's constant $h=0.7$
```

### K03S: Kauffmann et al. (2003) surface density transition

- Citation: [Kauffmann, G., et al. 2003, MNRAS, 341, 54](https://ui.adsabs.harvard.edu/abs/2003MNRAS.341...54K), [arXiv:astro-ph/0205070](https://arxiv.org/abs/astro-ph/0205070).
- Where: summary of sec. 5 (Dn4000 and HdA versus mu_*). Validity: -. Drawn over native x = 8.4231 to 8.4231.
- Native axes: x = `logSigma`, y = `logsSFR`. Kind: threshold. fitOffset: false.
- IMF: Kroupa (2001). Cosmology: H0=70, Om=0.3, OL=0.7. Band, aperture and calibration: Petrosian z-band R50.
- Conversions: log Σ★ −0.054 dex, which is −2 × 0.027 dex for r band versus z band Petrosian radii (all galaxies in an SDSS DR17 sample).
- Notes: K03 found a sharp change in stellar age (Dn4000) at a surface density of about 3 × 10⁸ M☉ kpc⁻². K03 used z band Petrosian radii, and we use r band radii, so the line moves from 8.48 to 8.42 on our axis.
- Verification (2026-09-24): verified. μ★ ~ 3 × 10⁸ M☉ kpc⁻² (K03b sec. 5 and summary), with μ★ = 0.5 M★/(π R50,z²). The r/z radius ratio was measured again on an independent SkyServer sample of 8,000 galaxies (+0.0277 dex, against +0.0270).
- Second review (2026-09-24): verified. K03b sec. 5 and its summary give a transition at μ★ ~ 3 × 10⁸ M☉ kpc⁻², with μ★ = 0.5 M★/[π R50(z)²], the Petrosian z band radius and a Kroupa IMF. Σ★ does not depend on h. In K03b Fig. 13, which we rendered, 50 % of galaxies have Dn4000 > 1.55 at log μ★ ≈ 8.55 to 8.6, so the quoted value of 3 × 10⁸ marks the lower part of the transition.

Excerpts from the source (status per excerpt):

```text
[found] K03b/masses1.tex: with a strong transition at $\mu_* \sim 3\times 10^8 M_{\odot}$ kpc$^{-2}$
[found] K03b/masses1.tex: We define the surface mass density $\mu_*$ as $0.5M_*/[\pi R50^2(z)]$, where $R50(z)$ is the Petrosian half-light radius in the $z$-band
[found] K03b/masses1.tex: The stellar masses are derived assuming a universal initial mass function (IMF) in the parametrisation of Kroupa (2001).
```

### Q11d: Quiescence threshold, sSFR = 10⁻¹¹ yr⁻¹ (surface density view)

- Citation: [Wetzel, A. R., Tinker, J. L., & Conroy, C. 2012, MNRAS, 424, 232](https://ui.adsabs.harvard.edu/abs/2012MNRAS.424..232W), [arXiv:1107.5311](https://arxiv.org/abs/1107.5311).
- Where: sec. 2.1. Validity: all masses. Drawn over native x = 5.5 to 11.0.
- Native axes: x = `logSigma`, y = `logsSFR`. Kind: threshold. fitOffset: false.
- IMF: MPA-JHU (same as ours). Cosmology: -. Band, aperture and calibration: MPA-JHU DR7 sSFR.
- Conversions: None.
- Notes: Line of constant sSFR = 10⁻¹¹ yr⁻¹. W12 call galaxies below it quenched and galaxies above it active. W12 used the MPA-JHU DR7 sSFRs, as we do.
- Verification (2026-09-24): verified. as Q11.
- Second review (2026-09-24): verified. As Q11.

Excerpts from the source (status per excerpt):

```text
[found] W12/ms.tex: we divide galaxies into those with $\ssfr > 10^{-11}\yrinv$, referred to as `active', and those with $\ssfr < 10^{-11}\yrinv$, referred to as `quenched'.
```

### B03: Bernardi et al. (2003) Fundamental Plane, edge-on, r band

- Citation: [Bernardi, M., et al. 2003, AJ, 125, 1866](https://ui.adsabs.harvard.edu/abs/2003AJ....125.1866B), [arXiv:astro-ph/0301626](https://arxiv.org/abs/astro-ph/0301626).
- Where: Table 2 (orthogonal ML, r*); eq. 2. Validity: B03 x = 9.24 +/- 0.25. Drawn over native x = 8.5 to 10.2.
- Native axes: x = `1.49·logSigV + 0.3·mu50`, y = `logR50`. Kind: fit. fitOffset: true.
- IMF: -. Cosmology: Om=0.3, OL=0.7, h=0.7. Band, aperture and calibration: de Vaucouleurs R_o, sigma at R_o/8, mu_o K- and evolution-corrected.
- Conversions: None applied to the coefficients. The site fits the zero point to the data (fitOffset).
- Notes: Edge-on Fundamental Plane of about 9,000 SDSS early type galaxies in the r band. The relation is log R = 1.49 log σ + 0.30 μ − 8.778, where μ = −2.5 log I. B03 used de Vaucouleurs radii and surface brightness with K and evolution corrections. Our R₅₀ and μ₅₀ are Petrosian values without a K correction, so the site shifts the curve in y to the median of the data.
- Verification (2026-09-24): verified. Table 2, orthogonal maximum likelihood, r*: a = 1.49, b = −0.75 (in log I), c = −8.778; μ = −2.5 log I; R in h70⁻¹ kpc; σ at R/8. c reproduces B03's own sample means (V* = 2.200, μ* = 19.87, R* = 0.490) to rounding.
- Second review (2026-09-24): verified. The r* row of Table 2 (orthogonal fit, maximum likelihood) was read again (1.49, −0.75, −8.778), with eq. 2. The coefficient b multiplies log I, and μ = −2.5 log I, so the coefficient of μ is +0.30. R is in h70⁻¹ kpc and σ in km s⁻¹. The plane through the maximum likelihood means gives c = −8.749, which agrees within the rounding of b (±0.002 × 19.87 ≈ ±0.04).
- Check against our data: the median of (data − curve) inside the range is +0.001 dex (N = 59,510).

Excerpts from the source (status per excerpt):

```text
[found] B03/bernardi3.tex: $r^*$ & 1.49$\pm 0.05$ & $-0.75\pm 0.01$ & $-8.778\pm 0.020$ & 0.052 & 0.094
[found] B03/bernardi3.tex: \log_{10} R_o = a\,\log_{10}\sigma + b\,\log_{10}I_o + c
[found] B03/bernardi3.tex: Note that $\mu = -2.5\log_{10}I_o$.
[found] B03/bernardi3.tex: $(\Omega_{\rm M},\Omega_{\Lambda},h)=(0.3,0.7,0.7)$
```

### K03: Kauffmann et al. (2003) star-forming / AGN demarcation

- Citation: [Kauffmann, G., et al. 2003, MNRAS, 346, 1055](https://ui.adsabs.harvard.edu/abs/2003MNRAS.346.1055K), [arXiv:astro-ph/0304239](https://arxiv.org/abs/astro-ph/0304239).
- Where: eq. 1. Validity: log [NII]/Ha < 0.05. Drawn over native x = -2.5 to -0.1679.
- Native axes: x = `N2Ha`, y = `O3Hb`. Kind: demarcation. fitOffset: false.
- IMF: -. Cosmology: -. Band, aperture and calibration: line ratios.
- Conversions: None.
- Notes: Empirical upper edge of the star-forming sequence. Galaxies above it are AGN or composites.
- Verification (2026-09-24): verified. eq. 1: 0.61/(x − 0.05) + 1.3.
- Second review (2026-09-24): verified. Eq. 1 of 'The Host Galaxies of AGN' was read again. A galaxy is an AGN if log([OIII]/Hβ) > 0.61/(log([NII]/Hα) − 0.05) + 1.3. Only the left branch (x < 0.05) is drawn, down to the lowest O3Hb value of the axis.

Excerpts from the source (status per excerpt):

```text
[found] K03c/tim_revisedn.tex: \log ([\rm{OIII}]/H\beta) > 0.61/(\log ([\rm{NII}]/H\alpha)-0.05) +1.3
```

### K01: Kewley et al. (2001) maximum starburst line

- Citation: [Kewley, L. J., et al. 2001, ApJ, 556, 121](https://ui.adsabs.harvard.edu/abs/2001ApJ...556..121K), [arXiv:astro-ph/0106324](https://arxiv.org/abs/astro-ph/0106324).
- Where: eq. 5. Validity: log [NII]/Ha < 0.47. Drawn over native x = -2.5 to 0.2432.
- Native axes: x = `N2Ha`, y = `O3Hb`. Kind: demarcation. fitOffset: false.
- IMF: -. Cosmology: -. Band, aperture and calibration: PEGASE/STARBURST99 + MAPPINGS models.
- Conversions: None.
- Notes: Theoretical upper limit of starburst photoionization models. Galaxies above it are AGN.
- Verification (2026-09-24): verified. eq. 5: 0.61/(x − 0.47) + 1.19.
- Second review (2026-09-24): verified. Eq. 5, log([OIII]/Hβ) = 0.61/(log([NII]/Hα) − 0.47) + 1.19, was read again. Only the left branch (x < 0.47) is drawn.

Excerpts from the source (status per excerpt):

```text
[found] K01/astroph_ms.tex: \log \left(\frac{{\rm [OIII]\,\lambda 5007}}{{\rm H}\beta}\right) = \frac{0.61} {\log ({\rm [NII]}/{\rm H}\alpha) -0.47}+1.19
```

### S07: Schawinski et al. (2007) Seyfert / LINER line

- Citation: [Schawinski, K., et al. 2007, MNRAS, 382, 1415](https://ui.adsabs.harvard.edu/abs/2007MNRAS.382.1415S), [arXiv:0709.3015](https://arxiv.org/abs/0709.3015).
- Where: eq. 1. Validity: above K01. Drawn over native x = -0.1838 to 1.0.
- Native axes: x = `N2Ha`, y = `O3Hb`. Kind: demarcation. fitOffset: false.
- IMF: -. Cosmology: -. Band, aperture and calibration: line ratios.
- Conversions: None.
- Notes: Separates Seyferts (above) from LINERs (below) among AGN. We draw it only above the K01 line.
- Verification (2026-09-24): verified. eq. 1: 1.05 x + 0.45, drawn from its K01 intersection (−0.184, 0.257).
- Second review (2026-09-24): verified. Eq. 1, log([OIII]/Hβ) = 1.05 log([NII]/Hα) + 0.45, was read again. It separates Seyferts from LINERs among AGN, so it is drawn from its intersection with K01 at (−0.184, 0.257).

Excerpts from the source (status per excerpt):

```text
[found] S07/sfh_etypes.tex: \mathrm{log([OIII]/H\beta) = 1.05~log([NII]/H\alpha) + 0.45}
```

### Mo13: Moster, Naab & White (2013) stellar-to-halo mass relation at z = 0.1

- Citation: [Moster, B. P., Naab, T., & White, S. D. M. 2013, MNRAS, 428, 3121](https://ui.adsabs.harvard.edu/abs/2013MNRAS.428.3121M), [arXiv:1205.5807](https://arxiv.org/abs/1205.5807).
- Where: eq. 2; eqs. 11 to 14; Table 1. Validity: log M200c = 11 to 15 drawn. Drawn over native x = 11.126 to 15.182.
- Native axes: x = `logMh`, y = `logM`. Kind: fit. fitOffset: false.
- IMF: Chabrier. Cosmology: WMAP7: Om=0.272, h=0.704. Band, aperture and calibration: halo M200c (critical x 200).
- Conversions: Halo mass from M200c to M180m for NFW halos with Duffy et al. (2008) concentrations (+0.12 dex at 10¹¹ and +0.16 dex at 10¹⁴ M☉), plus +0.0025 dex for h = 0.704 to 0.7. Stellar mass +0.034 dex (Chabrier to Kroupa) and +0.0049 dex (h).
- Notes: Central galaxy stellar mass versus halo mass from abundance matching at several redshifts, evaluated at z = 0.1. Mo13 halo masses are M200c (200 times the critical density) with h = 0.704. Our halo masses are Lim et al. (2017) group masses, defined as M180m (180 times the mean density) and found by abundance matching.
- Verification (2026-09-24): verified. eq. 2, the z/(z+1) evolution and Table 1; masses in M☉ for h = 0.704, M200c, Chabrier. The halo conversion was re-derived with a separate NFW and Duffy+08 code (+0.135 dex at 10¹² M☉).
- Second review (2026-09-24): verified. Eq. 2 and Table 1 were read again. Table 1 belongs to the evolution that is linear in (1 − a), not to the form that is quadratic in z in the earlier section. The table note says that all masses are in M☉. The halo mass is M200c, h = 0.704 (WMAP7) and the IMF is Chabrier. With a separate NFW conversion we get +0.135 dex at 10¹² M☉.
- Check against our data: the median of (data − curve) inside the range is −0.013 dex (N = 406,205).

Excerpts from the source (status per excerpt):

```text
[found] Mo13/moster2012.tex: Best fit & 11.590 & 1.195 & 0.0351 & -0.0247 & 1.376 & -0.826 & 0.608 & 0.329
[found] Mo13/moster2012.tex: \frac{m}{M} = 2 \; N \; \left[ \left( \frac{M}{M_1} \right)^{-\beta} + \left( \frac{M}{M_1} \right)^{\gamma} \right]^{-1}
[found] Mo13/moster2012.tex: \log M_1(z) &=& M_{10}+M_{11}(1-a)=M_{10}+M_{11}\frac{z}{z+1}
[found] Mo13/moster2012.tex: All virial masses are computed with respect to 200 times the critical density.
[found] Mo13/moster2012.tex: (\Omega_{\rm m},\Omega_{\rm \Lambda}, \Omega_{\rm b},h,n,\sigma_8)= (0.272, 0.728, 0.046,0.704,0.967,0.810)
[found] Mo13/moster2012.tex: We employ a \citet{chabrier2003} initial mass function (IMF) and we convert all stellar masses to this IMF.
```

### B13: Behroozi, Wechsler & Conroy (2013) stellar-to-halo mass relation at z = 0.1

- Citation: [Behroozi, P. S., Wechsler, R. H., & Conroy, C. 2013, ApJ, 770, 57](https://ui.adsabs.harvard.edu/abs/2013ApJ...770...57B), [arXiv:1207.6105](https://arxiv.org/abs/1207.6105).
- Where: eq. 3; sec. 5 parameters (fit.tex). Validity: log Mvir = 10.5 to 15 drawn. Drawn over native x = 10.5522 to 15.0777.
- Native axes: x = `logMh`, y = `logM`. Kind: fit. fitOffset: false.
- IMF: Chabrier. Cosmology: Om=0.27, OL=0.73, h=0.7. Band, aperture and calibration: halo Mvir (Bryan & Norman 1998).
- Conversions: Halo mass from Mvir to M180m for NFW halos with Duffy et al. (2008) concentrations (+0.05 dex at 10¹¹ and +0.07 dex at 10¹⁴ M☉). Stellar mass +0.034 dex (Chabrier to Kroupa).
- Notes: Median central galaxy stellar mass versus halo mass at z = 0.1. B13 halo masses are virial masses (Bryan & Norman 1998) with h = 0.7.
- Verification (2026-09-24): verified. eq. 3 and the sec. 5 parameters; median M★ at fixed Mvir (Bryan & Norman), h = 0.7, Ωm = 0.27, Chabrier. Halo conversion re-derived (+0.059 dex at 10¹² M☉). B13's nuisance offset μ(z = 0.1) = −0.027 dex between measured and true M★ is not applied.
- Second review (2026-09-24): verified. Eq. 3, which gives the median M★ at fixed halo mass, and every coefficient of sec. 5 were read again. The halo mass is Mvir (Bryan & Norman, relative to the critical density), with Ωm = 0.27, h = 0.7 and a Chabrier IMF. With a separate NFW conversion we get +0.059 dex at 10¹² M☉.
- Check against our data: the median of (data − curve) inside the range is −0.011 dex (N = 406,183).

Excerpts from the source (status per excerpt):

```text
[found] B13/fit.tex: \log_{10}(M_1) &=& 11.514^{+0.053}_{-0.009} + (-1.793^{+0.315}_{-0.330}(a-1) + (-0.251^{+0.012}_{-0.125})z)\nu
[found] B13/fit.tex: \log_{10}(\epsilon) &=& -1.777^{+0.133}_{-0.146} + (-0.006^{+0.113}_{-0.361}(a-1) + (-0.000^{+0.003}_{-0.104})z)\nu +
[found] B13/fit.tex: -0.119^{+0.061}_{-0.012}(a-1)
[found] B13/fit.tex: \alpha &=& -1.412^{+0.020}_{-0.105} + (0.731^{+0.344}_{-0.296}(a-1))\nu
[found] B13/fit.tex: \delta &=& 3.508^{+0.087}_{-0.369} + (2.608^{+2.446}_{-1.261}(a-1) + -0.043^{+0.958}_{0.071}z)\nu
[found] B13/fit.tex: \gamma &=& 0.316^{+0.076}_{-0.012} + (1.319^{+0.584}_{-0.505}(a-1) + 0.279^{+0.256}_{-0.081}z)\nu
[found] B13/fit.tex: \nu &=& \exp(-4a^2)
[found] B13/paper.tex: f(x) & = & -\log_{10}(10^{\alpha x} + 1) + \delta \frac{(\log_{10}(1+\exp(x)))^\gamma}{1+\exp(10^{-x})}.
[found] B13/paper.tex: We use the virial mass (as defined in \citealt{mvir_conv}) to define the halo mass of central galaxies
[found] B13/paper.tex: $\Omega_M = 0.27$, $\Omega_\Lambda = 0.73$, $h=0.7$
```

### Q11e: Quiescence threshold, sSFR = 10⁻¹¹ yr⁻¹ (halo mass view)

- Citation: [Wetzel, A. R., Tinker, J. L., & Conroy, C. 2012, MNRAS, 424, 232](https://ui.adsabs.harvard.edu/abs/2012MNRAS.424..232W), [arXiv:1107.5311](https://arxiv.org/abs/1107.5311).
- Where: sec. 2.1. Validity: all masses. Drawn over native x = 10.0 to 15.5.
- Native axes: x = `logMh`, y = `logsSFR`. Kind: threshold. fitOffset: false.
- IMF: MPA-JHU (same as ours). Cosmology: -. Band, aperture and calibration: MPA-JHU DR7 sSFR.
- Conversions: None.
- Notes: Line of constant sSFR = 10⁻¹¹ yr⁻¹. W12 call galaxies below it quenched and galaxies above it active. W12 used the MPA-JHU DR7 sSFRs, as we do.
- Verification (2026-09-24): verified. as Q11.
- Second review (2026-09-24): verified. As Q11.

Excerpts from the source (status per excerpt):

```text
[found] W12/ms.tex: we divide galaxies into those with $\ssfr > 10^{-11}\yrinv$, referred to as `active', and those with $\ssfr < 10^{-11}\yrinv$, referred to as `quenched'.
```

### C18: Catinella et al. (2018) xGASS H I gas fraction medians

- Citation: [Catinella, B., et al. 2018, MNRAS, 476, 875](https://ui.adsabs.harvard.edu/abs/2018MNRAS.476..875C), [arXiv:1802.02373](https://arxiv.org/abs/1802.02373).
- Where: Table 1, log M* block, column (b). Validity: <log M*> = 9.14 to 11.20. Drawn over native x = 9.14 to 11.2.
- Native axes: x = `logM`, y = `logfHI`. Kind: median. fitOffset: false.
- IMF: MPA-JHU DR7 values (labeled Chabrier). Cosmology: H0=70, Om=0.3, OL=0.7. Band, aperture and calibration: Arecibo H I; non-detections at upper limits.
- Conversions: None. The masses are MPA-JHU DR7 values.
- Notes: Weighted medians of log(M_HI/M★) in bins of mass for the xGASS representative sample. Non-detections are set to their upper limits. Our H I data are ALFALFA detections only, so they lie above this curve at high mass.
- Verification (2026-09-24): corrected. Table 1 log M★ block, weighted medians with non-detections at their upper limits; MPA-JHU DR7 masses (labeled Chabrier, used as given). The drawn polyline was corrected, see below. Correction: The 85 point polyline passed through only 2 of the 8 Table 1 medians and cut the corners by up to 0.011 dex. The medians are now vertices of the polyline.
- Second review (2026-09-24): verified. The log M★ block of Table 1 was read again. The bin means run from 9.14 to 11.20, the weighted medians run from −0.092 to −1.785, and non-detections are set to their upper limits. The masses are the improved MPA-JHU DR7 masses, the same values as ours. The fix of the first review is confirmed, since all 8 medians are vertices of the polyline.
- Check against our data: the median of (data − curve) inside the range is +0.686 dex (N = 11,159).

Excerpts from the source (status per excerpt):

```text
[found] C18/table_hi_avgs.tex: log \Mst & 9.14 & $-$0.242$\pm$0.053 & $-$0.092 & 113
[found] C18/table_hi_avgs.tex: Weighted median of logarithm of gas fraction; \hi\ mass of non-detections set to upper limit.
[found] C18/xgass.tex: Stellar masses are from the Max Planck Institute for Astrophysics (MPA)/Johns Hopkins University (JHU) value-added catalog based on SDSS DR7
[found] C18/xgass.tex: and assume a \citet{chabrier03} initial mass function.
```

### H12: Huang et al. (2012) ALFALFA H I mass-stellar mass relation

- Citation: [Huang, S., et al. 2012, ApJ, 756, 113](https://ui.adsabs.harvard.edu/abs/2012ApJ...756..113H), [arXiv:1207.0523](https://arxiv.org/abs/1207.0523).
- Where: eq. 1. Validity: log M* about 6.5 to 11.25 (bins of 0.5 dex). Drawn over native x = 7.0342 to 11.2842.
- Native axes: x = `logM`, y = `logfHI`. Kind: fit. fitOffset: false.
- IMF: Chabrier. Cosmology: h=0.7. Band, aperture and calibration: ALFALFA alpha.40 detections; SED masses.
- Conversions: log M★ +0.034 dex and log(M_HI/M★) −0.034 dex (Chabrier to Kroupa).
- Notes: Fit to the mean log M_HI in bins of mass for ALFALFA α.40 detections with SDSS and GALEX data. This matches the selection of our H I data, which are also ALFALFA detections. H12 masses come from their own SED fits with a Chabrier IMF.
- Verification (2026-09-24): verified. eq. 1 (0.712 and 3.117 below 10⁹, 0.276 and 7.042 above): mean log M_HI in 0.5 dex bins of log M★ for α.40 detections; Chabrier, h = 0.7.
- Second review (2026-09-24): verified. Eq. 1 was read again, and it is continuous at 10⁹ M☉. It gives ⟨log M_HI⟩ in 0.5 dex bins for detections in the α.40, SDSS and GALEX sample. The IMF is Chabrier with h = 0.7, so we add 0.034 dex to the mass and subtract 0.034 dex from the gas fraction.
- Check against our data: the median of (data − curve) inside the range is +0.068 dex (N = 15,805).

Excerpts from the source (status per excerpt):

```text
[found] H12/draft120629.tex: 0.712 \langle \log M_* \rangle + 3.117,~\log M_* \leq 9; \\
[found] H12/draft120629.tex: 0.276 \langle \log M_* \rangle + 7.042,~\log M_* > 9.
[found] H12/draft120629.tex: A \citet{Chabrier2003} IMF is adopted.
[found] H12/draft120629.tex: we adopt a reduced Hubble constant $h = H_0/(100~{\rm km~s^{-1}~Mpc^{-1}}) = 0.7$
```

## Sources used for the conventions

```text
[found] MD14/paper.tex: To rescale stellar masses from Chabrier or Kroupa to Salpeter IMF, we divide by constant factors 0.61 and 0.66, respectively.
[found] MD14/paper.tex: we divide by constant factors of 0.63 (Chabrier) or 0.67 (Kroupa).
[found] D08/update_concmass.tex: F & 0--2 & $5.71 \pm^{0.12}_{0.12}$ & $-0.084 \pm^{0.006}_{0.006}$ & $-0.47 \pm^{0.04}_{0.04}$
[found] D08/update_concmass.tex: F & 0--2 & $7.85 \pm^{0.17}_{0.18}$ & $-0.081 \pm^{0.006}_{0.006}$ & $-0.71 \pm^{0.04}_{0.04}$
[found] D08/update_concmass.tex: $M_{\rm pivot} = 2\times 10^{12}\,h^{-1}{\rm M}_{\odot}$
[found] BN98/paper.tex: \Delta_c = 18\pi^2 + 82x - 39x^2
[found] L17/local_group.tex: $r_{180}$ is the radius of the halo, within which the mean mass density is 180 times the mean density of the universe
[found] PP04/o3n2_08jan04.tex: A least squares linear fit to the data in the range $-1 < O3N2 < 1.9$ yields the relation:
[found] PP04/o3n2_08jan04.tex: 12 + \log {\rm (O/H)} = 8.73 - 0.32 \times O3N2
[found] K03a/masses0_mn.tex: We adopt the universal initial mass function (IMF) as parametrized by Kroupa (2001).
[found] HB09/hydebernardi.tex: a_{\rm ort} &=& 1.434 \quad {\rm and}\quad b_{\rm ort} = 0.315
```

## Choices and recommendations

- MZR axes. T04 is drawn on `OH` because MPA-JHU `OH_P50` uses the T04 method. AM13 and C20 are drawn on `OH_PP04`. Their O/H scales rest on electron temperature (direct) abundances, and PP04 O3N2 is an empirical calibration against H II regions with mostly direct abundances. On the T04 axis, AM13 would sit 0.10 dex (at 10^9) to 0.33 dex (at 10^11) below T04, and C20 0.14 to 0.33 dex below. That gap comes from the calibration, not from the galaxies. On `OH_PP04`, both lie within 0.03 dex of our data median (see the checks above). KE08 gives the MZR for PP04 O3N2 itself, so it is also drawn on `OH_PP04`.
- The MZR on the O3N2 scale has its own preset, `mzr2` (code `MZRᴾ`, x = `{logM:1}`, y = `{OH_PP04:1}`, color `logSFR`, literature `KE08, AM13, C20`), added by the core agent on this recommendation. The `mzr` preset lists `T04` only. KE08, AM13 and C20 carry view `mzr2`, the preset they belong to.
- FMR. M10 goes on `OH_PP04` (the FMR preset y) with fitOffset true. M10 used the Maiolino et al. (2008) calibrations, whose zero point and range differ from PP04 O3N2. The x conversion (IMF and fiber SFR) is applied to the curve. The fiber to total SFR offset comes from an M10-like sample cut on the raw Hα errors, which reproduces the size of the M10 sample.
- Presets. The literature lists in `site/js/config/presets.js` (read on 2026-09-24) name only ids that exist, and each relation's native axes match its preset's axes, so every listed relation is drawn at full opacity in its preset.
- FP. The verified B03 r band coefficients are a = 1.49 and b = −0.75 in log I, so b′ = −0.4 b = 0.30 in μ. The preset combo `{logSigV:1.49, mu50:0.30}` is correct as it is. Hyde & Bernardi (2009) find a = 1.434 and b = 0.315 for the r band orthogonal fit. In our standardized units the two x axes differ by 2.4 degrees (alignment 0.9991), so the two curves would draw almost on top of each other. We draw only B03.
- The sSFR = 10⁻¹¹ yr⁻¹ threshold of W12 has one entry per view, because each entry has its own native axes. The ids are `Q11` (sfms), `Q11s` (ssfr), `Q11e` (env) and `Q11d` (sigma). `Q11d` and `RP15s` are additions to the preset table.
- H I. C18 describes the representative xGASS sample with non-detections. H12 describes ALFALFA detections, which is how our H I data were selected. We suggest both for the `hi` preset.

## Known limits

- T04, KE08, S03 and K03 used the Kauffmann et al. (2003) masses from DR2 and DR4. In those masses a model mass to light ratio is multiplied by the Petrosian z band luminosity. Our MPA-JHU DR7 masses come from fits to the total magnitudes. The MPA-JHU comparison of the two methods gives a median offset of −0.01 dex, with larger offsets at low mass. For concentrated galaxies (C ≥ 2.86) the Petrosian magnitude misses 0.03 dex of the total light. We apply no correction for this.
- The Sérsic to Petrosian size factor for S03 comes from two median relations of slightly different samples (early types are c > 2.86 in one and n > 2.5 in the other). A de Vaucouleurs profile without seeing would put the early type curve about 0.1 dex lower, so the early type curve is uncertain by about that much.
- The r/z radius ratio used for S03 is the median over all angular sizes. For the Sérsic radii of S03, which are corrected for seeing, the ratio of large galaxies may apply instead. That would raise both S03 curves by about 0.02 dex (see the second review).
- M10 computed their fiber SFRs from Hα with the Kennicutt (1998) formula, and we use the MPA-JHU fiber SFRs in their place. SFRs rebuilt in the M10 way lie 0.03 to 0.09 dex lower, so the M10 curve may need to move a further 0.01 to 0.03 dex to lower μ0.32 (see the second review).
- The fiber SFR correction for M10 is one median value (0.509 dex). In bins of our μ0.32, the median of μ_tot − μ_M10 for the M10-like sample stays within 0.035 dex of the constant shift over μ0.32 = 9.5 to 11.1, so a constant is adequate there. M10's O/H calibration (Maiolino et al. 2008) also has a different dynamic range from PP04 O3N2, so after fitOffset only the zero point is matched and the shape is a guide.
- The SHMR conversions change only the halo mass definition. The halo mass function and cosmology behind each abundance matching also differ, by a few hundredths of a dex. Lim et al. (2017) halo masses come from abundance matching of group proxies, so part of the SHMR is built into the data.
- S14 at z = 0.1 extends their fit beyond the redshifts they fit (z ≈ 0.25 to 2.75).
- B13 relate the true stellar mass to halo mass. Their nuisance offset between measured and true masses, μ(z = 0.1) = −0.027 dex, is not applied, because our MPA-JHU masses are not on their calibration.
