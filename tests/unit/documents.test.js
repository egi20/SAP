'use strict';

const PizZip = require('pizzip');

const { buildSowDocx } = require('../../utils/documents/sowDocx');
const { buildWbsXlsx } = require('../../utils/documents/wbsXlsx');
const { buildSummaryPptx } = require('../../utils/documents/summaryPptx');
const { inspectDocument, escapeXml, assertWellFormedXml } = require('../../utils/documents/validate');
const { paletteFor, HEX, formatMoney } = require('../../utils/documents/brand');
const { filenameFor, generatePackage, isDocumentKind } = require('../../services/quotePackage');
const { calculateEstimation } = require('../../utils/sapEstimation');

const estimate = calculateEstimation({
  selectedModules: ['fi-gl', 'co-cca', 'sd-sales'],
  selectedAddons: ['addon-vertex'],
  transitionApproach: 'brownfield',
  numberOfUsers: 600,
  numberOfCompanyCodes: 3,
  numberOfCountries: 2,
  numberOfIntegrations: 5,
  clientIndustry: 'Manufacturing',
  companySize: 'Large (501-5000)'
});

const quote = {
  reference: 'Q-TEST1234',
  project_name: 'S/4HANA finance core',
  client_company: 'Acme Manufacturing GmbH',
  client_name: 'A Buyer',
  created_at: new Date('2026-09-01T00:00:00Z'),
  catalogue_version: 'abc123def456',
  project_summary: '<p>Finance and order-to-cash.</p>',
  estimate
};

/** Pull the readable text out of an Open XML part, so a figure can be looked for. */
function textOf(buffer, part) {
  const zip = new PizZip(buffer);
  return zip
    .file(part)
    .asText()
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}

describe('every generator validates its own output', () => {
  test('SOW', async () => {
    const buffer = await buildSowDocx(quote);
    expect(inspectDocument(buffer, 'docx').ok).toBe(true);
  });

  test('work breakdown', async () => {
    const buffer = await buildWbsXlsx(quote);
    expect(inspectDocument(buffer, 'xlsx').ok).toBe(true);
  });

  test('deck', async () => {
    const buffer = await buildSummaryPptx(quote);
    expect(inspectDocument(buffer, 'pptx').ok).toBe(true);
  });

  test('a quote with no stored estimate is refused rather than rendered empty', async () => {
    await expect(buildSowDocx({ ...quote, estimate: null })).rejects.toThrow(/no stored estimate/);
    await expect(buildWbsXlsx({ ...quote, estimate: null })).rejects.toThrow(/no stored estimate/);
    await expect(buildSummaryPptx({ ...quote, estimate: null })).rejects.toThrow(/no stored estimate/);
  });
});

describe('the documents render the estimate and derive nothing', () => {
  test('the SOW prints the stored totals, not recomputed ones', async () => {
    const text = textOf(await buildSowDocx(quote), 'word/document.xml');

    expect(text).toContain(estimate.totalManDays.toLocaleString('en-GB'));
    expect(text).toContain(formatMoney(estimate.totalBudget, estimate.currency));
    expect(text).toContain(estimate.multipliers.transition.name);
    expect(text).toContain(quote.reference);
    expect(text).toContain(quote.client_company);
  });

  test('the SOW quotes hypercare as a share OF the total, never as a line beneath it', async () => {
    const text = textOf(await buildSowDocx(quote), 'word/document.xml');
    // The wording is the guard against the reference's double count coming back through a
    // formatter rather than through the engine.
    expect(text).toMatch(/Of which hypercare/);
    expect(text).not.toMatch(/Hypercare\s+\d/); // never its own addable line
  });

  test('the SOW states the boundaries as their own section', async () => {
    const text = textOf(await buildSowDocx(quote), 'word/document.xml');
    expect(estimate.crossModuleBreakdown.length).toBeGreaterThan(0);
    expect(text).toContain('Boundaries to modules not in scope');
    expect(text).toContain(String(estimate.crossModuleDays));
  });

  test('the SOW says what free-text scope was costed at, rather than hiding it', async () => {
    const withFreeText = {
      ...quote,
      estimate: calculateEstimation({ selectedModules: ['fi-gl'], otherModules: 'payroll interface, bank statements' })
    };
    const text = textOf(await buildSowDocx(withFreeText), 'word/document.xml');
    expect(text).toContain('Scope described in free text');
  });

  test('the workbook totals are formulas over the printed cells, not the stored number typed again', async () => {
    const sheet = new PizZip(await buildWbsXlsx(quote)).file('xl/worksheets/sheet2.xml').asText();
    expect(sheet).toMatch(/SUM\(B\d+:B\d+\)/);
    expect(sheet).toMatch(/SUM\(C\d+:C\d+\)/);
  });

  test('the deck carries a slide per message and no more', async () => {
    const zip = new PizZip(await buildSummaryPptx(quote));
    const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    // title, headline, scope, boundaries, phases, team, next steps
    expect(slides).toHaveLength(7);
  });

  test('the boundary slide is absent when there are no boundaries', async () => {
    const noBoundaries = { ...quote, estimate: calculateEstimation({ selectedModules: ['fi-gl'] }) };
    expect(noBoundaries.estimate.crossModuleBreakdown).toHaveLength(0);

    const zip = new PizZip(await buildSummaryPptx(noBoundaries));
    const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    expect(slides).toHaveLength(6);
  });
});

describe('an ordinary company name does not break the deck', () => {
  /*
   * pptxgenjs escapes slide text but writes `author`, `company`, `title` and `subject`
   * straight into docProps. "Smith & Jones Ltd" is about as ordinary as a name gets, and it
   * produced a raw ampersand in XML and a file that would not open. The generator escapes
   * those four properties; these tests pin both halves — that the escaping works, and that
   * the validator would have caught it if it did not.
   */
  test('a name with an ampersand still produces a deck that opens', async () => {
    const buffer = await buildSummaryPptx({ ...quote, client_company: 'Smith & Jones Ltd' });
    expect(inspectDocument(buffer, 'pptx').ok).toBe(true);
  });

  test('every metadata-hostile character survives all three formats', async () => {
    const hostile = { ...quote, client_company: 'A&B <Ltd> "quoted" \'apostrophe\'', project_name: 'Phase 1 & 2' };
    for (const [build, kind] of [[buildSowDocx, 'docx'], [buildWbsXlsx, 'xlsx'], [buildSummaryPptx, 'pptx']]) {
      // eslint-disable-next-line no-await-in-loop
      const buffer = await build(hostile);
      expect({ kind, ok: inspectDocument(buffer, kind).ok }).toEqual({ kind, ok: true });
    }
  });

  test('the validator rejects XML it cannot parse, which is what makes the above meaningful', () => {
    expect(() => assertWellFormedXml('<a>Smith & Jones</a>', 'test.xml')).toThrow(/Malformed XML/);
    expect(() => assertWellFormedXml(`<a>${escapeXml('Smith & Jones')}</a>`, 'test.xml')).not.toThrow();
  });

  test('a buffer that is not a zip is refused before anything tries to open it', () => {
    expect(inspectDocument(Buffer.from('not a document'), 'docx')).toMatchObject({ ok: false });
    expect(inspectDocument(Buffer.alloc(0), 'docx')).toMatchObject({ ok: false });
  });
});

describe('branding cannot make a document unreadable', () => {
  test('a colour below the contrast floor is refused and the default stands', () => {
    expect(paletteFor({ colours: { navy: 'FFF3A0' } }).navy).toBe(HEX.navy);
  });

  test('a readable colour is accepted', () => {
    expect(paletteFor({ colours: { navy: '6A1B4D' } }).navy).toBe('6A1B4D');
  });

  test('a malformed value is ignored rather than reaching the generator', () => {
    for (const bad of ['not-a-colour', '#12', null, 42, { r: 1 }]) {
      expect(paletteFor({ colours: { navy: bad } }).navy).toBe(HEX.navy);
    }
  });

  test('body text is never brandable — only the two accents are', () => {
    const palette = paletteFor({ colours: { navy: '6A1B4D', ink: 'EEEEEE', rule: 'FFFFFF' } });
    expect(palette.ink).toBe(HEX.ink);
    expect(palette.rule).toBe(HEX.rule);
  });
});

describe('filenames are safe as a header value', () => {
  test('a project name with a slash, quotes or a newline cannot escape the header', () => {
    const name = filenameFor({ reference: 'Q-ABC', project_name: 'Müller & Co / "phase" 2\nx' }, 'package');
    expect(name).toBe('q-abc-muller-co-phase-2-x.zip');
    expect(name).not.toMatch(/["/\\\r\n]/);
  });

  test('a project name of nothing but punctuation falls back to the reference', () => {
    expect(filenameFor({ reference: 'Q-ABC', project_name: '///' }, 'sow')).toBe('q-abc.docx');
  });

  test('each kind gets its own extension', () => {
    const q = { reference: 'Q-ABC', project_name: 'Thing' };
    expect(filenameFor(q, 'sow')).toMatch(/\.docx$/);
    expect(filenameFor(q, 'wbs')).toMatch(/\.xlsx$/);
    expect(filenameFor(q, 'deck')).toMatch(/\.pptx$/);
    expect(filenameFor(q, 'package')).toMatch(/\.zip$/);
  });

  test('an unknown kind is not a document kind', () => {
    expect(isDocumentKind('exe')).toBe(false);
    expect(isDocumentKind('__proto__')).toBe(false);
  });
});

describe('the package', () => {
  test('carries all three documents and a readme naming the basis', async () => {
    const pkg = await generatePackage(quote);
    const zip = new PizZip(pkg.buffer);
    const names = Object.keys(zip.files);

    expect(names).toHaveLength(4);
    expect(names.some((n) => n.endsWith('.docx'))).toBe(true);
    expect(names.some((n) => n.endsWith('.xlsx'))).toBe(true);
    expect(names.some((n) => n.endsWith('.pptx'))).toBe(true);

    const readme = zip.file('README.txt').asText();
    expect(readme).toContain(quote.catalogue_version);
    expect(readme).toContain('An estimate, not a fixed price.');
    expect(readme).toContain(String(estimate.totalManDays));
  });

  test('every document inside it opens', async () => {
    const zip = new PizZip((await generatePackage(quote)).buffer);
    for (const [name, kind] of [['docx', 'docx'], ['xlsx', 'xlsx'], ['pptx', 'pptx']]) {
      const file = Object.keys(zip.files).find((n) => n.endsWith(`.${name}`));
      const buffer = Buffer.from(zip.file(file).asUint8Array());
      expect({ name, ok: inspectDocument(buffer, kind).ok }).toEqual({ name, ok: true });
    }
  });
});
