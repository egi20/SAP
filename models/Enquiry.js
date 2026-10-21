'use strict';

const sharp = require('sharp');
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
/*
 * One ENUM, two modes (migration 030). "Report a problem" offers the first six, "Share an
 * idea" the idea_* four; both halves are derived from the one list, so neither can name a
 * value the column would refuse.
 */
const ISSUE_TYPES = Object.freeze(['bug', 'question', 'account', 'billing', 'abuse', 'other',
  'idea_feature', 'idea_improvement', 'idea_integration', 'idea_other']);
const IDEA_TYPES = Object.freeze(ISSUE_TYPES.filter((t) => t.startsWith('idea_')));
const PROBLEM_TYPES = Object.freeze(ISSUE_TYPES.filter((t) => !t.startsWith('idea_')));
const SEVERITIES = Object.freeze(['low', 'normal', 'high', 'critical']);
// For an idea the same column holds a PRIORITY, and "critical" means nothing for an idea.
const PRIORITIES = Object.freeze(SEVERITIES.filter((s) => s !== 'critical'));

/**
 * An address somebody typed into "Which page" or "Link to the content", or null.
 *
 * http(s) only, parsed rather than pattern-matched, and with no credentials in it: a
 * `javascript:` URL stored here is a script one click away for the administrator who
 * reads the report, and `https://saphub.net@evil.example/` reads as ours and is not.
 * @returns {{ ok: boolean, value: string|null }}
 */
function reportUrl(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { ok: true, value: null };
  if (text.length > 500) return { ok: false, value: null };
  let url;
  try { url = new URL(text); } catch (e) { return { ok: false, value: null }; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) {
    return { ok: false, value: null };
  }
  return { ok: true, value: url.toString() };
}
const STATUSES = Object.freeze(['new', 'open', 'closed']);
const ATTACHMENT_RETENTION_DAYS = 90;

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
  static get PROBLEM_TYPES() { return PROBLEM_TYPES; }
  static get IDEA_TYPES() { return IDEA_TYPES; }
  static get PRIORITIES() { return PRIORITIES; }
  static reportUrl = reportUrl;
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
    issueType = null, severity = null, pageUrl = null, contentUrl = null,
    envInfo = null, publishConsent = false,
    topic = null, arrangement = null, country = null, privacyVersion = null
  }) {
    if (!KINDS.includes(kind)) throw new Error(`Unknown enquiry kind: ${kind}`);

    const isIssue = kind === 'issue';
    if (isIssue && (!ISSUE_TYPES.includes(issueType) || !SEVERITIES.includes(severity))) {
      throw new Error('An issue needs a type and a severity');
    }
    if (isIssue && IDEA_TYPES.includes(issueType) && !PRIORITIES.includes(severity)) {
      throw new Error('An idea has a priority, and "critical" is not one');
    }
    // Held here as well as in the route: a URL column is what the admin screen will trust.
    for (const url of [pageUrl, contentUrl]) {
      if (url !== null && !reportUrl(url).ok) throw new Error('A report URL must be http(s)');
    }

    const isTax = kind === 'tax_advisory';
    if (isTax && (!isTopic(topic) || !isArrangement(arrangement) || !/^[A-Z]{2}$/.test(String(country || '')))) {
      throw new Error('A tax advisory enquiry needs a topic, an arrangement and a country');
    }

    try {
      const [result] = await promisePool.query(
        `INSERT INTO enquiries
           (kind, user_id, name, email, subject, body, issue_type, severity, page_url, content_url,
            env_info, publish_consent, topic, arrangement, country, privacy_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          kind, userId, name, email, subject, body,
          isIssue ? issueType : null,
          isIssue ? severity : null,
          isIssue ? pageUrl : null,
          isIssue && issueType === 'abuse' ? contentUrl : null,
          isIssue && envInfo ? String(envInfo).slice(0, 400) : null,
          // Only an idea can be published, so only an idea carries the consent.
          isIssue && IDEA_TYPES.includes(issueType) && publishConsent ? 1 : 0,
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

  /** The reference a reporter is given and quotes back: R-<id>, nothing else encoded in it. */
  static reference(id) {
    return `R-${id}`;
  }

  /**
   * How many reports this address sent recently. The per-IP limiter bounds one machine;
   * this bounds one address spread across many, because the confirmation email goes to the
   * address typed, and an open form that mails whoever it is told to is a way to mail
   * somebody who never asked.
   */
  static async recentCountForEmail(email, minutes = 60) {
    const [[row]] = await promisePool.query(
      `SELECT COUNT(*) AS n FROM enquiries
        WHERE email = ? AND kind = 'issue' AND created_at > (NOW() - INTERVAL ? MINUTE)`,
      [String(email || '').trim(), minutes]
    );
    return Number(row.n);
  }

  /** A member's own reports, newest first — /report-issue/mine. Only rows tied to the account. */
  static async issuesForUser(userId, { limit = 50 } = {}) {
    const [rows] = await promisePool.query(
      `SELECT id, subject, issue_type, severity, status, created_at, handled_at, published_at
         FROM enquiries
        WHERE user_id = ? AND kind = 'issue'
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
      [userId, limit]
    );
    return rows;
  }

  /*
   * Ideas on /ideas. PUBLIC ONLY WITH BOTH SWITCHES (migration 031): the sender consented on
   * the form, and an administrator published it. Every public read below carries both
   * conditions, from this one fragment.
   */
  static publicIdeaFilter() {
    return {
      clause: "e.kind = 'issue' AND e.issue_type IN (?) AND e.publish_consent = 1 AND e.published_at IS NOT NULL",
      params: [IDEA_TYPES]
    };
  }

  static async setIdeaPublished(id, published, adminUserId) {
    const [result] = await promisePool.query(
      `UPDATE enquiries
          SET published_at = ${published ? 'NOW()' : 'NULL'}, published_by = ?
        WHERE id = ? AND kind = 'issue' AND issue_type IN (?) AND publish_consent = 1`,
      [published ? adminUserId : null, id, IDEA_TYPES]
    );
    return result.affectedRows === 1;
  }

  /** Published ideas with their vote counts, and whether the viewer voted. No names. */
  static async publishedIdeas({ viewerUserId = null, limit = 100 } = {}) {
    const { clause, params } = Enquiry.publicIdeaFilter();
    const [rows] = await promisePool.query(
      `SELECT e.id, e.subject, e.body, e.issue_type, e.status, e.published_at,
              (SELECT COUNT(*) FROM idea_votes v WHERE v.enquiry_id = e.id) AS votes,
              EXISTS (SELECT 1 FROM idea_votes v WHERE v.enquiry_id = e.id AND v.user_id = ?) AS my_vote
         FROM enquiries e
        WHERE ${clause}
        ORDER BY votes DESC, e.published_at DESC
        LIMIT ?`,
      [viewerUserId || 0, ...params, limit]
    );
    return rows.map((r) => ({ ...r, votes: Number(r.votes), my_vote: Boolean(Number(r.my_vote)) }));
  }

  /**
   * Vote, or take the vote back. Refused for anything that is not a published idea, so a
   * vote cannot be cast on a report nobody was meant to see — or used to find out which ids
   * are ideas waiting to be published.
   * @returns {Promise<{ok: boolean, voted?: boolean}>}
   */
  static async toggleIdeaVote(id, userId) {
    const { clause, params } = Enquiry.publicIdeaFilter();
    const [[idea]] = await promisePool.query(`SELECT e.id FROM enquiries e WHERE e.id = ? AND ${clause}`, [id, ...params]);
    if (!idea) return { ok: false };
    const [removed] = await promisePool.query('DELETE FROM idea_votes WHERE enquiry_id = ? AND user_id = ?', [id, userId]);
    if (removed.affectedRows) return { ok: true, voted: false };
    await promisePool.query('INSERT IGNORE INTO idea_votes (enquiry_id, user_id) VALUES (?, ?)', [id, userId]);
    return { ok: true, voted: true };
  }

  /**
   * Store the screenshots on a report. The buffers are re-encoded by sharp first — that is
   * the sanitiser, as for profile photographs — and bounded to 2000px on the long side,
   * which keeps a 4K screenshot readable and a few hundred kilobytes.
   */
  static async addAttachments(enquiryId, buffers) {
    for (const buffer of buffers) {
      // eslint-disable-next-line no-await-in-loop
      const { data, info } = await sharp(buffer)
        .rotate()
        .resize(2000, 2000, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 85 })
        .toBuffer({ resolveWithObject: true });
      // eslint-disable-next-line no-await-in-loop
      await promisePool.query(
        `INSERT INTO enquiry_attachments (enquiry_id, content_type, bytes, byte_size, width, height)
         VALUES (?, 'image/webp', ?, ?, ?, ?)`,
        [enquiryId, data, data.length, info.width, info.height]
      );
    }
  }

  /** Metadata only — the list on the admin screen never loads the bytes. */
  static async attachmentsFor(enquiryId) {
    const [rows] = await promisePool.query(
      `SELECT id, content_type, byte_size, width, height, created_at
         FROM enquiry_attachments WHERE enquiry_id = ? ORDER BY id`,
      [enquiryId]
    );
    return rows;
  }

  static async attachment(enquiryId, attachmentId) {
    const [rows] = await promisePool.query(
      'SELECT content_type, bytes FROM enquiry_attachments WHERE enquiry_id = ? AND id = ? LIMIT 1',
      [enquiryId, attachmentId]
    );
    return rows[0] || null;
  }

  /*
   * The Privacy policy promises screenshots are deleted ATTACHMENT_RETENTION_DAYS after the
   * report is closed. The report text stays as the record of what was reported; the
   * picture, which can carry anything that was on somebody's screen, does not.
   */
  static get ATTACHMENT_RETENTION_DAYS() { return ATTACHMENT_RETENTION_DAYS; }

  static async purgeExpiredAttachments(days = ATTACHMENT_RETENTION_DAYS) {
    const [result] = await promisePool.query(
      `DELETE a FROM enquiry_attachments a
         JOIN enquiries e ON e.id = a.enquiry_id
        WHERE e.status = 'closed' AND e.handled_at IS NOT NULL
          AND e.handled_at < (NOW() - INTERVAL ? DAY)`,
      [days]
    );
    return result.affectedRows;
  }

  static async attachmentsDueForPurge(days = ATTACHMENT_RETENTION_DAYS) {
    const [[row]] = await promisePool.query(
      `SELECT COUNT(*) AS total FROM enquiry_attachments a
         JOIN enquiries e ON e.id = a.enquiry_id
        WHERE e.status = 'closed' AND e.handled_at IS NOT NULL
          AND e.handled_at < (NOW() - INTERVAL ? DAY)`,
      [days]
    );
    return Number(row.total);
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
