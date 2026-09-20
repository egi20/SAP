'use strict';

const { contrastRatio, MIN_TEXT_RATIO, normaliseHex } = require('../contrast');

/**
 * One brand definition shared by the DOCX, XLSX and PPTX generators.
 *
 * The three libraries want colours in different shapes — `docx` and `pptxgenjs` want hex
 * without a hash, `exceljs` wants an ARGB prefix — so the raw hex lives here once and each
 * generator converts. Three separate colour constants is how a deck ends up a different
 * blue from the document.
 *
 * These mirror the tokens in `public/css/style.css` and `DESIGN.md`. Changing a brand
 * colour means changing both, and that is worth a comment because nothing enforces it.
 *
 * `blue` is the INTERACTIVE blue (#0064D9), not SAP's #0070F2. Same decision as on the web
 * — see DESIGN.md — and it matters more on paper, where a document may be printed in
 * greyscale or read on a projector.
 */
const HEX = {
  navy: '00265B',
  blue: '0064D9',
  accent: '0070F2',
  ink: '16191D',
  inkMuted: '5A6673',
  rule: 'C9CFD6',
  wash: 'F6F8FA',
  ok: '2E7D5B',
  warn: 'A86A00'
};

const FONT = 'Calibri';

/** exceljs wants ARGB. */
function argb(hex) {
  return `FF${hex}`;
}

/** Format an integer with thousands separators, for document text. */
function formatNumber(value) {
  return Number(value || 0).toLocaleString('en-GB');
}

function formatMoney(value, currency) {
  return `${formatNumber(Math.round(Number(value || 0)))} ${currency}`;
}

/** ISO date, which is unambiguous in every locale a client might read it in. */
function formatDate(date = new Date()) {
  return new Date(date).toISOString().slice(0, 10);
}

/**
 * The palette one document renders with.
 *
 * A company may replace the two ACCENT colours and nothing else. Body text, rules and
 * shading stay the Hub's neutrals — a company choosing its own heading colour is branding;
 * a company choosing its own body-text colour is a company shipping an unreadable document
 * to a client under its own name.
 *
 * THE CONTRAST CHECK HAPPENS HERE, and that is a deliberate difference from the reference.
 * There, company branding is validated on the way into storage and this function only
 * guards the SHAPE, which is correct as long as storage is the only source. There is no
 * company-branding feature here yet, so a colour could only arrive from a caller — and a
 * function that trusts its caller's colour is the one that eventually renders white text
 * on pale yellow. Both checks are cheap; a refused colour falls back to the Hub's own
 * rather than failing the document.
 */
function paletteFor(branding) {
  const colours = (branding && branding.colours) || {};
  const palette = { ...HEX };

  for (const key of ['navy', 'blue']) {
    const normalised = normaliseHex(colours[key]);
    if (!normalised) continue;
    // Headings sit on white paper, so the floor is the same one DESIGN.md sets on screen.
    if (contrastRatio(normalised, 'FFFFFF') < MIN_TEXT_RATIO) continue;
    palette[key] = normalised;
  }

  return palette;
}

/**
 * The letterhead lines, in the order they are printed, with nothing empty in between.
 *
 * Returns an empty array when a company has configured none, which is what lets every
 * generator render the block unconditionally instead of branching on whether it exists.
 */
function letterheadLines(branding) {
  const head = (branding && branding.letterhead) || {};

  return [
    head.legal_name,
    head.address,
    [head.contact_email, head.contact_phone].filter(Boolean).join('  ·  ') || null,
    head.website,
    [
      head.registration_number ? `Reg. ${head.registration_number}` : null,
      head.vat_number ? `VAT ${head.vat_number}` : null
    ]
      .filter(Boolean)
      .join('  ·  ') || null
  ].filter(Boolean);
}

module.exports = {
  HEX,
  FONT,
  argb,
  formatNumber,
  formatMoney,
  formatDate,
  paletteFor,
  letterheadLines
};
