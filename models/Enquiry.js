'use strict';

const { promisePool } = require('../config/database');
const { containsPattern } = require('../utils/likePattern');

/**
 * Enquiries: what the contact form and the issue reporter both produce.
 *
 * ONE queue, because the rule that let these forms exist at all is "somebody is watching
 * it", and two queues means a second one nobody opens.
 *
 * The vocabularies below mirror the ENUMs in migration 018, and a unit test compares each
 * against that file — the arrangement `Job.STATUSES` and `Moderation.SUBJECT_TYPES` use.
 * Written out by hand in the form, the validator and the admin filter is how an option
 * gets added to a dropdown and silently rejected behind it.
 */
const KINDS = Object.freeze(['contact', 'issue']);
const ISSUE_TYPES = Object.freeze(['bug', 'question', 'account', 'billing', 'abuse', 'other']);
const SEVERITIES = Object.freeze(['low', 'normal', 'high']);
const STATUSES = Object.freeze(['new', 'open', 'closed']);

/**
 * The one filter builder for this table. A list view and a count that disagree about what
 * is in scope is how a queue shows "3 waiting" above an empty page.
 */
function buildFilter(filters = {}) {
  const where = [];
  const params = [];

  if (STATUSES.includes(filters.status)) {
    where.push('e.status = ?');
    params.push(filters.status);
  }
  if (KINDS.includes(filters.kind)) {
    where.push('e.kind = ?');
    params.push(filters.kind);
  }
  if (filters.q) {
    // Through utils/likePattern.js, like every other LIKE here: a search for "%" must be
    // a search for a percent sign, not a full table scan.
    where.push('(e.subject LIKE ? OR e.body LIKE ? OR e.email LIKE ? OR e.name LIKE ?)');
    const like = containsPattern(filters.q);
    params.push(like, like, like, like);
  }

  return { clause: where.length ? where.join(' AND ') : '1 = 1', params };
}

class Enquiry {
  static get KINDS() { return KINDS; }
  static get ISSUE_TYPES() { return ISSUE_TYPES; }
  static get SEVERITIES() { return SEVERITIES; }
  static get STATUSES() { return STATUSES; }
  static buildFilter = buildFilter;

  /**
   * Record one.
   *
   * The issue fields are NULLED for a contact message rather than defaulted, matching the
   * CHECK in the migration: "not asked" and "answered with the first option" are different
   * facts, and only one of them is true.
   */
  static async create({
    kind, userId = null, name, email, subject, body,
    issueType = null, severity = null, pageUrl = null
  }) {
    if (!KINDS.includes(kind)) throw new Error(`Unknown enquiry kind: ${kind}`);

    const isIssue = kind === 'issue';
    if (isIssue && (!ISSUE_TYPES.includes(issueType) || !SEVERITIES.includes(severity))) {
      throw new Error('An issue needs a type and a severity');
    }

    const [result] = await promisePool.query(
      `INSERT INTO enquiries (kind, user_id, name, email, subject, body, issue_type, severity, page_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        kind, userId, name, email, subject, body,
        isIssue ? issueType : null,
        isIssue ? severity : null,
        isIssue ? pageUrl : null
      ]
    );
    return { id: result.insertId };
  }

  static async browse(filters = {}, { limit = 25, offset = 0 } = {}) {
    const { clause, params } = buildFilter(filters);

    const [rows] = await promisePool.query(
      `SELECT e.*, h.name AS handler_name
         FROM enquiries e
         LEFT JOIN users h ON h.id = e.handled_by
        WHERE ${clause}
        ORDER BY e.created_at DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const [[{ total }]] = await promisePool.query(
      `SELECT COUNT(*) AS total FROM enquiries e WHERE ${clause}`,
      params
    );

    return { rows, total };
  }

  static async find(id) {
    const [rows] = await promisePool.query(
      `SELECT e.*, h.name AS handler_name
         FROM enquiries e
         LEFT JOIN users h ON h.id = e.handled_by
        WHERE e.id = ?`,
      [id]
    );
    return rows[0] || null;
  }

  /** How many are waiting, for the badge on the admin tab. Counting is what makes a queue watched. */
  static async openCount() {
    const [[row]] = await promisePool.query(
      "SELECT COUNT(*) AS count FROM enquiries WHERE status IN ('new', 'open')"
    );
    return row.count;
  }

  /**
   * Move one through the queue.
   *
   * `handled_by` and `handled_at` are stamped on every move, including back to `open`, so
   * the row always says who touched it last. A note is written when one is given and left
   * alone when it is not — an empty textarea on a status form must not erase what somebody
   * wrote earlier, which is the same reason `AppSetting.setMany` takes every key.
   */
  static async setStatus(id, status, adminUserId, note = null) {
    if (!STATUSES.includes(status)) throw new Error(`Unknown enquiry status: ${status}`);

    const sets = ['status = ?', 'handled_by = ?', 'handled_at = NOW()'];
    const params = [status, adminUserId];
    if (note !== null && String(note).trim()) {
      sets.push('admin_note = ?');
      params.push(String(note).slice(0, 5000));
    }
    params.push(id);

    const [result] = await promisePool.query(
      `UPDATE enquiries SET ${sets.join(', ')} WHERE id = ?`,
      params
    );
    return result.affectedRows > 0;
  }
}

module.exports = Enquiry;
