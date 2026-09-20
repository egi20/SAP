'use strict';

const ExcelJS = require('exceljs');

const { HEX, argb, formatDate, paletteFor } = require('./brand');
const { assertDocumentOpens } = require('./validate');
const { moduleLabel, lineLabel } = require('../../config/sapProducts');

/**
 * Work-breakdown workbook, rendered from a stored quote.
 *
 * Same rule as the SOW: every number comes from `quote.estimate`, which has already passed
 * reconciliation. Where a total appears it is an Excel SUM over the very cells above it, so
 * a reader who changes a cell sees the total move — and a reader who changes nothing sees
 * the same figure the document and the web page show.
 */

/** Built per document rather than module-level: two workbooks can generate at once. */
function headerFill(brand) {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(brand.navy) } };
}
const SUBHEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(HEX.wash) } };
const GANTT_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(HEX.blue) } };
const BOUNDARY_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb('FFF3CD') } };
const THIN_BORDER = { style: 'thin', color: { argb: argb(HEX.rule) } };

function styleHeaderRow(row, brand) {
  row.eachCell((cellRef) => {
    cellRef.fill = headerFill(brand);
    cellRef.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cellRef.alignment = { vertical: 'middle', wrapText: true };
    cellRef.border = { bottom: THIN_BORDER };
  });
  row.height = 22;
}

function styleTotalRow(row) {
  row.eachCell((cellRef) => {
    cellRef.fill = SUBHEADER_FILL;
    cellRef.font = { bold: true };
    cellRef.border = { top: THIN_BORDER, bottom: THIN_BORDER };
  });
}

function addTitle(sheet, title, subtitle, brand, span = 'A1:D1') {
  sheet.mergeCells(span);
  const cellRef = sheet.getCell('A1');
  cellRef.value = title;
  cellRef.font = { bold: true, size: 16, color: { argb: argb(brand.navy) } };
  sheet.getRow(1).height = 24;

  if (subtitle) {
    sheet.mergeCells(span.replace(/1/g, '2'));
    const sub = sheet.getCell('A2');
    sub.value = subtitle;
    sub.font = { size: 10, color: { argb: argb(HEX.inkMuted) } };
  }
}

function summarySheet(workbook, quote, estimate, brand) {
  const sheet = workbook.addWorksheet('Summary', { views: [{ showGridLines: false }] });
  sheet.columns = [{ width: 36 }, { width: 32 }, { width: 18 }, { width: 18 }];

  addTitle(sheet, quote.project_name, `${quote.reference} · ${quote.client_company}`, brand);

  sheet.addRow([]);
  const rows = [
    ['Client', quote.client_company],
    ['Contact', quote.client_name || '—'],
    ['Date', formatDate(quote.created_at)],
    ['Transition approach', estimate.multipliers.transition.name],
    ['Extensibility', estimate.multipliers.cleanCore.name],
    ['Estimate basis', `catalogue ${quote.catalogue_version}`],
    [],
    ['Total effort (days)', estimate.totalManDays],
    ['Duration (weeks)', estimate.projectDurationWeeks],
    ['Implementation budget', estimate.implementationBudget],
    ['Blended day rate', estimate.averageDailyRate],
    ['Currency', estimate.currency]
  ];

  if (estimate.runPhase && estimate.runPhase.included) {
    // "Of which", never a line added beneath the total. See the SOW for the same wording.
    rows.push(['Of which hypercare (days)', estimate.runPhase.days]);
  }

  for (const row of rows) {
    const added = sheet.addRow(row);
    added.getCell(1).font = { bold: true, color: { argb: argb(HEX.ink) } };
  }

  return sheet;
}

/**
 * The work breakdown, with a week-by-week bar per phase.
 *
 * The Gantt is real cells rather than a picture: a reader can widen a phase, insert a row
 * or filter it. A rendered image would be prettier and useless the moment anybody wants to
 * work with it, which on a work breakdown is immediately.
 */
function wbsSheet(workbook, quote, estimate, brand) {
  const sheet = workbook.addWorksheet('WBS', {
    views: [{ state: 'frozen', xSplit: 1, ySplit: 4 }]
  });

  const totalWeeks = estimate.projectDurationWeeks;
  sheet.columns = [
    { width: 26 },
    { width: 10 },
    { width: 12 },
    { width: 34 },
    ...Array.from({ length: totalWeeks }, () => ({ width: 3.2 }))
  ];

  addTitle(sheet, 'Work breakdown', `${quote.reference} · SAP Activate phases, run sequentially`, brand, 'A1:D1');
  sheet.addRow([]);

  const header = sheet.addRow([
    'Phase',
    'Days',
    'Weeks',
    'Quality gate',
    ...Array.from({ length: totalWeeks }, (unused, i) => i + 1)
  ]);
  styleHeaderRow(header, brand);

  const firstDataRow = header.number + 1;

  for (const entry of estimate.timeline) {
    const row = sheet.addRow([entry.phase, entry.days, entry.durationWeeks, entry.milestone]);

    for (let week = entry.startWeek; week <= entry.endWeek; week += 1) {
      const cellRef = row.getCell(4 + week);
      cellRef.fill = GANTT_FILL;
      cellRef.border = { top: THIN_BORDER, bottom: THIN_BORDER };
    }
  }

  const lastDataRow = sheet.lastRow.number;

  /*
   * A real SUM over the printed cells, not the stored total typed in again.
   *
   * They agree today because the estimate reconciles. Writing the stored figure here
   * instead would mean the one case where they disagree — a hand-edited row — is the case
   * the reader cannot see.
   */
  const totals = sheet.addRow([
    'Total',
    { formula: `SUM(B${firstDataRow}:B${lastDataRow})` },
    { formula: `SUM(C${firstDataRow}:C${lastDataRow})` },
    ''
  ]);
  styleTotalRow(totals);

  return sheet;
}

function scopeSheet(workbook, estimate, brand) {
  const sheet = workbook.addWorksheet('Scope');
  sheet.columns = [{ width: 38 }, { width: 34 }, { width: 12 }];

  addTitle(sheet, 'Scope', 'Every line that contributed effort', brand, 'A1:C1');
  sheet.addRow([]);

  const header = sheet.addRow(['Item', 'Basis', 'Days']);
  styleHeaderRow(header, brand);
  const firstDataRow = header.number + 1;

  for (const line of estimate.lineBreakdown) {
    sheet.addRow([
      line.name || lineLabel(line.id),
      `foundation ${line.foundationDays} / modules ${line.moduleDays}`,
      line.effectiveDays
    ]);
  }

  for (const module of estimate.moduleBreakdown) {
    sheet.addRow([`  ${module.name || moduleLabel(module.id)}`, 'module baseline', module.days]);
  }

  /*
   * Boundaries are shaded, because they are the rows a client asks about.
   *
   * They are also the rows most easily mistaken for double-charging a module that is
   * already listed above — so the basis column says, on every one of them, which module is
   * NOT in scope.
   */
  for (const boundary of estimate.crossModuleBreakdown || []) {
    const row = sheet.addRow([
      `  ${moduleLabel(boundary.from)} → ${moduleLabel(boundary.to)}`,
      `boundary — ${moduleLabel(boundary.to)} not in scope`,
      boundary.days
    ]);
    row.eachCell((cellRef) => {
      cellRef.fill = BOUNDARY_FILL;
    });
  }

  for (const addon of estimate.addonBreakdown) {
    sheet.addRow([addon.name, `add-on · ${addon.category}`, addon.days]);
  }

  const integrations = estimate.multipliers.integrations;
  if (integrations.count > 0) {
    sheet.addRow([
      `${integrations.count} integration(s)`,
      `${integrations.complexity} · ${integrations.daysEach} days each`,
      integrations.count * integrations.daysEach
    ]);
  }

  if (estimate.unmapped && estimate.unmapped.days > 0) {
    sheet.addRow(['Scope described in free text', 'costed, not ignored', estimate.unmapped.days]);
  }

  const lastDataRow = sheet.lastRow.number;
  const totals = sheet.addRow([
    'Before multipliers and contingency',
    '',
    { formula: `SUM(C${firstDataRow}:C${lastDataRow})` }
  ]);
  styleTotalRow(totals);

  /*
   * Said plainly, because the column does NOT add up to the headline figure and a reader
   * who adds it up deserves to know why before they email about it. The multipliers are on
   * the Team sheet; this column is the scope before any of them.
   */
  sheet.addRow([]);
  const note = sheet.addRow([
    'This column is the scope before multipliers and contingency. See "Team & cost" for how it '
      + `becomes ${estimate.totalManDays} days.`
  ]);
  note.getCell(1).font = { italic: true, size: 10, color: { argb: argb(HEX.inkMuted) } };

  return sheet;
}

function teamSheet(workbook, estimate, brand) {
  const sheet = workbook.addWorksheet('Team & cost');
  sheet.columns = [{ width: 32 }, { width: 10 }, { width: 10 }, { width: 14 }, { width: 16 }];

  addTitle(sheet, 'Team and cost', 'Days × rate, on whole numbers', brand, 'A1:E1');
  sheet.addRow([]);

  const header = sheet.addRow(['Role', 'Share', 'Days', 'Day rate', 'Cost']);
  styleHeaderRow(header, brand);
  const firstDataRow = header.number + 1;

  for (const resource of estimate.resourceAllocation) {
    const row = sheet.addRow([resource.name, resource.share / 100, resource.days, resource.dailyRate, null]);
    row.getCell(2).numFmt = '0%';
    // The cost is a formula over the two cells beside it, so the arithmetic is visible.
    row.getCell(5).value = { formula: `C${row.number}*D${row.number}` };
    row.getCell(4).numFmt = '#,##0';
    row.getCell(5).numFmt = '#,##0';
  }

  const lastDataRow = sheet.lastRow.number;
  const totals = sheet.addRow([
    'Total',
    null,
    { formula: `SUM(C${firstDataRow}:C${lastDataRow})` },
    null,
    { formula: `SUM(E${firstDataRow}:E${lastDataRow})` }
  ]);
  totals.getCell(5).numFmt = '#,##0';
  styleTotalRow(totals);

  sheet.addRow([]);
  const m = estimate.multipliers;
  const multiplierHeader = sheet.addRow(['Factor', 'Applied', '', '', 'Effect']);
  styleHeaderRow(multiplierHeader, brand);

  const factors = [
    ['Transition approach', m.transition.name, m.transition.value],
    ['Complexity', m.complexity.description || '—', m.complexity.value],
    ['Clean core', m.cleanCore.name, m.cleanCore.value],
    ['Users', m.users.count, m.users.value],
    ['Company codes', m.companyCodes.count, m.companyCodes.value],
    ['Countries', m.countries.count, m.countries.value],
    ['Industry', m.industry.name, m.industry.value],
    ['Company size', m.companySize.name, m.companySize.value]
  ];
  for (const [label, applied, effect] of factors) {
    const row = sheet.addRow([label, applied, '', '', effect]);
    row.getCell(5).numFmt = '0.00"×"';
  }

  sheet.addRow([]);
  sheet.addRow(['Base effort (days)', null, null, null, estimate.baseEffort]);
  sheet.addRow([`Contingency (${estimate.contingencyPercentage}%)`, null, null, null, estimate.contingencyDays]);
  const grand = sheet.addRow(['Total effort (days)', null, null, null, estimate.totalManDays]);
  styleTotalRow(grand);

  return sheet;
}

/**
 * @param {object} quote a row from `models/Quote.js`, with `estimate` already parsed
 * @param {object} [branding] optional company branding; colours are contrast-checked
 * @returns {Promise<Buffer>} an .xlsx that has been opened and parsed before being returned
 */
async function buildWbsXlsx(quote, branding = null) {
  const estimate = quote.estimate;
  if (!estimate || !estimate.timeline) {
    throw new Error('That quote has no stored estimate to render.');
  }

  const brand = paletteFor(branding);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'SAP Hub';
  workbook.created = new Date(quote.created_at || Date.now());

  summarySheet(workbook, quote, estimate, brand);
  wbsSheet(workbook, quote, estimate, brand);
  scopeSheet(workbook, estimate, brand);
  teamSheet(workbook, estimate, brand);

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

  assertDocumentOpens(buffer, 'xlsx', 'work breakdown');
  return buffer;
}

module.exports = { buildWbsXlsx };
