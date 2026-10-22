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

  static async countOpen(userId) {
    await promisePool.query('UPDATE sales_agents SET link_opens = link_opens + 1 WHERE user_id = ?', [userId]);
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
              MAX(s.created_at)                    AS last_signup
         FROM sales_agents sa
         JOIN users u ON u.id = sa.user_id
         LEFT JOIN users s ON s.sales_agent_id = sa.user_id
        GROUP BY sa.user_id, sa.code, sa.is_active, sa.link_opens, sa.created_at, u.name, u.email, u.is_active
        ORDER BY sa.is_active DESC, signups DESC, u.name`,
      []
    );
    return rows.map((r) => ({
      ...r,
      signups: Number(r.signups), consultants: Number(r.consultants), companies: Number(r.companies), verified: Number(r.verified)
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
              COALESCE(SUM(ra.referred_user_id IS NOT NULL), 0) AS via_referrer
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
                ROW_NUMBER() OVER (PARTITION BY u.sales_agent_id ORDER BY u.created_at DESC, u.id DESC) AS rn
           FROM users u WHERE u.sales_agent_id IN (?)
       ) ranked WHERE rn <= ?`,
      [agentIds, perAgent]
    );
    rows.forEach((r) => {
      (out[r.agent_id] = out[r.agent_id] || []).push(r);
    });
    return out;
  }
}

module.exports = SalesAgent;
