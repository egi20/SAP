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
 *
 * POSSIBLE matches are flagged, never merged (2026-10-22): a line with no email whose name
 * equals, or nearly equals (Jaro-Winkler ≥ POSSIBLE_THRESHOLD), the name on another line.
 * "John Smith" beside "John Smith, john@a.example", "Jon Smith" beside "John Smith". A
 * person decides; the clean list keeps both until they do.
 */

const MAX_LINES = 2000;
const MAX_CHARS = 200000;

// A deliberately loose shape: this finds an address in a line, it does not validate one.
const EMAIL_RE = /[^\s,;<>"']+@[^\s,;<>"']+\.[^\s,;<>"']+/;

function normaliseEmail(value) {
  return String(value || '').trim().toLowerCase();
}

const POSSIBLE_THRESHOLD = 0.92;
const MAX_POSSIBLE = 200;

/*
 * German spelling first, so "Müller" and "Mueller" are one key (DACH lists write both).
 * Only the umlauts and ß are folded — NOT "ue" back to "u": that would also make "Michael"
 * and "Michal" one key, and an exact key must never invent an equality. "Muller" against
 * "Mueller" is therefore a POSSIBLE match, which is what it is.
 */
const GERMAN = { ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss', ẞ: 'SS' };

/**
 * Case, accents, punctuation and word order removed. Sorting the words is what makes
 * "Smith, John" and "John Smith" the same key.
 */
function normaliseName(value) {
  return String(value || '')
    .replace(/[äöüÄÖÜßẞ]/g, (c) => GERMAN[c])
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

/** One pasted line → { line, raw, email, name, display }. */
function parseLine(raw, lineNumber) {
  const text = String(raw).trim();
  const found = text.match(EMAIL_RE);
  const email = found ? normaliseEmail(found[0]) : '';
  const nameText = (found ? text.replace(found[0], ' ') : text).replace(/[<>]/g, ' ');
  return {
    line: lineNumber,
    raw: text,
    email,
    name: normaliseName(nameText),
    // The name as it was written, for the screen: "John Smith", never the key "john smith".
    display: displayName(nameText)
  };
}

/**
 * The name part of a line as written, minus the separators left behind by the email and
 * minus quotes WRAPPING the whole name — `"O'Brien, Pat"` is a CSV cell, not a name with
 * quotes in it. An apostrophe inside the name is the name.
 */
function displayName(nameText) {
  let text = String(nameText).replace(/[,;]+\s*$/, '').replace(/^\s*[,;]+/, '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 2; i += 1) {
    const wrapped = text.match(/^(["“'])(.*)(["”'])$/);
    if (!wrapped || (wrapped[1] === "'") !== (wrapped[3] === "'")) break;
    text = wrapped[2].replace(/[,;]+\s*$/, '').trim();
  }
  return text;
}

/** Jaro-Winkler similarity, 0..1. Prefix-weighted, which suits names. */
function jaroWinkler(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aHit = new Array(a.length).fill(false);
  const bHit = new Array(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i += 1) {
    const lo = Math.max(0, i - range);
    const hi = Math.min(i + range + 1, b.length);
    for (let j = lo; j < hi; j += 1) {
      if (!bHit[j] && a[i] === b[j]) { aHit[i] = true; bHit[j] = true; matches += 1; break; }
    }
  }
  if (!matches) return 0;
  let k = 0;
  let transpositions = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (!aHit[i]) continue;
    while (!bHit[k]) k += 1;
    if (a[i] !== b[k]) transpositions += 1;
    k += 1;
  }
  const m = matches;
  const jaro = (m / a.length + m / b.length + (m - transpositions / 2) / m) / 3;
  let prefix = 0;
  while (prefix < 4 && a[prefix] && a[prefix] === b[prefix]) prefix += 1;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * PAIRS of people who may be one person: at least one side has no email, and the names are
 * equal or close. Pairs, not clusters: joining them transitively put "John Smith,
 * john@a.example" and "John Smith, john@b.example" in one box through a third line, which
 * says two people with different addresses may be one — the opposite of the rule above. A
 * pair says exactly what was compared. Candidates come from a shared word, so a list of two
 * thousand is not two million comparisons — a typo in one word leaves the other in common.
 */
function possibleMatches(people) {
  const byWord = new Map();
  people.forEach((p, index) => {
    for (const word of new Set(p.name.split(' ').filter(Boolean))) {
      if (!byWord.has(word)) byWord.set(word, []);
      byWord.get(word).push(index);
    }
  });
  const seen = new Set();
  const out = [];
  let comparisons = 0;
  for (const indexes of byWord.values()) {
    for (let x = 0; x < indexes.length; x += 1) {
      for (let y = x + 1; y < indexes.length; y += 1) {
        const i = Math.min(indexes[x], indexes[y]);
        const j = Math.max(indexes[x], indexes[y]);
        const pairKey = `${i}:${j}`;
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);
        if (people[i].email && people[j].email) continue;
        // A bound on work, not on results: one word on every line (a company name) would
        // otherwise compare everything with everything.
        comparisons += 1;
        if (comparisons > 200000) break;
        const score = jaroWinkler(people[i].name, people[j].name);
        if (score < POSSIBLE_THRESHOLD) continue;
        // Indexes only while scanning: a list where one word is on every line can produce many
        // thousands of pairs, and only the first MAX_POSSIBLE are ever shown.
        out.push([j, i, score]);
      }
    }
  }
  // The later line first: it is the one being asked about. people[] is in first-line order,
  // so sorting by index is sorting by line.
  out.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const side = (p) => ({ label: p.display || p.name, email: p.email, entries: p.entries });
  const pairs = out.slice(0, MAX_POSSIBLE).map(([j, i, score]) => ({
    reason: people[i].name === people[j].name ? 'same-name-one-email' : 'similar-name',
    score: Math.round(score * 100) / 100,
    a: side(people[j]),
    b: side(people[i]),
    entries: [...people[i].entries, ...people[j].entries].sort((p, q) => p.line - q.line)
  }));
  return { pairs, capped: out.length > MAX_POSSIBLE };
}

/** RFC 4180 cell, and never a formula: a leading = + - @ is what a spreadsheet would run. */
function csvCell(value) {
  let text = String(value == null ? '' : value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * @param {string} input  one record per line
 * @returns {{ total, unique, groups: Array<{ reason, key, entries }>, clean: string[], truncated }}
 *   `groups` holds only the keys that occur more than once, in the order they first appear.
 *   `unique` counts distinct people, so `total - unique` is the number of lines a merge removes.
 */
function findDuplicates(input) {
  const text = String(input || '').slice(0, MAX_CHARS);
  const allLines = text.split(/\r?\n/);
  const truncated = allLines.length > MAX_LINES || String(input || '').length > MAX_CHARS;

  const parsed = allLines.slice(0, MAX_LINES).map((raw, i) => parseLine(raw, i + 1));
  const records = parsed.filter((r) => r.raw !== '');
  // Blank lines BETWEEN entries, which is why the line numbers run past the count. Trailing
  // ones (a final newline) are not worth a sentence.
  const lastFilled = records.length ? records[records.length - 1].line : 0;
  const blank = parsed.filter((r) => r.raw === '' && r.line < lastFilled).length;

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
    if (!byKey.has(key)) {
      byKey.set(key, {
        reason,
        key: key.slice(key.indexOf(':') + 1),
        // Shown on screen: the address, or the name as first WRITTEN rather than its key.
        label: reason === 'email' ? r.email : (r.display || r.name),
        email: r.email,
        name: r.name,
        display: r.display,
        entries: []
      });
    }
    byKey.get(key).entries.push({ line: r.line, raw: r.raw });
  });

  const people = [...byKey.values()];
  const groups = people.filter((g) => g.entries.length > 1)
    .map(({ reason, key, label, entries }) => ({ reason, key, label, entries }));
  const possible = possibleMatches(people.filter((p) => p.name));
  // One line per person, as it was first written, in the order the list gave them: the
  // list somebody takes away. Nothing is merged into it — the first spelling is kept as typed,
  // and a POSSIBLE match stays two lines until a person decides.
  const clean = people.map((g) => g.entries[0].raw);
  const csv = ['name,email', ...people.map((g) => `${csvCell(g.display)},${csvCell(g.email)}`)].join('\r\n');
  return {
    total: records.length,
    blank,
    unique: byKey.size,
    groups,
    possible: possible.pairs,
    possibleCapped: possible.capped,
    clean,
    csv,
    truncated
  };
}

module.exports = {
  findDuplicates, normaliseName, normaliseEmail, jaroWinkler, csvCell,
  MAX_LINES, MAX_CHARS, POSSIBLE_THRESHOLD
};
