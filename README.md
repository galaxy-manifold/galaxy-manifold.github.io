# Galaxy Manifold

Conceptualized by [John Wu](https://jwuphysics.github.io) and implemented by Claude Opus 5.5.

Galaxy Manifold is a website for exploring galaxy scaling relations. It shows 657,057 galaxies from the SDSS Main Galaxy Sample. Each galaxy is a point in a space of 20 measured properties, e.g., stellar mass. The screen shows a two-dimensional linear projection of that space.

You can rotate the projection by hand, let it rotate on its own, or jump to a known view such as the mass-metallicity relation. Each jump is an animated rotation through the full space, so you can watch one relation turn into another.

## What you can do

- Drag the spokes of the round compass at the lower left to rotate the view. Each spoke is one property.
- Press play on the compass to start a slow random rotation.
- Click a view at the top of the page to jump to it. There are 14 views, including the mass-metallicity relation (MZR), the fundamental metallicity relation (FMR), the star-forming main sequence, the mass-size relation, the edge-on fundamental plane, the BPT diagram, and the stellar-to-halo mass relation.
- Color the points by a third property or by a class. The classes are BPT class, central or satellite from the group catalog, and Galaxy Zoo morphology. The brightness of the plot shows how many galaxies are in each place, and the color shows their average value.
- Turn on the running medians. With a color property set, the page draws one median line for each quarter of that property.
- Turn on the literature relations. Each one appears only when the axes match its own axes.
- Draw a lasso around a group of galaxies. The group stays highlighted when you rotate or change views.
- Switch to mosaic mode. The plot is then covered with galaxy images, and each cell shows the most typical galaxy in that cell.
- Click a galaxy to see its image and where it falls in every property.
- Press the tighten button to search for the x axis that gives the least scatter in y. Starting from the MZR on the PP04 metallicity scale, it finds an x axis of about log M★ − 0.52 log SFR.

## Data

The sample is every SDSS DR7 Main Galaxy Sample galaxy in the MPA-JHU DR8 catalog with extinction-corrected Petrosian r of 17.77 or brighter and redshift 0.005 to 0.30. `pipeline/REPORT.md` lists how many galaxies each cut removes.

The properties come from these sources:

- MPA-JHU DR8 (Kauffmann et al. 2003, Brinchmann et al. 2004, Tremonti et al. 2004, Salim et al. 2007) for stellar mass, star formation rate, metallicity, emission lines, Dn4000 and HδA.
- SDSS DR17 through the SkyServer SQL service for Petrosian sizes, magnitudes and axis ratios.
- The Lim et al. (2017) SDSS group catalog for group halo mass, central or satellite, and k-corrected g−r color. This catalog covers only the northern part of the SDSS footprint.
- ALFALFA α.100 (Haynes et al. 2018) for H I gas fractions of detected galaxies.
- Galaxy Zoo 1 (Lintott et al. 2008, 2011) for morphology.
- The Legacy Survey viewer's SDSS layer for the galaxy images.

`DESIGN.md` section 6 lists all 20 properties and how each one is computed. The page stores two metallicity scales. One is the MPA-JHU value (T04). The other uses the O3N2 line ratio (Pettini and Pagel 2004). The two scales give opposite signs for the dependence of metallicity on star formation rate at fixed mass, so the FMR view uses the PP04 scale.

The 24 literature relations are in `site/data/literature.json`. Each coefficient was checked against the arXiv source of its paper and converted to this sample's conventions (Kroupa IMF, H0 = 70, Petrosian r-band radii). `pipeline/LITERATURE.md` lists each equation, its source, and the conversions.

## Run it locally

```
python3 -m http.server 8000 -d site
```

Then open http://localhost:8000. The page needs a web server because browsers block `fetch()` for files opened straight from disk.

## Rebuild the data

The pipeline reads local catalogs through the `catalog` and `data` links in the project root, which point into `../sdss-predict-everything`. It also reads the Lim et al. (2017) files from `/home/john/Dropbox/data/xSAGA/lim+2017/catalogs/`.

```
python3 pipeline/fetch_skyserver.py    # SkyServer queries, cached; rerun until it prints COMPLETE
python3 pipeline/build_catalog.py      # merge the catalogs and compute the properties
python3 pipeline/export_web.py all     # write site/data, check it, and write REPORT.md
python3 pipeline/thumbs.py all         # choose the 15,994 galaxies with images and make thumbnails
python3 pipeline/literature.py         # rebuild site/data/literature.json from cached sources
node --test site/tests/                # unit tests for the projection math and overlays
```

Every download is cached in `pipeline/cache/`, so a second run sends no requests.

## Deploy to GitHub Pages

The workflow in `.github/workflows/pages.yml` runs the unit tests and publishes `site/` on every push to `main`. In the repository settings, set the Pages source to "GitHub Actions". The generated data in `site/data` is committed, because the pipeline needs local catalogs that GitHub does not have. It is about 58 MB, and about 30 MB of that is thumbnails.

## Build the Artifact version

```
python3 tools/build_artifact.py
```

This writes `dist/artifact/` for publishing as a claude.ai Artifact. An Artifact can hold at most 255 files and 64 MB, and it serves only web file types. The build therefore makes these changes:

- It packs the 15,994 thumbnails into 63 image sheets.
- It stores the data columns as base64 text.
- It turns off the large Legacy Survey image in the galaxy panel, because the Artifact host blocks images from other sites. The panel shows the small thumbnail when the galaxy has one.
- It hides the share button, because Artifact links cannot carry the view state.

## Caveats

- The sample is flux limited, so faint galaxies are missing at high redshift. You can use the redshift filter to see this.
- The spectra come from 3 arcsec fibers. At different redshifts the fiber covers different parts of a galaxy, which affects metallicity, star formation rate and Dn4000.
- Petrosian R50 is smaller than the true half-light radius for concentrated galaxies.
- The H I fractions are for ALFALFA detections only. At fixed stellar mass, they are higher than for all galaxies.
- Lim et al. (2017) assign halo masses from a mass proxy of each group, so part of the stellar-to-halo mass relation comes from how the catalog was built.

## Plans

These are not built yet:

- Axes from a convolutional network's image features, reduced to a few dimensions with UMAP.
- An axis from The Sequencer (Baron and Ménard 2021) applied to the optical spectra.

The page reads its properties from `site/data/manifest.json`, so a new axis needs only a new data column and a manifest entry. The code handles up to 24 properties and has a group reserved for learned axes.

## Layout

```
DESIGN.md        the design and the data format that all the code follows
pipeline/        Python scripts that build site/data
site/            the website (plain JavaScript modules and WebGL2, no build step)
site/data/       the generated data
tools/           the synthetic test data generator and the Artifact build
```
