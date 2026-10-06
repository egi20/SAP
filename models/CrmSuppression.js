'use strict';

const crypto = require('crypto');

const { promisePool } = require('../config/database');

/**
 * The do-not-contact list.
 *
 * It holds a SHA-256 of the lower-cased address and no address, for one reason worth
 * stating plainly: a suppression list containing plaintext addresses IS a mailing list of
 * people who specifically asked not to be mailed. Hashed, it answers the only question it
 * needs to answer — "is this address on it?" — and answers nothing else.
 *
 * It has NO foreign key to `crm_leads` and nothing anywhere deletes from it. That absence
 * is the design: deleting a lead is exactly how an application loses the fact that its
 * subject asked to be left alone, and the next quarterly import writes them straight back
 * in. The list outlives every row it protects.
 *
 * The hash is unsalted on purpose. A salt would make it unusable for its only job —
 * checking an address somebody is about to import — and the input space of email addresses
 * is small enough that a salt buys less than it looks like it does. What it does buy is
 * that a copy of this table is not a copy of the addresses.
 */

/**
 * The same conservative normalisation `models/User.js` uses: trim and lower-case, nothing
 * else. Gmail dots are PRESERVED. Any normalisation that differed between the suppress
 * path and the check path would make a suppression silently miss, which is the one failure
 * mode this module cannot have.
 */
function normaliseEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

function hashOf(email) {
  const clean = normaliseEmail(email);
  if (!clean) return null;
  return crypto.createHash('sha256').update(clean).digest('hex');
}

class CrmSuppression {
  static normaliseEmail = normaliseEmail;

  static hashOf = hashOf;

  /**
   * Add an address. Idempotent through `INSERT IGNORE` against the primary key, so
   * suppressing twice is a no-op and the FIRST reason is the one kept.
   */
  static async add(email, { reason = 'requested', note = null, actorUserId = null } = {}) {
    const hash = hashOf(email);
    if (!hash) return false;

    const [result] = await promisePool.query(
      'INSERT IGNORE INTO crm_suppressions (email_hash, reason, note, created_by) VALUES (?, ?, ?, ?)',
      [hash, String(reason).slice(0, 32), note ? String(note).slice(0, 500) : null, actorUserId]
    );
    return result.affectedRows === 1;
  }

  static async has(email) {
    const hash = hashOf(email);
    if (!hash) return false;
    const [rows] = await promisePool.query('SELECT 1 FROM crm_suppressions WHERE email_hash = ? LIMIT 1', [hash]);
    return rows.length > 0;
  }

  /**
   * Which of these addresses are suppressed, in one query.
   *
   * An import of five hundred addresses checked one at a time is five hundred round trips,
   * and the version that is slow is the version somebody later "optimises" by skipping the
   * check. The map back to the original spelling is kept locally so the caller can match
   * its own rows without the database ever being told which address it was.
   */
  static async filterSuppressed(emails) {
    const byHash = new Map();
    (emails || []).forEach((email) => {
      const hash = hashOf(email);
      if (hash) byHash.set(hash, normaliseEmail(email));
    });
    if (byHash.size === 0) return new Set();

    const hashes = [...byHash.keys()];
    const [rows] = await promisePool.query(
      `SELECT email_hash FROM crm_suppressions WHERE email_hash IN (${hashes.map(() => '?').join(', ')})`,
      hashes
    );
    return new Set(rows.map((r) => byHash.get(r.email_hash)).filter(Boolean));
  }

  static async count() {
    const [[{ total }]] = await promisePool.query('SELECT COUNT(*) AS total FROM crm_suppressions');
    return Number(total);
  }

  /**
   * The most recent entries for the admin screen: reasons, dates and who recorded them.
   * No addresses, because there are none to show — which is the point of the table.
   */
  static async recent({ limit = 50 } = {}) {
    const [rows] = await promisePool.query(
      `SELECT s.email_hash, s.reason, s.note, s.created_at,
              COALESCE(NULLIF(TRIM(u.name), ''), 'system') AS actor_name
         FROM crm_suppressions s
         LEFT JOIN users u ON u.id = s.created_by
        ORDER BY s.created_at DESC
        LIMIT ?`,
      [limit]
    );
    return rows;
  }
}

module.exports = CrmSuppression;
