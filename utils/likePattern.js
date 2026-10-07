'use strict';

/**
 * Turning a person's search text into a SQL LIKE pattern.
 *
 * `%` and `_` are LIKE wildcards, and every filter builder in this application was
 * interpolating the raw query between two `%` signs. The values were always bound, so
 * nothing was injectable — but two things were wrong anyway, and they got worse the moment
 * one box started searching four tables at once:
 *
 *  1. A search for `50%` did not look for "50%". It looked for "50" followed by anything,
 *     which is a different question with a different answer.
 *  2. A search for `%` became `%%%`, which matches every row in every table it is applied
 *     to. On a single list view that is a slow page; on a search box that asks four
 *     builders at once it is a free full scan of the database per request.
 *
 * MySQL's default LIKE escape character is a backslash, so the three characters that need
 * escaping are the backslash itself and the two wildcards. The backslash goes first —
 * escaping it after the wildcards would escape the escapes.
 */
function escapeLike(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

/**
 * The pattern for "contains this text", ready to bind.
 *
 * @example params.push(containsPattern(filters.q))
 */
function containsPattern(value) {
  return `%${escapeLike(String(value ?? '').trim())}%`;
}

/**
 * A short module code as a WHOLE WORD, for a REGEXP comparison — or null.
 *
 * "Contains" is the wrong question for the queries this site gets most. SAP module codes
 * are two to four letters, and `LIKE '%fi%'` finds "specific", "configuration" and
 * "Fiori"; `'%mm%'` finds "committed" and "communication". Every SAP advert contains those
 * words, so a search for FI returned every advert on the board — the exact failure the
 * About page promises this site does not have, and the one `utils/jobMatcher.js` already
 * refuses on the matching side.
 *
 * So a query that IS a short code (two to four letters or digits, nothing else) is
 * matched as a word: not preceded or followed by a letter or digit. Character classes
 * rather than `\b`, because MySQL 8 (ICU) and MariaDB (PCRE) agree on those and do not
 * entirely agree on word boundaries. The value is alphanumeric by construction, so there
 * is nothing in it to escape, and it is bound like every other value. Anything longer
 * returns null and the caller keeps its LIKE.
 *
 * @example
 *   const word = wholeWordPattern(filters.q);
 *   if (word) { where.push('col REGEXP ?'); params.push(word); }
 */
function wholeWordPattern(value) {
  const q = String(value ?? '').trim();
  if (!/^[A-Za-z0-9]{2,4}$/.test(q)) return null;
  return `(^|[^A-Za-z0-9])${q}([^A-Za-z0-9]|$)`;
}

/**
 * The WHERE fragment and params for "any of these columns mentions the query": a
 * whole-word REGEXP for a short code, a contains-LIKE for anything else.
 */
function textSearchClause(columns, value) {
  const word = wholeWordPattern(value);
  const op = word ? 'REGEXP' : 'LIKE';
  const bound = word || containsPattern(value);
  return {
    clause: `(${columns.map((col) => `${col} ${op} ?`).join(' OR ')})`,
    params: new Array(columns.length).fill(bound)
  };
}

module.exports = { escapeLike, containsPattern, wholeWordPattern, textSearchClause };
