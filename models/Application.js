'use strict';

const { promisePool, withTransaction } = require('../config/database');
const { containsPattern } = require('../utils/likePattern');

/**
 * The hiring pipeline state machine.
 *
 * Transitions are declared, not implied. An undeclared transition is rejected rather
 * than silently written, so the pipeline cannot end up in a state the UI has no
 * rendering for and so "hired" can never be reached without passing through a decision.
 */
const TRANSITIONS = Object.freeze({
  submitted: ['reviewing', 'rejected', 'withdrawn'],
  reviewing: ['shortlisted', 'rejected', 'withdrawn'],
  shortlisted: ['interviewing', 'rejected', 'withdrawn'],
  interviewing: ['offered', 'rejected', 'withdrawn'],
  offered: ['hired', 'rejected', 'withdrawn'],
  hired: [],
  rejected: [],
  withdrawn: ['submitted']
});

const TERMINAL = Object.freeze(['hired', 'rejected']);

/** Which side of the table may make a given transition. */
const CONSULTANT_TRANSITIONS = Object.freeze(['withdrawn', 'submitted']);

/**
 * And which side may make the others.
 *
 * This used to be half a rule: the consultant's moves were declared and the employer's
 * were "everything else", so an employer could move an application to `withdrawn` —
 * withdrawing, on somebody's behalf, the application they made. That is the one status in
 * this machine that means an act by the candidate, and `countForJob` excludes it on
 * exactly that reading ("somebody who pulled out is not competition"). An employer able to
 * set it can quietly change what the public count on their own advert means.
 *
 * Declaring both sides also means the board can ask what a given actor may do with a row
 * instead of guessing, so a control is never offered for a move the model will refuse.
 */
const EMPLOYER_TRANSITIONS = Object.freeze(['reviewing', 'shortlisted', 'interviewing', 'offered', 'hired', 'rejected']);

/**
 * The status vocabulary, in pipeline order, derived from the state machine above rather
 * than written out again.
 *
 * It mirrors the ENUM in migration 003 and a unit test compares the two, for the reason
 * `Job.STATUSES` exists: this list was typed out by hand in the route that validates
 * `?status=` and again in the template that renders the tab strip, which is how a stage
 * gets added to a filter and silently rejected behind it.
 */
const STATUSES = Object.freeze(Object.keys(TRANSITIONS));

/**
 * The columns of the board.
 *
 * The six live stages, and NOT `rejected` or `withdrawn`. A board is for the work in
 * progress; a closed-outcome column only grows, and within a month it is the widest thing
 * on the screen and the live stages are off the edge of it. Both outcomes keep their place
 * in the list view, which is the one that can filter and page.
 */
const BOARD_COLUMNS = Object.freeze(['submitted', 'reviewing', 'shortlisted', 'interviewing', 'offered', 'hired']);

/**
 * THE filter builder for applications — the only one.
 *
 * The per-job pipeline, the cross-job pipeline, the board and the stage counts all come
 * through here, so the number on a tab provably counts the rows the tab opens. The job
 * pipeline assembled its own two-line WHERE before this existed, which was fine while
 * there was one list; the second list is where a divergence starts.
 *
 * Every query using it joins `applications a`, `jobs j` and `users u` under those aliases.
 */
function buildFilter(filters = {}) {
  const where = [];
  const params = [];

  // Scoping. A caller that passes neither is asking for every application on the site,
  // so say so rather than answering it.
  if (filters.company_user_id) {
    where.push('j.company_user_id = ?');
    params.push(filters.company_user_id);
  }
  if (filters.job_id) {
    where.push('a.job_id = ?');
    params.push(filters.job_id);
  }
  if (!filters.company_user_id && !filters.job_id) {
    throw new Error('An application filter must be scoped to a company or a job.');
  }

  if (filters.status && STATUSES.includes(filters.status)) {
    where.push('a.status = ?');
    params.push(filters.status);
  } else if (Array.isArray(filters.statuses) && filters.statuses.length) {
    const valid = filters.statuses.filter((s) => STATUSES.includes(s));
    if (valid.length === 0) throw new Error('No recognised status in the filter.');
    where.push(`a.status IN (${valid.map(() => '?').join(',')})`);
    params.push(...valid);
  } else if (!filters.include_withdrawn) {
    /*
     * Withdrawn is hidden unless it is asked for, by name or by the toggle. The same
     * reading as `countForJob`: a pipeline answers "who is in play", and somebody who
     * pulled out is not. They are one checkbox away, never gone — a row that cannot be
     * reached at all is a row an employer cannot work out what happened to.
     */
    where.push("a.status <> 'withdrawn'");
  }

  if (filters.q) {
    // Through likePattern, like every other LIKE in this codebase. A search for `%`
    // is a search for a per-cent sign, not a full scan of the applications table.
    where.push('u.name LIKE ?');
    params.push(containsPattern(filters.q));
  }

  /*
   * "Has reached this stage", from the append-only event log rather than from the current
   * status. Somebody who interviewed and was then turned down HAS interviewed, and a
   * filter reading `status = 'interviewing'` answers a narrower question than the one its
   * label asks — which matters most for the stage people most want to look back at.
   */
  if (filters.reached && STATUSES.includes(filters.reached)) {
    where.push('EXISTS (SELECT 1 FROM application_events ae WHERE ae.application_id = a.id AND ae.to_status = ?)');
    params.push(filters.reached);
  }

  return { clause: where.join(' AND '), params };
}

function canTransition(from, to) {
  return Boolean(TRANSITIONS[from] && TRANSITIONS[from].includes(to));
}

function isTerminal(status) {
  return TERMINAL.includes(status);
}

class Application {
  static get TRANSITIONS() {
    return TRANSITIONS;
  }

  static get STATUSES() {
    return STATUSES;
  }

  static get BOARD_COLUMNS() {
    return BOARD_COLUMNS;
  }

  static get EMPLOYER_TRANSITIONS() {
    return EMPLOYER_TRANSITIONS;
  }

  static buildFilter = buildFilter;

  /** What this actor may move this application to, so a control is never offered in vain. */
  static transitionsFor(status, { actorIsEmployer = false } = {}) {
    const allowed = actorIsEmployer ? EMPLOYER_TRANSITIONS : CONSULTANT_TRANSITIONS;
    return (TRANSITIONS[status] || []).filter((to) => allowed.includes(to));
  }

  static canTransition = canTransition;

  static isTerminal = isTerminal;

  /**
   * Apply, or re-open a withdrawn application.
   *
   * The unique key on (job_id, consultant_user_id) makes this idempotent: a
   * double-submitted form updates the existing row rather than creating a duplicate.
   * The job's denormalised counter is only incremented when a row is actually inserted.
   */
  static async apply(jobId, consultantUserId, { coverLetter = null, dayRate = null, currency = 'EUR', availableFrom = null }) {
    return withTransaction(async (conn) => {
      const [[job]] = await conn.query(
        "SELECT id, status, company_user_id, title FROM jobs WHERE id = ? AND status = 'open' FOR UPDATE",
        [jobId]
      );
      if (!job) {
        const err = new Error('This job is no longer accepting applications.');
        err.code = 'JOB_NOT_OPEN';
        throw err;
      }

      const [[existing]] = await conn.query(
        'SELECT id, status FROM applications WHERE job_id = ? AND consultant_user_id = ? FOR UPDATE',
        [jobId, consultantUserId]
      );

      if (existing) {
        if (isTerminal(existing.status)) {
          const err = new Error('This application has already been decided.');
          err.code = 'APPLICATION_CLOSED';
          throw err;
        }
        await conn.query(
          `UPDATE applications
              SET cover_letter = ?, day_rate = ?, currency = ?, available_from = ?, status = 'submitted'
            WHERE id = ?`,
          [coverLetter, dayRate, currency, availableFrom, existing.id]
        );
        await conn.query(
          'INSERT INTO application_events (application_id, actor_user_id, from_status, to_status, note) VALUES (?, ?, ?, ?, ?)',
          [existing.id, consultantUserId, existing.status, 'submitted', 'Application updated']
        );
        return { applicationId: existing.id, created: false, job };
      }

      const [result] = await conn.query(
        `INSERT INTO applications (job_id, consultant_user_id, cover_letter, day_rate, currency, available_from)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [jobId, consultantUserId, coverLetter, dayRate, currency, availableFrom]
      );
      await conn.query(
        'INSERT INTO application_events (application_id, actor_user_id, from_status, to_status) VALUES (?, ?, NULL, ?)',
        [result.insertId, consultantUserId, 'submitted']
      );
      await conn.query('UPDATE jobs SET application_count = application_count + 1 WHERE id = ?', [jobId]);

      return { applicationId: result.insertId, created: true, job };
    });
  }

  /**
   * Move an application through the pipeline.
   *
   * `actorUserId` must own the job (employer side) or be the applicant (consultant
   * side); the caller establishes that. This method enforces the state machine and
   * writes the audit event in the same transaction as the status change, so the audit
   * can never be missing for a transition that happened.
   */
  static async transition(applicationId, actorUserId, toStatus, { note = null, actorIsEmployer = false } = {}) {
    return withTransaction(async (conn) => {
      const [[application]] = await conn.query('SELECT * FROM applications WHERE id = ? FOR UPDATE', [applicationId]);
      if (!application) {
        const err = new Error('Application not found.');
        err.code = 'NOT_FOUND';
        throw err;
      }

      if (!canTransition(application.status, toStatus)) {
        const err = new Error(`Cannot move an application from "${application.status}" to "${toStatus}".`);
        err.code = 'INVALID_TRANSITION';
        throw err;
      }

      const allowedForActor = actorIsEmployer ? EMPLOYER_TRANSITIONS : CONSULTANT_TRANSITIONS;
      if (!allowedForActor.includes(toStatus)) {
        const err = new Error(
          actorIsEmployer
            ? 'Only the applicant can make this change.'
            : 'Only the hiring company can make this change.'
        );
        err.code = 'FORBIDDEN';
        throw err;
      }

      await conn.query('UPDATE applications SET status = ? WHERE id = ?', [toStatus, applicationId]);
      await conn.query(
        'INSERT INTO application_events (application_id, actor_user_id, from_status, to_status, note) VALUES (?, ?, ?, ?, ?)',
        [applicationId, actorUserId, application.status, toStatus, note]
      );

      return { ...application, status: toStatus, previousStatus: application.status };
    });
  }

  static async findById(applicationId) {
    const [rows] = await promisePool.query(
      `SELECT a.*, j.title AS job_title, j.slug AS job_slug, j.company_user_id,
              u.name AS consultant_name, u.email AS consultant_email,
              cp.headline, cp.primary_role, cp.seniority, cp.country, cp.profile_picture
         FROM applications a
         JOIN jobs j ON j.id = a.job_id
         JOIN users u ON u.id = a.consultant_user_id
         LEFT JOIN consultant_profiles cp ON cp.user_id = a.consultant_user_id
        WHERE a.id = ? LIMIT 1`,
      [applicationId]
    );
    return rows[0] || null;
  }

  /**
   * The rows behind every applicant list on the site.
   *
   * One SELECT, one filter builder, one ordering. The per-job pipeline, the cross-job
   * pipeline and the board are three layouts over this, so a candidate who is invisible
   * on one is invisible on all three without any of them knowing why.
   */
  static async list(filters = {}, { limit = 50, offset = 0 } = {}) {
    const { clause, params } = buildFilter(filters);

    const [rows] = await promisePool.query(
      `SELECT a.*, u.name AS consultant_name,
              j.title AS job_title, j.slug AS job_slug, j.status AS job_status,
              cp.headline, cp.primary_role, cp.seniority, cp.country, cp.profile_picture,
              cp.linkedin_verified,
              (SELECT COUNT(*) FROM consultant_certifications cc WHERE cc.user_id = a.consultant_user_id) AS certification_count,
              (SELECT MIN(ae.created_at) FROM application_events ae
                WHERE ae.application_id = a.id AND ae.to_status = 'interviewing') AS first_interviewed_at
         FROM applications a
         JOIN jobs j ON j.id = a.job_id
         JOIN users u ON u.id = a.consultant_user_id
         LEFT JOIN consultant_profiles cp ON cp.user_id = a.consultant_user_id
        WHERE ${clause}
        ORDER BY FIELD(a.status,'offered','interviewing','shortlisted','reviewing','submitted','hired','rejected','withdrawn'),
                 a.updated_at DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const [[{ total }]] = await promisePool.query(
      `SELECT COUNT(*) AS total
         FROM applications a
         JOIN jobs j ON j.id = a.job_id
         JOIN users u ON u.id = a.consultant_user_id
        WHERE ${clause}`,
      params
    );

    return { rows, total };
  }

  /** One advert's applicants. */
  static async listForJob(jobId, filters = {}, options = {}) {
    return Application.list({ ...filters, job_id: jobId }, options);
  }

  /**
   * Every applicant for every one of this company's adverts, one row per application.
   *
   * The company id is applied HERE rather than being left to the caller, so there is no
   * version of this call that returns somebody else's pipeline.
   */
  static async listForCompany(companyUserId, filters = {}, options = {}) {
    return Application.list({ ...filters, company_user_id: companyUserId }, options);
  }

  /**
   * Stage counts over the SAME filter as the list, so the number on a tab counts the rows
   * the tab opens. A count assembled from its own WHERE is the first thing to disagree
   * with the page under it, and it disagrees silently.
   */
  static async countsFor(filters = {}) {
    const { clause, params } = buildFilter({ ...filters, status: '', statuses: null });
    const [rows] = await promisePool.query(
      `SELECT a.status, COUNT(*) AS count
         FROM applications a
         JOIN jobs j ON j.id = a.job_id
         JOIN users u ON u.id = a.consultant_user_id
        WHERE ${clause}
        GROUP BY a.status`,
      params
    );
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
  }

  /**
   * How many people have applied, for the advert's own overview card.
   *
   * WITHDRAWN APPLICATIONS ARE EXCLUDED. The number answers "how much competition is
   * there", and somebody who pulled out is not competition — counting them inflates the
   * figure in the one direction that discourages the next reader for no reason.
   *
   * It is shown publicly on purpose. A candidate deciding where to spend an evening
   * learns something true from it, and hiding it advantages nobody but the advertiser.
   */
  static async countForJob(jobId) {
    const [[row]] = await promisePool.query(
      "SELECT COUNT(*) AS count FROM applications WHERE job_id = ? AND status <> 'withdrawn'",
      [jobId]
    );
    return row.count;
  }

  static async listForConsultant(consultantUserId, { limit = 30, offset = 0 } = {}) {
    const [rows] = await promisePool.query(
      `SELECT a.*, j.title AS job_title, j.slug AS job_slug, j.status AS job_status,
              cp.company_name, cp.slug AS company_slug
         FROM applications a
         JOIN jobs j ON j.id = a.job_id
         LEFT JOIN company_profiles cp ON cp.user_id = j.company_user_id
        WHERE a.consultant_user_id = ?
        ORDER BY a.updated_at DESC
        LIMIT ? OFFSET ?`,
      [consultantUserId, limit, offset]
    );
    return rows;
  }

  static async events(applicationId) {
    const [rows] = await promisePool.query(
      `SELECT ae.*, u.name AS actor_name
         FROM application_events ae
         LEFT JOIN users u ON u.id = ae.actor_user_id
        WHERE ae.application_id = ?
        ORDER BY ae.created_at ASC, ae.id ASC`,
      [applicationId]
    );
    return rows;
  }

  static async statusCountsForCompany(companyUserId) {
    const [rows] = await promisePool.query(
      `SELECT a.status, COUNT(*) AS count
         FROM applications a JOIN jobs j ON j.id = a.job_id
        WHERE j.company_user_id = ?
        GROUP BY a.status`,
      [companyUserId]
    );
    return Object.fromEntries(rows.map((r) => [r.status, r.count]));
  }
}

module.exports = Application;
