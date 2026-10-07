'use strict';

/**
 * Find the duplicates in a pasted list of people.
 *
 * PURE, and nothing is stored. The list arrives in a form, is grouped here, and is rendered
 * back in the response — there is no table, no upload kept on disk and no log line holding
 * a single address. A list of somebody's contacts is the most personal thing anybody will
 * paste into this site, and the only safe copy of it is the one that was never written.
 *
 * This is NOT DynamicsHub's record-deduplication product (65 handlers over twelve tables,
 * excluded in docs/PORT-PLAN.md and still excluded). It is the narrow question somebody
 * merging two spreadsheets of SAP contacts actually asks: which lines are the same person?
 *
 * Matching, in order of confidence:
 *   1. the same email address, ignoring case and surrounding space — the same mailbox;
 *   2. otherwise, the same name once case, accents, punctuation and word order are
 *      ignored — "Müller, Anna" and "anna muller" are one person written two ways.
 * A line with an email is never matched to another line on name alone: two people called
 * John Smith with different addresses are two people, and merging them is the error this
 * tool exists to prevent rather than to make.
 */

const MAX_LINES = 2000;
const MAX_CHARS = 200000;

// A deliberately loose shape: this finds an address in a line, it does not validate one.
const EMAIL_RE = /[^\s,;<>"']+@[^\s,;<>"']+\.[^\s,;<>"']+/;

function normaliseEmail(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * Case, accents, punctuation and word order removed. Sorting the words is what makes
 * "Smith, John" and "John Smith" the same key.
 */
function normaliseName(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

/** One pasted line → { line, raw, email, name }. */
function parseLine(raw, lineNumber) {
  const text = String(raw).trim();
  const found = text.match(EMAIL_RE);
  const email = found ? normaliseEmail(found[0]) : '';
  const nameText = found ? text.replace(found[0], ' ') : text;
  return {
    line: lineNumber,
    raw: text,
    email,
    name: normaliseName(nameText.replace(/[<>]/g, ' '))
  };
}

/**
 * @param {string} input  one record per line
 * @returns {{ total, unique, groups: Array<{ reason, key, entries }>, truncated }}
 *   `groups` holds only the keys that occur more than once, in the order they first appear.
 *   `unique` counts distinct people, so `total - unique` is the number of lines a merge removes.
 */
function findDuplicates(input) {
  const text = String(input || '').slice(0, MAX_CHARS);
  const allLines = text.split(/\r?\n/);
  const truncated = allLines.length > MAX_LINES || String(input || '').length > MAX_CHARS;

  const records = allLines
    .slice(0, MAX_LINES)
    .map((raw, i) => parseLine(raw, i + 1))
    .filter((r) => r.raw !== '');

  const byKey = new Map();
  records.forEach((r) => {
    let key = null;
    let reason = null;
    if (r.email) {
      key = `email:${r.email}`;
      reason = 'email';
    } else if (r.name) {
      key = `name:${r.name}`;
      reason = 'name';
    }
    if (!key) return;
    if (!byKey.has(key)) byKey.set(key, { reason, key: key.slice(key.indexOf(':') + 1), entries: [] });
    byKey.get(key).entries.push({ line: r.line, raw: r.raw });
  });

  const groups = [...byKey.values()].filter((g) => g.entries.length > 1);
  return { total: records.length, unique: byKey.size, groups, truncated };
}

module.exports = { findDuplicates, normaliseName, normaliseEmail, MAX_LINES, MAX_CHARS };
