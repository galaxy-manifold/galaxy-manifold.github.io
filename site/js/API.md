# Galaxy Manifold — core API (as implemented)

For the UI agent (`js/ui/*`, `css/ui.css`) and the overlays agent (`js/view/overlays/*`,
`css/overlays.css`). The contract is DESIGN.md §10–§12; this file records what the code does,
including the few additions and deviations (logged in DESIGN.md §19).

## Boot order (`js/main.js`)

```
?data=<dir>  (default 'data'; 'data-synth' = dev data from tools/make_synth.py: 250k galaxies,
             4000 fake thumbnails, a small dev literature.json)
manifest → app = createApp({manifest, base}) → await initUI(app) → await initOverlays(app)
         → await app.load() → app.start()
```

- `initUI` / `initOverlays` run **before the columns load**. `app.data.dims`,
  `app.data.categories`, `app.config.*` and the store are usable then; column access
  (`value`, `column`, `raw`, `proj`, previews) waits for the **`data:ready`** event.
  `app.data.loaded` tells you which case you are in.
- Loading progress is emitted as `load:progress` `{fraction, loaded, files, done, phase}`.
  The core also animates the default splash in `#splash` and hides it after the first paint
  (adds class `done`, then `hidden`). Set `app.config.splash.auto = false` during `initUI`
  to take over; call `app.hideSplash()` yourself when ready.
- **First view.** If no view action ran before `app.load()`, the first paint shows a random
  tour-set frame and `app.start()` animates into MZR (2.6 s; ×0.3 under
  `prefers-reduced-motion`). Any view action called before `start()` (e.g. URL restore
  during `initUI` or in a `data:ready` handler) cancels the arrival. Actions called before the
  first paint apply instantly; camera fits requested before data load are deferred to the
  load; an explicit `camera.set()` before load wins over the deferred fit.
- WebGL2 missing, or manifest/columns failing, gives a full-screen card (`.core-fatal`).
  UI init errors are logged and do not stop the core.

## `app`

| member | notes |
|---|---|
| `data` | Dataset (below) |
| `store`, `events` | state (§12.2) and emitter (§12.3) |
| `renderer`, `camera`, `proj`, `thumbs`, `interaction` | see below |
| `config` | `{presets, allPresets, defaultPreset, dims: {table, get, colorRange, format, tourDefault}, style, splash: {auto}}` — `presets` only lists presets whose dims exist |
| `frame` | the current `Float64Array(2D)`, **mutated in place** every animation frame; copy it if you need a snapshot |
| `frameVersion` | increments on every frame change |
| `layers` | `{stage, gl, tiles, overlay, stageUI}` |
| `requestRender()` | rAF-coalesced GL redraw, followed by the `render` event |
| `isMoving()` | true while animating/touring/camera-animating, within 150 ms of the last change, or while `proj` is stale |
| `actions` | below |
| `pursuit.tighten(opts)` | stub returning false; the overlays agent replaces `app.pursuit` |
| `preview(idOrFrame, {width=112, height=72, dpr, background, canvas, color, filters})` | offscreen render of a preset (its color and category filter, current z filter) or of a frame. Returns a canvas at once and fills it asynchronously; `canvas.ready` is a Promise. ~3 ms CPU each, so stagger many (one per frame). `null` before `data:ready` |
| `presetFrame(id)` | frame for a preset (or `null`) |
| `presetAlignment(id)` | orientation-aware match of the current frame to a preset: `min(v̂x·px, v̂y·py)`, 1 = exact, negative if flipped. Use `< 0.99` to fade the active cartridge (§13.5) |
| `currentCombos()` | `{x, y}` current axes as physical combos (exact, orientation kept) — use to preserve one axis when setting the other |
| `axisInfo(col)` | `frame.axisInfo(app.frame, col, dims)` (labels/ticks, below) |
| `colorInfo()` | current color: `{mode:'none'}` · `{mode:'continuous', key, dim, cmap, reverse, range:[lo,hi] physical, lo, hi (u), spec}` · `{mode:'categorical', key, cat, slot, hex[8], colors[8], spec}` |
| `colorParams(key)`, `filterParams(filters?, color?)` | the renderer/projection descriptions for any color key / filters state: `{z, masks, need}` (`need` = dim index that must be present, from `needColor`; −1 = none). Cached while filters and (with `needColor`) the color are unchanged, so identity tells you when the effective filter changed |
| `dimWeights()` | `Float64Array(D)` of `w_d = √(px_d²+py_d²)` for the current frame |
| `timing`, `stats` | load timings (ms) and `{fps, drawMs, tickMs, tickMax}` |
| `motion` | `{reduced(), scale()}` (`scale()` = 0.3 under reduced motion) |
| `load()`, `start()`, `measure()`, `hideSplash()` | lifecycle helpers (see above; `measure` re-reads the stage size) |

### Actions (`app.actions`)

Durations are ms and are multiplied by `app.motion.scale()`. View actions return a Promise
resolving when the animation ends.

| action | behavior |
|---|---|
| `setFrame(F, {duration=0})` | geodesic animation (or jump) to frame F (re-orthonormalized). Stops the tour, clears `presetId` |
| `setAxes({x, y}, {duration=1100, fit=true})` | physical combos `{key: κ}`; a missing side keeps the current one (via `currentCombos`). x is built first, y Gram–Schmidt'ed against it. If the new axis is parallel to the kept one, the axes **swap** (e.g. dropping the current x dim on Y). Animates frame and camera together; clears `presetId` |
| `applyPreset(id, {duration=1100})` | sets `presetId`, the preset color, category filters (categories the preset does not mention reset to all; z filter kept), then `setAxes` with fit |
| `rotateDim(key, [ax, ay])` | manual-tour step (Cook & Buja), immediate; target clamped to a′²+b′² ≤ 0.995. When the dim is already in the plane, a rim target rotates in-plane and an inner target tilts toward the first tour-set dim not in view. Stops the tour |
| `setColor('logSFR' \| 'cat:bpt' \| null)` | returns false for unknown keys |
| `setMode('glow' \| 'mosaic')` | mosaic dims the glow to `render.mosaicDim` (0.35) |
| `setFilter({z: [lo,hi] \| null})`, `setFilter({cats: {bpt: mask}})`, `setFilter({needColor: bool})` | masks are bitmasks over codes 0..7 (bit c = code c shown; 0xFF = all). `needColor` hides galaxies without a value of the color variable (a continuous dim missing, or category code 0); it follows the color as it changes |
| `tour.play() / pause() / toggle() / setSet(keys) / setSpeed(v)` | constant 0.35 rad/s × speed along geodesics between uniform random tour-set planes (no in-plane spin). Speed ramps up/down (~0.2 s). Starting the tour eases the camera to an isotropic fit; each leg re-centers the camera on its target plane unless the user zoomed/panned during this tour. `setSet` needs ≥ 2 known keys |
| `fit({duration=600})` | robust (0.5–99.5 %) bounds of the visible prefix sample; anisotropic up to 2.2× |
| `resetView()` | clears the z filter and `needColor`, re-applies the current (or default) preset |
| `select(mask \| null)` | `Uint8Array(n)` nonzero = selected; empty masks clear. Emits `select` `{count}` |
| `inspect(index \| null)` | emits `inspect` `{index}` (also when unchanged) |
| `setTool('pan' \| name)` | any tool registered on `app.interaction` |
| `setOverlay(name, bool)` | `trends`, `literature`, `axes` (any name is stored) |
| `setRender({gain, pointSize, bloom, dim, mosaicDim})` | clamped: gain 0.05–20, pointSize 0.5–8 CSS px (≈ visible diameter), bloom 0–1 |
| `setMosaic({cell, scale: 'fit' \| 'true'})` | cell 16–256 CSS px |

## Store (`app.store`)

`get()`, `set(patch, {source})`, `subscribe(fn(state, changed, source, prev)) → unsubscribe`.
`set` deep-merges plain objects (arrays and typed arrays are replaced) and yields a new
top-level object; `changed` lists changed top-level keys. Initial state:

```js
{ presetId: null, color: null, mode: 'glow',
  overlays: { trends: true, literature: true, axes: true },
  filters: { z: null, cats: { bpt: 0xFF, env: 0xFF, morph: 0xFF }, needColor: false },
  tour: { playing: false, set: [...TOUR_DEFAULT present], speed: 1 },
  render: { gain: 1, pointSize: 2, bloom: 0.3 },        // + optional dim, mosaicDim
  tool: 'pan', selection: null /* {mask, count} */, inspected: null,
  mosaic: { cell: 56, scale: 'fit' } }
```

`presetId` is the last applied preset; it is cleared by `setAxes`/`setFrame` but kept while
touring or dragging spokes (fade the cartridge with `presetAlignment`).

## Events (`app.events.on(name, fn) → off`)

| event | payload / when |
|---|---|
| `load:progress` | `{fraction, loaded, files, done, phase}` while columns load (`phase` 'columns' then 'upload') |
| `data:ready` | after the first paint of the loaded data |
| `data:meta` | ra/dec/plate/mjd/fiber loaded (`data.meta.loaded`) |
| `frame` | `{animating}` on every frame change. `animating` is true during tours, animations and spoke drags; a final `{animating:false}` precedes `settle` |
| `camera` | every camera change (pan, zoom, animation step) |
| `settle` | motion stopped for 150 ms **and** `proj` refreshed for the current frame/filters |
| `state` | `{changed, state, source}` after every store change |
| `hover` | `{index, sx, sy}` (CSS px in the stage), throttled 40 ms, never while moving; `index −1` ends a hover |
| `inspect`, `select` | `{index}`, `{count}` |
| `resize` | `{width, height, dpr}`; core has resized all three stage canvases (clears them) |
| `render` | after each GL draw — **draw overlays here** to stay in sync with the glow |
| `thumb` | `k` — thumbnail k finished loading |
| `context` | `{lost}` WebGL context lost/restored; re-request previews on `{lost:false}` |

## Dataset (`app.data`)

`n`, `D`, `dims[i]` (DimSpec + `index`, `A`, `B`, `ua`, `ub`, `step`), `dimIndex(keyOrIndex)`
(−1 unknown), `dim(k)`, `raw[i]` / `raw.logM` (Uint16Array, 0 = missing), `value(i, k)`
(physical or NaN), `ustd(i, k)` (u or NaN), `column(k)` (Float32Array physical, lazy, NaN =
missing), `categories` (normalized CatSpecs: `{key, label, file, slot, codes:[{code, label,
name, color}]}`), `catSpec(key)`, `cats[key]` (Uint8Array, 0 = missing), `catCode(i, key)`,
`quantile(k, p)` / `percentile(k, x)` (from the 101 manifest quantiles; p in 0–100),
`meta` `{ra, dec, plate, mjd, fiber, loaded, ready: Promise}`, `metaRow(i)` (mjd offset
applied; null until loaded), `thumbs` (manifest block or null), `thumbRows` (Uint32Array),
`thumbCrop` (Float32Array, arcsec), `rowToThumb` (Int32Array(n), −1 = none), `hasThumbs`,
`manifest`, `base`, `loaded`, `failed` (URLs of columns that could not be loaded; those read
as all-missing).

## Frame math (`js/math/frame.js`, pure)

Frames are `Float64Array(2D)`, column-major `[px…, py…]`. `dims` = `app.data.dims`.

- `frameFromCombos(x, y, dims) → {F, degenerate}` · `comboVector(combo, dims) → {v, norm, offset}`
- `columnCombo(F, col, dims)` / `frameToCombos(F, dims)` — exact inverse (κ_ref = ±1)
- **Axes:** `info = axisInfo(F, col, dims)` → `{ref, refKey, kr, kappa, offset, terms, single}`;
  `axisLabel(info, dims)` → `"log M★ − 0.32 log SFR"` or `"log M★ [M☉]"`;
  `axisTicks(info, X0, X1, {count=6}) → [{X, A, text}]` (X in projected u, sorted by X;
  `text` uses a unicode minus); `axisValue(info, X) → A`, `axisPosition(info, A) → X`.
  Get `X0, X1` from `camera.viewBounds()` (x) or its y part for column 1.
- **Literature/native axes:** `nativeMap(xCombo, yCombo, F, dims)` →
  `{ax, ay, opacity, toFrame(Ax, Ay) → [X, Y], toNative}`; `opacity` =
  `smoothstep(0.90, 0.985, min(ax, ay))`; curves mirror and turn correctly as F moves.
  Also `alignment`, `signedAlignment`, `literatureOpacity`, `viewAlignment`.
- `manualRotate(F, j, [a, b], {prefer})`, `geodesic(Fa, Fb, {noSpin, prefer}) → {at(t, out), angles, spin, dist, target}`,
  `randomFrame(D, indices, rng)`, `dimWeights(F)`, `fadeFactors(F)`, `visibility(mask, fade)`,
  `orthonormalize`, `polarOrthonormalize`, `principalAngles`, `frameDistance`, `niceStep`, `fmtNum`.

`js/math/stats.js`: `quantiles`, `quantileSorted`, `sortedFinite`, `median`,
`robustScatter` (1.4826·MAD), `runningQuantiles(xs, ys, {bins, range, minCount=30, q, mask})`,
`hist2d`, `percentileFromQuantiles`, `valueFromQuantiles`, `meanStd`.
`js/math/cosmo.js`: `kpcPerArcsec(z)`, `comovingDistance`, `angularDiameterDistance`,
`luminosityDistance` (flat ΛCDM from the manifest cosmology, default 70/0.3).

## ProjectionCache (`app.proj`)

After each `settle`: `X`, `Y` (Float32Array n) and `vis` (Uint8Array n, 0–255 incl. filters;
0 = hidden) hold the current frame; `stale` is true while they do not; `version` counts
refreshes; `F` is the frame they belong to; `mode` is `'worker'` or `'sliced'`.

- `pick(sx, sy, rPx=10, {thumbsOnly=false, minVis=1}) → index | −1` (CSS px; −1 while stale)
- `sampleVisible(k, {minVis=1, inView=false}) → Int32Array` — uniform random visible subsample (row order is a fixed permutation)
- `projectRow(i, F=proj.F) → [X, Y]`
- `projectSample(rows, F, {filters, out}) → {X, Y, vis}` — **live** projection of any rows for any frame (vis 0..1 incl. fade + filters); use this during motion (e.g. trends ≤ 15k rows at ≤ 10 Hz)
- `projectPrefix(F, filters?) → {M, X, Y, V}` — rows 0..M−1 (M = min(n, 65536)), shared buffers, cached per frame+filters
- `estimateBounds(F, filters?, {qlo, qhi, minVis}) → [x0, x1, y0, y1]`, `estimateRef(...)`, `requestRef(...)` (exposure)

## Camera (`app.camera`)

`cx, cy` (u), `scale` (CSS px per u along **x**), `aspect` (y scale / x scale; fits may use up
to `maxAspect` = 2.2 so relations fill the stage), `scaleX`, `scaleY`, `width, height` (CSS px),
`dpr`, `safe` `{left:76, right:28, top:28, bottom:64}` (margins kept free when fitting; set
with `setSafeArea({...})`). Methods: `toScreen(X, Y) → [sx, sy]`, `toData(sx, sy)`,
`viewBounds()`, `fitBounds([x0,x1,y0,y1], {duration, pad=0.06, iso=false})`,
`set({cx, cy, scale, aspect}, {duration})`, `zoomAt(sx, sy, factor)`, `panBy(dx, dy)`,
`params()`, `snapshot()`, `animating`, `stop()`.
**Always map with `toScreen`/`toData`** (y has its own scale). Easing:
`cubicBezier(…)` and `easeView` are exported from `js/view/camera.js`.

## Interaction (`app.interaction`)

Wheel zooms about the cursor, the active tool handles drags (`'pan'` built in), a click runs
click handlers (highest priority first) and otherwise picks and calls `inspect` (empty space
→ `inspect(null)`), double-click fits, and a two-finger pinch zooms and pans. Only events whose target is a stage
canvas or `#stage` itself are handled; `#stage-ui` has `pointer-events: none` and its
children get `auto`, so UI mounted there keeps its events.

- `registerTool(name, {onDown, onMove, onUp, onCancel, cursor, dragCursor}) → unregister`.
  A tool selected via `actions.setTool(name)` before it is registered becomes active as soon
  as it registers (until then drags pan).
  Handlers get `{sx, sy, X, Y, dx, dy, startX, startY, event, app}`; `onDown` may return
  `false` to decline; `onUp` returning `true` suppresses the click.
- `addClickHandler(fn(ctx) → true to consume, priority=0) → off`; `ctx.pick(r)` picks.
- `hoverRadius` (10 px), `clearHover()`, `refreshHover()`.

## ThumbCache (`app.thumbs`)

`available`, `count`, `url(k)`, `get(k) → HTMLImageElement | null` (queues a load; ≤ 16 in
flight, newest first; emits `thumb`), `prefetch(ks)`, `cancelQueued()`, `forRow(i) → k | −1`,
`rowOf(k)`, `crop(k)` (arcsec), `isLoaded(k)`. Holds up to 3000 decoded images (LRU).
`manifest.thumbs` may be `null` (then `available` is false and `forRow` is −1).

## Renderer (`app.renderer`)

WebGL2 on `#gl`. `info` → `{float32, float16, maxPointSize, tier: 'RGBA32F'|'RGBA16F'|'RGBA8', lost}`;
`render(params)` (normally via `requestRender`), `renderPreview(frame, params, opts)` (use
`app.preview`). Accumulation targets are RGBA32F with `EXT_color_buffer_float` +
`EXT_float_blend`, else RGBA16F, else RGBA8. Categorical color uses three MRT attachments
(codes 0–3, codes 4–7, selected). The composite writes premultiplied color over the CSS stage
background (graph paper + vignette), with an optional quarter-resolution bloom.

## Page, layers and CSS hooks

- `index.html` provides `#app > #topbar, #rail, #stage (#gl, #tiles, #overlay, #stage-ui),
  #inspector, #console` and `#splash` (see §12.4). Stack in `#stage`: `#gl` 1, grain
  (`#stage::after`) 2, `#tiles` 3, `#overlay` 4, `#stage-ui` 6.
- Core sizes the backing stores of all three canvases to stage × DPR (DPR capped at 2) on
  `resize`; draw with `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)` and CSS-px coordinates.
- Inspector drawer: add class `open` (or `data-open="true"`) to `#inspector`; below 760 px it
  becomes a bottom sheet. Rail becomes a horizontal strip (`--rail-strip-h`).
- `#stage.gl-lost` while the WebGL context is lost; `#splash.done` when the splash fades.
- Tokens in `css/tokens.css` (`--bg`, `--cream`, `--orange`, group colors `--g-<group>`,
  category colors `--bpt-1…`, fonts `--font-display|ui|mono`, `--ease-view`, layout sizes).
  JS mirrors in `js/config/style.js` (`COLORS`, `GROUP_COLORS`, `groupColor`,
  `CATEGORY_COLORS`, `COLORMAPS`, `MOTION`, `FONTS`, `hexToRgb`).
- Colormaps for legends: `js/gl/colormaps.js` → `sampleColormap(name, t, reverse)`,
  `sampleColormapHex`, `colormapCSS(name, {reverse, direction, steps})` (OKLab
  interpolation, identical to the GPU LUT).
- Per-dim config (`js/config/dims.js`): `dimConfig(key)` → `{cmap, reverse, tour, decimals,
  range}`, `formatValue(key, x, {unit, spec})`, `colorRange(spec)`, `TOUR_DEFAULT`.
  Presets (`js/config/presets.js`): `PRESETS` (order: mzr, mzr2, fmr, sfms, ssfr, cmr, size,
  sigma, fp, bpt, shmr, env, hi, d4k — number keys 1–9, 0 map to the first ten),
  `presetById`, `codes(...)` (mask helper), `ALL_CODES`. A preset's `literature` ids match `literature.json`; relations also carry
  `view` = preset id (the more robust grouping key).

## Data notes worth knowing

- Galaxies missing a dim fade out as that dim rotates in (`w_d` → 0.12). The default tour
  set contains `OH` (§14), so most quiescent galaxies are hidden for much of the tour.
- MPA-JHU `OH_P50` (T04) values cluster on a comb (~0.02 dex), which shows as horizontal
  striping in stretched MZR views; it is in the data, not the renderer.
