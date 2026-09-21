'use strict';

const { promisePool } = require('../config/database');

/**
 * The AI spend ledger.
 *
 * `record()` NEVER throws, for the same reason `Notification.emit` never does: it runs
 * after an answer the visitor has already been given, and failing to write the accounting
 * row must not turn a delivered answer into a 500. It is logged loudly instead — a ledger
 * that silently stops recording is a budget that silently stops binding.
 */
class ApiUsage {
  static async record({
    feature,
    model,
    userId = null,
    inputTokens = 0,
    outputTokens = 0,
    costUsd = 0,
    outcome = 'ok'
  }) {
    try {
      await promisePool.query(
        `INSERT INTO ai_usage (feature, model, user_id, input_tokens, output_tokens, cost_usd, outcome)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          String(feature).slice(0, 40),
          String(model).slice(0, 80),
          userId,
          Math.max(0, Math.round(Number(inputTokens) || 0)),
          Math.max(0, Math.round(Number(outputTokens) || 0)),
          Number(costUsd) || 0,
          outcome === 'error' ? 'error' : 'ok'
        ]
      );
      return true;
    } catch (err) {
      console.error(`ApiUsage.record failed (${feature}): ${err.message}`);
      return false;
    }
  }

  /**
   * Month to date, in the SERVER's timezone via `DATE_FORMAT(NOW(), '%Y-%m-01')`.
   *
   * A calendar month rather than a rolling thirty days, deliberately: this figure is
   * compared against an invoice, and invoices arrive per calendar month.
   */
  static async monthToDateCost() {
    const [[row]] = await promisePool.query(
      `SELECT COALESCE(SUM(cost_usd), 0) AS cost
         FROM ai_usage
        WHERE created_at >= DATE_FORMAT(NOW(), '%Y-%m-01')`
    );
    return Number(row.cost) || 0;
  }

  static async monthToDateCostForUser(userId) {
    const [[row]] = await promisePool.query(
      `SELECT COALESCE(SUM(cost_usd), 0) AS cost
         FROM ai_usage
        WHERE user_id = ? AND created_at >= DATE_FORMAT(NOW(), '%Y-%m-01')`,
      [userId]
    );
    return Number(row.cost) || 0;
  }

  /** For the admin panel: the last N days, one row per day. */
  static async dailyCost({ days = 30 } = {}) {
    // GROUP BY the expression, not the alias — see the note in routes/admin.js.
    const [rows] = await promisePool.query(
      `SELECT DATE(created_at) AS day,
              COUNT(*) AS calls,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(cost_usd) AS cost,
              SUM(outcome = 'error') AS errors
         FROM ai_usage
        WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        GROUP BY DATE(created_at)
        ORDER BY DATE(created_at) DESC`,
      [days]
    );
    return rows;
  }

  static async purgeOlderThan(days = 400) {
    const [result] = await promisePool.query(
      'DELETE FROM ai_usage WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
      [days]
    );
    return result.affectedRows;
  }
}

module.exports = ApiUsage;
