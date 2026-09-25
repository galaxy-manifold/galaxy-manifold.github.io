// Pointer handling on #stage (§12.1 Interaction).
//   wheel → zoom around the cursor · drag → active tool ('pan' built in) · click → click
//   handlers by priority, else pick → actions.inspect · double-click → fit · two-finger
//   pinch → zoom + pan · hover → throttled 'hover' events, never while the view is moving.
// Only events whose target is a stage canvas (or the stage itself) are handled, so UI mounted
// in #stage-ui keeps its own pointer events.
//
//   registerTool(name, {onDown, onMove, onUp, onCancel, cursor}) → unregister()
//     handlers get ctx {sx, sy, X, Y, dx, dy, startX, startY, event, app}; onDown may return
//     false to decline the gesture.
//   addClickHandler(fn, priority = 0) → off();  fn(ctx) returns true to consume the click.

const CLICK_SLOP = 4;        // px
const CLICK_MS = 600;
const HOVER_MS = 40;
const WHEEL_K = 0.0016;

export class Interaction {
  constructor(app, element) {
    this.app = app;
    this.el = element;
    this.tools = new Map();
    this.clickHandlers = [];
    this.tool = 'pan';
    this.requested = 'pan';
    this._pointers = new Map();
    this._down = null;
    this._pinch = null;
    this._hoverTimer = 0;
    this._hoverLast = { index: -1, sx: 0, sy: 0 };
    this._lastHoverPos = null;
    this.hoverRadius = 10;
    this.registerTool('pan', {
      cursor: 'grab',
      dragCursor: 'grabbing',
      onMove: (c) => this.app.camera.panBy(c.dx, c.dy),
    });
    this._bind();
    this._updateCursor();
  }

  registerTool(name, spec) {
    this.tools.set(name, spec);
    // a tool requested before it was registered (e.g. restored from the URL) activates now
    if (name === this.requested && this.tool !== name && !this._down) this.tool = name;
    if (name === this.tool) this._updateCursor();
    return () => {
      if (this.tools.get(name) !== spec) return;
      this.tools.delete(name);
      if (this.tool === name) {
        this.tool = 'pan';
        this._updateCursor();
      }
    };
  }

  addClickHandler(fn, priority = 0) {
    const h = { fn, priority };
    this.clickHandlers.push(h);
    this.clickHandlers.sort((a, b) => b.priority - a.priority);
    return () => {
      const i = this.clickHandlers.indexOf(h);
      if (i >= 0) this.clickHandlers.splice(i, 1);
    };
  }

  setTool(name) {
    if (this._down) this._cancelDrag();
    this.requested = name;
    this.tool = this.tools.has(name) ? name : 'pan';
    this._updateCursor();
  }

  _updateCursor(dragging = false) {
    const t = this.tools.get(this.tool) || this.tools.get('pan');
    this.el.style.cursor = (dragging && t.dragCursor) || t.cursor || 'default';
  }

  _isStageTarget(e) {
    const t = e.target;
    return t === this.el || (t && t.tagName === 'CANVAS' && t.parentElement === this.el);
  }

  _pos(e) {
    const r = this.el.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  _ctx(e, sx, sy, extra = {}) {
    const [X, Y] = this.app.camera.toData(sx, sy);
    return { sx, sy, X, Y, event: e, app: this.app, ...extra };
  }

  _bind() {
    const el = this.el;
    this._h = {
      down: (e) => this._onDown(e),
      move: (e) => this._onMove(e),
      up: (e) => this._onUp(e),
      cancel: (e) => this._onCancel(e),
      leave: () => {
        this._lastHoverPos = null;
        this.clearHover();
      },
      wheel: (e) => this._onWheel(e),
      dbl: (e) => {
        if (!this._isStageTarget(e)) return;
        e.preventDefault();
        this.app.actions.fit();
      },
    };
    el.addEventListener('pointerdown', this._h.down);
    el.addEventListener('pointermove', this._h.move);
    el.addEventListener('pointerup', this._h.up);
    el.addEventListener('pointercancel', this._h.cancel);
    el.addEventListener('pointerleave', this._h.leave);
    el.addEventListener('wheel', this._h.wheel, { passive: false });
    el.addEventListener('dblclick', this._h.dbl);
  }

  destroy() {
    const el = this.el;
    el.removeEventListener('pointerdown', this._h.down);
    el.removeEventListener('pointermove', this._h.move);
    el.removeEventListener('pointerup', this._h.up);
    el.removeEventListener('pointercancel', this._h.cancel);
    el.removeEventListener('pointerleave', this._h.leave);
    el.removeEventListener('wheel', this._h.wheel);
    el.removeEventListener('dblclick', this._h.dbl);
    clearTimeout(this._hoverTimer);
  }

  _onDown(e) {
    if (!this._isStageTarget(e)) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const [sx, sy] = this._pos(e);
    this._pointers.set(e.pointerId, { sx, sy });
    try { this.el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    this.clearHover();
    if (this._pointers.size === 2) {
      // second finger: switch to pinch, abandoning any tool gesture
      if (this._down) this._cancelDrag();
      const [a, b] = [...this._pointers.values()];
      this._pinch = { d: Math.hypot(a.sx - b.sx, a.sy - b.sy) || 1, mx: (a.sx + b.sx) / 2, my: (a.sy + b.sy) / 2 };
      return;
    }
    if (this._pointers.size > 2) return;
    const tool = this.tools.get(this.tool) || this.tools.get('pan');
    const ctx = this._ctx(e, sx, sy, { dx: 0, dy: 0, startX: sx, startY: sy });
    let accepted = true;
    if (tool.onDown) accepted = tool.onDown(ctx) !== false;
    this._down = { id: e.pointerId, sx, sy, lx: sx, ly: sy, t: performance.now(), moved: false, tool, accepted };
    e.preventDefault();
  }

  _onMove(e) {
    const p = this._pointers.get(e.pointerId);
    const [sx, sy] = this._pos(e);
    if (p) {
      p.sx = sx;
      p.sy = sy;
    }
    if (this._pinch && this._pointers.size >= 2) {
      const [a, b] = [...this._pointers.values()];
      const d = Math.hypot(a.sx - b.sx, a.sy - b.sy) || 1;
      const mx = (a.sx + b.sx) / 2, my = (a.sy + b.sy) / 2;
      const cam = this.app.camera;
      cam.panBy(mx - this._pinch.mx, my - this._pinch.my);
      cam.zoomAt(mx, my, d / this._pinch.d);
      this._pinch = { d, mx, my };
      return;
    }
    const dn = this._down;
    if (dn && dn.id === e.pointerId) {
      const dx = sx - dn.lx, dy = sy - dn.ly;
      if (!dn.moved && Math.hypot(sx - dn.sx, sy - dn.sy) > CLICK_SLOP) {
        dn.moved = true;
        this._updateCursor(true);
      }
      dn.lx = sx;
      dn.ly = sy;
      if (dn.moved && dn.accepted && dn.tool.onMove) {
        dn.tool.onMove(this._ctx(e, sx, sy, { dx, dy, startX: dn.sx, startY: dn.sy }));
      }
      return;
    }
    if (!this._isStageTarget(e) || e.buttons) return;
    this._scheduleHover(sx, sy);
  }

  _onUp(e) {
    const hadPinch = !!this._pinch;
    this._pointers.delete(e.pointerId);
    try { this.el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (hadPinch) {
      if (this._pointers.size < 2) this._pinch = null;
      return;
    }
    const dn = this._down;
    if (!dn || dn.id !== e.pointerId) return;
    this._down = null;
    this._updateCursor(false);
    const [sx, sy] = this._pos(e);
    const ctx = this._ctx(e, sx, sy, { dx: sx - dn.lx, dy: sy - dn.ly, startX: dn.sx, startY: dn.sy, moved: dn.moved });
    let consumed = false;
    if (dn.accepted && dn.tool.onUp) consumed = dn.tool.onUp(ctx) === true;
    const isClick = !dn.moved && performance.now() - dn.t < CLICK_MS;
    if (isClick && !consumed) this._click(ctx);
  }

  _onCancel(e) {
    this._pointers.delete(e.pointerId);
    if (this._pointers.size < 2) this._pinch = null;
    if (this._down && this._down.id === e.pointerId) this._cancelDrag();
  }

  _cancelDrag() {
    const dn = this._down;
    this._down = null;
    this._updateCursor(false);
    if (dn && dn.accepted && dn.tool.onCancel) dn.tool.onCancel({ app: this.app });
  }

  _click(ctx) {
    ctx.pick = (r = this.hoverRadius) => this.app.proj.pick(ctx.sx, ctx.sy, r);
    for (const h of this.clickHandlers.slice()) {
      try {
        if (h.fn(ctx) === true) return;
      } catch (err) {
        console.error('click handler failed', err);
      }
    }
    const i = ctx.pick();
    this.app.actions.inspect(i >= 0 ? i : null);
  }

  _onWheel(e) {
    if (!this._isStageTarget(e)) return;
    e.preventDefault();
    const [sx, sy] = this._pos(e);
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= 400;
    if (e.ctrlKey) dy *= 3;   // trackpad pinch arrives as ctrl+wheel with small deltas
    const factor = Math.exp(-Math.max(-600, Math.min(600, dy)) * WHEEL_K);
    this.app.camera.zoomAt(sx, sy, factor);
    this.clearHover();
  }

  _scheduleHover(sx, sy) {
    this._lastHoverPos = [sx, sy];
    if (this._hoverTimer) return;
    this._hoverTimer = setTimeout(() => {
      this._hoverTimer = 0;
      this._doHover();
    }, HOVER_MS);
  }

  _doHover() {
    if (!this._lastHoverPos) return;
    const [sx, sy] = this._lastHoverPos;
    if (this.app.isMoving()) {
      this.clearHover();
      return;
    }
    const index = this.app.proj.pick(sx, sy, this.hoverRadius);
    const last = this._hoverLast;
    if (index === last.index && (index < 0 || (last.sx === sx && last.sy === sy))) return;
    this._hoverLast = { index, sx, sy };
    this.app.events.emit('hover', { index, sx, sy });
  }

  /** Emit a hover end (index −1) if a hover is showing. */
  clearHover() {
    clearTimeout(this._hoverTimer);
    this._hoverTimer = 0;
    if (this._hoverLast.index >= 0) {
      this._hoverLast = { index: -1, sx: 0, sy: 0 };
      this.app.events.emit('hover', { index: -1, sx: 0, sy: 0 });
    }
  }

  /** Re-run hover at the last pointer position (e.g. after a settle). */
  refreshHover() {
    if (this._lastHoverPos && !this._down) this._doHover();
  }
}
