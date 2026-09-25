// WebGL2 density-glow renderer (DESIGN.md §11).
//
//   const r = new Renderer(canvas, { onLost, onRestored });
//   if (!r.init()) → WebGL2 unavailable
//   r.setData(dataset); r.resize(cssW, cssH, dpr);
//   r.render(params);                 // params: see RenderParams below
//   r.renderPreview(frame, params, { width, height }) → HTMLCanvasElement
//
// RenderParams (all u-space quantities are standardized coordinates):
//   frame      Float64Array(2D)
//   camera     {cx, cy, scale, aspect, width, height}  (CSS px; scale = CSS px per u along x,
//              aspect = y/x scale ratio)
//   color      {mode: 'none'|'continuous'|'categorical', dim, lo, hi, cmap, slot, colors}
//              lo/hi in u (hi < lo reverses); colors: 8 [r,g,b] (0..1) for codes 0..7
//   filters    {z: null | {dim, lo, hi} (u), masks: [m0, m1, m2, m3] (visible-code bitmasks),
//              need: dim index that must be present (−1 = none)}
//   pointSize  CSS px (sprite diameter), gain, ref (auto exposure), dim (global, 0..1)
//   selection  bool (a selection is active)
//   bloom      strength 0..1 (0 disables the pass)
//   count      optional number of rows to draw (prefix subsample)

import {
  ACCUM_VS, ACCUM_FS_CONT, ACCUM_FS_CAT, FULLSCREEN_VS, COMPOSITE_FS, DOWN_FS, BLUR_FS, FINAL_FS,
} from './shaders.js';
import { buildLUT, colormapRow } from './colormaps.js';
import { NEUTRAL, SELECTION_COLOR, hexToRgb01 } from '../config/style.js';
import { FADE_WIDTH } from '../math/frame.js';

const MAXD = 24;
const GAMMA = 0.8;
const FLOOR = 0.2;          // minimum luminance of an isolated, fully visible galaxy
const UNSEL_DIM = 0.25;     // unselected light when a selection is active
const SEL_BOOST = 2.5;      // exposure boost of selected light
const MEM_BUDGET = 192 * 1024 * 1024;   // bytes for one accumulation target before degrading
const NEUTRAL_RGB = hexToRgb01(NEUTRAL);
const SELECTION_RGB = hexToRgb01(SELECTION_COLOR);

/** Quad size factor: the (1 − r²)² kernel's visible (FWHM) diameter is ~0.54 of its quad,
 *  so a quad of 1.5 × pointSize reads as roughly pointSize CSS px. */
export const SPRITE_SCALE = 1.5;

/** Sprite quad diameter in device px for a pointSize in CSS px. */
export function spriteSizeDev(pointSize, dpr, maxPointSize = 64) {
  return Math.min(maxPointSize, Math.max(1, (pointSize || 2) * SPRITE_SCALE * (dpr || 1)));
}

export { spriteIntegral } from '../workers/kernel.js';

/** Typical peak pixel value of one sprite (pixel centers are ≤ ~0.5 px from the point). */
export function spritePeak(sizeDev) {
  const R = Math.max(0.5, sizeDev / 2);
  const r = Math.min(1, 0.5 / R);
  return Math.max(0.2, (1 - r * r) ** 2);
}

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shader compile failed: ${log}`);
  }
  return sh;
}

function makeProgram(gl, vsSrc, fsSrc) {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(prog)}`);
  }
  const u = {};
  const nu = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) || 0;
  for (let i = 0; i < nu; i++) {
    const info = gl.getActiveUniform(prog, i);
    const name = info.name.replace(/\[0\]$/, '');
    u[name] = gl.getUniformLocation(prog, name);
  }
  return { prog, u };
}

export class Renderer {
  constructor(canvas, { onLost, onRestored } = {}) {
    this.canvas = canvas;
    this.onLost = onLost;
    this.onRestored = onRestored;
    this.gl = null;
    this.lost = false;
    this.data = null;
    this.count = 0;
    this.cssWidth = 1;
    this.cssHeight = 1;
    this.dpr = 1;
    this._sel = null;
    this._targets = {};
    this._previewTargets = new Map();
    // scratch uniform arrays
    this._px = new Float32Array(MAXD);
    this._py = new Float32Array(MAXD);
    this._fade = new Float32Array(MAXD);
    this._colW = new Float32Array(MAXD);
    this._zW = new Float32Array(MAXD);
    this._needW = new Float32Array(MAXD);
    this._A = new Float32Array(MAXD);
    this._B = new Float32Array(MAXD);
    this._cat = new Float32Array(24);
    this._masks = new Uint32Array(4);
    this._onLost = (e) => {
      e.preventDefault();
      this.lost = true;
      this._targets = {};
      this._previewTargets.clear();
      this.onLost?.();
    };
    this._onRestored = () => {
      this.lost = false;
      try {
        this._setup();
        if (this.data) this.setData(this.data);
        if (this._sel) this.setSelection(this._sel);
      } catch (err) {
        console.error('WebGL restore failed', err);
        return;
      }
      this.onRestored?.();
    };
  }

  static supported() {
    try {
      const c = document.createElement('canvas');
      return !!(c.getContext('webgl2'));
    } catch {
      return false;
    }
  }

  /** Create the context and GL resources. Returns false if WebGL2 is unavailable. */
  init() {
    const gl = this.canvas.getContext('webgl2', {
      alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: false, powerPreference: 'high-performance',
    });
    if (!gl) return false;
    this.gl = gl;
    this.canvas.addEventListener('webglcontextlost', this._onLost, false);
    this.canvas.addEventListener('webglcontextrestored', this._onRestored, false);
    this._setup();
    return true;
  }

  _setup() {
    const gl = this.gl;
    const cbf = gl.getExtension('EXT_color_buffer_float');
    const fblend = gl.getExtension('EXT_float_blend');
    const half = cbf ? null : gl.getExtension('EXT_color_buffer_half_float');
    this.caps = {
      float32: !!(cbf && fblend),
      float16: !!(cbf || half),
      maxPointSize: gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)?.[1] || 64,
      maxDrawBuffers: gl.getParameter(gl.MAX_DRAW_BUFFERS),
    };
    this.pCont = makeProgram(gl, ACCUM_VS, ACCUM_FS_CONT);
    this.pCat = makeProgram(gl, ACCUM_VS, ACCUM_FS_CAT);
    this.pComp = makeProgram(gl, FULLSCREEN_VS, COMPOSITE_FS);
    this.pDown = makeProgram(gl, FULLSCREEN_VS, DOWN_FS);
    this.pBlur = makeProgram(gl, FULLSCREEN_VS, BLUR_FS);
    this.pFinal = makeProgram(gl, FULLSCREEN_VS, FINAL_FS);
    // colormap LUT
    const lut = buildLUT();
    this.lutRows = lut.rows;
    this.lut = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, lut.width, lut.rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut.data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.emptyVao = gl.createVertexArray();
    this.vao = gl.createVertexArray();
    this.vboDims = gl.createBuffer();
    this.vboCats = gl.createBuffer();
    this.vboSel = gl.createBuffer();
    this._targets = {};
    this._previewTargets.clear();
    this._fbOk = new Map();
    // probe render-target formats now, while the GPU is idle (the check is a sync round trip)
    for (const mode of ['cont', 'cat']) {
      try {
        this._deleteTarget(this._createAccum(4, 4, mode));
      } catch (e) {
        console.warn(`no accumulation format for ${mode} mode`, e);
      }
    }
    this.ready = false;
  }

  get info() {
    return {
      ...this.caps,
      tier: this._targets.cont?.tier || this._targets.cat?.tier || null,
      lost: this.lost,
      count: this.count,
    };
  }

  /**
   * Interleave the dimension columns into the vertex layout (4 dims per vec4 attribute,
   * padded with 0 = missing). Async: yields to the event loop every ~budgetMs.
   */
  static async interleave(data, { budgetMs = 8 } = {}) {
    const n = data.n, D = Math.min(MAXD, data.D);
    const S = 4 * Math.ceil(D / 4);
    const buf = new Uint16Array(n * S);
    const CH = 16384;
    let t0 = performance.now();
    for (let i0 = 0; i0 < n; i0 += CH) {
      const i1 = Math.min(n, i0 + CH);
      for (let d = 0; d < D; d++) {
        const col = data.raw[d];
        if (!col) continue;
        for (let i = i0, o = i0 * S + d; i < i1; i++, o += S) buf[o] = col[i];
      }
      if (performance.now() - t0 > budgetMs) {
        await new Promise((r) => setTimeout(r, 0));
        t0 = performance.now();
      }
    }
    return buf;
  }

  /**
   * Upload the dataset (interleaved uint16 dims, category codes, selection flags).
   * opts.dims: a buffer from Renderer.interleave(data) (built synchronously if omitted).
   */
  setData(data, { dims } = {}) {
    this.data = data;
    const gl = this.gl;
    if (!gl || this.lost) return;
    const n = data.n, D = Math.min(MAXD, data.D);
    const S = 4 * Math.ceil(D / 4);
    const nAttr = S / 4;
    let buf = dims && dims.length === n * S ? dims : null;
    if (!buf) {
      buf = new Uint16Array(n * S);
      for (let d = 0; d < D; d++) {
        const col = data.raw[d];
        if (!col) continue;
        for (let i = 0, o = d; i < n; i++, o += S) buf[o] = col[i];
      }
    }
    const cats = new Uint8Array(n * 4);
    for (const c of data.categories) {
      const col = data.cats[c.key];
      if (c.slot < 0 || !col) continue;
      for (let i = 0, o = c.slot; i < n; i++, o += 4) cats[o] = col[i];
    }
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vboDims);
    gl.bufferData(gl.ARRAY_BUFFER, buf, gl.STATIC_DRAW);
    for (let k = 0; k < 6; k++) {
      if (k < nAttr) {
        gl.enableVertexAttribArray(k);
        gl.vertexAttribPointer(k, 4, gl.UNSIGNED_SHORT, true, S * 2, k * 8);
      } else {
        gl.disableVertexAttribArray(k);
        gl.vertexAttrib4f(k, 0, 0, 0, 0);
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vboCats);
    gl.bufferData(gl.ARRAY_BUFFER, cats, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(6);
    gl.vertexAttribIPointer(6, 4, gl.UNSIGNED_BYTE, 4, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vboSel);
    gl.bufferData(gl.ARRAY_BUFFER, this._sel && this._sel.length === n ? this._sel : new Uint8Array(n), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(7);
    gl.vertexAttribPointer(7, 1, gl.UNSIGNED_BYTE, false, 1, 0);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this._A.fill(0);
    this._B.fill(0);
    for (let d = 0; d < D; d++) {
      this._A[d] = data.dims[d].A;
      this._B[d] = data.dims[d].B;
    }
    this.D = D;
    this.count = n;
    this.ready = true;
  }

  /** Selection flags (Uint8Array(n), nonzero = selected) or null. */
  setSelection(mask) {
    this._sel = mask || null;
    const gl = this.gl;
    if (!gl || this.lost || !this.ready) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vboSel);
    if (mask && mask.length === this.count) gl.bufferSubData(gl.ARRAY_BUFFER, 0, mask);
    else gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Uint8Array(this.count));
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  /** Size the drawing buffer for a CSS size and device-pixel ratio (capped at 2). */
  resize(cssW, cssH, dpr = 1) {
    this.cssWidth = Math.max(1, cssW);
    this.cssHeight = Math.max(1, cssH);
    this.dpr = Math.min(2, Math.max(1, dpr || 1));
    const w = Math.max(1, Math.round(this.cssWidth * this.dpr));
    const h = Math.max(1, Math.round(this.cssHeight * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  // ---------------------------------------------------------------- render targets

  _tiers() {
    const gl = this.gl;
    const t = [];
    if (this.caps.float32) t.push({ name: 'RGBA32F', rgba: gl.RGBA32F, r: gl.R32F, bytes: 16, scale: 1 });
    if (this.caps.float16) t.push({ name: 'RGBA16F', rgba: gl.RGBA16F, r: gl.R16F, bytes: 8, scale: 1 });
    t.push({ name: 'RGBA8', rgba: gl.RGBA8, r: gl.R8, bytes: 4, scale: 1 / 8 });
    return t;
  }

  _makeTex(fmt, w, h, filter) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, fmt, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  _deleteTarget(t) {
    if (!t) return;
    const gl = this.gl;
    for (const tex of t.texs) gl.deleteTexture(tex);
    gl.deleteFramebuffer(t.fbo);
  }

  _createAccum(w, h, mode) {
    const gl = this.gl;
    const nAtt = mode === 'cat' ? 3 : 1;
    const tiers = this._tiers();
    for (let ti = 0; ti < tiers.length; ti++) {
      const t = tiers[ti];
      const mem = w * h * t.bytes * (mode === 'cat' ? 2.25 : 1);
      if (mem > MEM_BUDGET && ti < tiers.length - 1) continue;
      for (const singleR of nAtt === 3 ? [true, false] : [false]) {
        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        const texs = [];
        for (let i = 0; i < nAtt; i++) {
          const tex = this._makeTex(i === 2 && singleR ? t.r : t.rgba, w, h, gl.NEAREST);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, tex, 0);
          texs.push(tex);
        }
        if (nAtt > 1) gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
        // checkFramebufferStatus is a synchronous GPU round trip: ask once per format combination
        const key = `${t.name}:${nAtt}:${singleR}`;
        let ok = this._fbOk.get(key);
        if (ok === undefined) {
          ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
          this._fbOk.set(key, ok);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        if (ok) return { fbo, texs, w, h, mode, tier: t.name, accScale: t.scale, nAtt };
        this._deleteTarget({ fbo, texs });
      }
    }
    throw new Error('no renderable accumulation format');
  }

  _createColor(w, h, filter) {
    const gl = this.gl;
    const fbo = gl.createFramebuffer();
    const tex = this._makeTex(gl.RGBA8, w, h, filter);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, texs: [tex], w, h };
  }

  _target(key, w, h, make) {
    const t = this._targets[key];
    if (t && t.w === w && t.h === h) return t;
    this._deleteTarget(t);
    const nt = make();
    this._targets[key] = nt;
    return nt;
  }

  // ---------------------------------------------------------------- passes

  _accumulate(tgt, p) {
    const gl = this.gl;
    const D = this.D;
    const F = p.frame;
    const FD = F.length >> 1;
    const px = this._px, py = this._py, fade = this._fade, colW = this._colW, zW = this._zW, needW = this._needW;
    px.fill(0); py.fill(0); fade.fill(1); colW.fill(0); zW.fill(0); needW.fill(0);
    for (let d = 0; d < Math.min(D, FD); d++) {
      px[d] = F[d];
      py[d] = F[FD + d];
      fade[d] = Math.min(1, Math.max(0, 1 - Math.hypot(F[d], F[FD + d]) / FADE_WIDTH));
    }
    const color = p.color || { mode: 'none' };
    const cmode = color.mode === 'continuous' && color.dim >= 0 ? 1 : color.mode === 'categorical' ? 2 : 0;
    if (cmode === 1) colW[color.dim] = 1;
    const z = p.filters && p.filters.z;
    if (z && z.dim >= 0) zW[z.dim] = 1;
    const need = p.filters ? p.filters.need : -1;
    if (need >= 0 && need < D) needW[need] = 1;
    const masks = this._masks;
    masks.fill(0xffffffff);
    if (p.filters && p.filters.masks) for (let s = 0; s < 4; s++) if (p.filters.masks[s] != null) masks[s] = p.filters.masks[s] >>> 0;

    gl.bindFramebuffer(gl.FRAMEBUFFER, tgt.fbo);
    gl.viewport(0, 0, tgt.w, tgt.h);
    const zero = [0, 0, 0, 0];
    for (let i = 0; i < tgt.nAtt; i++) gl.clearBufferfv(gl.COLOR, i, zero);
    const prog = tgt.mode === 'cat' ? this.pCat : this.pCont;
    const u = prog.u;
    gl.useProgram(prog.prog);
    gl.uniform4fv(u.u_A, this._A);
    gl.uniform4fv(u.u_B, this._B);
    gl.uniform4fv(u.u_px, px);
    gl.uniform4fv(u.u_py, py);
    gl.uniform4fv(u.u_fade, fade);
    gl.uniform4fv(u.u_colW, colW);
    gl.uniform4fv(u.u_zW, zW);
    gl.uniform4fv(u.u_needW, needW);
    const lo = cmode === 1 ? color.lo : 0, hi = cmode === 1 ? color.hi : 1;
    gl.uniform2f(u.u_colRange, lo, Math.abs(hi - lo) > 1e-9 ? 1 / (hi - lo) : 1);
    gl.uniform3f(u.u_zRange, z ? z.lo : 0, z ? z.hi : 0, z && z.dim >= 0 ? 1 : 0);
    gl.uniform4uiv(u.u_catMask, masks);
    gl.uniform1i(u.u_catSlot, cmode === 2 ? color.slot : -1);
    gl.uniform1i(u.u_colorMode, cmode);
    const cam = p.camera;
    gl.uniform4f(u.u_cam, cam.cx, cam.cy, (2 * cam.scale) / cam.width, (2 * cam.scale * (cam.aspect || 1)) / cam.height);
    const sizeDev = spriteSizeDev(p.pointSize, p.dpr || this.dpr, this.caps.maxPointSize);
    gl.uniform1f(u.u_pointSize, sizeDev);
    gl.uniform1f(u.u_accScale, tgt.accScale);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.bindVertexArray(this.vao);
    const count = Math.min(this.count, p.count > 0 ? p.count : this.count);
    gl.drawArrays(gl.POINTS, 0, count);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    return { cmode, sizeDev };
  }

  _composite(acc, p, info) {
    const gl = this.gl;
    const u = this.pComp.u;
    gl.useProgram(this.pComp.prog);
    for (let i = 0; i < 3; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, acc.texs[Math.min(i, acc.texs.length - 1)]);
    }
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    gl.uniform1i(u.u_acc0, 0);
    gl.uniform1i(u.u_acc1, 1);
    gl.uniform1i(u.u_acc2, 2);
    gl.uniform1i(u.u_lut, 3);
    const color = p.color || {};
    gl.uniform1i(u.u_mode, info.cmode);
    gl.uniform1f(u.u_lutV, (colormapRow(color.cmap) + 0.5) / this.lutRows);
    const cat = this._cat;
    for (let c = 0; c < 8; c++) {
      const rgb = (color.colors && color.colors[c]) || NEUTRAL_RGB;
      cat[3 * c] = rgb[0]; cat[3 * c + 1] = rgb[1]; cat[3 * c + 2] = rgb[2];
    }
    gl.uniform3fv(u.u_cat, cat);
    gl.uniform3fv(u.u_neutral, NEUTRAL_RGB);
    gl.uniform3fv(u.u_selColor, SELECTION_RGB);
    gl.uniform1f(u.u_gain, p.gain > 0 ? p.gain : 1);
    gl.uniform1f(u.u_invRef, 1 / Math.max(1e-6, p.ref || 1));
    gl.uniform1f(u.u_gamma, GAMMA);
    gl.uniform1f(u.u_floor, p.floor ?? FLOOR);
    gl.uniform1f(u.u_invPeak, 1 / spritePeak(info.sizeDev));
    gl.uniform1f(u.u_selActive, p.selection ? 1 : 0);
    gl.uniform1f(u.u_unselDim, UNSEL_DIM);
    gl.uniform1f(u.u_selBoost, SEL_BOOST);
    gl.uniform1f(u.u_dim, p.dim ?? 1);
    gl.uniform1f(u.u_invAccScale, 1 / acc.accScale);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  _fullscreen(prog, bindings) {
    const gl = this.gl;
    gl.useProgram(prog.prog);
    let unit = 0;
    for (const [name, value] of Object.entries(bindings)) {
      if (value && value.tex) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, value.tex);
        gl.uniform1i(prog.u[name], unit++);
      } else if (Array.isArray(value)) {
        gl.uniform2f(prog.u[name], value[0], value[1]);
      } else if (typeof value === 'number') {
        gl.uniform1f(prog.u[name], value);
      }
    }
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Draw a frame to the canvas. Returns false if nothing could be drawn. */
  render(p) {
    const gl = this.gl;
    if (!gl || this.lost || !this.ready || gl.isContextLost()) return false;
    const W = this.canvas.width, H = this.canvas.height;
    const mode = p.color && p.color.mode === 'categorical' ? 'cat' : 'cont';
    // keep only the accumulation target of the active mode alive
    const other = mode === 'cat' ? 'cont' : 'cat';
    if (this._targets[other]) {
      this._deleteTarget(this._targets[other]);
      delete this._targets[other];
    }
    const acc = this._target(mode, W, H, () => this._createAccum(W, H, mode));
    const info = this._accumulate(acc, { ...p, dpr: this.dpr });
    const bloom = p.bloom > 0 ? Math.min(1, p.bloom) : 0;
    if (!bloom) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this._composite(acc, p, info);
      return true;
    }
    const base = this._target('base', W, H, () => this._createColor(W, H, gl.LINEAR));
    gl.bindFramebuffer(gl.FRAMEBUFFER, base.fbo);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this._composite(acc, p, info);
    const bw = Math.max(1, Math.round(W / 4)), bh = Math.max(1, Math.round(H / 4));
    const b1 = this._target('bloomA', bw, bh, () => this._createColor(bw, bh, gl.LINEAR));
    const b2 = this._target('bloomB', bw, bh, () => this._createColor(bw, bh, gl.LINEAR));
    gl.bindFramebuffer(gl.FRAMEBUFFER, b1.fbo);
    gl.viewport(0, 0, bw, bh);
    this._fullscreen(this.pDown, { u_src: { tex: base.texs[0] }, u_texel: [1 / W, 1 / H] });
    gl.bindFramebuffer(gl.FRAMEBUFFER, b2.fbo);
    this._fullscreen(this.pBlur, { u_src: { tex: b1.texs[0] }, u_dir: [1.6 / bw, 0] });
    gl.bindFramebuffer(gl.FRAMEBUFFER, b1.fbo);
    this._fullscreen(this.pBlur, { u_src: { tex: b2.texs[0] }, u_dir: [0, 1.6 / bh] });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this._fullscreen(this.pFinal, { u_base: { tex: base.texs[0] }, u_bloom: { tex: b1.texs[0] }, u_strength: bloom });
    return true;
  }

  /**
   * Render any frame offscreen into a small canvas (preset cartridges).
   * p: RenderParams (camera sized to width×height CSS px); opts: {width=112, height=72, dpr,
   * background: '#rrggbb' to flatten onto a color (default transparent), canvas: reuse}.
   * The canvas is returned at once and filled asynchronously (PBO + fence, no GPU stall);
   * `canvas.ready` is a Promise resolving to the canvas (or null if the context was lost).
   */
  renderPreview(frame, p, { width = 112, height = 72, dpr, background = null, canvas } = {}) {
    const gl = this.gl;
    if (!gl || this.lost || !this.ready || gl.isContextLost()) return null;
    const r = Math.min(2, Math.max(1, dpr || this.dpr || 1));
    const W = Math.max(1, Math.round(width * r)), H = Math.max(1, Math.round(height * r));
    const mode = p.color && p.color.mode === 'categorical' ? 'cat' : 'cont';
    const key = `${W}x${H}:${mode}`;
    let t = this._previewTargets.get(key);
    if (!t) {
      t = { acc: this._createAccum(W, H, mode), out: this._createColor(W, H, gl.NEAREST) };
      this._previewTargets.set(key, t);
      if (this._previewTargets.size > 6) {
        const [k0, t0] = this._previewTargets.entries().next().value;
        this._deleteTarget(t0.acc);
        this._deleteTarget(t0.out);
        this._previewTargets.delete(k0);
      }
    }
    const params = { ...p, frame, dpr: r, camera: { ...p.camera, width, height } };
    const info = this._accumulate(t.acc, params);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.out.fbo);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this._composite(t.acc, params, info);
    const pbo = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, W * H * 4, gl.STREAM_READ);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const cv = canvas || document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    cv.style.width = `${width}px`;
    cv.style.height = `${height}px`;
    const bg = background ? hexToRgb01(background).map((c) => c * 255) : null;
    cv.ready = new Promise((resolve) => {
      const poll = () => {
        if (this.lost || gl.isContextLost()) {
          resolve(null);
          return;
        }
        const st = gl.clientWaitSync(sync, 0, 0);
        if (st === gl.TIMEOUT_EXPIRED) {
          setTimeout(poll, 6);
          return;
        }
        gl.deleteSync(sync);
        const px = new Uint8Array(W * H * 4);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, px);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        gl.deleteBuffer(pbo);
        const ctx = cv.getContext('2d');
        const img = ctx.createImageData(W, H);
        const d = img.data;
        for (let y = 0; y < H; y++) {
          const src = (H - 1 - y) * W * 4, dst = y * W * 4;
          for (let x = 0; x < W * 4; x += 4) {
            const a = px[src + x + 3];
            if (bg) {
              const ia = 1 - a / 255;
              d[dst + x] = px[src + x] + bg[0] * ia;
              d[dst + x + 1] = px[src + x + 1] + bg[1] * ia;
              d[dst + x + 2] = px[src + x + 2] + bg[2] * ia;
              d[dst + x + 3] = 255;
            } else if (a > 0) {
              const k = 255 / a;
              d[dst + x] = px[src + x] * k;
              d[dst + x + 1] = px[src + x + 1] * k;
              d[dst + x + 2] = px[src + x + 2] * k;
              d[dst + x + 3] = a;
            }
          }
        }
        ctx.putImageData(img, 0, 0);
        resolve(cv);
      };
      setTimeout(poll, 0);
    });
    return cv;
  }

  destroy() {
    this.canvas.removeEventListener('webglcontextlost', this._onLost);
    this.canvas.removeEventListener('webglcontextrestored', this._onRestored);
    const lose = this.gl && this.gl.getExtension('WEBGL_lose_context');
    lose?.loseContext();
    this.gl = null;
  }
}
