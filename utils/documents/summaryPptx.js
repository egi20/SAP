'use strict';

const PptxGenJS = require('pptxgenjs');

const { HEX, FONT, formatNumber, formatMoney, formatDate, paletteFor } = require('./brand');
const { assertDocumentOpens, escapeXml } = require('./validate');
const { moduleLabel } = require('../../config/sapProducts');

/**
 * Client-facing summary deck, rendered from a stored quote.
 *
 * Same rule as the other two generators: it formats `quote.estimate` and derives nothing. A
 * deck that rounds differently from the SOW is the version a client quotes back at you in a
 * meeting.
 *
 * Deliberately restrained: seven slides, one message each. A deck that repeats the whole
 * workbook is not read.
 */

const LAYOUT = { name: 'HUB16x9', width: 13.333, height: 7.5 };
const MARGIN = 0.6;
const CONTENT_WIDTH = LAYOUT.width - MARGIN * 2;

function addSlide(pptx, title, subtitle, brand) {
  const slide = pptx.addSlide();
  slide.background = { color: 'FFFFFF' };

  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: LAYOUT.width, h: 0.12, fill: { color: brand.blue } });

  slide.addText(title, {
    x: MARGIN,
    y: 0.45,
    w: CONTENT_WIDTH,
    h: 0.6,
    fontFace: FONT,
    fontSize: 26,
    bold: true,
    color: brand.navy
  });

  if (subtitle) {
    slide.addText(subtitle, {
      x: MARGIN,
      y: 1.02,
      w: CONTENT_WIDTH,
      h: 0.35,
      fontFace: FONT,
      fontSize: 13,
      color: HEX.inkMuted
    });
  }

  return slide;
}

/** A row of big numbers. The only place in the deck where a figure is allowed to be large. */
function addStatRow(slide, stats, brand, y = 1.9) {
  const gap = 0.3;
  const width = (CONTENT_WIDTH - gap * (stats.length - 1)) / stats.length;

  stats.forEach((stat, index) => {
    const x = MARGIN + index * (width + gap);

    slide.addShape(slide._pptx ? 'rect' : 'rect', {
      x,
      y,
      w: width,
      h: 1.5,
      fill: { color: HEX.wash },
      line: { color: HEX.rule, width: 0.5 }
    });
    slide.addText(String(stat.value), {
      x,
      y: y + 0.18,
      w: width,
      h: 0.75,
      align: 'center',
      fontFace: FONT,
      fontSize: 34,
      bold: true,
      color: brand.navy
    });
    slide.addText(stat.label, {
      x,
      y: y + 0.95,
      w: width,
      h: 0.4,
      align: 'center',
      fontFace: FONT,
      fontSize: 11,
      color: HEX.inkMuted
    });
  });
}

function addTable(slide, headers, rows, brand, options = {}) {
  const head = headers.map((h) => ({
    text: h,
    options: { bold: true, color: 'FFFFFF', fill: { color: brand.navy }, fontFace: FONT, fontSize: 11 }
  }));

  const body = rows.map((row) =>
    row.map((value) => ({
      text: String(value),
      options: { fontFace: FONT, fontSize: 11, color: HEX.ink }
    }))
  );

  slide.addTable([head, ...body], {
    x: MARGIN,
    y: options.y || 1.7,
    w: CONTENT_WIDTH,
    colW: options.colW,
    border: { type: 'solid', color: HEX.rule, pt: 0.5 },
    rowH: options.rowH || 0.32,
    valign: 'middle'
  });
}

function titleSlide(pptx, quote, estimate, brand, preparedBy) {
  const slide = pptx.addSlide();
  slide.background = { color: brand.navy };

  slide.addText(quote.project_name, {
    x: MARGIN,
    y: 2.3,
    w: CONTENT_WIDTH,
    h: 1.2,
    fontFace: FONT,
    fontSize: 40,
    bold: true,
    color: 'FFFFFF'
  });

  slide.addText(
    `Prepared for ${quote.client_company}${quote.client_name ? ` · ${quote.client_name}` : ''}`,
    { x: MARGIN, y: 3.5, w: CONTENT_WIDTH, h: 0.5, fontFace: FONT, fontSize: 16, color: 'D6E4F7' }
  );

  slide.addText(
    `${estimate.multipliers.transition.name}  ·  ${quote.reference}  ·  ${formatDate(quote.created_at)}`,
    { x: MARGIN, y: 4.05, w: CONTENT_WIDTH, h: 0.4, fontFace: FONT, fontSize: 12, color: '9FC0E8' }
  );

  slide.addText(preparedBy, {
    x: MARGIN,
    y: 6.5,
    w: CONTENT_WIDTH,
    h: 0.4,
    fontFace: FONT,
    fontSize: 12,
    color: '9FC0E8'
  });

  return slide;
}

function headlineSlide(pptx, estimate, brand) {
  const slide = addSlide(pptx, 'The headline', 'Every figure in this deck comes from the same estimate', brand);

  addStatRow(
    slide,
    [
      { value: formatNumber(estimate.totalManDays), label: 'Consultant-days' },
      { value: estimate.projectDurationWeeks, label: 'Weeks' },
      { value: formatNumber(estimate.implementationBudget), label: `Budget (${estimate.currency})` },
      { value: formatNumber(estimate.averageDailyRate), label: `Blended day rate (${estimate.currency})` }
    ],
    brand
  );

  const lines = [
    `Base effort ${formatNumber(estimate.baseEffort)} days plus ${estimate.contingencyPercentage}% contingency.`,
    `${estimate.multipliers.transition.name}. ${estimate.multipliers.transition.description}`
  ];

  if (estimate.runPhase && estimate.runPhase.included) {
    lines.push(
      `Hypercare of ${estimate.runPhase.days} days is inside this total, not added to it.`
    );
  }

  slide.addText(lines.map((t) => ({ text: t, options: { bullet: true } })), {
    x: MARGIN,
    y: 3.7,
    w: CONTENT_WIDTH,
    h: 1.6,
    fontFace: FONT,
    fontSize: 13,
    color: HEX.ink
  });

  return slide;
}

function scopeSlide(pptx, estimate, brand) {
  const slide = addSlide(pptx, 'What is in scope', null, brand);

  addTable(
    slide,
    ['Product line', 'Days'],
    estimate.lineBreakdown.map((l) => [l.name, formatNumber(l.effectiveDays)]),
    brand,
    { colW: [9.5, 2.6] }
  );

  if (estimate.moduleBreakdown.length) {
    slide.addText(
      `Modules: ${estimate.moduleBreakdown.map((m) => m.name || moduleLabel(m.id)).join(', ')}`,
      { x: MARGIN, y: 5.4, w: CONTENT_WIDTH, h: 1.2, fontFace: FONT, fontSize: 12, color: HEX.inkMuted }
    );
  }

  return slide;
}

/**
 * The boundaries get their own slide when there are any.
 *
 * It is the question that comes up in the meeting this deck is presented in, and the answer
 * is easier to give with the pairs on a screen than from memory.
 */
function boundarySlide(pptx, estimate, brand) {
  if (!estimate.crossModuleBreakdown || !estimate.crossModuleBreakdown.length) return null;

  const slide = addSlide(
    pptx,
    'Boundaries to what is not in scope',
    `${formatNumber(estimate.crossModuleDays)} days of interfaces to processes this programme does not implement`,
    brand
  );

  addTable(
    slide,
    ['In scope', 'Boundary to', 'Days'],
    estimate.crossModuleBreakdown.map((b) => [moduleLabel(b.from), moduleLabel(b.to), formatNumber(b.days)]),
    brand,
    { colW: [5, 5, 2.1] }
  );

  slide.addText(
    'Bringing the module on the right into scope would absorb this work rather than add to it.',
    { x: MARGIN, y: 6.3, w: CONTENT_WIDTH, h: 0.5, fontFace: FONT, fontSize: 12, color: HEX.inkMuted }
  );

  return slide;
}

function phaseSlide(pptx, estimate, brand) {
  const slide = addSlide(pptx, 'How it runs', 'SAP Activate, phase by phase', brand);

  addTable(
    slide,
    ['Phase', 'Weeks', 'Days', 'Quality gate'],
    estimate.timeline.map((t) => [t.phase, `${t.startWeek}–${t.endWeek}`, formatNumber(t.days), t.milestone]),
    brand,
    { colW: [2.4, 1.4, 1.2, 7.1] }
  );

  return slide;
}

function teamSlide(pptx, estimate, brand) {
  const slide = addSlide(pptx, 'The team', 'Days × rate, on whole numbers', brand);

  addTable(
    slide,
    ['Role', 'Share', 'Days', 'Cost'],
    [
      ...estimate.resourceAllocation.map((r) => [
        r.name,
        `${r.share}%`,
        formatNumber(r.days),
        formatNumber(r.totalCost)
      ]),
      [
        'Total',
        '',
        formatNumber(estimate.totalManDays),
        formatMoney(estimate.implementationBudget, estimate.currency)
      ]
    ],
    brand,
    { colW: [5.6, 1.6, 1.6, 3.3] }
  );

  return slide;
}

function nextStepsSlide(pptx, estimate, brand) {
  const slide = addSlide(pptx, 'What happens next', null, brand);

  const steps = [
    'Confirm the transition approach — it is the single biggest lever on this number.',
    'Firm up anything described in free text; those items are estimated, not scoped.',
    'Agree the modules in scope, and therefore which boundaries disappear.',
    'Confirm system availability for the start of Prepare.',
    'Sign the statement of work that accompanies this deck.'
  ];

  slide.addText(steps.map((t) => ({ text: t, options: { bullet: true } })), {
    x: MARGIN,
    y: 1.8,
    w: CONTENT_WIDTH,
    h: 3,
    fontFace: FONT,
    fontSize: 15,
    color: HEX.ink,
    lineSpacingMultiple: 1.4
  });

  slide.addText(
    'This is an estimate produced from the scope stated in the statement of work, not a fixed price.',
    { x: MARGIN, y: 6.3, w: CONTENT_WIDTH, h: 0.5, fontFace: FONT, fontSize: 12, italic: true, color: HEX.inkMuted }
  );

  return slide;
}

/**
 * @param {object} quote a row from `models/Quote.js`, with `estimate` already parsed
 * @param {object} [branding] optional company branding; colours are contrast-checked
 * @returns {Promise<Buffer>} a .pptx that has been opened and parsed before being returned
 */
async function buildSummaryPptx(quote, branding = null) {
  const estimate = quote.estimate;
  if (!estimate || !estimate.timeline) {
    throw new Error('That quote has no stored estimate to render.');
  }

  const brand = paletteFor(branding);
  const pptx = new PptxGenJS();
  pptx.defineLayout(LAYOUT);
  pptx.layout = LAYOUT.name;

  const preparedBy = (branding && branding.letterhead && branding.letterhead.legal_name) || 'SAP Hub';

  /*
   * ESCAPED, and this is a real bug rather than caution.
   *
   * pptxgenjs escapes slide text but writes `author`, `company`, `title` and `subject`
   * straight into `docProps/`. A company called "Smith & Jones Ltd" — about as ordinary as a
   * name gets — produces a raw `&` in XML and a deck that will not open. The client company
   * name is worse, because it is whatever somebody typed into a form.
   *
   * The validator below would catch it, but only by refusing to produce the deck at all;
   * escaping here means the deck is produced and the name is right.
   */
  pptx.author = escapeXml(preparedBy);
  pptx.company = escapeXml(preparedBy);
  pptx.title = escapeXml(`Statement of Work — ${quote.project_name}`);
  pptx.subject = escapeXml(`Prepared for ${quote.client_company}`);

  titleSlide(pptx, quote, estimate, brand, preparedBy);
  headlineSlide(pptx, estimate, brand);
  scopeSlide(pptx, estimate, brand);
  boundarySlide(pptx, estimate, brand);
  phaseSlide(pptx, estimate, brand);
  teamSlide(pptx, estimate, brand);
  nextStepsSlide(pptx, estimate, brand);

  const buffer = Buffer.from(await pptx.write({ outputType: 'nodebuffer' }));

  assertDocumentOpens(buffer, 'pptx', 'summary deck');
  return buffer;
}

module.exports = { buildSummaryPptx };
