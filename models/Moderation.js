'use strict';

const { promisePool, withTransaction } = require('../config/database');
const Points = require('./Points');
const { POINT_AWARDS } = require('../config/community');

/**
 * Taking content down, and being able to say why later.
 *
 * THE rule: content is HIDDEN, never deleted. A hide is reversible, keeps the row so
 * counters and foreign keys stay consistent, and leaves the author's work intact if the
 * decision turns out to be wrong. DELETE is not a decision anybody should be able to take
 * in one click from a list view.
 *
 * All of it goes through this one module. A second place that flipped `hidden_at` would be
 * a second place that forgot the counter, the points or the log — and the columns have
 * been read by `Post.buildFilter` and every query in `RateSubmission` since they were
 * created, so a bare UPDATE would "work" convincingly while getting the rest wrong.
 *
 * POINTS ARE SETTLED, NOT REVERSED, and that is the substantive difference from the
 * reference. It keys each adjustment on the moderation EVENT (`mod:{eventId}`), which it
 * has to: with only `award`/`reverse` available, a key derived from the content is
 * consumed after one cycle and hide-then-restore-then-hide would take the points away once
 * and never give them back. Keying on a fresh event id works, but it makes the author's
 * balance a function of the SEQUENCE of moderation actions rather than of the current
 * state — so a reverse for content that was never awarded still deducts, and any gap
 * between the two ledgers is invisible. `Points.settleTo` computes the difference between
 * what a subject has paid and what it should pay now, so here the balance is a function of
 * the state: hidden pays nothing, visible pays the award, and it comes out right however
 * many times a moderator changes their mind or whatever happened before.
 */

const SUBJECT_TYPES = Object.freeze(['post', 'reply', 'rate_submission', 'consultant_profile', 'job']);

function notFound(message) {
  const err = new Error(message);
  err.code = 'NOT_FOUND';
  return err;
}

/** Append-only. An undo is another row, never an edit to this one. */
async function logEvent(conn, { subjectType, subjectId, action, actorUserId, subjectUserId, reason }) {
  const [result] = await conn.query(
    `INSERT INTO moderation_events
       (subject_type, subject_id, action, actor_user_id, subject_user_id, reason)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      subjectType,
      subjectId,
      action,
      actorUserId || null,
      subjectUserId || null,
      reason ? String(reason).slice(0, 200) : null
    ]
  );
  return result.insertId;
}

class Moderation {
  static get SUBJECT_TYPES() {
    return SUBJECT_TYPES;
  }

  /**
   * Hide or restore a post.
   *
   * Its replies are left alone deliberately: they are other people's writing, and a thread
   * removed for its opening post does not make every answer under it abusive. They become
   * unreachable with it, which is the intended effect, and they keep their points because
   * nothing was decided about them.
   */
  static async setPostHidden(postId, hidden, { actorUserId, reason = null } = {}) {
    return withTransaction(async (conn) => {
      const [[post]] = await conn.query(
        'SELECT id, author_user_id, title, slug, hidden_at FROM posts WHERE id = ? FOR UPDATE',
        [postId]
      );
      if (!post) throw notFound('That post no longer exists.');

      // Not an error, just nothing to do: two moderators pressing the same button is a
      // normal thing to happen, not a conflict to surface.
      if (Boolean(post.hidden_at) === Boolean(hidden)) return { changed: false, post };

      const eventId = await logEvent(conn, {
        subjectType: 'post',
        subjectId: postId,
        action: hidden ? 'hide' : 'restore',
        actorUserId,
        subjectUserId: post.author_user_id,
        reason
      });

      if (hidden) {
        await conn.query(
          'UPDATE posts SET hidden_at = NOW(), hidden_by_user_id = ?, hidden_reason = ? WHERE id = ?',
          [actorUserId || null, reason ? String(reason).slice(0, 200) : null, postId]
        );
      } else {
        await conn.query(
          'UPDATE posts SET hidden_at = NULL, hidden_by_user_id = NULL, hidden_reason = NULL WHERE id = ?',
          [postId]
        );
      }

      await Points.settleTo(
        post.author_user_id,
        'post_created',
        `post:${postId}`,
        hidden ? 0 : POINT_AWARDS.post_created.points,
        { connection: conn }
      );

      return { changed: true, post, eventId };
    });
  }

  /**
   * Hide or restore a reply.
   *
   * Three things move with the flag, and all three are why this cannot be a bare UPDATE:
   *
   *  1. `posts.reply_count` — denormalised so the feed never aggregates, which means it is
   *     only ever right if it moves in the same transaction;
   *  2. the accepted-solution mark — a question must never point at content nobody can
   *     read, so hiding the accepted answer un-solves the question and settles the (much
   *     larger) award for it back to nothing;
   *  3. the points for having written it.
   */
  static async setReplyHidden(replyId, hidden, { actorUserId, reason = null } = {}) {
    return withTransaction(async (conn) => {
      const [[reply]] = await conn.query(
        'SELECT id, post_id, author_user_id, is_solution, hidden_at FROM post_replies WHERE id = ? FOR UPDATE',
        [replyId]
      );
      if (!reply) throw notFound('That reply no longer exists.');

      if (Boolean(reply.hidden_at) === Boolean(hidden)) return { changed: false, reply };

      const eventId = await logEvent(conn, {
        subjectType: 'reply',
        subjectId: replyId,
        action: hidden ? 'hide' : 'restore',
        actorUserId,
        subjectUserId: reply.author_user_id,
        reason
      });

      if (hidden) {
        await conn.query(
          'UPDATE post_replies SET hidden_at = NOW(), hidden_by_user_id = ?, hidden_reason = ? WHERE id = ?',
          [actorUserId || null, reason ? String(reason).slice(0, 200) : null, replyId]
        );
        /*
         * CAST because `reply_count` is UNSIGNED: under strict mode `0 - 1` is an error,
         * not a negative number. It cannot reach zero here in practice — every visible
         * reply added one — but a counter that can error out on an edge is a counter that
         * eventually will, in the middle of somebody else's transaction.
         */
        await conn.query(
          'UPDATE posts SET reply_count = GREATEST(CAST(reply_count AS SIGNED) - 1, 0) WHERE id = ?',
          [reply.post_id]
        );

        if (reply.is_solution) {
          await conn.query('UPDATE post_replies SET is_solution = 0 WHERE id = ?', [replyId]);
          await conn.query(
            'UPDATE posts SET is_solved = 0, solution_reply_id = NULL WHERE id = ? AND solution_reply_id = ?',
            [reply.post_id, replyId]
          );
          await Points.settleTo(reply.author_user_id, 'reply_accepted', `accepted:${replyId}`, 0, {
            connection: conn
          });
        }
      } else {
        await conn.query(
          'UPDATE post_replies SET hidden_at = NULL, hidden_by_user_id = NULL, hidden_reason = NULL WHERE id = ?',
          [replyId]
        );
        await conn.query('UPDATE posts SET reply_count = reply_count + 1 WHERE id = ?', [reply.post_id]);
        // The solution mark is NOT restored. Whether this is still the best answer is the
        // asker's call, not a side effect of a moderator undoing a removal.
      }

      await Points.settleTo(
        reply.author_user_id,
        'reply_created',
        `reply:${replyId}`,
        hidden ? 0 : POINT_AWARDS.reply_created.points,
        { connection: conn }
      );

      return { changed: true, reply, eventId };
    });
  }

  /**
   * Void or reinstate a rate submission.
   *
   * Not about speech, about arithmetic: the index publishes percentiles, and one figure
   * entered in the wrong unit — an annual salary typed into a day-rate field — moves them
   * for everybody, silently. Voiding removes the row from every aggregate while leaving it
   * in place, so the contribution stays auditable and the unique key still governs what
   * that person may submit for the period.
   *
   * There is deliberately no "correct the value" path. An aggregate whose inputs an
   * administrator can retype is an aggregate nobody should trust.
   */
  static async setRateVoided(submissionId, voided, { actorUserId, reason = null } = {}) {
    return withTransaction(async (conn) => {
      const [[row]] = await conn.query(
        'SELECT id, user_id, amount_eur, voided_at FROM rate_submissions WHERE id = ? FOR UPDATE',
        [submissionId]
      );
      if (!row) throw notFound('That submission no longer exists.');

      if (Boolean(row.voided_at) === Boolean(voided)) return { changed: false, submission: row };

      const eventId = await logEvent(conn, {
        subjectType: 'rate_submission',
        subjectId: submissionId,
        action: voided ? 'void' : 'reinstate',
        actorUserId,
        subjectUserId: row.user_id,
        reason
      });

      if (voided) {
        await conn.query(
          'UPDATE rate_submissions SET voided_at = NOW(), voided_by = ?, void_reason = ? WHERE id = ?',
          [actorUserId || null, reason ? String(reason).slice(0, 200) : null, submissionId]
        );
      } else {
        await conn.query(
          'UPDATE rate_submissions SET voided_at = NULL, voided_by = NULL, void_reason = NULL WHERE id = ?',
          [submissionId]
        );
      }

      await Points.settleTo(
        row.user_id,
        'rate_contributed',
        `rate:${submissionId}`,
        voided ? 0 : POINT_AWARDS.rate_contributed.points,
        { connection: conn }
      );

      return { changed: true, submission: row, eventId };
    });
  }

  /** The log, newest first. Read-only everywhere: there is no update or delete path. */
  /**
   * Take a consultant profile out of the public directory, or put it back.
   *
   * THIS IS THE ONLY WRITER of `admin_hidden_at`, for the reason every other column in
   * this file has one: three things read the directory — the list, the search source and
   * the match — and all three go through `ConsultantProfile.buildFilter`, so a bare UPDATE
   * somewhere else would look like it worked while the decision was never logged.
   *
   * It writes a DIFFERENT column from the member's own `is_public`. An administrator
   * writing to that one would be making a suggestion: the member presses Publish again and
   * the decision is gone, with nothing on their screen having said one was made.
   *
   * Nothing is deleted. The profile, the skills, the certifications and the delivery
   * history all stay — the owner still sees what they wrote, and restoring is one press.
   */
  static async setProfileHidden(userId, hidden, { actorUserId, reason = null } = {}) {
    return withTransaction(async (conn) => {
      const [[profile]] = await conn.query(
        'SELECT user_id, admin_hidden_at FROM consultant_profiles WHERE user_id = ? FOR UPDATE',
        [userId]
      );
      if (!profile) throw notFound('That consultant profile no longer exists.');

      // Two moderators pressing the same button is a normal thing to happen.
      if (Boolean(profile.admin_hidden_at) === Boolean(hidden)) return { changed: false };

      const eventId = await logEvent(conn, {
        subjectType: 'consultant_profile',
        subjectId: userId,
        action: hidden ? 'hide' : 'restore',
        actorUserId,
        subjectUserId: userId,
        reason
      });

      if (hidden) {
        await conn.query(
          `UPDATE consultant_profiles
              SET admin_hidden_at = NOW(), admin_hidden_by_user_id = ?, admin_hidden_reason = ?
            WHERE user_id = ?`,
          [actorUserId || null, reason ? String(reason).slice(0, 200) : null, userId]
        );
      } else {
        /*
         * Restoring clears the moderator's column and NOTHING ELSE. Whether the profile
         * then appears is still the member's own `is_public` and the completeness floor —
         * an administrator undoing a removal does not publish somebody's profile for them,
         * exactly as restoring a reply gives back the writing points but not the
         * accepted-answer mark.
         */
        await conn.query(
          `UPDATE consultant_profiles
              SET admin_hidden_at = NULL, admin_hidden_by_user_id = NULL, admin_hidden_reason = NULL
            WHERE user_id = ?`,
          [userId]
        );
      }

      return { changed: true, eventId };
    });
  }

  /**
   * Take a job advert down, or put it back.
   *
   * A DIFFERENT COLUMN FROM `status`, for the reason the profile one is different from
   * `is_public`: the advertiser moves their own status freely, so a moderator writing
   * `closed` there would be overruled by the next person who pressed Reopen.
   *
   * Nothing is deleted. The applications made to the advert, their audit events and the
   * conversations anchored to it belong to other people and stay exactly where they are —
   * which is also why this is not "delete the job".
   */
  static async setJobHidden(jobId, hidden, { actorUserId, reason = null } = {}) {
    return withTransaction(async (conn) => {
      const [[job]] = await conn.query(
        'SELECT id, title, slug, company_user_id, admin_hidden_at FROM jobs WHERE id = ? FOR UPDATE',
        [jobId]
      );
      if (!job) throw notFound('That advert no longer exists.');
      if (Boolean(job.admin_hidden_at) === Boolean(hidden)) return { changed: false, job };

      const eventId = await logEvent(conn, {
        subjectType: 'job',
        subjectId: jobId,
        action: hidden ? 'hide' : 'restore',
        actorUserId,
        subjectUserId: job.company_user_id,
        reason
      });

      if (hidden) {
        await conn.query(
          'UPDATE jobs SET admin_hidden_at = NOW(), admin_hidden_by_user_id = ?, admin_hidden_reason = ? WHERE id = ?',
          [actorUserId || null, reason ? String(reason).slice(0, 200) : null, jobId]
        );
      } else {
        /*
         * Restoring clears our decision and nothing else. Whether the advert is live again
         * is still its own `status` — an administrator undoing a removal does not republish
         * somebody's advert for them.
         */
        await conn.query(
          'UPDATE jobs SET admin_hidden_at = NULL, admin_hidden_by_user_id = NULL, admin_hidden_reason = NULL WHERE id = ?',
          [jobId]
        );
      }

      return { changed: true, job, eventId };
    });
  }

  static async events({ limit = 50, offset = 0, subjectUserId = null } = {}) {
    const where = subjectUserId ? 'e.subject_user_id = ?' : '1 = 1';
    const params = subjectUserId ? [subjectUserId] : [];

    const [rows] = await promisePool.query(
      `SELECT e.*, actor.name AS actor_name, member.name AS member_name
         FROM moderation_events e
         LEFT JOIN users actor ON actor.id = e.actor_user_id
         LEFT JOIN users member ON member.id = e.subject_user_id
        WHERE ${where}
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const [[{ total }]] = await promisePool.query(
      `SELECT COUNT(*) AS total FROM moderation_events e WHERE ${where}`,
      params
    );
    return { rows, total };
  }

  /**
   * Everything currently taken down, for the screen that can put it back.
   *
   * A moderation tool that can only remove is a tool nobody dares use, so the hidden list
   * is as prominent as the queue and every row carries who hid it and why.
   */
  static async hiddenContent({ limit = 50 } = {}) {
    const [posts] = await promisePool.query(
      `SELECT p.id, p.title, p.slug, p.kind, p.hidden_at, p.hidden_reason,
              u.name AS author_name, hider.name AS hidden_by_name
         FROM posts p
         JOIN users u ON u.id = p.author_user_id
         LEFT JOIN users hider ON hider.id = p.hidden_by_user_id
        WHERE p.hidden_at IS NOT NULL
        ORDER BY p.hidden_at DESC
        LIMIT ?`,
      [limit]
    );

    const [replies] = await promisePool.query(
      `SELECT r.id, r.post_id, r.body, r.hidden_at, r.hidden_reason,
              p.title AS post_title, p.slug AS post_slug,
              u.name AS author_name, hider.name AS hidden_by_name
         FROM post_replies r
         JOIN posts p ON p.id = r.post_id
         JOIN users u ON u.id = r.author_user_id
         LEFT JOIN users hider ON hider.id = r.hidden_by_user_id
        WHERE r.hidden_at IS NOT NULL
        ORDER BY r.hidden_at DESC
        LIMIT ?`,
      [limit]
    );

    const [rates] = await promisePool.query(
      `SELECT rs.id, rs.role, rs.seniority, rs.amount, rs.currency, rs.period,
              rs.voided_at, rs.void_reason,
              u.name AS contributor_name, voider.name AS voided_by_name
         FROM rate_submissions rs
         JOIN users u ON u.id = rs.user_id
         LEFT JOIN users voider ON voider.id = rs.voided_by
        WHERE rs.voided_at IS NOT NULL
        ORDER BY rs.voided_at DESC
        LIMIT ?`,
      [limit]
    );

    /*
     * The two takedowns that are not community content. They are here rather than behind
     * an `include_hidden` option on `Job.buildFilter` or
     * `ConsultantProfile.buildFilter`, because an option like that is how the rule ends up
     * switched off on whichever page forgets to pass it.
     */
    const [jobs] = await promisePool.query(
      `SELECT j.id, j.title, j.slug, j.status, j.admin_hidden_at, j.admin_hidden_reason,
              COALESCE(NULLIF(TRIM(cp.company_name), ''), u.name) AS company_name,
              hider.name AS hidden_by_name
         FROM jobs j
         JOIN users u ON u.id = j.company_user_id
         LEFT JOIN company_profiles cp ON cp.user_id = j.company_user_id
         LEFT JOIN users hider ON hider.id = j.admin_hidden_by_user_id
        WHERE j.admin_hidden_at IS NOT NULL
        ORDER BY j.admin_hidden_at DESC
        LIMIT ?`,
      [limit]
    );

    const [profiles] = await promisePool.query(
      `SELECT p.user_id, p.headline, p.primary_role, p.admin_hidden_at, p.admin_hidden_reason,
              u.name AS member_name, hider.name AS hidden_by_name
         FROM consultant_profiles p
         JOIN users u ON u.id = p.user_id
         LEFT JOIN users hider ON hider.id = p.admin_hidden_by_user_id
        WHERE p.admin_hidden_at IS NOT NULL
        ORDER BY p.admin_hidden_at DESC
        LIMIT ?`,
      [limit]
    );

    return { posts, replies, rates, jobs, profiles };
  }
}

module.exports = Moderation;
