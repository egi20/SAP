'use strict';

const { promisePool } = require('../config/database');
const { containsPattern } = require('../utils/likePattern');

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

  /**
   * THE ONE FILTER BUILDER for the log.
   *
   * The list, its count, the "most of them are here" summary and the export all come
   * through it, so the top paths are the top paths of what is on the screen rather than of
   * everything ever recorded — which is the number somebody actually wants when they have
   * just narrowed to one day.
   *
   * There is no "error type" column to filter on and none is invented: `status_code` is
   * what this table actually knows, and a dropdown labelled with a fact we hold beats one
   * labelled with a category we would have to guess at.
   */
  static buildFilter({ q = '', statusCode = '', from = '', to = '' } = {}) {
    const where = [];
    const params = [];

    if (q) {
      // Through likePattern like every other LIKE here: a search for `%` is a search for a
      // per-cent sign, not a scan of the whole log.
      const like = containsPattern(q);
      where.push('(message LIKE ? OR path LIKE ?)');
      params.push(like, like);
    }

    const code = Number.parseInt(statusCode, 10);
    if (Number.isInteger(code) && code >= 100 && code <= 599) {
      where.push('status_code = ?');
      params.push(code);
    }

    /*
     * `from` and `to` are whole days, and `to` is EXCLUSIVE-of-the-next-day rather than
     * `<= ?`. `created_at <= '2026-01-05'` means "up to midnight at the start of the 5th",
     * so the obvious spelling silently drops everything that happened on the last day of
     * the range somebody asked for — the one day they are most likely to care about.
     */
    if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      where.push('created_at >= ?');
      params.push(from);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      where.push('created_at < DATE_ADD(?, INTERVAL 1 DAY)');
      params.push(to);
    }

    return { clause: where.length ? where.join(' AND ') : '1 = 1', params };
  }

  static async list(filters = {}, { limit = 50, offset = 0 } = {}) {
    const { clause, params } = ErrorLog.buildFilter(filters);
    const [rows] = await promisePool.query(
      `SELECT * FROM error_logs WHERE ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const [[{ total }]] = await promisePool.query(
      `SELECT COUNT(*) AS total FROM error_logs WHERE ${clause}`,
      params
    );
    return { rows, total };
  }

  /**
   * Where the errors are, under the current filter.
   *
   * One repeated path is the difference between "the site is broken" and "one route is
   * broken", and a page of fifty rows that are all the same path reads as the former.
   *
   * GROUP BY the real column, not an alias. `GROUP BY path` is safe here because `path` IS
   * a column of this table — the trap `/admin/analytics` hit was grouping by an alias that
   * happened to share a name with a different real column.
   */
  static async topPaths(filters = {}, { limit = 10 } = {}) {
    const { clause, params } = ErrorLog.buildFilter(filters);
    const [rows] = await promisePool.query(
      `SELECT path, COUNT(*) AS total, MAX(created_at) AS last_seen
         FROM error_logs
        WHERE ${clause} AND path IS NOT NULL
        GROUP BY path
        ORDER BY total DESC, last_seen DESC
        LIMIT ?`,
      [...params, limit]
    );
    return rows;
  }

  /** The status codes present under the current filter, so the control offers only real ones. */
  static async statusCodes() {
    const [rows] = await promisePool.query(
      'SELECT DISTINCT status_code FROM error_logs WHERE status_code IS NOT NULL ORDER BY status_code'
    );
    return rows.map((r) => r.status_code);
  }

  /** Rows for an export, through the same builder the screen used. The stack is left out. */
  static async exportRows(filters = {}, { limit = 5000 } = {}) {
    const { clause, params } = ErrorLog.buildFilter(filters);
    const [rows] = await promisePool.query(
      `SELECT created_at, status_code, method, path, message, user_id
         FROM error_logs
        WHERE ${clause}
        ORDER BY created_at DESC
        LIMIT ?`,
      [...params, limit]
    );
    return rows;
  }

  /**
   * Delete exactly the rows the screen showed under a filter (2026-11-06, owner: "once the
   * errors are fixed, delete them in prod"). Through the ONE builder, like the list and the
   * export, so the rows removed are provably the rows listed.
   *
   * Two guards, both from rules elsewhere here. An unfiltered call is REFUSED — clearing the
   * whole log is a different decision, and the age-window purge is the one for it. And the
   * screen posts the count it showed: if the filter now matches a different number, nothing is
   * deleted (the CRM's interlock). The delete is bounded by the highest id counted, so an error
   * recorded a second after the page loaded is never removed unseen.
   */
  static async deleteMatching(filters = {}, expectedCount) {
    const { clause, params } = ErrorLog.buildFilter(filters);
    if (clause === '1 = 1') {
      const err = new Error('Choose a filter first: deleting the whole log is what the age-window purge is for.');
      err.code = 'ERROR_LOG_NO_FILTER';
      throw err;
    }
    const conn = await promisePool.getConnection();
    try {
      await conn.beginTransaction();
      const [[{ n, maxId }]] = await conn.query(
        `SELECT COUNT(*) AS n, MAX(id) AS maxId FROM error_logs WHERE ${clause}`,
        params
      );
      if (Number(n) !== Number(expectedCount)) {
        await conn.rollback();
        const err = new Error(`The filter now matches ${n} entries, not the ${expectedCount} shown. Nothing was deleted; reload and check.`);
        err.code = 'ERROR_LOG_COUNT_MISMATCH';
        throw err;
      }
      const [result] = await conn.query(
        `DELETE FROM error_logs WHERE ${clause} AND id <= ?`,
        [...params, maxId || 0]
      );
      await conn.commit();
      return result.affectedRows;
    } catch (err) {
      try { await conn.rollback(); } catch (e) { /* already rolled back */ }
      throw err;
    } finally {
      conn.release();
    }
  }

  static async purgeOlderThan(days = 90) {
    const [result] = await promisePool.query('DELETE FROM error_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)', [days]);
    return result.affectedRows;
  }
}

module.exports = ErrorLog;
