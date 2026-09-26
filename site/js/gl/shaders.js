// GLSL ES 3.00 sources (DESIGN.md §11).
//
// Accumulate pass: one soft point sprite per galaxy, additive blending into a float target.
//   continuous color: (R, G, B, A) += w·(1, c·has, has, sel)
//   categorical:       att0 += w·onehot(code 0..3), att1 += w·onehot(code 4..7), att2.r += w·sel
// with w = visibility × kernel. Decoding, projection, missing-dim fade, filters and color
// lookup all happen in the vertex shader, so a frame costs only uniform updates on the CPU.

export const ACCUM_VS = `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in vec4 a_d0;
layout(location = 1) in vec4 a_d1;
layout(location = 2) in vec4 a_d2;
layout(location = 3) in vec4 a_d3;
layout(location = 4) in vec4 a_d4;
layout(location = 5) in vec4 a_d5;
layout(location = 6) in uvec4 a_cats;
layout(location = 7) in float a_sel;
layout(location = 8) in vec4 a_d6;   // dims 24-27 (added after cats/sel took 6 and 7)

uniform vec4 u_A[7];        // decode: u = A*val + B (val = normalized uint16)
uniform vec4 u_B[7];
uniform vec4 u_px[7];       // frame columns
uniform vec4 u_py[7];
uniform vec4 u_fade[7];     // per-dim missing fade factors
uniform vec4 u_colW[7];     // one-hot of the color dimension
uniform vec4 u_zW[7];       // one-hot of the range-filter dimension (z)
uniform vec4 u_needW[7];    // one-hot of a dimension that must be present (needColor)
uniform vec2 u_colRange;    // (lo, 1/(hi-lo)) in u-space (hi < lo reverses)
uniform vec3 u_zRange;      // (lo, hi, active) in u-space
uniform uvec4 u_catMask;    // visible-code bitmask per category slot
uniform int u_catSlot;      // category slot used for categorical color
uniform int u_colorMode;    // 0 none, 1 continuous, 2 categorical
uniform vec4 u_cam;         // (cx, cy, 2*scale/width, 2*scale/height)
uniform float u_pointSize;  // device px

out float v_w;
out float v_c;
out float v_has;
out float v_sel;
flat out uint v_code;

const float MISS = 0.5 / 65535.0;

void main() {
  vec4 val[7] = vec4[7](a_d0, a_d1, a_d2, a_d3, a_d4, a_d5, a_d6);
  float X = 0.0, Y = 0.0, vis = 1.0;
  float cU = 0.0, cM = 0.0, zU = 0.0, zM = 0.0, nM = 0.0;
  for (int k = 0; k < 7; k++) {
    vec4 v = val[k];
    vec4 m = vec4(lessThan(v, vec4(MISS)));
    vec4 u = (u_A[k] * v + u_B[k]) * (1.0 - m);
    X += dot(u, u_px[k]);
    Y += dot(u, u_py[k]);
    vec4 f = mix(vec4(1.0), u_fade[k], m);
    vis *= f.x * f.y * f.z * f.w;
    cU += dot(u, u_colW[k]);
    cM += dot(m, u_colW[k]);
    zU += dot(u, u_zW[k]);
    zM += dot(m, u_zW[k]);
    nM += dot(m, u_needW[k]);
  }
  uvec4 bits = (u_catMask >> min(a_cats, uvec4(31u))) & uvec4(1u);
  if (bits.x == 0u || bits.y == 0u || bits.z == 0u || bits.w == 0u) vis = 0.0;
  if (u_zRange.z > 0.5 && (zM > 0.5 || zU < u_zRange.x || zU > u_zRange.y)) vis = 0.0;
  if (nM > 0.5) vis = 0.0;

  v_c = clamp((cU - u_colRange.x) * u_colRange.y, 0.0, 1.0);
  v_has = (u_colorMode == 1 && cM < 0.5) ? 1.0 : 0.0;
  v_sel = min(a_sel, 1.0);
  uint code = u_catSlot == 0 ? a_cats.x : u_catSlot == 1 ? a_cats.y : u_catSlot == 2 ? a_cats.z
            : u_catSlot == 3 ? a_cats.w : 0u;
  v_code = code > 7u ? 0u : code;
  v_w = vis;
  if (vis < 0.01) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 1.0;
    return;
  }
  gl_Position = vec4((vec2(X, Y) - u_cam.xy) * u_cam.zw, 0.0, 1.0);
  gl_PointSize = u_pointSize;
}
`;

const KERNEL = `
float kernel() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 >= 1.0) discard;
  float k = 1.0 - r2;
  return k * k;
}
`;

export const ACCUM_FS_CONT = `#version 300 es
precision highp float;
in float v_w;
in float v_c;
in float v_has;
in float v_sel;
uniform float u_accScale;
out vec4 o;
${KERNEL}
void main() {
  float w = v_w * kernel() * u_accScale;
  o = vec4(w, w * v_c * v_has, w * v_has, w * v_sel);
}
`;

export const ACCUM_FS_CAT = `#version 300 es
precision highp float;
precision highp int;
in float v_w;
in float v_sel;
flat in uint v_code;
uniform float u_accScale;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
${KERNEL}
void main() {
  float w = v_w * kernel() * u_accScale;
  uvec4 c = uvec4(v_code);
  o0 = w * vec4(equal(c, uvec4(0u, 1u, 2u, 3u)));
  o1 = w * vec4(equal(c, uvec4(4u, 5u, 6u, 7u)));
  o2 = vec4(w * v_sel, 0.0, 0.0, 0.0);
}
`;

export const FULLSCREEN_VS = `#version 300 es
const vec2 P[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
out vec2 v_uv;
void main() {
  vec2 p = P[gl_VertexID];
  v_uv = 0.5 * p + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

// Composite: luminance = 1 − exp(−gain·count/ref), γ, plus a small floor so isolated
// galaxies stay visible; hue = colormap(G/B) or the count-weighted class mix; selection lifts
// selected light and dims the rest. Output is premultiplied over the CSS stage background.
export const COMPOSITE_FS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_acc0;
uniform sampler2D u_acc1;
uniform sampler2D u_acc2;
uniform sampler2D u_lut;
uniform float u_lutV;
uniform int u_mode;          // 0 neutral, 1 continuous, 2 categorical
uniform vec3 u_cat[8];
uniform vec3 u_neutral;
uniform vec3 u_selColor;
uniform float u_gain;
uniform float u_invRef;
uniform float u_gamma;
uniform float u_floor;
uniform float u_invPeak;
uniform float u_selActive;
uniform float u_unselDim;
uniform float u_selBoost;
uniform float u_dim;
uniform float u_invAccScale;
out vec4 o;

float transfer(float c) {
  float L = 1.0 - exp(-u_gain * c * u_invRef);
  L = pow(max(L, 0.0), u_gamma);
  return max(L, u_floor * clamp(c * u_invPeak, 0.0, 1.0));
}

void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  vec4 a0 = texelFetch(u_acc0, ij, 0) * u_invAccScale;
  float count;
  float sel;
  vec3 col;
  if (u_mode == 2) {
    vec4 a1 = texelFetch(u_acc1, ij, 0) * u_invAccScale;
    sel = texelFetch(u_acc2, ij, 0).r * u_invAccScale;
    count = dot(a0, vec4(1.0)) + dot(a1, vec4(1.0));
    vec3 s = a0.x * u_cat[0] + a0.y * u_cat[1] + a0.z * u_cat[2] + a0.w * u_cat[3]
           + a1.x * u_cat[4] + a1.y * u_cat[5] + a1.z * u_cat[6] + a1.w * u_cat[7];
    col = s / max(count, 1e-12);
  } else {
    count = a0.r;
    sel = a0.a;
    col = u_neutral;
    if (u_mode == 1 && a0.b > 1e-12) {
      float t = clamp(a0.g / a0.b, 0.0, 1.0);
      vec3 cm = texture(u_lut, vec2((t * 255.0 + 0.5) / 256.0, u_lutV)).rgb;
      col = mix(u_neutral, cm, clamp(a0.b / max(count, 1e-12), 0.0, 1.0));
    }
  }
  if (count <= 1e-7) {
    o = vec4(0.0);
    return;
  }
  vec3 rgb;
  float alpha;
  if (u_selActive > 0.5) {
    sel = clamp(sel, 0.0, count);
    float Lb = u_unselDim * transfer(count - sel);
    float Ls = transfer(sel * u_selBoost);          // sparse selections still glow
    vec3 cs = min(mix(col, u_selColor, 0.4) * 1.25 + vec3(0.04, 0.02, 0.0), vec3(1.0));
    alpha = Lb + Ls * (1.0 - Lb);
    rgb = col * Lb * (1.0 - Ls) + cs * Ls;
  } else {
    alpha = transfer(count);
    rgb = col * alpha;
  }
  o = vec4(rgb, alpha) * u_dim;
}
`;

// Bloom: 4-tap downsample of the composited image, separable 9-tap blur, additive combine.
export const DOWN_FS = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform vec2 u_texel;       // 1 / source size
in vec2 v_uv;
out vec4 o;
void main() {
  vec2 d = u_texel;
  o = 0.25 * (texture(u_src, v_uv + vec2(-d.x, -d.y)) + texture(u_src, v_uv + vec2(d.x, -d.y))
            + texture(u_src, v_uv + vec2(-d.x, d.y)) + texture(u_src, v_uv + vec2(d.x, d.y)));
}
`;

export const BLUR_FS = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform vec2 u_dir;         // texel step along the blur direction
in vec2 v_uv;
out vec4 o;
void main() {
  const float w0 = 0.2270270270, w1 = 0.3162162162, w2 = 0.0702702703;
  vec4 c = texture(u_src, v_uv) * w0;
  c += (texture(u_src, v_uv + u_dir * 1.3846153846) + texture(u_src, v_uv - u_dir * 1.3846153846)) * w1;
  c += (texture(u_src, v_uv + u_dir * 3.2307692308) + texture(u_src, v_uv - u_dir * 3.2307692308)) * w2;
  o = c;
}
`;

export const FINAL_FS = `#version 300 es
precision highp float;
uniform sampler2D u_base;
uniform sampler2D u_bloom;
uniform float u_strength;
in vec2 v_uv;
out vec4 o;
void main() {
  vec4 b = texelFetch(u_base, ivec2(gl_FragCoord.xy), 0);
  vec4 g = texture(u_bloom, v_uv) * u_strength;
  vec4 c = b + g * (1.0 - b.a * 0.6);
  c.a = min(c.a, 1.0);
  c.rgb = min(c.rgb, vec3(c.a));
  o = c;
}
`;
