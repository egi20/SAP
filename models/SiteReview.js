'use strict';

const { promisePool } = require('../config/database');

/**
 * Testimonials about the Hub itself.
 *
 * THREE DEPARTURES FROM THE REFERENCE.
 *
 * 1. SIGNED IN ONLY. The reference accepts a review from a guest who types any name and
 *    any role. That is a testimonial farm with a text box: nothing links the words to
 *    anyone who used the site, and there is no cost to posting a hundred. Requiring an
 *    account gives the review a subject, gives moderation somebody to act on, and makes
 *    `UNIQUE (user_id)` mean something — one voice, one review.
 *
 * 2. HIDDEN, NEVER DELETED. `SiteReview.delete` there is a hard
 *    `DELETE FROM site_reviews WHERE id = ?`, reachable from a bulk action on an admin
 *    list. A moderator who cannot undo will not act, and afterwards nobody can answer
 *    "who removed that, and when". Here `hidden_at` is a nullable timestamp and both
 *    directions are one statement.
 *
 * 3. THE ROLE IS DERIVED, NOT TYPED. The reference stores a free-text `author_role`, so
 *    "SAP Mentor" is a claim the page then renders as fact next to somebody's name.
 *    Here it comes from the roles the account actually holds.
 *
 * Editing a review clears its approval. An approved review whose text can be swapped
 * afterwards is an approval that means nothing — it is the oldest trick in the
 * user-generated-content book.
 */

const MAX_BODY = 1000;
const MIN_BODY = 40;

/**
 * What an author may be labelled as, derived from the flags on their account rather than
 * accepted from the form.
 */
function roleLabelFor(sessionUser) {
  if (!sessionUser) return null;
  if (sessionUser.isRecruiter) return 'recruiter';
  if (sessionUser.isCompany) return 'company';
  if (sessionUser.isConsultant) return 'consultant';
  return null;
}

function normaliseBody(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_BODY);
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

/** Validate a submission. Pure, so the rules are testable without a database. */
function normaliseSubmission(input = {}) {
  // An integer, or a string that is ENTIRELY digits. Deliberately not `parseInt`:
  // `parseInt('3.5')` is 3 and `parseInt('4abc')` is 4, so a crafted body would be
  // rounded into a rating nobody chose. Third time this codebase has hit that trap —
  // see config/challenges.js and models/TaxEnquiry.js.
  const raw = input.rating;
  const rating = Number.isInteger(raw) ? raw : /^\d+$/.test(String(raw ?? '')) ? Number(raw) : NaN;
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    fail('RATING_INVALID', 'Please choose a rating from one to five.');
  }

  const body = normaliseBody(input.body);
  if (body.length < MIN_BODY) {
    fail('BODY_TOO_SHORT', `Please write at least ${MIN_BODY} characters — a rating on its own tells nobody anything.`);
  }

  return { rating, body };
}

class SiteReview {
  static get MAX_BODY() {
    return MAX_BODY;
  }

  static get MIN_BODY() {
    return MIN_BODY;
  }

  static normaliseSubmission = normaliseSubmission;

  static roleLabelFor = roleLabelFor;

  /**
   * Leave or replace a review.
   *
   * `ON DUPLICATE KEY UPDATE` against `UNIQUE (user_id)` makes this one statement rather
   * than a select-then-branch, and it CLEARS the approval on every write: a review whose
   * text changed has not been read by a moderator, whatever it said when it was.
   *
   * `hidden_at` is deliberately NOT cleared. Somebody whose review was hidden for abuse
   * cannot un-hide it by editing.
   */
  static async submit(userId, input, sessionUser = null) {
    const { rating, body } = normaliseSubmission(input);
    const role = roleLabelFor(sessionUser);

    const [result] = await promisePool.query(
      `INSERT INTO site_reviews (user_id, rating, body, author_role)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE rating = VALUES(rating), body = VALUES(body),
                               author_role = VALUES(author_role),
                               approved_at = NULL, approved_by = NULL`,
      [userId, rating, body, role]
    );
    // mysql2 reports 1 for an insert and 2 for an update on ON DUPLICATE KEY.
    return { created: result.affectedRows === 1 };
  }

  static async forUser(userId) {
    const [[row]] = await promisePool.query('SELECT * FROM site_reviews WHERE user_id = ?', [userId]);
    return row || null;
  }

  /**
   * THE ONE FILTER BUILDER for reviews.
   *
   * Published means approved AND not hidden, as a fixed fragment. `include_pending` and
   * `include_hidden` are the only opt-ins and only the admin screen passes them.
   */
  static buildFilter(filters = {}) {
    const clauses = [];
    const params = [];

    if (!filters.include_pending) clauses.push('r.approved_at IS NOT NULL');
    if (!filters.include_hidden) clauses.push('r.hidden_at IS NULL');

    if (filters.status === 'pending') clauses.push('r.approved_at IS NULL', 'r.hidden_at IS NULL');
    if (filters.status === 'hidden') clauses.push('r.hidden_at IS NOT NULL');

    if (Number.isInteger(filters.min_rating)) {
      clauses.push('r.rating >= ?');
      params.push(filters.min_rating);
    }

    return { clause: clauses.length ? clauses.join(' AND ') : '1 = 1', params };
  }

  /**
   * Reviews for a page.
   *
   * The display name uses the same COALESCE as `models/Conversation.js`: an account with
   * no name would otherwise be shown by its email local part, and this is a public page.
   * The email is not selected at all.
   */
  static async list(filters = {}, { limit = 12, offset = 0 } = {}) {
    const { clause, params } = SiteReview.buildFilter(filters);

    const [rows] = await promisePool.query(
      `SELECT r.id, r.rating, r.body, r.author_role, r.approved_at, r.hidden_at, r.created_at,
              r.user_id,
              COALESCE(NULLIF(TRIM(u.name), ''), 'SAP Hub member') AS author_name
         FROM site_reviews r JOIN users u ON u.id = r.user_id
        WHERE ${clause} AND u.is_active = 1
        ORDER BY COALESCE(r.approved_at, r.created_at) DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const [[{ total }]] = await promisePool.query(
      `SELECT COUNT(*) AS total FROM site_reviews r JOIN users u ON u.id = r.user_id
        WHERE ${clause} AND u.is_active = 1`,
      params
    );
    return { rows, total };
  }

  /**
   * The published average and count.
   *
   * Computed over approved, unhidden reviews only, so the figure on the home page matches
   * the reviews under it. Returns nulls rather than a zero when there are none: "0.0 out
   * of 5" is a claim, and an absent average is a fact.
   */
  static async summary() {
    const [[row]] = await promisePool.query(
      `SELECT COUNT(*) AS total, AVG(r.rating) AS average
         FROM site_reviews r JOIN users u ON u.id = r.user_id
        WHERE r.approved_at IS NOT NULL AND r.hidden_at IS NULL AND u.is_active = 1`
    );
    const total = Number(row.total) || 0;
    return { total, average: total ? Math.round(Number(row.average) * 10) / 10 : null };
  }

  static async setApproved(id, approved, { actorUserId = null } = {}) {
    const [result] = await promisePool.query(
      'UPDATE site_reviews SET approved_at = ?, approved_by = ? WHERE id = ?',
      [approved ? new Date() : null, approved ? actorUserId : null, id]
    );
    return result.affectedRows === 1;
  }

  static async setHidden(id, hidden) {
    const [result] = await promisePool.query(
      'UPDATE site_reviews SET hidden_at = ? WHERE id = ?',
      [hidden ? new Date() : null, id]
    );
    return result.affectedRows === 1;
  }

  static async pendingCount() {
    const [[{ total }]] = await promisePool.query(
      'SELECT COUNT(*) AS total FROM site_reviews WHERE approved_at IS NULL AND hidden_at IS NULL'
    );
    return total;
  }
}

module.exports = SiteReview;
