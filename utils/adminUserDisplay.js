'use strict';

/**
 * How one row of /admin/users is printed. PURE, so the odd cases are tested rather than
 * discovered on the screen.
 *
 * `users.name` is ONE column. The table splits it at the first space because the
 * reference's table has two, and that is all the split is: a display convenience over the
 * single stored value, never written back — "Maria de la Cruz" is printed as "Maria" and
 * "de la Cruz", which is wrong for some people and is why nothing reads these halves.
 */
function nameColumns(row) {
  const isCompany = row.user_type === 'company';
  if (isCompany) {
    // The company's own name where it has given one; the account name otherwise.
    return { first: row.company_name || row.name || '—', last: '—' };
  }
  const parts = String(row.name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: '—', last: '—' };
  return { first: parts[0], last: parts.slice(1).join(' ') || '—' };
}

/**
 * "DE" → the flag emoji, built from regional-indicator symbols. Anything that is not two
 * letters gives '' rather than a broken glyph, and the code is printed beside it anyway,
 * because a flag is a picture and some systems draw it as two letters in boxes.
 */
function flagEmoji(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return '';
  return String.fromCodePoint(...[...c].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

module.exports = { nameColumns, flagEmoji };
