'use strict';

const { promisePool, withTransaction } = require('../config/database');
const User = require('./User');

/**
 * Handing an advert over to a colleague.
 *
 * The whole design follows from one fact: an advert is not only text. It owns
 * applications — cover letters, day rates, names — and the threads anchored to it, and
 * those were written by people who chose ONE employer. So this is an offer addressed to an
 * email, accepted by a signed-in account, and it is refused outright the moment the advert
 * has acquired anybody else's data.
 */

/**
 * An offer expires, because one that does not is a standing grant on somebody else's
 * advert. Seven days is long enough for somebody on leave and short enough that a
 * forgotten offer is not still live a quarter later.
 */
const OFFER_WINDOW_DAYS = 7;

const STATUSES = Object.freeze(['pending', 'accepted', 'declined', 'cancelled', 'expired']);

function windowEnd(from = new Date()) {
  return new Date(from.getTime() + OFFER_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

function notFound(message = 'That transfer is no longer available.') {
  const err = new Error(message);
  err.code = 'TRANSFER_NOT_FOUND';
  return err;
}

function refuse(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

class JobTransfer {
  static get OFFER_WINDOW_DAYS() {
    return OFFER_WINDOW_DAYS;
  }

  static get STATUSES() {
    return STATUSES;
  }

  static get MAX_MESSAGE_LENGTH() {
    return 500;
  }

  /**
   * May this advert be handed over, and if not, WHY NOT in words the owner can act on.
   *
   * An advert with applications or a thread carries data that belongs to the people who
   * wrote it. This application has no notion of an organisation — two colleagues are two
   * unrelated company accounts with two company profiles that merely happen to share a
   * name — so there is nothing here that can establish that the recipient works at the
   * same employer the candidates applied to. Moving their cover letters and day rates to
   * an account the system cannot connect to that employer is a disclosure nobody asked
   * them about, and an advert nobody has applied to yet has nothing to disclose.
   *
   * "Close it and post your own" is a worse answer than this one only when there are no
   * applications — which is exactly the case this allows.
   */
  static async eligibility(jobId, conn = promisePool) {
    const [[counts]] = await conn.query(
      `SELECT
         (SELECT COUNT(*) FROM applications WHERE job_id = ?) AS applications,
         (SELECT COUNT(*) FROM conversations WHERE job_id = ?) AS conversations`,
      [jobId, jobId]
    );

    const reasons = [];
    if (Number(counts.applications) > 0) {
      reasons.push(
        `${counts.applications} ${Number(counts.applications) === 1 ? 'person has' : 'people have'} applied. ` +
          'Their applications were made to your account, so the advert is no longer yours alone to give away.'
      );
    }
    if (Number(counts.conversations) > 0) {
      reasons.push('A conversation is anchored to this role, and the other party wrote it to you.');
    }

    return { ok: reasons.length === 0, reasons };
  }

  /**
   * Offer the advert to an address.
   *
   * The address is NOT resolved to an account here. Doing so would let any company account
   * use this form to ask whether a given email has an account on the site, one offer at a
   * time — and the sender gains nothing from the answer that the expiry does not give
   * them. The recipient finds the offer by matching their own signed-in address.
   */
  static async offer(jobId, fromUserId, { toEmail, message = null } = {}) {
    const normalised = User.normaliseEmail(toEmail || '');
    if (!normalised || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalised)) {
      throw refuse('INVALID_EMAIL', 'That does not look like an email address.');
    }

    return withTransaction(async (conn) => {
      const [[job]] = await conn.query(
        'SELECT id, company_user_id, title FROM jobs WHERE id = ? FOR UPDATE',
        [jobId]
      );
      if (!job) throw notFound('That role no longer exists.');
      if (job.company_user_id !== fromUserId) throw notFound();

      const [[owner]] = await conn.query('SELECT email FROM users WHERE id = ? LIMIT 1', [fromUserId]);
      if (owner && User.normaliseEmail(owner.email) === normalised) {
        throw refuse('SELF_TRANSFER', 'That is your own address.');
      }

      const { ok, reasons } = await JobTransfer.eligibility(jobId, conn);
      if (!ok) throw refuse('NOT_TRANSFERABLE', reasons[0]);

      /*
       * A pending offer that has run out of time is settled HERE, by the next person to
       * act, rather than by a scheduled job. The unique key allows one pending row per
       * advert, so this is also what makes a second offer possible after the first lapsed
       * — and it leaves the lapse in the audit trail instead of silently reusing the row.
       */
      await conn.query(
        "UPDATE job_transfers SET status = 'expired', responded_at = NOW() WHERE job_id = ? AND status = 'pending' AND expires_at <= NOW()",
        [jobId]
      );

      const [[existing]] = await conn.query(
        "SELECT id FROM job_transfers WHERE job_id = ? AND status = 'pending' LIMIT 1",
        [jobId]
      );
      if (existing) {
        throw refuse('ALREADY_OFFERED', 'This role is already offered to somebody. Cancel that offer first.');
      }

      const [result] = await conn.query(
        'INSERT INTO job_transfers (job_id, from_user_id, to_email, message, expires_at) VALUES (?, ?, ?, ?, ?)',
        [jobId, fromUserId, normalised, message ? String(message).slice(0, 500) : null, windowEnd()]
      );

      return { id: result.insertId, jobTitle: job.title, toEmail: normalised };
    });
  }

  /**
   * Accept, and move the advert.
   *
   * Everything that could have changed since the offer was made is re-checked INSIDE the
   * transaction with both rows locked: the expiry, the advert's current owner, and above
   * all the eligibility — somebody applying between the offer and the acceptance is the
   * race this rule exists for, and it is the one case where a refusal here is the whole
   * point rather than an inconvenience.
   */
  static async accept(transferId, acceptingUser) {
    try {
      return await JobTransfer.acceptInTransaction(transferId, acceptingUser);
    } catch (err) {
      /*
       * The lapse is recorded HERE, outside the transaction that refused the acceptance.
       *
       * The obvious place to write it is next to the check, and that is wrong: the throw
       * that reports the refusal rolls the whole transaction back, so the row the handler
       * just marked `expired` goes back to `pending` on the way out. A test caught it —
       * the refusal was correct and the audit it wrote never existed.
       */
      if (err.code === 'EXPIRED') {
        await promisePool.query(
          "UPDATE job_transfers SET status = 'expired', responded_at = NOW() WHERE id = ? AND status = 'pending'",
          [transferId]
        );
      }
      throw err;
    }
  }

  static async acceptInTransaction(transferId, acceptingUser) {
    return withTransaction(async (conn) => {
      const [[transfer]] = await conn.query('SELECT * FROM job_transfers WHERE id = ? FOR UPDATE', [transferId]);
      if (!transfer || transfer.status !== 'pending') throw notFound();

      // The offer was addressed to an address, and this is the only thing that claims it.
      if (User.normaliseEmail(acceptingUser.email) !== transfer.to_email) throw notFound();
      // The constraint MariaDB would not take, held where the writing happens.
      if (transfer.from_user_id === acceptingUser.id) throw notFound();
      if (!acceptingUser.isCompany) {
        throw refuse('NOT_A_COMPANY', 'An advert can only be held by a company account.');
      }

      if (new Date(transfer.expires_at) <= new Date()) {
        throw refuse('EXPIRED', 'That offer has expired. Ask for a new one.');
      }

      const [[job]] = await conn.query('SELECT * FROM jobs WHERE id = ? FOR UPDATE', [transfer.job_id]);
      if (!job) throw notFound('That role no longer exists.');
      if (job.company_user_id !== transfer.from_user_id) {
        throw refuse('MOVED', 'That role has changed hands since the offer was made.');
      }

      const { ok, reasons } = await JobTransfer.eligibility(job.id, conn);
      if (!ok) throw refuse('NOT_TRANSFERABLE', reasons[0]);

      /*
       * An OPEN advert is paused by the move, and nothing else changes.
       *
       * The public page names the company that posted the role and renders their "About
       * the company" box. That sentence changing under the people reading it, with nobody
       * having looked at the advert first, is the one thing a transfer must not do
       * silently — so the new owner reads what now carries their name and publishes it
       * themselves. A draft stays a draft: there is nothing live to take down.
       */
      const nextStatus = job.status === 'open' ? 'paused' : job.status;
      await conn.query('UPDATE jobs SET company_user_id = ?, status = ? WHERE id = ?', [
        acceptingUser.id,
        nextStatus,
        job.id
      ]);

      await conn.query(
        "UPDATE job_transfers SET status = 'accepted', to_user_id = ?, responded_at = NOW() WHERE id = ?",
        [acceptingUser.id, transferId]
      );

      return { jobId: job.id, jobSlug: job.slug, jobTitle: job.title, fromUserId: transfer.from_user_id, wasPaused: nextStatus !== job.status };
    });
  }

  /** The recipient says no. Nothing moves; the row records that they answered. */
  static async decline(transferId, decliningUser) {
    const [result] = await promisePool.query(
      "UPDATE job_transfers SET status = 'declined', to_user_id = ?, responded_at = NOW() WHERE id = ? AND status = 'pending' AND to_email = ?",
      [decliningUser.id, transferId, User.normaliseEmail(decliningUser.email)]
    );
    if (result.affectedRows === 0) throw notFound();
    return true;
  }

  /** The sender withdraws it. */
  static async cancel(transferId, fromUserId) {
    const [result] = await promisePool.query(
      "UPDATE job_transfers SET status = 'cancelled', responded_at = NOW() WHERE id = ? AND status = 'pending' AND from_user_id = ?",
      [transferId, fromUserId]
    );
    if (result.affectedRows === 0) throw notFound();
    return true;
  }

  /** Offers this account has made, newest first. The whole history, not just the live one. */
  static async listForSender(fromUserId, { limit = 50 } = {}) {
    const [rows] = await promisePool.query(
      `SELECT t.*, j.title AS job_title, j.slug AS job_slug, j.status AS job_status,
              (t.status = 'pending' AND t.expires_at <= NOW()) AS lapsed
         FROM job_transfers t
         JOIN jobs j ON j.id = t.job_id
        WHERE t.from_user_id = ?
        ORDER BY t.created_at DESC
        LIMIT ?`,
      [fromUserId, limit]
    );
    return rows;
  }

  /**
   * Offers waiting for this account, matched on the signed-in address.
   *
   * Live ones only: an offer that lapsed was never accepted and showing it as actionable
   * would be offering a button that answers "expired".
   */
  static async pendingForUser(user, { limit = 50 } = {}) {
    const [rows] = await promisePool.query(
      `SELECT t.*, j.title AS job_title, j.slug AS job_slug, j.status AS job_status,
              j.role, j.country, j.city, j.seniority,
              u.name AS from_name, cp.company_name AS from_company
         FROM job_transfers t
         JOIN jobs j ON j.id = t.job_id
         JOIN users u ON u.id = t.from_user_id
         LEFT JOIN company_profiles cp ON cp.user_id = t.from_user_id
        WHERE t.to_email = ? AND t.status = 'pending' AND t.expires_at > NOW()
        ORDER BY t.created_at DESC
        LIMIT ?`,
      [User.normaliseEmail(user.email), limit]
    );
    return rows;
  }

  /** The live offer on one advert, for the owner's panel. */
  static async pendingForJob(jobId) {
    const [rows] = await promisePool.query(
      "SELECT * FROM job_transfers WHERE job_id = ? AND status = 'pending' AND expires_at > NOW() LIMIT 1",
      [jobId]
    );
    return rows[0] || null;
  }
}

module.exports = JobTransfer;
