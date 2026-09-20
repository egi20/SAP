'use strict';

/** Lowercase, ASCII, hyphenated. Never empty: falls back to `fallback`. */
function slugify(input, fallback = 'item') {
  const slug = String(input || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);
  return slug || fallback;
}

/**
 * Append `-2`, `-3`, ... until `isTaken(candidate)` returns false.
 * `isTaken` is async so callers can hit the database.
 */
async function uniqueSlug(base, isTaken, { maxAttempts = 50 } = {}) {
  const root = slugify(base);
  let candidate = root;
  for (let n = 2; n <= maxAttempts; n += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await isTaken(candidate))) return candidate;
    candidate = `${root}-${n}`;
  }
  return `${root}-${Date.now().toString(36)}`;
}

module.exports = { slugify, uniqueSlug };
