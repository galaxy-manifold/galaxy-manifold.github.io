// Pure text helpers for canvas labels (no DOM). Dimension labels and units carry unicode
// super- and subscripts ("log R₅₀", "12+log(O/H)ᴼ³ᴺ²", "M☉ yr⁻¹", "⁰·¹(g−r)") and the
// "_x" subscript convention ("log M_HI/M★"). Space Mono has no glyphs for most of these, so
// the browser would fall back to a font with tiny, mismatched glyphs; scriptRuns() turns such
// text into runs of plain characters with a script level, which the overlays draw at a
// smaller size, raised or lowered. Unit-tested in site/tests/overlays.test.mjs.

const SUP = {
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
  '⁺': '+', '⁻': '−', '⁼': '=', '⁽': '(', '⁾': ')', 'ⁿ': 'n', 'ⁱ': 'i',
  'ᴬ': 'A', 'ᴮ': 'B', 'ᴰ': 'D', 'ᴱ': 'E', 'ᴳ': 'G', 'ᴴ': 'H', 'ᴵ': 'I', 'ᴶ': 'J', 'ᴷ': 'K',
  'ᴸ': 'L', 'ᴹ': 'M', 'ᴺ': 'N', 'ᴼ': 'O', 'ᴾ': 'P', 'ᴿ': 'R', 'ᵀ': 'T', 'ᵁ': 'U', 'ⱽ': 'V', 'ᵂ': 'W',
  'ᵃ': 'a', 'ᵇ': 'b', 'ᶜ': 'c', 'ᵈ': 'd', 'ᵉ': 'e', 'ᶠ': 'f', 'ᵍ': 'g', 'ʰ': 'h', 'ʲ': 'j',
  'ᵏ': 'k', 'ˡ': 'l', 'ᵐ': 'm', 'ᵒ': 'o', 'ᵖ': 'p', 'ʳ': 'r', 'ˢ': 's', 'ᵗ': 't', 'ᵘ': 'u',
  'ᵛ': 'v', 'ʷ': 'w', 'ˣ': 'x', 'ʸ': 'y', 'ᶻ': 'z',
};

const SUB = {
  '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9',
  '₊': '+', '₋': '−', '₌': '=', '₍': '(', '₎': ')', 'ₐ': 'a', 'ₑ': 'e', 'ₒ': 'o', 'ₓ': 'x',
  'ₕ': 'h', 'ₖ': 'k', 'ₗ': 'l', 'ₘ': 'm', 'ₙ': 'n', 'ₚ': 'p', 'ₛ': 's', 'ₜ': 't',
  'ᵢ': 'i', 'ⱼ': 'j', 'ᵣ': 'r', 'ᵤ': 'u', 'ᵥ': 'v',
};

const WORD = /[A-Za-z0-9]/;

/**
 * Split text into runs [{text, script}] with script 0 (normal), 1 (superscript) or −1
 * (subscript); script runs hold the plain characters. A middle dot between two superscript
 * characters belongs to the superscript ("⁰·¹" → "0.1"), and "_" followed by letters or
 * digits starts a subscript ("M_HI" → "M" + sub "HI"). Adjacent runs of one level merge.
 */
export function scriptRuns(text) {
  const s = String(text ?? '');
  const chars = Array.from(s);
  const runs = [];
  const push = (t, script) => {
    const last = runs[runs.length - 1];
    if (last && last.script === script) last.text += t;
    else runs.push({ text: t, script });
  };
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (SUP[c]) { push(SUP[c], 1); continue; }
    if (SUB[c]) { push(SUB[c], -1); continue; }
    if (c === '·' && SUP[chars[i - 1]] && SUP[chars[i + 1]]) { push('.', 1); continue; }
    if (c === '_' && i + 1 < chars.length && WORD.test(chars[i + 1])) {
      let j = i + 1, t = '';
      while (j < chars.length && WORD.test(chars[j])) t += chars[j++];
      push(t, -1);
      i = j - 1;
      continue;
    }
    push(c, 0);
  }
  return runs;
}

/** True when the text holds any super/subscript (so plain fillText would misrender it). */
export function hasScripts(text) {
  return scriptRuns(text).some((r) => r.script !== 0);
}

/**
 * True when a label has a top-level + or − (outside (), [], ⟨⟩), so that a coefficient in
 * front of it needs parentheses: "0.5 (12+log(O/H))" but "0.5 ⁰·¹(g−r)". A leading sign
 * does not count.
 */
export function needsParens(label) {
  let depth = 0, i = 0;
  for (const c of String(label ?? '')) {
    if (c === '(' || c === '[' || c === '⟨' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '⟩' || c === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0 && i > 0 && (c === '+' || c === '−' || c === '-')) return true;
    i++;
  }
  return false;
}

/** Relative size and baseline shift (in font sizes) of a script level. */
export const SCRIPT = { scale: 0.72, sup: -0.36, sub: 0.2 };

/**
 * Lay out runs at font size `px`: [{text, script, size, dy, x}] plus total width, using a
 * measure(text, size) callback (canvas measureText in the app, a stub in tests).
 */
export function layoutRuns(runs, px, measure) {
  let x = 0;
  const out = [];
  for (const r of runs) {
    const size = r.script ? Math.max(6, Math.round(px * SCRIPT.scale * 2) / 2) : px;
    const dy = r.script > 0 ? SCRIPT.sup * px : r.script < 0 ? SCRIPT.sub * px : 0;
    const w = measure(r.text, size);
    out.push({ text: r.text, script: r.script, size, dy, x, w });
    x += w;
  }
  return { runs: out, width: x };
}
