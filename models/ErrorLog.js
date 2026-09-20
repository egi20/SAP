'use strict';

const { promisePool } = require('../config/database');

/**
 * Persisted application errors, for the admin panel.
 *
 * `record()` swallows its own failures: an error handler that throws while logging an
 * error turns a 500 into an unhandled rejection and takes the process with it.
 */
class ErrorLog {
  static async record(err, req = null, statusCode = 500) {
    try {
      await promisePool.query(
        `INSERT INTO error_logs (message, stack, method, path, status_code, user_id, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          String(err && err.message ? err.message : err).slice(0, 500),
          err && err.stack ? String(err.stack).slice(0, 10000) : null,
          req ? req.method : null,
          req ? String(req.originalUrl || req.url).slice(0, 255) : null,
          statusCode,
          req && req.session && req.session.user ? req.session.user.id : null,
          req ? String(req.get('user-agent') || '').slice(0, 255) : null
        ]
      );
    } catch (logErr) {
      console.error(`Failed to persist error log: ${logErr.message}`);
    }
  }

  static async list({ limit = 50, offset = 0 } = {}) {
    const [rows] = await promisePool.query(
      'SELECT * FROM error_logs ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [limit, offset]
    );
    const [[{ total }]] = await promisePool.query('SELECT COUNT(*) AS total FROM error_logs');
    return { rows, total };
  }

  static async purgeOlderThan(days = 90) {
    const [result] = await promisePool.query('DELETE FROM error_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)', [days]);
    return result.affectedRows;
  }
}

module.exports = ErrorLog;
