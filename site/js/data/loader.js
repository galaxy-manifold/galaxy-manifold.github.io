// Data loading (DESIGN.md §5) and the Dataset API (§12.1).
//
//   const manifest = await loadManifest(base);
//   const data = new Dataset(manifest, base);          // dims / categories usable at once
//   await loadColumns(data, { onProgress });           // dims + cats + thumbs index/crop
//   loadMeta(data).then(...)                            // ra/dec/plate/mjd/fiber, after paint
//
// Every binary file is fetched as bytes; if it starts with the gzip magic 0x1f 0x8b it is
// inflated with DecompressionStream('gzip'), otherwise it is used as is (a server may have
// applied Content-Encoding already). Dimension columns are byte-shuffled uint16 (§5.3).

import { percentileFromQuantiles, valueFromQuantiles } from '../math/stats.js';

const CAT_SLOTS = 4;   // a_cats is a uvec4 (bpt, env, morph, spare)

/** Sanitise a ?data= value to a relative path inside the site (default 'data'). */
export function resolveBase(param) {
  const s = (param || '').trim();
  if (!s || s.includes('..') || s.includes('//') || s.includes(':') || s.startsWith('/') || s.includes('\\')
      || !/^[\w\-./]+$/.test(s)) return 'data';
  return s.replace(/\/+$/, '');
}

function joinUrl(base, file) {
  return `${base}/${String(file).replace(/^\/+/, '')}`;
}

export class LoadError extends Error {
  constructor(message, { url, cause } = {}) {
    super(message);
    this.name = 'LoadError';
    this.url = url;
    if (cause) this.cause = cause;
  }
}

export async function loadManifest(base, { signal } = {}) {
  const url = joinUrl(base, 'manifest.json');
  let res;
  try {
    res = await fetch(url, { signal, cache: 'no-cache' });
  } catch (e) {
    throw new LoadError(`network error fetching ${url}`, { url, cause: e });
  }
  if (!res.ok) throw new LoadError(`HTTP ${res.status} for ${url}`, { url });
  const m = await res.json();
  if (!m || !Array.isArray(m.dims) || !(m.n > 0)) throw new LoadError(`malformed manifest ${url}`, { url });
  if (m.dims.length > 24) console.warn(`manifest has ${m.dims.length} dims; only the first 24 are used`);
  return m;
}

/**
 * Fetch a URL as bytes, reporting (loaded, total) as the body streams in. A file named
 * *.b64.txt holds base64 text of the bytes (the Artifact build uses it: Artifacts serve no
 * generic binary types) and is decoded here, so callers always get the original bytes.
 */
export async function fetchBytes(url, opts = {}) {
  const bytes = await fetchRaw(url, opts);
  return /\.b64\.txt(?:$|[?#])/.test(url) ? fromBase64(bytes) : bytes;
}

function fromBase64(textBytes) {
  const text = new TextDecoder().decode(textBytes).replace(/\s+/g, '');
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(text);
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function fetchRaw(url, { onBytes, signal } = {}) {
  let res;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    throw new LoadError(`network error fetching ${url}`, { url, cause: e });
  }
  if (!res.ok) throw new LoadError(`HTTP ${res.status} for ${url}`, { url });
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !res.body.getReader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onBytes?.(buf.length, total || buf.length);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onBytes?.(loaded, total);
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(loaded);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export function isGzip(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** Inflate if the bytes carry the gzip magic; otherwise return them unchanged. */
export async function gunzipIfNeeded(bytes, url = '') {
  if (!isGzip(bytes)) return bytes;
  if (typeof DecompressionStream === 'undefined') {
    throw new LoadError('this browser cannot decompress gzip data (DecompressionStream missing)', { url });
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Undo the §5.3 byte shuffle: v[i] = s[i] | (s[n + i] << 8). */
export function unshuffleU16(s, n) {
  if (s.length !== 2 * n) throw new LoadError(`dimension column has ${s.length} bytes, expected ${2 * n}`);
  const v = new Uint16Array(n);
  for (let i = 0; i < n; i++) v[i] = s[i] | (s[n + i] << 8);
  return v;
}

function typed(bytes, Ctor, n, url) {
  const bpe = Ctor.BYTES_PER_ELEMENT;
  if (n != null && bytes.length !== n * bpe) {
    throw new LoadError(`${url}: ${bytes.length} bytes, expected ${n * bpe}`, { url });
  }
  if (bytes.byteOffset % bpe === 0) return new Ctor(bytes.buffer, bytes.byteOffset, bytes.length / bpe);
  return new Ctor(bytes.slice().buffer);
}

/** Normalise a manifest CatSpec: codes → [{code, label, name, color}] sorted by code. */
export function normalizeCatSpec(spec, index) {
  let codes = [];
  const c = spec.codes;
  if (Array.isArray(c)) {
    codes = c.map((e, i) => (typeof e === 'string'
      ? { code: i + 1, label: e }
      : { code: +(e.code ?? i + 1), label: e.label ?? e.name ?? String(e.code), name: e.name, color: e.color }));
  } else if (c && typeof c === 'object') {
    codes = Object.entries(c).map(([k, e]) => (typeof e === 'string'
      ? { code: +k, label: e }
      : { code: +k, label: e.label ?? e.name ?? k, name: e.name, color: e.color }));
  }
  codes = codes.filter((e) => e.code >= 1 && e.code <= 7).sort((a, b) => a.code - b.code);
  for (const e of codes) e.name = e.name || e.label;
  return {
    ...spec,
    index,
    slot: index < CAT_SLOTS ? index : -1,
    file: spec.file || `cats/${spec.key}.u8.gz`,
    codes,
  };
}

/**
 * Dataset: manifest-derived metadata is available immediately; columns are filled by
 * loadColumns() and meta by loadMeta().
 */
export class Dataset {
  constructor(manifest, base = 'data') {
    this.manifest = manifest;
    this.base = base;
    this.n = manifest.n;
    this.dims = manifest.dims.slice(0, 24).map((d, index) => {
      const step = (d.max - d.min) / 65534;
      return {
        ...d,
        index,
        // integer decode: u = v * ua + ub  (v = raw uint16, 1..65535)
        ua: step / d.scale,
        ub: (d.min - step - d.center) / d.scale,
        // shader decode on normalised val = v/65535 (§11)
        A: (65535 * (d.max - d.min)) / (65534 * d.scale),
        B: (d.min - (d.max - d.min) / 65534 - d.center) / d.scale,
        step,
      };
    });
    this.D = this.dims.length;
    this._dimIndex = new Map(this.dims.map((d) => [d.key, d.index]));
    this.categories = (manifest.categories || []).map((c, i) => normalizeCatSpec(c, i));
    this._catSpec = new Map(this.categories.map((c) => [c.key, c]));
    this.raw = new Array(this.D).fill(null);
    for (const d of this.dims) {
      Object.defineProperty(this.raw, d.key, { get: () => this.raw[d.index], enumerable: false });
    }
    this.cats = {};
    this.thumbs = manifest.thumbs || null;
    this.thumbRows = new Uint32Array(0);
    this.thumbCrop = new Float32Array(0);
    this.rowToThumb = null;
    this.loaded = false;
    this._columns = new Map();
    let resolveMeta;
    const ready = new Promise((r) => { resolveMeta = r; });
    this.meta = { ra: null, dec: null, plate: null, mjd: null, fiber: null, loaded: false, ready };
    this._resolveMeta = resolveMeta;
  }

  /** Index of a dim by key (or pass-through for a valid index); −1 if unknown. */
  dimIndex(k) {
    if (typeof k === 'number') return k >= 0 && k < this.D ? k : -1;
    const i = this._dimIndex.get(k);
    return i === undefined ? -1 : i;
  }

  dim(k) {
    const i = this.dimIndex(k);
    return i < 0 ? null : this.dims[i];
  }

  /** Physical value of dim k for row i, or NaN if missing. */
  value(i, k) {
    const d = this.dims[this.dimIndex(k)];
    const col = d && this.raw[d.index];
    if (!col) return NaN;
    const v = col[i];
    return v === 0 ? NaN : d.min + (v - 1) * d.step;
  }

  /** Standardised value u = (x − center)/scale, or NaN if missing. */
  ustd(i, k) {
    const d = this.dims[this.dimIndex(k)];
    const col = d && this.raw[d.index];
    if (!col) return NaN;
    const v = col[i];
    return v === 0 ? NaN : v * d.ua + d.ub;
  }

  /** Whole column in physical units (Float32Array, NaN = missing), computed lazily. */
  column(k) {
    const d = this.dims[this.dimIndex(k)];
    if (!d || !this.raw[d.index]) return null;
    let c = this._columns.get(d.index);
    if (!c) {
      const raw = this.raw[d.index];
      c = new Float32Array(this.n);
      const { min, step } = d;
      for (let i = 0; i < this.n; i++) {
        const v = raw[i];
        c[i] = v === 0 ? NaN : min + (v - 1) * step;
      }
      this._columns.set(d.index, c);
    }
    return c;
  }

  catSpec(key) {
    return this._catSpec.get(key) || null;
  }

  catCode(i, key) {
    const c = this.cats[key];
    return c ? c[i] : 0;
  }

  /** Physical value at percentile p (0–100) from the manifest quantiles. */
  quantile(k, p) {
    const d = this.dim(k);
    return d ? valueFromQuantiles(d.quantiles, p) : NaN;
  }

  /** Percentile (0–100) of physical value x among valid values of dim k. */
  percentile(k, x) {
    const d = this.dim(k);
    return d ? percentileFromQuantiles(d.quantiles, x) : NaN;
  }

  /** Meta for one row once loaded: {ra, dec, plate, mjd, fiber} (mjd with its offset). */
  metaRow(i) {
    const m = this.meta;
    if (!m.loaded) return null;
    const off = this.manifest.meta?.mjd?.offset ?? 0;
    return {
      ra: m.ra ? m.ra[i] : NaN,
      dec: m.dec ? m.dec[i] : NaN,
      plate: m.plate ? m.plate[i] : 0,
      mjd: m.mjd ? m.mjd[i] + off : 0,
      fiber: m.fiber ? m.fiber[i] : 0,
    };
  }

  get hasThumbs() {
    return this.thumbRows.length > 0;
  }
}

/** Run async tasks with limited concurrency. */
async function pool(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

/**
 * Fetch dims, categories and the thumbnail index/crop in parallel.
 * onProgress({fraction, loaded, total, files, done}) is called as bytes arrive.
 */
export async function loadColumns(data, { onProgress, signal, concurrency = 6 } = {}) {
  const { n, base } = data;
  const jobs = [];
  for (const d of data.dims) {
    jobs.push({ url: joinUrl(base, d.file), weight: 2, kind: 'dim', d });
  }
  for (const c of data.categories) {
    jobs.push({ url: joinUrl(base, c.file), weight: 0.6, kind: 'cat', c });
  }
  const th = data.thumbs;
  if (th && th.count > 0 && th.index) {
    jobs.push({ url: joinUrl(base, th.index), weight: 0.2, kind: 'thumbIndex' });
    if (th.crop) jobs.push({ url: joinUrl(base, th.crop), weight: 0.2, kind: 'thumbCrop' });
  }
  const frac = new Float64Array(jobs.length);
  const wsum = jobs.reduce((s, j) => s + j.weight, 0);
  let bytes = 0, done = 0;
  const report = () => {
    let f = 0;
    for (let i = 0; i < jobs.length; i++) f += jobs[i].weight * frac[i];
    onProgress?.({ fraction: f / wsum, loaded: bytes, files: jobs.length, done });
  };
  report();
  data.failed = [];
  const tasks = jobs.map((job, ji) => async () => {
    let last = 0;
    try {
      const raw = await fetchBytes(job.url, {
        signal,
        onBytes: (loaded, total) => {
          bytes += loaded - last;
          last = loaded;
          // unknown length: creep toward 0.9 until the body completes
          frac[ji] = total > 0 ? Math.min(0.95, loaded / total) : Math.min(0.9, frac[ji] + 0.05);
          report();
        },
      });
      const b = await gunzipIfNeeded(raw, job.url);
      if (job.kind === 'dim') {
        data.raw[job.d.index] = unshuffleU16(b, n);
      } else if (job.kind === 'cat') {
        data.cats[job.c.key] = typed(b, Uint8Array, n, job.url);
      } else if (job.kind === 'thumbIndex') {
        data.thumbRows = typed(b, Uint32Array, th.count, job.url);
      } else if (job.kind === 'thumbCrop') {
        data.thumbCrop = typed(b, Float32Array, th.count, job.url);
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      // degrade gracefully: a broken column reads as all-missing
      console.warn(`column unavailable (${job.url}):`, e.message || e);
      data.failed.push(job.url);
      if (job.kind === 'dim') data.raw[job.d.index] = new Uint16Array(n);
    }
    frac[ji] = 1;
    done++;
    report();
  });
  await pool(tasks, concurrency);
  const badDims = data.dims.filter((d) => data.failed.includes(joinUrl(base, d.file))).length;
  if (badDims > data.D / 2) throw new LoadError(`${badDims} of ${data.D} dimension columns failed to load`, { url: base });
  // categories that failed (or were never listed) still get an all-missing column
  for (const c of data.categories) if (!data.cats[c.key]) data.cats[c.key] = new Uint8Array(n);
  const rt = new Int32Array(n).fill(-1);
  for (let k = 0; k < data.thumbRows.length; k++) {
    const r = data.thumbRows[k];
    if (r < n) rt[r] = k;
  }
  data.rowToThumb = rt;
  if (data.thumbCrop.length !== data.thumbRows.length) {
    data.thumbCrop = new Float32Array(data.thumbRows.length).fill(NaN);
  }
  data.loaded = true;
  return data;
}

/** Fetch the meta columns (ra, dec, plate, mjd, fiber); resolves to data.meta. */
export async function loadMeta(data, { signal, concurrency = 3 } = {}) {
  const spec = data.manifest.meta || {};
  const ctor = { f32: Float32Array, u16: Uint16Array, u32: Uint32Array, i32: Int32Array, u8: Uint8Array, f64: Float64Array };
  const keys = Object.keys(spec).filter((k) => spec[k] && spec[k].file);
  await pool(keys.map((k) => async () => {
    const url = joinUrl(data.base, spec[k].file);
    try {
      const b = await gunzipIfNeeded(await fetchBytes(url, { signal }), url);
      data.meta[k] = typed(b, ctor[spec[k].dtype] || Float32Array, data.n, url);
    } catch (e) {
      console.warn(`meta column ${k} unavailable:`, e.message || e);
    }
  }), concurrency);
  data.meta.loaded = true;
  data._resolveMeta(data.meta);
  return data.meta;
}
