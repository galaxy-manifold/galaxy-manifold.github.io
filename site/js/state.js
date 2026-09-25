// Store (§12.2): get(), set(patch, {source}), subscribe(fn).
// set() deep-merges plain objects (arrays, typed arrays and class instances are replaced) and
// produces a new state object, so subscribers may compare old and new references.
// Subscribers receive (state, changed, source, prev) where `changed` lists top-level keys.

function isPlain(v) {
  return v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
}

function merge(base, patch) {
  if (!isPlain(base) || !isPlain(patch)) return patch;
  const out = { ...base };
  for (const k of Object.keys(patch)) out[k] = merge(base[k], patch[k]);
  return out;
}

function same(a, b) {
  if (a === b) return true;
  if (isPlain(a) && isPlain(b)) {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => same(a[k], b[k]));
  }
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
  return false;
}

export class Store {
  constructor(initial = {}) {
    this._s = initial;
    this._subs = new Set();
  }

  get() {
    return this._s;
  }

  set(patch, { source = 'app' } = {}) {
    const prev = this._s;
    const next = { ...prev };
    const changed = [];
    for (const k of Object.keys(patch || {})) {
      const v = merge(prev[k], patch[k]);
      if (!same(prev[k], v)) {
        next[k] = v;
        changed.push(k);
      }
    }
    if (!changed.length) return changed;
    this._s = next;
    for (const fn of [...this._subs]) {
      try {
        fn(next, changed, source, prev);
      } catch (err) {
        console.error('store subscriber failed', err);
      }
    }
    return changed;
  }

  subscribe(fn) {
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }
}
