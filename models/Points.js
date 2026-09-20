'use strict';

const { promisePool } = require('../config/database');
const { POINT_AWARDS, levelFor } = require('../config/community');
const { escapeLike } = require('../utils/likePattern');

/**
 * The points ledger.
 *
 * Append-only. A single `points` column on the user row would be unauditable — nobody
 * could answer "where did these come from", and a double award could never be found, let
 * alone reversed. The ledger is the record; a total is a SUM over it.
 *
 * `award()` is fire-and-forget for the same reason notifications are: points are a side
 * effect of an action that has already succeeded, and failing to record them must never
 * fail the action. The unique `dedupe_key` makes the insert idempotent, so a retried
 * request or a re-run emitter cannot pay twice.
 */
class Points {
  static async award(userId, reason, dedupeKey, { connection = null } = {}) {
    const definition = POINT_AWARDS[reason];
    if (!definition || !userId || !dedupeKey) return false;

    const runner = connection || promisePool;
    try {
      const [result] = await runner.query(
        'INSERT IGNORE INTO points_ledger (user_id, reason, points, dedupe_key) VALUES (?, ?, ?, ?)',
        [userId, reason, definition.points, String(dedupeKey).slice(0, 190)]
      );
      return result.affectedRows === 1;
    } catch (err) {
      console.error(`Points award failed (${reason}): ${err.message}`);
      return false;
    }
  }

  /**
   * Reverse an award by writing a compensating entry rather than deleting the original.
   *
   * A ledger that can be edited is not a ledger. Un-accepting an answer or removing an
   * upvote must leave both the award and its reversal visible.
   */
  static async reverse(userId, reason, dedupeKey, { connection = null } = {}) {
    const definition = POINT_AWARDS[reason];
    if (!definition || !userId || !dedupeKey) return false;

    const runner = connection || promisePool;
    try {
      const [result] = await runner.query(
        'INSERT IGNORE INTO points_ledger (user_id, reason, points, dedupe_key) VALUES (?, ?, ?, ?)',
        [userId, `${reason}_reversed`, -definition.points, `reverse:${String(dedupeKey).slice(0, 180)}`]
      );
      return result.affectedRows === 1;
    } catch (err) {
      console.error(`Points reversal failed (${reason}): ${err.message}`);
      return false;
    }
  }

  /**
   * Make the ledger say what the CURRENT state says, by appending the difference.
   *
   * This exists because award-then-reverse keyed on the event is not reversible twice. An
   * upvote, withdrawn, then given again runs:
   *
   *     award   post_upvoted:12:34          +2
   *     reverse reverse:post_upvoted:12:34  -2
   *     award   post_upvoted:12:34          ignored — the key already exists
   *
   * so the author ends on -2 while the vote shows +1, permanently, because one voter
   * changed their mind twice. The same shape hits an accepted answer that is moved away and
   * then moved back. Both are silent, and neither can be found later without reading the
   * ledger by hand.
   *
   * So: compute what this subject has paid so far, compare it with what it SHOULD pay now,
   * and append one row for the difference. Append-only, because a ledger that can be edited
   * is not a ledger. Idempotent, because a repeat call computes a difference of zero and
   * writes nothing. And not farmable, because the net is pinned to the intended amount
   * however many times somebody flips — each swing costs a row, never a point.
   *
   * @param {string} subject a stable key for the thing being paid for, e.g. `post_upvoted:12:34`
   * @param {number} intendedPoints what the ledger should net for this subject right now
   */
  static async settleTo(userId, reason, subject, intendedPoints, { connection = null } = {}) {
    if (!userId || !reason || !subject) return false;

    const runner = connection || promisePool;
    const prefix = `${subject}#`;

    try {
      // The prefix is built from integers and a fixed reason, but it goes through the same
      // escaper as every other LIKE in this codebase — see CLAUDE.md.
      const [[current]] = await runner.query(
        'SELECT COALESCE(SUM(points), 0) AS net, COUNT(*) AS entries FROM points_ledger WHERE dedupe_key LIKE ?',
        [`${escapeLike(prefix)}%`]
      );

      const delta = Number(intendedPoints) - Number(current.net);
      if (delta === 0) return false;

      await runner.query(
        'INSERT IGNORE INTO points_ledger (user_id, reason, points, dedupe_key) VALUES (?, ?, ?, ?)',
        [
          userId,
          delta > 0 ? reason : `${reason}_reversed`,
          delta,
          `${prefix}${Number(current.entries)}`.slice(0, 190)
        ]
      );
      return true;
    } catch (err) {
      console.error(`Points settle failed (${reason}): ${err.message}`);
      return false;
    }
  }

  static async totalFor(userId) {
    const [[row]] = await promisePool.query(
      'SELECT COALESCE(SUM(points), 0) AS total FROM points_ledger WHERE user_id = ?',
      [userId]
    );
    return Number(row.total);
  }

  /** Total plus the derived level, which is what every sidebar actually wants. */
  static async standingFor(userId) {
    return levelFor(await Points.totalFor(userId));
  }

  static async recentFor(userId, { limit = 10 } = {}) {
    const [rows] = await promisePool.query(
      'SELECT reason, points, created_at FROM points_ledger WHERE user_id = ? ORDER BY id DESC LIMIT ?',
      [userId, limit]
    );
    return rows;
  }

  /**
   * Leaderboard over a window.
   *
   * All-time boards reward seniority rather than contribution, and become impossible for a
   * newcomer to enter. A rolling window keeps them winnable.
   */
  static async leaderboard({ days = 30, limit = 10 } = {}) {
    const [rows] = await promisePool.query(
      `SELECT pl.user_id, SUM(pl.points) AS points, u.name,
              cp.profile_picture, comp.logo
         FROM points_ledger pl
         JOIN users u ON u.id = pl.user_id AND u.is_active = 1
         LEFT JOIN consultant_profiles cp ON cp.user_id = u.id
         LEFT JOIN company_profiles comp ON comp.user_id = u.id
        WHERE pl.created_at > DATE_SUB(NOW(), INTERVAL ? DAY)
        GROUP BY pl.user_id, u.name, cp.profile_picture, comp.logo
       HAVING points > 0
        ORDER BY points DESC
        LIMIT ?`,
      [days, limit]
    );
    return rows.map((r) => ({ ...r, points: Number(r.points) }));
  }
}

module.exports = Points;
