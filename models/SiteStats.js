'use strict';

const { promisePool } = require('../config/database');

/**
 * The analytics figures the site counts ITSELF — no script, no consent, no sampling — over
 * a date range from `utils/analyticsRange.js`. They sit beside GA4 and Cloudflare on the
 * admin screens as the independent count, the way dynamicshub.net's "Server-side" panels do.
 *
 * Aggregates only. Nothing here returns a person: a country, a day, a count. The sign-up
 * country is IP-derived and can be wrong (a VPN, a holiday), which is why it is shown only
 * as a tally here and never beside a name — see "The user list shows the country the member
 * STATED" in CLAUDE.md.
 *
 * `from` and `to` are inclusive UTC days. A DATETIME column is bounded with
 * `< DATE_ADD(to, INTERVAL 1 DAY)`, never `<= to`, which would drop everything that
 * happened on the last day after midnight.
 */
class SiteStats {
  /** Page views counted by middleware/visitGeo.js, total and by country. */
  static async visitorsByCountry({ from, to }, { limit = 50 } = {}) {
    const [rows] = await promisePool.query(
      `SELECT country, SUM(visits) AS visits
         FROM visit_geo_daily
        WHERE day BETWEEN ? AND ?
        GROUP BY country
        ORDER BY visits DESC, country
        LIMIT ?`,
      [from, to, limit]
    );
    const [[total]] = await promisePool.query(
      'SELECT COALESCE(SUM(visits), 0) AS visits FROM visit_geo_daily WHERE day BETWEEN ? AND ?',
      [from, to]
    );
    return { total: Number(total.visits), rows: rows.map((r) => ({ country: r.country, visits: Number(r.visits) })) };
  }

  /** Accounts created in the range, by the country their sign-up request came from. */
  static async signupsByCountry({ from, to }, { limit = 50 } = {}) {
    const [rows] = await promisePool.query(
      `SELECT COALESCE(signup_country, '') AS country, COUNT(*) AS signups
         FROM users
        WHERE created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)
        GROUP BY COALESCE(signup_country, '')
        ORDER BY signups DESC, country
        LIMIT ?`,
      [from, to, limit]
    );
    return rows.map((r) => ({ country: r.country || null, signups: Number(r.signups) }));
  }

  /** Distinct players and plays of the daily challenge, per day and in total. */
  static async challengePlayers({ from, to }) {
    const [perDay] = await promisePool.query(
      `SELECT challenge_date AS day, COUNT(DISTINCT user_id) AS players, COUNT(*) AS plays
         FROM challenge_attempts
        WHERE challenge_date BETWEEN ? AND ?
        GROUP BY challenge_date
        ORDER BY challenge_date DESC`,
      [from, to]
    );
    const [[totals]] = await promisePool.query(
      `SELECT COUNT(DISTINCT user_id) AS players, COUNT(*) AS plays, COUNT(DISTINCT challenge_date) AS days
         FROM challenge_attempts
        WHERE challenge_date BETWEEN ? AND ?`,
      [from, to]
    );
    return {
      players: Number(totals.players),
      plays: Number(totals.plays),
      activeDays: Number(totals.days),
      perDay: perDay.map((r) => ({
        // mysql2 returns a DATE as a JS Date; print the calendar day it means.
        day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day),
        players: Number(r.players),
        plays: Number(r.plays)
      }))
    };
  }

  /**
   * Wipe the server-side visitor geography so it rebuilds from real traffic. It held
   * crawlers and Cloudflare's own edge addresses until 2026-10-21; a superadmin may clear it
   * once, deliberately, rather than read around that history forever.
   */
  static async resetVisitorGeography() {
    const [result] = await promisePool.query('DELETE FROM visit_geo_daily');
    return result.affectedRows;
  }
}

module.exports = SiteStats;
