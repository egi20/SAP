'use strict';

const { promisePool } = require('../config/database');
const { aggregate, aggregateBy, trendSeries, recentPeriods, currentPeriod } = require('../utils/rateAggregation');

/**
 * Rough EUR conversion for normalising submissions.
 *
 * Editorial and static on purpose: a live FX feed would silently re-date historical
 * aggregates every time it moved. The rate applied at submission time is frozen into
 * `amount_eur`, so a published aggregate never changes retroactively.
 */
const FX_TO_EUR = Object.freeze({
  EUR: 1,
  USD: 0.92,
  GBP: 1.17,
  CHF: 1.05,
  SEK: 0.088,
  NOK: 0.086,
  DKK: 0.134,
  PLN: 0.23,
  CZK: 0.04,
  RON: 0.2,
  ALL: 0.0102,
  AUD: 0.6,
  CAD: 0.68,
  INR: 0.011
});

const SUPPORTED_CURRENCIES = Object.keys(FX_TO_EUR);

function toEur(amount, currency) {
  const rate = FX_TO_EUR[currency];
  if (!rate) return null;
  return Math.round(Number(amount) * rate * 100) / 100;
}

class RateSubmission {
  static get SUPPORTED_CURRENCIES() {
    return SUPPORTED_CURRENCIES;
  }

  static toEur = toEur;

  /**
   * Record a submission for the current month.
   *
   * The unique key is (user, role, seniority, engagement, period), so re-submitting
   * within the same month corrects the previous figure rather than counting twice. That
   * is what makes "contributors" a count of people.
   */
  static async submit(userId, { role, seniority, engagementType, workMode, country, amount, currency }) {
    const amountEur = toEur(amount, currency);
    if (amountEur === null) {
      const err = new Error(`Unsupported currency: ${currency}`);
      err.code = 'UNSUPPORTED_CURRENCY';
      throw err;
    }

    const period = currentPeriod();
    await promisePool.query(
      `INSERT INTO rate_submissions
         (user_id, role, seniority, engagement_type, work_mode, country, amount, currency, amount_eur, period)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE amount = VALUES(amount), currency = VALUES(currency),
                               amount_eur = VALUES(amount_eur), work_mode = VALUES(work_mode),
                               country = VALUES(country)`,
      [userId, role, seniority, engagementType, workMode, country, amount, currency, amountEur, period]
    );
    return { period, amountEur };
  }

  static async findOwnLatest(userId) {
    const [rows] = await promisePool.query(
      'SELECT * FROM rate_submissions WHERE user_id = ? ORDER BY period DESC, updated_at DESC LIMIT 1',
      [userId]
    );
    return rows[0] || null;
  }

  /**
   * Fetch the raw rows a set of filters selects.
   *
   * The rows are deliberately returned unaggregated: aggregation, de-duplication by
   * person and the privacy floor all live in `utils/rateAggregation.js`, and doing any
   * of it in SQL would let a GROUP BY quietly bypass the floor.
   */
  static async rowsFor({ role = '', seniority = '', engagementType = 'contract', country = '', periods = [] } = {}) {
    /*
     * `voided_at IS NULL` is not optional and is not a filter the caller may turn off.
     *
     * A voided submission is one an administrator has established is wrong — most often a
     * figure entered in the wrong unit. It is kept for the audit trail and for the unique
     * key that stops a re-submission, but it must never reach an aggregate: one annual
     * salary in a day-rate bucket moves a percentile for everybody, and it does it
     * silently. There is no `include_voided` option here on purpose.
     */
    const where = ['voided_at IS NULL', 'engagement_type = ?'];
    const params = [engagementType];

    if (role) {
      where.push('role = ?');
      params.push(role);
    }
    if (seniority) {
      where.push('seniority = ?');
      params.push(seniority);
    }
    if (country) {
      where.push('country = ?');
      params.push(country);
    }
    if (periods.length) {
      where.push('period IN (?)');
      params.push(periods);
    }

    const [rows] = await promisePool.query(
      `SELECT user_id, role, seniority, country, work_mode, amount_eur, period
         FROM rate_submissions
        WHERE ${where.join(' AND ')}`,
      params
    );
    return rows;
  }

  /** One aggregate for the selected filters, over the last `months` periods. */
  static async summary(filters, { months = 12 } = {}) {
    const periods = recentPeriods(months);
    const rows = await RateSubmission.rowsFor({ ...filters, periods });
    return { ...aggregate(rows), periods };
  }

  /** Aggregate per role, for the index table. Suppressed rows keep their count. */
  static async byRole(filters, { months = 12 } = {}) {
    const periods = recentPeriods(months);
    const rows = await RateSubmission.rowsFor({ ...filters, role: '', periods });
    const grouped = aggregateBy(rows, (r) => r.role);
    return [...grouped.entries()]
      .map(([role, agg]) => ({ role, ...agg }))
      .sort((a, b) => (b.median ?? -1) - (a.median ?? -1));
  }

  /** Aggregate per seniority for one role. */
  static async bySeniority(filters, { months = 12 } = {}) {
    const periods = recentPeriods(months);
    const rows = await RateSubmission.rowsFor({ ...filters, seniority: '', periods });
    const grouped = aggregateBy(rows, (r) => r.seniority);
    return ['junior', 'mid', 'senior', 'lead'].map((seniority) => ({
      seniority,
      ...(grouped.get(seniority) || { contributors: 0, suppressed: true, median: null, p25: null, p75: null, min: null, max: null })
    }));
  }

  /** Monthly trend. Suppressed periods come back with `value: null` — render as gaps. */
  static async trend(filters, { months = 12 } = {}) {
    const periods = recentPeriods(months);
    const rows = await RateSubmission.rowsFor({ ...filters, periods });
    return trendSeries(rows, periods);
  }

  static async totalContributors() {
    // Counting PEOPLE, and only people whose contribution still counts — this number is
    // shown next to the index as evidence of how much it rests on.
    const [[row]] = await promisePool.query(
      'SELECT COUNT(DISTINCT user_id) AS count FROM rate_submissions WHERE voided_at IS NULL'
    );
    return row.count;
  }

  /**
   * The submissions themselves, for the moderation screen.
   *
   * The one place raw rows with an identifiable person attached are read, and it is
   * superadmin-gated in the route. `outlier` flags a figure far from its own bucket's
   * median — a hint about where to look, never an automatic void: an unusually high rate
   * is much more often a real senior contractor than a mistake.
   */
  static async listForReview({ limit = 50, offset = 0, includeVoided = false } = {}) {
    const where = includeVoided ? '1 = 1' : 'rs.voided_at IS NULL';

    const [rows] = await promisePool.query(
      `SELECT rs.*, u.email, u.name AS contributor_name,
              (SELECT ROUND(AVG(peer.amount_eur))
                 FROM rate_submissions peer
                WHERE peer.role = rs.role
                  AND peer.seniority = rs.seniority
                  AND peer.engagement_type = rs.engagement_type
                  AND peer.voided_at IS NULL) AS bucket_mean_eur
         FROM rate_submissions rs
         JOIN users u ON u.id = rs.user_id
        WHERE ${where}
        ORDER BY rs.created_at DESC
        LIMIT ? OFFSET ?`,
      [limit, offset]
    );

    const [[{ total }]] = await promisePool.query(
      `SELECT COUNT(*) AS total FROM rate_submissions rs WHERE ${where}`
    );

    return { rows, total };
  }
}

module.exports = RateSubmission;
