'use strict';

const { LIMITS, isSource, sourceNeedsDetail } = require('../config/crm');

/**
 * Reading a file of leads, as a PREVIEW first and a write second.
 *
 * CSV ONLY, and that is a decision rather than a limitation. The reference accepts .xlsx
 * and sniffs every sheet in the workbook by its headers, guessing which tabs are leads and
 * which to ignore — roughly three hundred lines whose own comments describe the failure
 * they were written to fix, rows silently skipped out of somebody's export. Guessing at
 * the shape of a file full of other people's contact details is the wrong place to be
 * clever. One format, named columns, and a preview a person confirms.
 *
 * The parser is small and hand-written on purpose: a dependency for a file this
 * application reads on one admin screen is a dependency on every other screen too. It
 * handles quoted fields, embedded commas, embedded newlines and doubled quotes, which is
 * the whole of RFC 4180 that matters here.
 */

/** Column aliases, so an export does not have to be renamed by hand first. */
const COLUMNS = Object.freeze({
  company: ['company', 'company name', 'organisation', 'organization', 'account'],
  contact_name: ['contact', 'contact name', 'name', 'full name'],
  contact_email: ['email', 'contact email', 'e-mail', 'email address'],
  contact_phone: ['phone', 'telephone', 'contact phone', 'mobile'],
  job_title: ['title', 'job title', 'role', 'position'],
  country: ['country', 'country code'],
  website: ['website', 'web', 'url', 'site'],
  linkedin_url: ['linkedin', 'linkedin url', 'linkedin profile']
});

/**
 * Split CSV text into rows of cells.
 *
 * Returns arrays; the caller maps headers. A trailing newline does not produce an empty
 * final row, and a lone `\r` inside a quoted field survives.
 */
function parseCsv(input) {
  // Written as an escape rather than a literal: an invisible character in source is one
  // nobody can see when it goes wrong.
  const text = String(input ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"' && field === '') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      endField();
      i += 1;
      continue;
    }
    if (ch === '\r' && text[i + 1] === '\n') {
      endRow();
      i += 2;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      endRow();
      i += 1;
      continue;
    }

    field += ch;
    i += 1;
  }

  if (field !== '' || row.length) endRow();
  return rows;
}

/** Map a header row onto the column names the model wants. */
function mapHeaders(header) {
  const normalised = header.map((h) => String(h ?? '').trim().toLowerCase());
  const index = {};
  Object.entries(COLUMNS).forEach(([field, aliases]) => {
    const at = normalised.findIndex((h) => aliases.includes(h));
    if (at >= 0) index[field] = at;
  });
  return index;
}

/**
 * Read a CSV into candidate leads.
 *
 * It validates NOTHING about the people — that is `CrmLead.normaliseLead`'s job, and
 * having two sets of rules for one write is how an import gets to store something the form
 * would have refused. What it does here is shape, bound and report: which columns it
 * found, which rows are unusable, and how many it would write.
 *
 * The source is passed in rather than read from the file, because it describes the FILE —
 * one import is one provenance, and a per-row source column would be a provenance nobody
 * checked.
 */
function readLeads(csvText, { source, sourceDetail = '' } = {}) {
  const problems = [];

  if (!isSource(source)) {
    problems.push('Choose where this file came from before importing it.');
  } else if (sourceNeedsDetail(source) && String(sourceDetail || '').trim().length < 3) {
    problems.push('Say specifically where it came from — the category on its own is not an answer.');
  }

  const rows = parseCsv(csvText);
  if (rows.length === 0) {
    problems.push('That file has no rows in it.');
    return { leads: [], skipped: [], headers: {}, problems, truncated: false };
  }

  const headers = mapHeaders(rows[0]);
  if (headers.company === undefined) {
    problems.push('No "company" column. The first row has to be a header row naming the columns.');
    return { leads: [], skipped: [], headers, problems, truncated: false };
  }

  const body = rows.slice(1);
  const truncated = body.length > LIMITS.importRows;
  const considered = body.slice(0, LIMITS.importRows);

  const leads = [];
  const skipped = [];
  const seen = new Set();

  considered.forEach((cells, offset) => {
    const at = (field) => (headers[field] === undefined ? '' : String(cells[headers[field]] ?? '').trim());
    const line = offset + 2; // header is line 1

    const company = at('company');
    if (!company) {
      skipped.push({ line, reason: 'No company name.' });
      return;
    }

    const email = at('contact_email').toLowerCase();
    if (email && seen.has(email)) {
      // Within one file, not against the database — the database's own unique key handles
      // that, and reporting it here tells the person their export has duplicates in it.
      skipped.push({ line, reason: `"${email}" appears more than once in this file.` });
      return;
    }
    if (email) seen.add(email);

    leads.push({
      line,
      company,
      contact_name: at('contact_name') || null,
      contact_email: email || null,
      contact_phone: at('contact_phone') || null,
      job_title: at('job_title') || null,
      country: at('country') || null,
      website: at('website') || null,
      linkedin_url: at('linkedin_url') || null,
      source,
      source_detail: sourceDetail
    });
  });

  return { leads, skipped, headers, problems, truncated };
}

module.exports = { parseCsv, mapHeaders, readLeads, COLUMNS };
