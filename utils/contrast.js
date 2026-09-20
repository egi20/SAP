'use strict';

/**
 * WCAG contrast, as a function rather than as a comment.
 *
 * Ported unchanged from the Salesforce Hub reference, which is the one place both
 * reference implementations got this right, and kept for the same reason it exists there:
 * `DESIGN.md` carries colour rules that are only facts somebody measured once, until a
 * function can check them. Here that matters before the first company ever picks a brand
 * colour for its own documents — SAP's own brand blue #0070F2 measures 4.57:1 on white,
 * which clears the AA threshold by seven hundredths, and a rule that tight is not one to
 * trust to anyone's eye.
 *
 * Pure, and the maths is the published sRGB formula — worth stating because a "good
 * enough" approximation here is how a colour that fails is waved through.
 */

/** '#0176D3' or '0176D3' or '#07D' -> {r, g, b}, or null if it is not a hex colour. */
function parseHex(value) {
  if (typeof value !== 'string') return null;
  const hex = value.trim().replace(/^#/, '');

  const expanded = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  if (!/^[0-9a-f]{6}$/i.test(expanded)) return null;

  return {
    r: parseInt(expanded.slice(0, 2), 16),
    g: parseInt(expanded.slice(2, 4), 16),
    b: parseInt(expanded.slice(4, 6), 16)
  };
}

/** Normalise to six upper-case hex digits with no hash — the shape every generator wants. */
function normaliseHex(value) {
  const rgb = parseHex(value);
  if (!rgb) return null;
  return [rgb.r, rgb.g, rgb.b].map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** Relative luminance, per the WCAG 2.x definition. */
function relativeLuminance(value) {
  const rgb = parseHex(value);
  if (!rgb) return null;

  const channel = (raw) => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/**
 * @returns {number|null} the ratio, 1 to 21, or null if either colour is unparseable.
 */
function contrastRatio(a, b) {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  if (first === null || second === null) return null;

  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * AA for normal text is 4.5:1. Headings in these documents are set at 15pt and are NOT
 * large text by the WCAG definition (18pt, or 14pt bold), so the lower 3:1 threshold does
 * not apply — and choosing the more forgiving threshold for a colour somebody will also
 * use on a web page would be optimistic in the wrong direction.
 */
const MIN_TEXT_RATIO = 4.5;

/** The paper these documents are printed on, and the background every generator assumes. */
const DOCUMENT_BACKGROUND = 'FFFFFF';

function isReadableOnPaper(value, minimum = MIN_TEXT_RATIO) {
  const ratio = contrastRatio(value, DOCUMENT_BACKGROUND);
  return ratio !== null && ratio >= minimum;
}

module.exports = {
  MIN_TEXT_RATIO,
  DOCUMENT_BACKGROUND,
  parseHex,
  normaliseHex,
  relativeLuminance,
  contrastRatio,
  isReadableOnPaper
};
