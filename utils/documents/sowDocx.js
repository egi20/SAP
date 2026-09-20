'use strict';

const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  PageBreak,
  Header,
  Footer,
  PageNumber
} = require('docx');

const { HEX, FONT, formatNumber, formatMoney, formatDate, paletteFor, letterheadLines } = require('./brand');
const { assertDocumentOpens } = require('./validate');
const { moduleLabel, lineLabel } = require('../../config/sapProducts');
const { phaseLabel } = require('../../config/activatePhases');

/**
 * Statement of work, rendered from a stored quote.
 *
 * THE RULE: this file renders `quote.estimate` and computes nothing of its own. Every
 * figure here was produced by `utils/sapEstimation.js` and has already passed
 * `reconciliationProblems()`. A formatter that re-derives a percentage or re-rounds a cost
 * is how a document ends up contradicting the web page it came from.
 *
 * Sums that appear as totals are summations of the very rows printed above them, so a
 * reader can add the column up and get the same answer.
 */

const CELL_MARGIN = { top: 80, bottom: 80, left: 120, right: 120 };
const RIGHT = AlignmentType.RIGHT;

function text(value, options = {}) {
  return new TextRun({ text: String(value ?? ''), font: FONT, ...options });
}

function para(value, options = {}) {
  const { spacing, alignment, ...runOptions } = options;
  return new Paragraph({
    alignment,
    spacing: spacing || { after: 120 },
    children: [text(value, runOptions)]
  });
}

function bullets(items, brand = HEX) {
  return items.map(
    (item) =>
      new Paragraph({
        bullet: { level: 0 },
        spacing: { after: 80 },
        children: [text(item, { size: 20, color: brand.ink || HEX.ink })]
      })
  );
}

/**
 * @param {object} brand a palette from `paletteFor()`. Defaults to the Hub's own, so a
 *   caller with no branding renders exactly as the Hub would.
 */
function heading(value, level = HeadingLevel.HEADING_1, brand = HEX) {
  return new Paragraph({
    heading: level,
    spacing: { before: 320, after: 160 },
    children: [text(value, { bold: true, color: brand.navy, size: level === HeadingLevel.HEADING_1 ? 30 : 24 })]
  });
}

function cell(value, { bold = false, align = AlignmentType.LEFT, shade = null, color = HEX.ink, width = null } = {}) {
  return new TableCell({
    margins: CELL_MARGIN,
    width: width ? { size: width, type: WidthType.PERCENTAGE } : undefined,
    shading: shade ? { fill: shade } : undefined,
    children: [
      new Paragraph({
        alignment: align,
        spacing: { after: 0 },
        children: [text(value, { bold, color, size: 20 })]
      })
    ]
  });
}

function table(headers, rows, { widths = null, footer = null, brand = HEX } = {}) {
  const borders = {
    top: { style: BorderStyle.SINGLE, size: 2, color: HEX.rule },
    bottom: { style: BorderStyle.SINGLE, size: 2, color: HEX.rule },
    left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: HEX.rule },
    insideVertical: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }
  };

  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map((h, i) =>
      cell(h.label, {
        bold: true,
        color: 'FFFFFF',
        shade: brand.navy,
        align: h.align || AlignmentType.LEFT,
        width: widths ? widths[i] : null
      })
    )
  });

  const bodyRows = rows.map(
    (row) =>
      new TableRow({
        children: row.map((value, i) =>
          cell(value, { align: headers[i].align || AlignmentType.LEFT, width: widths ? widths[i] : null })
        )
      })
  );

  const footerRows = footer
    ? [
        new TableRow({
          children: footer.map((value, i) =>
            cell(value, {
              bold: true,
              shade: HEX.wash,
              align: headers[i].align || AlignmentType.LEFT,
              width: widths ? widths[i] : null
            })
          )
        })
      ]
    : [];

  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders, rows: [headerRow, ...bodyRows, ...footerRows] });
}

/** Cover block. Deliberately plain: a cover that overstates is the first thing a client discounts. */
function coverSection(quote, estimate, brand, branding) {
  const letterhead = letterheadLines(branding);

  return [
    ...(letterhead.length
      ? [
          new Paragraph({
            spacing: { before: 400, after: 0 },
            children: [text(letterhead[0], { bold: true, size: 22, color: brand.navy })]
          }),
          ...letterhead
            .slice(1)
            .map(
              (line) =>
                new Paragraph({ spacing: { after: 0 }, children: [text(line, { size: 18, color: HEX.inkMuted })] })
            )
        ]
      : []),

    new Paragraph({
      spacing: { before: letterhead.length ? 700 : 1200, after: 0 },
      children: [text('Statement of Work', { bold: true, size: 56, color: brand.navy })]
    }),
    new Paragraph({ spacing: { after: 480 }, children: [text(quote.project_name, { size: 32, color: brand.blue })] }),

    table(
      [{ label: 'Prepared for' }, { label: '' }],
      [
        ['Client', quote.client_company],
        ['Contact', quote.client_name || '—'],
        ['Reference', quote.reference],
        ['Date', formatDate(quote.created_at)],
        ['Transition approach', estimate.multipliers.transition.name],
        ['Estimate basis', `catalogue ${quote.catalogue_version}`]
      ],
      { widths: [30, 70], brand }
    ),

    new Paragraph({
      spacing: { before: 480 },
      children: [text('Summary', { bold: true, size: 24, color: brand.navy })]
    }),
    table(
      [{ label: 'Measure' }, { label: 'Value', align: RIGHT }],
      [
        ['Total effort', `${formatNumber(estimate.totalManDays)} consultant-days`],
        [
          'Indicative duration',
          `${estimate.projectDurationWeeks} weeks (about ${estimate.projectDurationMonths} months)`
        ],
        /*
         * Hypercare is quoted as a share OF the total, never as a line beneath it.
         *
         * The reference prints a hypercare figure next to the implementation budget and
         * then totals the two — which double-counts, because its hypercare phase is already
         * inside the effort. The wording here is load-bearing: "of which".
         */
        ...(estimate.runPhase && estimate.runPhase.included
          ? [
              [
                `Of which hypercare (${estimate.runPhase.days} days)`,
                formatMoney(estimate.runPhase.cost, estimate.currency)
              ]
            ]
          : []),
        ['Blended day rate', formatMoney(estimate.averageDailyRate, estimate.currency)]
      ],
      { widths: [55, 45], brand, footer: ['Total', formatMoney(estimate.totalBudget, estimate.currency)] }
    ),

    new Paragraph({ children: [new PageBreak()] })
  ];
}

function scopeSection(quote, estimate, brand) {
  const children = [heading('1. Scope', HeadingLevel.HEADING_1, brand)];

  if (quote.project_summary) {
    // Plain text. The stored summary was sanitised on the way in; rendering it as markup
    // here would be a second, weaker parser deciding what the author meant.
    children.push(para(String(quote.project_summary).replace(/<[^>]*>/g, '').trim(), { size: 20 }));
  }

  children.push(
    table(
      [{ label: 'Product line' }, { label: 'Basis' }, { label: 'Days', align: RIGHT }],
      estimate.lineBreakdown.map((line) => [
        line.name || lineLabel(line.id),
        `foundation ${line.foundationDays}, modules ${line.moduleDays} — the greater applies`,
        formatNumber(line.effectiveDays)
      ]),
      { widths: [32, 48, 20], brand }
    )
  );

  if (estimate.moduleBreakdown.length) {
    children.push(
      heading('1.1 Modules in scope', HeadingLevel.HEADING_2, brand),
      table(
        [{ label: 'Module' }, { label: 'Baseline days', align: RIGHT }],
        estimate.moduleBreakdown.map((m) => [m.name || moduleLabel(m.id), formatNumber(m.days)]),
        { widths: [75, 25], brand }
      )
    );
  }

  /*
   * The boundaries, stated as their own subsection rather than folded into a subtotal.
   *
   * This is the part of an SAP estimate a client most often challenges, and the answer is
   * easier to give in writing than on a call: the work exists because the module on the
   * other side is NOT in scope, and bringing it into scope would absorb it. Hiding it
   * inside a line called "integration" is how it becomes an argument later.
   */
  if (estimate.crossModuleBreakdown && estimate.crossModuleBreakdown.length) {
    children.push(
      heading('1.2 Boundaries to modules not in scope', HeadingLevel.HEADING_2, brand),
      para(
        'Each of these is an interface to a process this programme does not implement. The effort '
          + 'is an integration to a system boundary rather than configuration of the module named on '
          + 'the right, and it would be absorbed into that module if it were brought into scope.',
        { size: 20, color: HEX.inkMuted }
      ),
      table(
        [{ label: 'In scope' }, { label: 'Boundary to' }, { label: 'Days', align: RIGHT }],
        estimate.crossModuleBreakdown.map((b) => [moduleLabel(b.from), moduleLabel(b.to), formatNumber(b.days)]),
        {
          widths: [40, 40, 20],
          brand,
          footer: ['', 'Total', formatNumber(estimate.crossModuleDays)]
        }
      )
    );
  }

  if (estimate.addonBreakdown.length) {
    children.push(
      heading('1.3 Add-on products', HeadingLevel.HEADING_2, brand),
      table(
        [{ label: 'Product' }, { label: 'Category' }, { label: 'Days', align: RIGHT }],
        estimate.addonBreakdown.map((a) => [a.name, a.category, formatNumber(a.days)]),
        { widths: [50, 30, 20], brand }
      )
    );
  }

  const integrations = estimate.multipliers.integrations;
  if (integrations.count > 0) {
    children.push(
      heading('1.4 Integrations', HeadingLevel.HEADING_2, brand),
      para(
        `${integrations.count} interface(s) at ${integrations.complexity} complexity, `
          + `${integrations.daysEach} days each.`,
        { size: 20 }
      )
    );
  }

  if (estimate.unmapped && estimate.unmapped.days > 0) {
    children.push(
      heading('1.5 Scope described in free text', HeadingLevel.HEADING_2, brand),
      para(
        `${estimate.unmapped.modules} item(s) of scope, ${estimate.unmapped.addons} add-on(s) and `
          + `${estimate.unmapped.integrations} integration(s) were described in words rather than chosen `
          + `from the catalogue. They are costed at ${formatNumber(estimate.unmapped.days)} days in total `
          + `and are the first thing to firm up: an item costed at zero is an argument later.`,
        { size: 20 }
      )
    );
  }

  return children;
}

function approachSection(estimate, brand) {
  const transition = estimate.multipliers.transition;
  const cleanCore = estimate.multipliers.cleanCore;

  return [
    heading('2. Approach', HeadingLevel.HEADING_1, brand),

    heading(`2.1 ${transition.name}`, HeadingLevel.HEADING_2, brand),
    para(transition.description, { size: 20 }),

    heading(`2.2 Extensibility: ${cleanCore.name}`, HeadingLevel.HEADING_2, brand),
    para(cleanCore.description, { size: 20 }),

    heading('2.3 Phases', HeadingLevel.HEADING_2, brand),
    para(
      'SAP Activate. The phases run sequentially, so the duration below is the sum of the phase '
        + 'durations rather than the total effort divided by the team.',
      { size: 20, color: HEX.inkMuted }
    ),
    table(
      [{ label: 'Phase' }, { label: 'What happens' }, { label: 'Days', align: RIGHT }],
      estimate.phaseBreakdown
        .filter((p) => p.days > 0)
        .map((p) => [p.name || phaseLabel(p.id), p.description, formatNumber(p.days)]),
      {
        widths: [22, 58, 20],
        brand,
        footer: ['', 'Total', formatNumber(estimate.totalManDays)]
      }
    ),

    heading('2.4 Timeline', HeadingLevel.HEADING_2, brand),
    table(
      [{ label: 'Phase' }, { label: 'Weeks' }, { label: 'Quality gate' }],
      estimate.timeline.map((t) => [t.phase, `${t.startWeek}–${t.endWeek}`, t.milestone]),
      { widths: [28, 17, 55], brand }
    )
  ];
}

function commercialsSection(estimate, brand) {
  const m = estimate.multipliers;

  return [
    heading('3. Team and commercials', HeadingLevel.HEADING_1, brand),
    table(
      [
        { label: 'Role' },
        { label: 'Share', align: RIGHT },
        { label: 'Days', align: RIGHT },
        { label: 'Day rate', align: RIGHT },
        { label: 'Cost', align: RIGHT }
      ],
      estimate.resourceAllocation.map((r) => [
        r.name,
        `${r.share}%`,
        formatNumber(r.days),
        formatNumber(r.dailyRate),
        formatNumber(r.totalCost)
      ]),
      {
        widths: [34, 12, 14, 18, 22],
        brand,
        footer: [
          'Total',
          '',
          formatNumber(estimate.totalManDays),
          '',
          formatMoney(estimate.implementationBudget, estimate.currency)
        ]
      }
    ),

    heading('3.1 How the effort was derived', HeadingLevel.HEADING_2, brand),
    table(
      [{ label: 'Factor' }, { label: 'Applied' }, { label: 'Effect', align: RIGHT }],
      [
        ['Transition approach', m.transition.name, `×${m.transition.value}`],
        ['Complexity', m.complexity.description || '—', `×${m.complexity.value}`],
        ['Clean core', m.cleanCore.name, `×${m.cleanCore.value}`],
        ['Users', formatNumber(m.users.count), `×${m.users.value}`],
        ['Company codes', formatNumber(m.companyCodes.count), `×${m.companyCodes.value}`],
        ['Countries', formatNumber(m.countries.count), `×${m.countries.value}`],
        ['Industry', m.industry.name, `×${m.industry.value}`],
        ['Company size', m.companySize.name, `×${m.companySize.value}`]
      ],
      { widths: [28, 52, 20], brand }
    ),
    para(
      `Base effort ${formatNumber(estimate.baseEffort)} days plus `
        + `${estimate.contingencyPercentage}% contingency (${formatNumber(estimate.contingencyDays)} days) `
        + `gives ${formatNumber(estimate.totalManDays)} days.`,
      { size: 20, spacing: { before: 160, after: 120 } }
    )
  ];
}

function assumptionsSection(estimate, brand) {
  const assumptions = [
    'Figures are an estimate produced from the scope stated above, not a fixed price.',
    'Effort is expressed in consultant-days; a day is one person working one working day.',
    'The client provides business subject-matter experts for fit-to-standard workshops and testing.',
    'Systems, licences and environments are available at the start of the Prepare phase.',
    'Data supplied for migration is cleansed by the client before each migration cycle.',
    estimate.options.includeTraining
      ? 'End-user enablement is included as a workstream across Explore, Realize and Deploy.'
      : 'End-user enablement is NOT included and would be additional.',
    estimate.runPhase && estimate.runPhase.included
      ? `Hypercare of ${estimate.runPhase.days} days is included within the total above.`
      : 'Hypercare after go-live is NOT included and would be additional.'
  ];

  const exclusions = [
    'SAP licences, cloud subscriptions and infrastructure costs.',
    'Third-party product licences for any add-on named in section 1.',
    'Travel and accommodation, unless separately agreed.',
    'Any scope not listed in section 1.'
  ];

  return [
    heading('4. Assumptions', HeadingLevel.HEADING_1, brand),
    ...bullets(assumptions, brand),
    heading('5. Exclusions', HeadingLevel.HEADING_1, brand),
    ...bullets(exclusions, brand),
    heading('6. Validity', HeadingLevel.HEADING_1, brand),
    para(
      'This estimate reflects the catalogue and day rates in force on the date shown on the cover. '
        + 'Scope changes, a different transition approach, or a later start may change it.',
      { size: 20 }
    )
  ];
}

/**
 * @param {object} quote a row from `models/Quote.js`, with `estimate` already parsed
 * @param {object} [branding] optional company branding; colours are contrast-checked
 * @returns {Promise<Buffer>} a .docx that has been opened and parsed before being returned
 */
async function buildSowDocx(quote, branding = null) {
  const estimate = quote.estimate;
  if (!estimate || !estimate.phaseBreakdown) {
    throw new Error('That quote has no stored estimate to render.');
  }

  const brand = paletteFor(branding);
  const letterhead = letterheadLines(branding);
  const footerName = letterhead[0] || 'SAP Hub';

  const doc = new Document({
    creator: footerName,
    title: `Statement of Work — ${quote.project_name}`,
    description: `${quote.reference} for ${quote.client_company}`,
    styles: { default: { document: { run: { font: FONT, size: 20, color: HEX.ink } } } },
    sections: [
      {
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: RIGHT,
                children: [text(`${quote.reference} · ${quote.client_company}`, { size: 16, color: HEX.inkMuted })]
              })
            ]
          })
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  text(`${footerName} · `, { size: 16, color: HEX.inkMuted }),
                  new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 16, color: HEX.inkMuted })
                ]
              })
            ]
          })
        },
        children: [
          ...coverSection(quote, estimate, brand, branding),
          ...scopeSection(quote, estimate, brand),
          ...approachSection(estimate, brand),
          ...commercialsSection(estimate, brand),
          ...assumptionsSection(estimate, brand)
        ]
      }
    ]
  });

  const buffer = await Packer.toBuffer(doc);

  // Never serve a document nobody has opened. See utils/documents/validate.js.
  assertDocumentOpens(buffer, 'docx', 'statement of work');
  return buffer;
}

module.exports = { buildSowDocx };
