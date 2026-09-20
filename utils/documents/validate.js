'use strict';

const sax = require('sax');
const PizZip = require('pizzip');

/**
 * Never serve a generated document you have not opened.
 *
 * DOCX, XLSX and PPTX are all zip containers of XML parts. A generator that produces a
 * subtly broken part yields a file that downloads fine and then fails to open, which the
 * recipient experiences as "you sent me a corrupt file" — the worst possible failure for a
 * document you are about to put in front of a client.
 *
 * A presence check for the expected parts does NOT catch this. Only a real parse does.
 */

/**
 * Strictly parse a string as XML, throwing on the first error with the surrounding text.
 *
 * @param {string} xml
 * @param {string} partName included in the error message
 * @throws {Error} when the XML is not well-formed
 */
function assertWellFormedXml(xml, partName = 'document.xml') {
  const parser = sax.parser(true, {}); // strict mode, no namespace resolution
  let firstError = null;

  parser.onerror = function onerror(err) {
    if (!firstError) firstError = err;
    this.resume();
  };

  try {
    parser.write(xml).close();
  } catch (err) {
    if (!firstError) firstError = err;
  }

  if (firstError) {
    const position = typeof parser.position === 'number' ? parser.position : -1;
    const near =
      position >= 0
        ? ` near "${xml.slice(Math.max(0, position - 40), position + 40).replace(/\s+/g, ' ')}"`
        : '';
    throw new Error(`Malformed XML in ${partName}: ${String(firstError.message).split('\n')[0]}${near}`);
  }
}

/**
 * Check an Open XML package: it must be a readable zip, carry the parts the format
 * requires, and every .xml/.rels part inside it must parse.
 *
 * Returns `{ ok, reason }` rather than throwing, so a caller can fall back to a simpler
 * layout instead of failing the request.
 *
 * @param {Buffer} buffer
 * @param {string[]} requiredParts paths that must exist inside the package
 * @returns {{ok: boolean, reason?: string, partsChecked?: number}}
 */
function inspectOpenXmlPackage(buffer, requiredParts = []) {
  if (!buffer || buffer.length < 4) return { ok: false, reason: 'empty buffer' };

  // Every Open XML file is a zip, and every zip starts "PK".
  if (buffer.slice(0, 2).toString('latin1') !== 'PK') {
    return { ok: false, reason: 'not a zip (PK) container' };
  }

  let zip;
  try {
    zip = new PizZip(buffer);
  } catch (err) {
    return { ok: false, reason: `unreadable zip: ${err.message}` };
  }

  for (const part of requiredParts) {
    if (!zip.file(part)) return { ok: false, reason: `missing ${part}` };
  }

  let partsChecked = 0;
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir) continue;
    if (!/\.(xml|rels)$/i.test(name)) continue;
    try {
      assertWellFormedXml(zip.file(name).asText(), name);
      partsChecked += 1;
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  return { ok: true, partsChecked };
}

const REQUIRED_PARTS = {
  docx: ['[Content_Types].xml', 'word/document.xml'],
  xlsx: ['[Content_Types].xml', 'xl/workbook.xml'],
  pptx: ['[Content_Types].xml', 'ppt/presentation.xml']
};

function inspectDocument(buffer, kind) {
  const required = REQUIRED_PARTS[kind];
  if (!required) throw new Error(`Unknown document kind: ${kind}`);
  return inspectOpenXmlPackage(buffer, required);
}

/**
 * Throwing wrapper for call sites that have no fallback and must not serve a bad file.
 * @throws {Error & {code:'DOCUMENT_MALFORMED'}}
 */
function assertDocumentOpens(buffer, kind, label = kind) {
  const result = inspectDocument(buffer, kind);
  if (!result.ok) {
    const err = new Error(`Generated ${label} failed its own validity check: ${result.reason}`);
    err.code = 'DOCUMENT_MALFORMED';
    throw err;
  }
  return result;
}

/** Escape the five XML entities. Used wherever a value is placed into raw markup. */
function escapeXml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = {
  assertWellFormedXml,
  inspectOpenXmlPackage,
  inspectDocument,
  assertDocumentOpens,
  escapeXml,
  REQUIRED_PARTS
};
