// Tiny synchronous event emitter. on() returns an unsubscribe function; a failing handler is
// logged and does not stop the others.

export class Emitter {
  constructor() {
    this._h = new Map();
  }

  on(name, fn) {
    let set = this._h.get(name);
    if (!set) this._h.set(name, (set = new Set()));
    set.add(fn);
    return () => this.off(name, fn);
  }

  once(name, fn) {
    const off = this.on(name, (p) => {
      off();
      fn(p);
    });
    return off;
  }

  off(name, fn) {
    const set = this._h.get(name);
    if (set) set.delete(fn);
  }

  emit(name, payload) {
    const set = this._h.get(name);
    if (!set || !set.size) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`handler for '${name}' failed`, err);
      }
    }
  }
}
