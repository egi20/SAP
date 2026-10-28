'use strict';

const { promisePool } = require('../config/database');
const Referral = require('./Referral');

/**
 * Sales agents (migration 035): colleagues with a personal sign-up link that is measured
 * and pays nothing. Not the referral scheme — see the migration for why the two are apart.
 *
 * Codes use the referral alphabet and length, so they read the same aloud, but live in
 * their own table: the same eight letters can be a referral code and an agent code without
 * either meaning the other, because they arrive on different URLs.
 */

const { generateCode, normaliseCode } = Referral;

class SalesAgent {
  static normaliseCode = normaliseCode;

  /** Put an existing account on the list, or return the row it already has. */
  static async add(userId, addedBy) {
    const existing = await SalesAgent.findByUserId(userId);
    if (existing) return { agent: existing, created: false };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await promisePool.query('INSERT INTO sales_agents (user_id, code, added_by) VALUES (?, ?, ?)', [userId, generateCode(), addedBy || null]);
        // eslint-disable-next-line no-await-in-loop
        return { agent: await SalesAgent.findByUserId(userId), created: true };
      } catch (err) {
        if (err.code !== 'ER_DUP_ENTRY') throw err;
        // eslint-disable-next-line no-await-in-loop
        const raced = await SalesAgent.findByUserId(userId);
        if (raced) return { agent: raced, created: false };
      }
    }
    throw new Error('Could not allocate a sales agent code.');
  }

  static async findByUserId(userId) {
    const [rows] = await promisePool.query('SELECT * FROM sales_agents WHERE user_id = ?', [userId]);
    return rows[0] || null;
  }

  /** An agent whose link still counts: on the list, switched on, and an active account. */
  static async findActiveByCode(raw) {
    const code = normaliseCode(raw);
    if (!code) return null;
    const [rows] = await promisePool.query(
      `SELECT sa.* FROM sales_agents sa JOIN users u ON u.id = sa.user_id
        WHERE sa.code = ? AND sa.is_active = 1 AND u.is_active = 1`,
      [code]
    );
    return rows[0] || null;
  }

  static async setActive(userId, active) {
    const [result] = await promisePool.query('UPDATE sales_agents SET is_active = ? WHERE user_id = ?', [active ? 1 : 0, userId]);
    return result.affectedRows > 0;
  }

  /**
   * One counted open: the lifetime counter, and a dated row (migration 040) so the admin tab
   * can say how many happened in the last 24 hours. The dated row is best-effort — a failure
   * there must not cost the counter, and the visitor is redirected either way.
   */
  static async countOpen(userId) {
    await promisePool.query('UPDATE sales_agents SET link_opens = link_opens + 1 WHERE user_id = ?', [userId]);
    try {
      await promisePool.query('INSERT INTO sales_agent_link_opens (agent_user_id) VALUES (?)', [userId]);
    } catch (err) {
      console.error(`Sales agent open not dated: ${err.message}`);
    }
  }

  /**
   * Credit a new account to the agent whose link it came through. First touch: the WHERE
   * refuses to overwrite, and an agent cannot be credited with their own account.
   */
  static async attribute(rawCode, newUserId) {
    try {
      const agent = await SalesAgent.findActiveByCode(rawCode);
      if (!agent || agent.user_id === newUserId) return false;
      const [result] = await promisePool.query(
        'UPDATE users SET sales_agent_id = ? WHERE id = ? AND sales_agent_id IS NULL',
        [agent.user_id, newUserId]
      );
      return result.affectedRows > 0;
    } catch (err) {
      // A sign-up has already succeeded; failing to note whose link it was must not undo it.
      console.error(`Sales agent attribution failed: ${err.message}`);
      return false;
    }
  }

  /** Every agent with what their link has done, in ONE query for the page. */
  static async listAll() {
    const [rows] = await promisePool.query(
      `SELECT sa.user_id, sa.code, sa.is_active, sa.link_opens, sa.created_at,
              u.name, u.email, u.is_active AS account_active,
              COUNT(s.id)                          AS signups,
              COALESCE(SUM(s.is_consultant = 1), 0) AS consultants,
              COALESCE(SUM(s.is_company = 1), 0)    AS companies,
              COALESCE(SUM(s.email_verified = 1), 0) AS verified,
              MAX(s.created_at)                    AS last_signup,
              COALESCE(SUM(s.created_at >= NOW() - INTERVAL 24 HOUR), 0) AS signups_24h,
              (SELECT COUNT(*) FROM sales_agent_link_opens o
                WHERE o.agent_user_id = sa.user_id AND o.opened_at >= NOW() - INTERVAL 24 HOUR) AS opens_24h
         FROM sales_agents sa
         JOIN users u ON u.id = sa.user_id
         LEFT JOIN users s ON s.sales_agent_id = sa.user_id
        GROUP BY sa.user_id, sa.code, sa.is_active, sa.link_opens, sa.created_at, u.name, u.email, u.is_active
        ORDER BY sa.is_active DESC, signups DESC, u.name`,
      []
    );
    return rows.map((r) => ({
      ...r,
      signups: Number(r.signups), consultants: Number(r.consultants), companies: Number(r.companies), verified: Number(r.verified),
      signups_24h: Number(r.signups_24h), opens_24h: Number(r.opens_24h)
    }));
  }

  /** One agent's own figures, for their dashboard — the same counts the admin tab shows. */
  static async statsFor(userId) {
    const [[row]] = await promisePool.query(
      `SELECT sa.code, sa.is_active, sa.link_opens,
              COUNT(s.id) AS signups,
              COALESCE(SUM(s.is_consultant = 1), 0) AS consultants,
              COALESCE(SUM(s.is_company = 1), 0) AS companies,
              COALESCE(SUM(s.email_verified = 1), 0) AS verified,
              MAX(s.created_at) AS last_signup
         FROM sales_agents sa
         LEFT JOIN users s ON s.sales_agent_id = sa.user_id
        WHERE sa.user_id = ?
        GROUP BY sa.user_id, sa.code, sa.is_active, sa.link_opens`,
      [userId]
    );
    if (!row) return null;
    ['signups', 'consultants', 'companies', 'verified'].forEach((k) => { row[k] = Number(row[k]); });
    return row;
  }

  /**
   * Everybody who signed up WITHOUT an agent's link — the exact complement of the agents'
   * counts, so the agents' sign-ups plus this row is every account. `viaReferrer` is called
   * out because those people did follow a link, a referrer's, and are not organic.
   */
  static async unattributed() {
    const [[row]] = await promisePool.query(
      `SELECT (SELECT COUNT(*) FROM users) AS all_accounts,
              COUNT(*) AS signups,
              COALESCE(SUM(u.is_consultant = 1), 0) AS consultants,
              COALESCE(SUM(u.is_company = 1), 0) AS companies,
              COALESCE(SUM(u.email_verified = 1), 0) AS verified,
              COALESCE(SUM(ra.referred_user_id IS NOT NULL), 0) AS via_referrer,
              COALESCE(SUM(u.created_at >= NOW() - INTERVAL 24 HOUR), 0) AS signups_24h
         FROM users u
         LEFT JOIN referral_attributions ra ON ra.referred_user_id = u.id
        WHERE u.sales_agent_id IS NULL`,
      []
    );
    return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)]));
  }

  /** The accounts each agent brought in, newest first, capped per agent — one query. */
  static async peopleFor(agentIds, { perAgent = 50 } = {}) {
    const out = {};
    if (!agentIds.length) return out;
    const [rows] = await promisePool.query(
      `SELECT * FROM (
         SELECT u.sales_agent_id AS agent_id, u.id, u.name, u.email, u.created_at, u.is_active,
                u.is_consultant, u.is_company, u.email_verified,
                ${COUNTRY_SQL} AS country, ${COUNTRY_SOURCE_SQL} AS country_source,
                ROW_NUMBER() OVER (PARTITION BY u.sales_agent_id ORDER BY u.created_at DESC, u.id DESC) AS rn
           FROM users u ${COUNTRY_JOINS} WHERE u.sales_agent_id IN (?)
       ) ranked WHERE rn <= ?`,
      [agentIds, perAgent]
    );
    rows.forEach((r) => {
      (out[r.agent_id] = out[r.agent_id] || []).push(r);
    });
    return out;
  }

  /**
   * Where each agent's sign-ups are from, for every agent AND the "No agent link" bucket, in
   * ONE query. Keyed by agent user id; the no-link rows come back under `direct`, and
   * `overall` sums the agents only — it feeds a card about agent-link sign-ups, and folding
   * the no-link population into it would make that heading false.
   *
   * Every row is `{ code, count, fromIp }`: `code` is null for "Unknown", so the counts
   * always add up to the sign-up totals beside them. `fromIp` says how many of that country
   * were read from the sign-up address because the person has not stated one yet.
   */
  static async countriesByAgent() {
    const [rows] = await promisePool.query(
      `SELECT u.sales_agent_id AS agent_id, ${COUNTRY_SQL} AS code,
              COUNT(*) AS n, COALESCE(SUM(${COUNTRY_SOURCE_SQL} = 'ip'), 0) AS from_ip
         FROM users u ${COUNTRY_JOINS}
        GROUP BY u.sales_agent_id, ${COUNTRY_SQL}`,
      []
    );
    return SalesAgent.groupCountries(rows);
  }

  /** Pure: the grouping behind `countriesByAgent`, exported for the unit test. */
  static groupCountries(rows) {
    const byAgent = {};
    const direct = [];
    const overall = new Map();
    const add = (list, code, n, fromIp) => {
      const hit = list.find((r) => r.code === code);
      if (hit) { hit.count += n; hit.fromIp += fromIp; } else list.push({ code, count: n, fromIp });
    };
    rows.forEach((r) => {
      const code = r.code ? String(r.code).toUpperCase() : null;
      const n = Number(r.n) || 0;
      const fromIp = Number(r.from_ip) || 0;
      if (r.agent_id == null) { add(direct, code, n, fromIp); return; }
      add((byAgent[r.agent_id] = byAgent[r.agent_id] || []), code, n, fromIp);
      const o = overall.get(code) || { code, count: 0, fromIp: 0 };
      o.count += n; o.fromIp += fromIp;
      overall.set(code, o);
    });
    // Biggest first; Unknown last among equals so a real country is never hidden behind it.
    const order = (a, b) => (b.count - a.count) || ((a.code === null) - (b.code === null)) || String(a.code).localeCompare(String(b.code));
    Object.values(byAgent).forEach((list) => list.sort(order));
    direct.sort(order);
    return { byAgent, direct, overall: [...overall.values()].sort(order) };
  }
}

/*
 * A person's country: the one they STATED on a profile when there is one, otherwise the
 * country of the address they signed up from. The admin user list shows only the stated
 * one (see models/User.js), and for a member's own row that rule stands. Here the question
 * is where an agent's link reached, about people who mostly signed up minutes ago and have
 * stated nothing, so the sign-up address is the only answer there is — and every surface
 * that shows it says which of the two it was (`country_source`).
 */
const COUNTRY_JOINS = `LEFT JOIN consultant_profiles cp ON cp.user_id = u.id
         LEFT JOIN company_profiles comp ON comp.user_id = u.id`;
const COUNTRY_SQL = "NULLIF(COALESCE(NULLIF(cp.country, ''), NULLIF(comp.country, ''), u.signup_country), '')";
const COUNTRY_SOURCE_SQL = `CASE WHEN NULLIF(COALESCE(NULLIF(cp.country, ''), NULLIF(comp.country, '')), '') IS NOT NULL THEN 'stated'
              WHEN NULLIF(u.signup_country, '') IS NOT NULL THEN 'ip' ELSE NULL END`;

module.exports = SalesAgent;
