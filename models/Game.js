'use strict';

const { promisePool, withTransaction } = require('../config/database');
const Points = require('./Points');
const games = require('../config/games');

/** Same rule as the challenge board: never an email local part on a public table. */
const DISPLAY_NAME_SQL = "COALESCE(NULLIF(TRIM(u.name), ''), 'SAP Hub member')";

function parseAnswers(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Attempts at the scored SAP games. This model GRADES; it never stores a number a client
 * sent. The shape is models/Challenge.js again, deliberately — one attempt per game per day
 * by a unique key checked by attempting the insert, and points settled once per attempt in
 * the same transaction.
 */
class Game {
  static async submit(userId, gameKey, submitted, { now = new Date() } = {}) {
    if (!games.SCORED_KEYS.includes(gameKey)) throw new Error(`${gameKey} is not a scored game`);
    const date = games.serverDate(now);
    const graded = games.grade(gameKey, games.dailySetFor(gameKey, date), submitted);

    return withTransaction(async (conn) => {
      const [result] = await conn.query(
        `INSERT IGNORE INTO game_attempts (user_id, game, game_date, score, total, answers)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [userId, gameKey, date, graded.score, graded.total, JSON.stringify(games.recordOf(graded))]
      );
      if (result.affectedRows !== 1) return { recorded: false, date, graded };

      await Points.settleTo(userId, 'game_completed', `game:${gameKey}:${date}:${userId}`, graded.points, { connection: conn });
      return { recorded: true, date, graded };
    });
  }

  static async attemptFor(userId, gameKey, date) {
    const [[row]] = await promisePool.query(
      'SELECT * FROM game_attempts WHERE user_id = ? AND game = ? AND game_date = ?',
      [userId, gameKey, date]
    );
    return row ? { ...row, answers: parseAnswers(row.answers) } : null;
  }

  /** Today's games this person has played, keyed by game, for the hub. */
  static async playedOn(userId, date) {
    const [rows] = await promisePool.query(
      'SELECT game, score, total FROM game_attempts WHERE user_id = ? AND game_date = ?',
      [userId, date]
    );
    return Object.fromEntries(rows.map((r) => [r.game, { score: r.score, total: r.total }]));
  }

  /**
   * Rebuild a closed attempt's result from the date and the stored choices, so a reload
   * keeps the explanations. A regrade that disagrees with the stored score means the bank
   * changed under a played day, and it is logged rather than hidden.
   */
  static replay(attempt, gameKey, date) {
    if (!attempt) return null;
    const set = games.dailySetFor(gameKey, date);
    const graded = games.grade(gameKey, set, games.submissionFromRecord(gameKey, set, attempt.answers));
    if (graded.score !== attempt.score) {
      console.warn(`Game.replay: ${gameKey} on ${date} stored ${attempt.score}, regrades to ${graded.score}.`);
    }
    return graded;
  }

  /** One game's board for a day. Ties break on the EARLIER attempt, never on a duration. */
  static async dailyBoard(gameKey, date, { limit = 10 } = {}) {
    const [rows] = await promisePool.query(
      `SELECT a.score, a.total, ${DISPLAY_NAME_SQL} AS name
         FROM game_attempts a JOIN users u ON u.id = a.user_id
        WHERE a.game = ? AND a.game_date = ? AND u.is_active = 1
        ORDER BY a.score DESC, a.created_at ASC
        LIMIT ?`,
      [gameKey, date, limit]
    );
    return rows;
  }

  /** Every scored game on a day, summed per person — the hub's board. */
  static async combinedBoard(date, { limit = 10 } = {}) {
    const [rows] = await promisePool.query(
      `SELECT ${DISPLAY_NAME_SQL} AS name, SUM(a.score) AS score, SUM(a.total) AS total, COUNT(*) AS games
         FROM game_attempts a JOIN users u ON u.id = a.user_id
        WHERE a.game_date = ? AND u.is_active = 1
        GROUP BY u.id, u.name
        ORDER BY score DESC, MIN(a.created_at) ASC
        LIMIT ?`,
      [date, limit]
    );
    return rows.map((r) => ({ ...r, score: Number(r.score), total: Number(r.total), games: Number(r.games) }));
  }

  /**
   * "Today's Rankings" on /games/challenges, as on dynamicshub.net: the daily challenge AND
   * every scored game, summed per person. Two tables, one board — the challenge is a game
   * like the others to somebody reading the page, and a board that left it out would rank
   * a person who played only the challenge below somebody who played nothing.
   */
  static async todaysRankings(date, { limit = 10 } = {}) {
    const [rows] = await promisePool.query(
      `SELECT ${DISPLAY_NAME_SQL} AS name, SUM(a.score) AS score, SUM(a.total) AS total, COUNT(*) AS games
         FROM (SELECT user_id, score, total, created_at FROM game_attempts WHERE game_date = ?
               UNION ALL
               SELECT user_id, score, total, created_at FROM challenge_attempts WHERE challenge_date = ?) a
         JOIN users u ON u.id = a.user_id
        WHERE u.is_active = 1
        GROUP BY u.id, u.name
        ORDER BY score DESC, MIN(a.created_at) ASC
        LIMIT ?`,
      [date, date, limit]
    );
    return rows.map((r) => ({ ...r, score: Number(r.score), total: Number(r.total), games: Number(r.games) }));
  }
}

module.exports = Game;
