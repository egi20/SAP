'use strict';

const { promisePool } = require('../config/database');
const { containsPattern } = require('../utils/likePattern');
const { RETENTION_DAYS, isTopic, isArrangement } = require('../config/taxAdvisory');

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
/*
 * THREE kinds and still one queue. A tax advisory enquiry is the same object as a contact
 * message — a person writing in and expecting an answer — differing in which fields the
 * form asked for, which is exactly the reason migration 018 refused to give the issue
 * reporter a table of its own.
 */
const KINDS = Object.freeze(['contact', 'issue', 'tax_advisory']);
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

  static get RETENTION_DAYS() { return RETENTION_DAYS; }

  /**
   * Record one.
   *
   * Each kind's own fields are NULLED for the others rather than defaulted, matching the
   * CHECK in migrations 018 and 027: "not asked" and "answered with the first option" are
   * different facts, and only one of them is true.
   */
  static async create({
    kind, userId = null, name, email, subject, body,
    issueType = null, severity = null, pageUrl = null,
    topic = null, arrangement = null, country = null, privacyVersion = null
  }) {
    if (!KINDS.includes(kind)) throw new Error(`Unknown enquiry kind: ${kind}`);

    const isIssue = kind === 'issue';
    if (isIssue && (!ISSUE_TYPES.includes(issueType) || !SEVERITIES.includes(severity))) {
      throw new Error('An issue needs a type and a severity');
    }

    const isTax = kind === 'tax_advisory';
    if (isTax && (!isTopic(topic) || !isArrangement(arrangement) || !/^[A-Z]{2}$/.test(String(country || '')))) {
      throw new Error('A tax advisory enquiry needs a topic, an arrangement and a country');
    }

    try {
      const [result] = await promisePool.query(
        `INSERT INTO enquiries
           (kind, user_id, name, email, subject, body, issue_type, severity, page_url,
            topic, arrangement, country, privacy_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          kind, userId, name, email, subject, body,
          isIssue ? issueType : null,
          isIssue ? severity : null,
          isIssue ? pageUrl : null,
          isTax ? topic : null,
          isTax ? arrangement : null,
          isTax ? country : null,
          isTax ? privacyVersion : null
        ]
      );
      return { id: result.insertId };
    } catch (err) {
      /*
       * The unique key on the generated `open_tax_email` is what holds "one open enquiry
       * per address", not a SELECT-then-INSERT in the handler. Two submissions arriving
       * together is the ordinary case for a double-tapped button, and only the database
       * can decide which one won.
       */
      if (err.code === 'ER_DUP_ENTRY') {
        const dup = new Error('There is already an open enquiry from that address. We will come back to it.');
        dup.code = 'ALREADY_OPEN';
        throw dup;
      }
      throw err;
    }
  }

  /**
   * Delete tax advisory enquiries past their retention.
   *
   * Scoped to this kind and to CLOSED rows: the retention promise is made on the tax form
   * and nowhere else, so it applies to the rows that form produced and to no others. A
   * purge that took the kind out of the WHERE would quietly extend a promise nobody made
   * to messages nobody promised it about.
   */
  static async purgeExpiredTaxEnquiries(days = RETENTION_DAYS) {
    const [result] = await promisePool.query(
      `DELETE FROM enquiries
        WHERE kind = 'tax_advisory' AND status = 'closed'
          AND handled_at IS NOT NULL AND handled_at < (NOW() - INTERVAL ? DAY)`,
      [days]
    );
    return result.affectedRows;
  }

  /** How many are due to go, so the retention promise is checkable rather than claimed. */
  static async taxEnquiriesDueForPurge(days = RETENTION_DAYS) {
    const [[row]] = await promisePool.query(
      `SELECT COUNT(*) AS total FROM enquiries
        WHERE kind = 'tax_advisory' AND status = 'closed'
          AND handled_at IS NOT NULL AND handled_at < (NOW() - INTERVAL ? DAY)`,
      [days]
    );
    return Number(row.total);
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
  /**
   * Record that the introduction was made.
   *
   * SET ONCE AND NEVER CLEARED, through a conditional UPDATE rather than a read-then-write:
   * it is the moment the Hub's involvement ends, and a date that can be moved is a date
   * nobody can rely on. It is a column rather than a status because it is a fact about
   * what happened, not a place in a queue — and `introduced` on a contact message would
   * be a state that screen has no meaning for.
   *
   * It does not close the enquiry. Whether there is anything left to do is the person
   * working the queue's call, and the retention clock starts when they say so.
   */
  static async markIntroduced(id) {
    const [result] = await promisePool.query(
      "UPDATE enquiries SET introduced_at = NOW() WHERE id = ? AND kind = 'tax_advisory' AND introduced_at IS NULL",
      [id]
    );
    return result.affectedRows === 1;
  }

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
