// ThumbCache (§12.1): lazily loads the 64×64 thumbnail JPEGs of the representative subset.
//   url(k)    → URL of thumbnail k
//   get(k)    → HTMLImageElement once loaded, else null (starts loading; emits 'thumb' (k))
//   forRow(i) → thumbnail index of row i, or −1
//   assign(img, k) → point an <img> at thumbnail k now, or as soon as it is ready
// At most `maxInFlight` (16) requests run at once; the most recently requested thumbnails are
// fetched first (LIFO), and at most `capacity` decoded images are kept (LRU).
//
// Atlas mode (manifest.thumbs.atlas, used by the Artifact build, which may ship at most 255
// files): thumbnails come packed 16 × 16 per JPEG sheet. A requested thumbnail's sheet is
// loaded once, the tile is cut out into its own blob URL, and from then on it behaves exactly
// like an individually loaded file.

export class ThumbCache {
  constructor(data, emit, { maxInFlight = 16, capacity = 3000 } = {}) {
    this.data = data;
    this.emit = emit || (() => {});
    this.maxInFlight = maxInFlight;
    this.capacity = capacity;
    this.spec = data.thumbs;
    this._entries = new Map();   // k → {img, state: 'queued'|'loading'|'loaded'|'error'}
    this._queue = [];
    this._inFlight = 0;
    this.atlas = this.spec && this.spec.atlas ? this.spec.atlas : null;
    this._sheets = new Map();    // atlas index → {img, state, waiting: Set(k)} (LRU, small)
    this._sheetCapacity = 12;
    this._waiters = new Map();   // k → Set(<img>) awaiting assign()
  }

  get count() {
    return this.data.thumbRows.length;
  }

  get available() {
    return !!this.spec && this.count > 0;
  }

  url(k) {
    const s = this.spec;
    if (!s) return '';
    if (this.atlas) {
      const e = this._entries.get(k);
      return e && e.state === 'loaded' ? e.img.src : '';
    }
    const shard = Math.floor(k / (s.shard || 1000));
    const rel = (s.url || 'thumbs/{shard}/{k}.jpg').replace('{shard}', shard).replace('{k}', k);
    return `${this.data.base}/${rel}`;
  }

  forRow(i) {
    const rt = this.data.rowToThumb;
    return rt && i >= 0 && i < rt.length ? rt[i] : -1;
  }

  rowOf(k) {
    return k >= 0 && k < this.count ? this.data.thumbRows[k] : -1;
  }

  /** Crop side in arcsec of thumbnail k (NaN if unknown). */
  crop(k) {
    return k >= 0 && k < this.data.thumbCrop.length ? this.data.thumbCrop[k] : NaN;
  }

  /**
   * Show thumbnail k in an <img>. Individual files: sets src directly. Atlas mode: sets it now
   * if the tile is cut out already, otherwise once it is (a later assign() of the same <img>
   * to another k wins).
   */
  assign(img, k) {
    img.dataset.thumbK = String(k);
    if (!this.atlas) {
      img.src = this.url(k);
      return;
    }
    const u = this.url(k);
    if (u) {
      img.src = u;
      return;
    }
    img.removeAttribute('src');
    let set = this._waiters.get(k);
    if (!set) this._waiters.set(k, (set = new Set()));
    set.add(img);
    this.get(k);
  }

  isLoaded(k) {
    const e = this._entries.get(k);
    return !!e && e.state === 'loaded';
  }

  /** Image if loaded (refreshing its LRU position), else null after queueing a load. */
  get(k) {
    if (!(k >= 0 && k < this.count)) return null;
    const e = this._entries.get(k);
    if (e) {
      if (e.state === 'loaded') {
        this._entries.delete(k);
        this._entries.set(k, e);
        return e.img;
      }
      if (e.state === 'queued') this._queue.push(k);   // bump priority
      return null;
    }
    this._entries.set(k, { img: null, state: 'queued' });
    this._queue.push(k);
    this._pump();
    return null;
  }

  /** Queue several thumbnails (first = highest priority). */
  prefetch(list) {
    for (let j = list.length - 1; j >= 0; j--) this.get(list[j]);
  }

  /** Drop queued-but-not-started requests (e.g. when the view changed completely). */
  cancelQueued() {
    for (const k of this._queue) {
      const e = this._entries.get(k);
      if (e && e.state === 'queued') this._entries.delete(k);
    }
    this._queue.length = 0;
  }

  _pump() {
    while (this._inFlight < this.maxInFlight && this._queue.length) {
      const k = this._queue.pop();
      const e = this._entries.get(k);
      if (!e || e.state !== 'queued') continue;
      e.state = 'loading';
      if (this.atlas) {
        this._fromSheet(k, e);
        continue;
      }
      this._inFlight++;
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        e.img = img;
        e.state = 'loaded';
        this._inFlight--;
        this._evict();
        this._resolveWaiters(k);
        this.emit('thumb', k);
        this._pump();
      };
      img.onerror = () => {
        e.state = 'error';
        this._inFlight--;
        this._pump();
      };
      img.src = this.url(k);
    }
  }

  _evict() {
    if (this._entries.size <= this.capacity) return;
    for (const [k, e] of this._entries) {
      if (this._entries.size <= this.capacity) break;
      if (e.state === 'loaded' || e.state === 'error') {
        if (this.atlas && e.img && e.img.src.startsWith('blob:')) URL.revokeObjectURL(e.img.src);
        this._entries.delete(k);
      }
    }
  }

  _resolveWaiters(k) {
    const set = this._waiters.get(k);
    if (!set) return;
    this._waiters.delete(k);
    const e = this._entries.get(k);
    if (!e || e.state !== 'loaded') return;
    for (const img of set) if (img.dataset.thumbK === String(k)) img.src = e.img.src;
  }

  // ------------------------------------------------------------------ atlas mode

  _sheetUrl(a) {
    const rel = (this.atlas.url || 'thumbs/atlas/{a}.jpg').replace('{a}', a);
    return `${this.data.base}/${rel}`;
  }

  /** Cut thumbnail k out of its sheet (loading the sheet first if needed). */
  _fromSheet(k, e) {
    const per = this.atlas.per || 256;
    const a = Math.floor(k / per);
    let sh = this._sheets.get(a);
    if (!sh) {
      sh = { img: null, state: 'loading', waiting: new Set() };
      this._sheets.set(a, sh);
      this._inFlight++;
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        sh.img = img;
        sh.state = 'loaded';
        this._inFlight--;
        for (const kk of sh.waiting) this._cut(kk, sh.img);
        sh.waiting.clear();
        this._evictSheets();
        this._pump();
      };
      img.onerror = () => {
        sh.state = 'error';
        this._inFlight--;
        for (const kk of sh.waiting) {
          const ee = this._entries.get(kk);
          if (ee) ee.state = 'error';
        }
        sh.waiting.clear();
        this._sheets.delete(a);   // allow a later retry
        this._pump();
      };
      img.src = this._sheetUrl(a);
    } else {
      this._sheets.delete(a);    // LRU bump
      this._sheets.set(a, sh);
    }
    if (sh.state === 'loaded') this._cut(k, sh.img);
    else sh.waiting.add(k);
    void e;
  }

  _cut(k, sheet) {
    const e = this._entries.get(k);
    if (!e || e.state !== 'loading') return;
    const { per = 256, cols = 16, tile = 64 } = this.atlas;
    const p = k % per;
    const c = document.createElement('canvas');
    c.width = tile;
    c.height = tile;
    c.getContext('2d').drawImage(sheet, (p % cols) * tile, Math.floor(p / cols) * tile, tile, tile, 0, 0, tile, tile);
    c.toBlob((blob) => {
      if (!blob) {
        e.state = 'error';
        return;
      }
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        e.img = img;
        e.state = 'loaded';
        this._evict();
        this._resolveWaiters(k);
        this.emit('thumb', k);
      };
      img.onerror = () => { e.state = 'error'; };
      img.src = URL.createObjectURL(blob);
    }, 'image/jpeg', 0.92);
  }

  _evictSheets() {
    while (this._sheets.size > this._sheetCapacity) {
      const [a, sh] = this._sheets.entries().next().value;
      if (sh.state === 'loading') break;
      this._sheets.delete(a);
    }
  }
}
