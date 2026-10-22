'use strict';

const { promisePool } = require('../config/database');

/**
 * Runs of the in-app regression suite (migration 034). The cases themselves live in
 * `config/regressionTests.js`; this model stores only the switches an administrator set
 * and what each run found.
 */

/** A run that has not finished this long after it started was cut off by a restart. */
const INTERRUPTED_AFTER_MS = 15 * 60 * 1000;

class RegressionRun {
  /** Names of the cases an administrator switched off. */
  static async disabledNames() {
    const [rows] = await promisePool.query('SELECT case_name FROM regression_case_switches WHERE enabled = 0', []);
    return new Set(rows.map((r) => r.case_name));
  }

  static async setEnabled(caseName, enabled, userId) {
    await promisePool.query(
      `INSERT INTO regression_case_switches (case_name, enabled, updated_by, updated_at)
       VALUES (?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), updated_by = VALUES(updated_by), updated_at = NOW()`,
      [caseName, enabled ? 1 : 0, userId || null]
    );
  }

  static async start(scope, userId) {
    const [result] = await promisePool.query(
      'INSERT INTO regression_runs (scope, started_by) VALUES (?, ?)',
      [String(scope).slice(0, 120), userId || null]
    );
    return result.insertId;
  }

  static async addResult(runId, r) {
    await promisePool.query(
      `INSERT INTO regression_results
         (run_id, case_name, category, path, role, outcome, status_code, duration_ms, message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [runId, r.name.slice(0, 191), r.category.slice(0, 80), r.path.slice(0, 255), r.role || null,
        r.outcome, r.statusCode || null, Math.max(0, Math.round(r.durationMs || 0)),
        r.message ? String(r.message).slice(0, 500) : null]
    );
  }

  /** The tally is counted from the rows the run wrote, so it cannot disagree with them. */
  static async finish(runId, durationMs) {
    await promisePool.query(
      `UPDATE regression_runs r
          JOIN (SELECT run_id,
                       COUNT(*) AS total,
                       SUM(outcome = 'passed') AS passed,
                       SUM(outcome = 'failed') AS failed,
                       SUM(outcome = 'skipped') AS skipped
                  FROM regression_results WHERE run_id = ? GROUP BY run_id) t ON t.run_id = r.id
          SET r.total = t.total, r.passed = t.passed, r.failed = t.failed, r.skipped = t.skipped,
              r.finished_at = NOW(), r.duration_ms = ?
        WHERE r.id = ?`,
      [runId, Math.max(0, Math.round(durationMs)), runId]
    );
    // A run whose every case was switched off wrote no rows, and the JOIN above matched
    // nothing; it still finished.
    await promisePool.query('UPDATE regression_runs SET finished_at = COALESCE(finished_at, NOW()), duration_ms = ? WHERE id = ?',
      [Math.max(0, Math.round(durationMs)), runId]);
  }

  static withState(run) {
    if (!run) return null;
    let state = 'finished';
    if (!run.finished_at) {
      const age = Date.now() - new Date(run.started_at).getTime();
      state = age > INTERRUPTED_AFTER_MS ? 'interrupted' : 'running';
    }
    return { ...run, state };
  }

  static async recent(limit = 20) {
    const [rows] = await promisePool.query(
      `SELECT r.*, COALESCE(NULLIF(TRIM(u.name), ''), u.email) AS started_by_name
         FROM regression_runs r LEFT JOIN users u ON u.id = r.started_by
        ORDER BY r.id DESC LIMIT ?`,
      [limit]
    );
    return rows.map((r) => RegressionRun.withState(r));
  }

  static async find(runId) {
    const [rows] = await promisePool.query(
      `SELECT r.*, COALESCE(NULLIF(TRIM(u.name), ''), u.email) AS started_by_name
         FROM regression_runs r LEFT JOIN users u ON u.id = r.started_by WHERE r.id = ?`,
      [runId]
    );
    if (!rows.length) return null;
    const [results] = await promisePool.query(
      `SELECT * FROM regression_results WHERE run_id = ?
        ORDER BY FIELD(outcome, 'failed', 'skipped', 'passed'), category, id`,
      [runId]
    );
    return { ...RegressionRun.withState(rows[0]), results };
  }

  /** The most recent outcome of every case that has one, for the library screen. */
  static async lastOutcomes() {
    const [rows] = await promisePool.query(
      `SELECT res.case_name, res.outcome, res.status_code, res.message, res.run_id
         FROM regression_results res
         JOIN (SELECT case_name, MAX(id) AS id FROM regression_results GROUP BY case_name) latest
           ON latest.id = res.id`,
      []
    );
    return Object.fromEntries(rows.map((r) => [r.case_name, r]));
  }
}

RegressionRun.INTERRUPTED_AFTER_MS = INTERRUPTED_AFTER_MS;

module.exports = RegressionRun;
