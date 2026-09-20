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

module.exports = { escapeLike, containsPattern };
