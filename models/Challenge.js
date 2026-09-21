'use strict';

const { promisePool, withTransaction } = require('../config/database');
const Points = require('./Points');
const { dailySetFor, gradeAnswers, serverDate } = require('../config/challenges');

/**
 * Display name on a leaderboard.
 *
 * The same COALESCE `models/Conversation.js` uses, and for the same reason: an account
 * with no name would otherwise be shown by its email local part, which leaks
 * `firstname.lastname` to every visitor of a public-facing board. The email is not
 * selected at all here — a leaderboard has no use for one.
 */
const DISPLAY_NAME_SQL = "COALESCE(NULLIF(TRIM(u.name), ''), 'SAP Hub member')";

/**
 * The daily challenge.
 *
 * This model GRADES; it never stores a number a client sent. See `config/challenges.js`
 * for the reference implementation's `{ score, gameDate } = req.body` and why none of it
 * is ported.
 */

const STREAK_LOOKBACK_DAYS = 400;

class Challenge {
  /**
   * Record an attempt, or report that today is already played.
   *
   * The unique key on `(user_id, challenge_date)` is what enforces one attempt a day, and
   * it is checked by ATTEMPTING THE INSERT rather than by selecting first: a select-then-
   * insert has a window in which two concurrent submissions both see nothing and both
   * write. `INSERT IGNORE` closes it in the schema, the same way every fulfilment table
   * in this codebase does.
   *
   * Points are awarded inside the same transaction, keyed on the date, so a retried
   * request cannot pay twice even if the insert somehow did.
   */
  static async submit(userId, submittedAnswers, { now = new Date(), durationMs = null } = {}) {
    const date = serverDate(now);
    const questions = dailySetFor(date);
    const graded = gradeAnswers(questions, submittedAnswers);

    return withTransaction(async (conn) => {
      const record = graded.results.map((r) => ({ id: r.id, chosen: r.chosen, correct: r.correct }));

      /*
       * The serialised string binds straight into the JSON column. The reference writes
       * CAST(? AS JSON), which is MySQL-only — MariaDB rejects it with a parse error, and
       * this is the second place that bit. See models/RecruiterProfile.js, where it was
       * first found, for why binding the string is correct on both engines.
       */
      const [result] = await conn.query(
        `INSERT IGNORE INTO challenge_attempts
           (user_id, challenge_date, score, total, answers, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          userId,
          date,
          graded.score,
          graded.total,
          JSON.stringify(record),
          Number.isInteger(durationMs) && durationMs > 0 && durationMs < 86_400_000 ? durationMs : null
        ]
      );

      if (result.affectedRows !== 1) {
        // Already played. The earlier attempt stands: a second grading would let somebody
        // resubmit until they got five out of five, which is the reference's bug with an
        // extra step.
        const [[existing]] = await conn.query(
          'SELECT score, total, created_at FROM challenge_attempts WHERE user_id = ? AND challenge_date = ?',
          [userId, date]
        );
        return { recorded: false, date, alreadyPlayed: existing || null, graded };
      }

      /*
       * ONE settle for the attempt, not one award per correct answer.
       *
       * `Points.settleTo` is the only writer to the ledger here — see CLAUDE.md — and it
       * suits this better than a loop of awards anyway: the subject is the attempt, the
       * intended figure is what the attempt earned, and a retry computes a difference of
       * zero. The reference writes N rows keyed by index, which is a second key scheme
       * for the same fact and cannot be reconciled if the score is ever recomputed.
       *
       * It swallows its own failures by design: a bookkeeping problem must not fail the
       * thing the person actually did.
       */
      await Points.settleTo(
        userId,
        'challenge_completed',
        `challenge:${date}:${userId}`,
        graded.points,
        { connection: conn }
      );

      return { recorded: true, date, graded };
    });
  }

  /** Today's attempt for one person, or null. Used to decide what the page renders. */
  static async attemptFor(userId, date) {
    const [[row]] = await promisePool.query(
      'SELECT * FROM challenge_attempts WHERE user_id = ? AND challenge_date = ?',
      [userId, date]
    );
    if (!row) return null;

    // The JSON column comes back parsed on some driver paths and as a string on others —
    // the same handling as Payment.price_basis and RecruiterProfile.specialisms.
    let answers = row.answers;
    if (typeof answers === 'string') {
      try {
        answers = JSON.parse(answers);
      } catch {
        answers = null;
      }
    }
    return { ...row, answers: Array.isArray(answers) ? answers : [] };
  }

  /**
   * Re-grade a closed attempt so its explanations survive a page reload.
   *
   * The daily set is derived deterministically from the DATE, and the stored row keeps
   * which option was chosen for each question id — so the result can be rebuilt exactly,
   * at any time, from those two things. Without this the explanations exist only in the
   * response to the POST, and a refresh throws away the reason to have played.
   *
   * It is also a reconciliation: the score it recomputes is compared with the stored one,
   * and a disagreement means the bank was edited under a played day. That is logged
   * rather than hidden, because the honest answer to "your score changed" is to know.
   *
   * Safe to show the key here, and only here: the attempt is already closed by the unique
   * key, which is the same condition the POST path relies on.
   */
  static replay(attempt, date) {
    if (!attempt || !Array.isArray(attempt.answers)) return null;

    const chosen = {};
    for (const entry of attempt.answers) {
      if (entry && entry.id !== undefined) chosen[entry.id] = entry.chosen;
    }

    const graded = gradeAnswers(dailySetFor(date), chosen);
    if (graded.score !== attempt.score) {
      console.warn(
        `Challenge.replay: stored score ${attempt.score} for ${date} regrades to ${graded.score} `
        + '— the question bank has changed under a played day.'
      );
    }
    return graded;
  }

  /**
   * The current streak, DERIVED from the attempt dates.
   *
   * Not a counter, and not a `POST /streak/checkin` the browser calls — the reference has
   * both, and a stored counter fed by a client endpoint is a number with no evidence
   * behind it. Here the attempts ARE the evidence: the streak is however many consecutive
   * days end at today or yesterday, recomputed from rows that only the grader writes.
   *
   * Yesterday counts so that a streak is not lost at midnight by somebody who has not yet
   * played today; playing today extends it, missing today AND yesterday ends it.
   */
  static async streakFor(userId, { today = serverDate() } = {}) {
    const [rows] = await promisePool.query(
      `SELECT challenge_date
         FROM challenge_attempts
        WHERE user_id = ? AND challenge_date > (? - INTERVAL ? DAY)
        ORDER BY challenge_date DESC`,
      [userId, today, STREAK_LOOKBACK_DAYS]
    );
    return Challenge.streakFromDates(rows.map((r) => r.challenge_date), today);
  }

  /**
   * The streak rule as a pure function over dates, so it is testable without a database.
   * Exported deliberately: this is the bit that is easy to get wrong at month boundaries.
   */
  static streakFromDates(dates, today) {
    const played = new Set(
      (dates || []).map((d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)))
    );
    if (played.size === 0) return { days: 0, playedToday: false };

    const playedToday = played.has(today);
    const dayBefore = (iso) => new Date(`${iso}T00:00:00Z`).getTime() - 86_400_000;
    const isoOf = (ms) => new Date(ms).toISOString().slice(0, 10);

    let cursor = playedToday ? today : isoOf(dayBefore(today));
    if (!played.has(cursor)) return { days: 0, playedToday };

    let days = 0;
    while (played.has(cursor)) {
      days += 1;
      cursor = isoOf(dayBefore(cursor));
    }
    return { days, playedToday };
  }

  /**
   * The leaderboard for one day, and the all-time table.
   *
   * Both are derived at read time. There is no cached rank column anywhere, for the same
   * reason `job_features` has no `is_featured` boolean: a cached figure needs something to
   * come round and update it, and the day that job fails to run is the day the board is
   * quietly wrong.
   *
   * Ties break on the EARLIER attempt, not on `duration_ms`. The duration is reported by
   * the client, and ranking on a client-reported number is exactly the reference's bug.
   */
  static async dailyLeaderboard(date, { limit = 10 } = {}) {
    const [rows] = await promisePool.query(
      `SELECT a.score, a.total, a.created_at, u.id AS user_id, ${DISPLAY_NAME_SQL} AS name
         FROM challenge_attempts a
         JOIN users u ON u.id = a.user_id
        WHERE a.challenge_date = ? AND u.is_active = 1
        ORDER BY a.score DESC, a.created_at ASC
        LIMIT ?`,
      [date, limit]
    );
    return rows;
  }

  static async allTimeLeaderboard({ days = 30, limit = 10 } = {}) {
    const [rows] = await promisePool.query(
      `SELECT u.id AS user_id, ${DISPLAY_NAME_SQL} AS name,
              SUM(a.score) AS total_score,
              COUNT(*)     AS days_played
         FROM challenge_attempts a
         JOIN users u ON u.id = a.user_id
        WHERE a.challenge_date > (CURDATE() - INTERVAL ? DAY) AND u.is_active = 1
        GROUP BY u.id, u.name
        ORDER BY total_score DESC, days_played DESC, u.id ASC
        LIMIT ?`,
      [days, limit]
    );
    return rows;
  }

  /** How somebody has done overall, for their dashboard. */
  static async statsFor(userId) {
    const [[row]] = await promisePool.query(
      `SELECT COUNT(*) AS days_played, COALESCE(SUM(score), 0) AS correct,
              COALESCE(SUM(total), 0) AS asked, COALESCE(MAX(score), 0) AS best
         FROM challenge_attempts WHERE user_id = ?`,
      [userId]
    );
    return row;
  }
}

module.exports = Challenge;
