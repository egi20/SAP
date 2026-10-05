'use strict';

const { promisePool, withTransaction } = require('../config/database');

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

      if (!actorIsEmployer && !CONSULTANT_TRANSITIONS.includes(toStatus)) {
        const err = new Error('Only the hiring company can make this change.');
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

  static async listForJob(jobId, { status = '', limit = 50, offset = 0 } = {}) {
    const where = ['a.job_id = ?'];
    const params = [jobId];
    if (status) {
      where.push('a.status = ?');
      params.push(status);
    }
    const clause = where.join(' AND ');

    const [rows] = await promisePool.query(
      `SELECT a.*, u.name AS consultant_name,
              cp.headline, cp.primary_role, cp.seniority, cp.country, cp.profile_picture,
              cp.linkedin_verified,
              (SELECT COUNT(*) FROM consultant_certifications cc WHERE cc.user_id = a.consultant_user_id) AS certification_count
         FROM applications a
         JOIN users u ON u.id = a.consultant_user_id
         LEFT JOIN consultant_profiles cp ON cp.user_id = a.consultant_user_id
        WHERE ${clause}
        ORDER BY FIELD(a.status,'offered','interviewing','shortlisted','reviewing','submitted','hired','rejected','withdrawn'),
                 a.created_at DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const [[{ total }]] = await promisePool.query(`SELECT COUNT(*) AS total FROM applications a WHERE ${clause}`, params);
    return { rows, total };
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
