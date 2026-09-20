'use strict';

const archiver = require('archiver');

const { buildSowDocx } = require('../utils/documents/sowDocx');
const { buildWbsXlsx } = require('../utils/documents/wbsXlsx');
const { buildSummaryPptx } = require('../utils/documents/summaryPptx');
const { slugify } = require('../utils/slug');

/**
 * Deliverables produced from a stored quote.
 *
 * GENERATED ON DEMAND, NEVER STORED. Storing them would mean two sources of truth for the
 * same figures: the stored file and the stored estimate, diverging the moment anybody
 * regenerates one of them. The estimate is the record; a document is a rendering of it.
 *
 * Each generator validates its own output — it opens the package and parses every XML part
 * — before returning, so a file that will not open never reaches the response. See
 * `utils/documents/validate.js` for why a presence check is not enough.
 */
const DOCUMENT_KINDS = Object.freeze({
  sow: {
    label: 'Statement of work',
    extension: 'docx',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    build: buildSowDocx
  },
  wbs: {
    label: 'Work breakdown',
    extension: 'xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    build: buildWbsXlsx
  },
  deck: {
    label: 'Summary deck',
    extension: 'pptx',
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    build: buildSummaryPptx
  }
});

const PACKAGE_KIND = 'package';

function isDocumentKind(kind) {
  return Object.prototype.hasOwnProperty.call(DOCUMENT_KINDS, kind);
}

/**
 * A filename a client can read, and one that is safe as a header value.
 *
 * Through `slugify`, so a project called "Müller & Co / phase 2" cannot put a slash, a
 * quote or a newline into a Content-Disposition header. The reference is included because
 * two quotes for the same client often share a project name.
 */
function filenameFor(quote, kind) {
  const spec = kind === PACKAGE_KIND ? { extension: 'zip' } : DOCUMENT_KINDS[kind];
  const stem = slugify(`${quote.reference}-${quote.project_name}`, quote.reference);
  return `${stem}.${spec.extension}`;
}

/**
 * Build one deliverable.
 *
 * @returns {Promise<{buffer:Buffer, filename:string, contentType:string, label:string}>}
 * @throws {Error & {code:'UNKNOWN_DOCUMENT_KIND'}}
 */
async function generateDocument(quote, kind, branding = null) {
  if (!isDocumentKind(kind)) {
    const err = new Error(`Unknown document kind: ${kind}`);
    err.code = 'UNKNOWN_DOCUMENT_KIND';
    throw err;
  }

  const spec = DOCUMENT_KINDS[kind];
  const buffer = await spec.build(quote, branding);

  return { buffer, filename: filenameFor(quote, kind), contentType: spec.contentType, label: spec.label };
}

/**
 * All three, zipped, plus a README naming what is inside and what it was priced on.
 *
 * Every document is built and validated BEFORE the archive is opened. Streaming a generator
 * straight into the zip would mean a failure halfway through leaves a truncated archive
 * already on its way to the client, with a 200 status and no way to signal the error.
 */
async function generatePackage(quote, branding = null) {
  const documents = [];
  for (const kind of Object.keys(DOCUMENT_KINDS)) {
    // Sequential on purpose: three Open XML packages built at once is a memory spike for
    // no gain on a request that a person is waiting on anyway.
    // eslint-disable-next-line no-await-in-loop
    documents.push(await generateDocument(quote, kind, branding));
  }

  const buffer = await new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks = [];

    archive.on('data', (chunk) => chunks.push(chunk));
    archive.on('warning', reject);
    archive.on('error', reject);
    archive.on('end', () => resolve(Buffer.concat(chunks)));

    for (const document of documents) archive.append(document.buffer, { name: document.filename });
    archive.append(readmeFor(quote, documents), { name: 'README.txt' });
    archive.finalize();
  });

  return {
    buffer,
    filename: filenameFor(quote, PACKAGE_KIND),
    contentType: 'application/zip',
    label: 'Document package',
    documents: documents.map((d) => ({ filename: d.filename, label: d.label, byteSize: d.buffer.length }))
  };
}

/**
 * The note inside the zip.
 *
 * It names the catalogue the quote was priced under, because a document is only meaningful
 * alongside its basis — and because the person opening the zip in six months is rarely the
 * person who produced it.
 */
function readmeFor(quote, documents) {
  const estimate = quote.estimate || {};
  return [
    `${quote.project_name}`,
    `Prepared for ${quote.client_company}`,
    `Reference ${quote.reference}`,
    '',
    'Contents:',
    ...documents.map((d) => `  ${d.filename}  —  ${d.label}`),
    '',
    `Total effort: ${estimate.totalManDays} consultant-days`,
    `Indicative duration: ${estimate.projectDurationWeeks} weeks`,
    `Budget: ${estimate.totalBudget} ${estimate.currency}`,
    `Transition approach: ${estimate.multipliers ? estimate.multipliers.transition.name : 'not recorded'}`,
    '',
    `Priced under catalogue ${quote.catalogue_version}.`,
    'These documents are generated from the stored estimate and are not themselves stored.',
    'An estimate, not a fixed price.'
  ].join('\n');
}

module.exports = { DOCUMENT_KINDS, PACKAGE_KIND, isDocumentKind, filenameFor, generateDocument, generatePackage };
