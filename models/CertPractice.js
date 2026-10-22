'use strict';

const { promisePool } = require('../config/database');

/** Finished certification practice sessions (migration 038). Progress only — no points, no board. */
class CertPractice {
  static async record(userId, certCode, score, total) {
    await promisePool.query(
      'INSERT INTO cert_practice_attempts (user_id, cert_code, score, total) VALUES (?, ?, ?, ?)',
      [userId, certCode, score, total]
    );
  }

  /** Per exam: how many sessions, the best and the latest score, as fractions of their totals. */
  static async progressFor(userId) {
    const [rows] = await promisePool.query(
      `SELECT a.cert_code, COUNT(*) AS attempts,
              MAX(ROUND(100 * a.score / a.total)) AS best_pct,
              SUBSTRING_INDEX(GROUP_CONCAT(CONCAT(a.score, '/', a.total) ORDER BY a.id DESC), ',', 1) AS last
         FROM cert_practice_attempts a
        WHERE a.user_id = ?
        GROUP BY a.cert_code`,
      [userId]
    );
    return Object.fromEntries(rows.map((r) => [r.cert_code, { attempts: Number(r.attempts), bestPct: Number(r.best_pct), last: r.last }]));
  }
}

module.exports = CertPractice;
