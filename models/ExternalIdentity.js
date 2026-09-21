'use strict';

const { promisePool, withTransaction } = require('../config/database');

/**
 * Verified external identities, and the profile flag that mirrors one.
 *
 * THE SINGLE WRITER of `consultant_profiles.linkedin_verified`. The flag and the identity
 * row move in the same transaction, so the badge on a listing can never outlive the proof
 * behind it — the failure mode that a denormalised flag exists to create.
 *
 * What this model refuses to hold is as important as what it stores: no access token, no
 * profile payload, no provider email. See migration 014.
 */

const LINKEDIN = 'linkedin';

class ExternalIdentity {
  static get LINKEDIN() {
    return LINKEDIN;
  }

  static async find(provider, userId) {
    const [rows] = await promisePool.query(
      'SELECT * FROM external_identities WHERE provider = ? AND user_id = ? LIMIT 1',
      [provider, userId]
    );
    return rows[0] || null;
  }

  /**
   * Record a verified LinkedIn account.
   *
   * @returns {Promise<{linked:boolean, reason?:string}>} `linked:false` with
   *   `reason: 'claimed_elsewhere'` when that LinkedIn account already verifies a
   *   different Hub account. That is refused rather than moved: one provider account
   *   verifying several Hub accounts is the whole value of the badge gone, and silently
   *   transferring it would let someone take a badge off an account they do not control.
   */
  static async linkLinkedIn(userId, { subject, displayName, nameMatched }) {
    return withTransaction(async (conn) => {
      const [[claimed]] = await conn.query(
        'SELECT user_id FROM external_identities WHERE provider = ? AND subject = ? LIMIT 1 FOR UPDATE',
        [LINKEDIN, subject]
      );

      if (claimed && claimed.user_id !== userId) {
        return { linked: false, reason: 'claimed_elsewhere' };
      }

      // Re-verifying refreshes the snapshot: someone who changed their name on LinkedIn
      // should see the new one next to their badge rather than a stale one.
      await conn.query(
        `INSERT INTO external_identities (provider, user_id, subject, display_name, name_matched)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           subject = VALUES(subject),
           display_name = VALUES(display_name),
           name_matched = VALUES(name_matched),
           verified_at = NOW()`,
        [LINKEDIN, userId, subject, displayName ? String(displayName).slice(0, 200) : null, nameMatched ? 1 : 0]
      );

      // The mirror, in the same transaction. A consultant profile may not exist — an
      // account can verify LinkedIn without being a consultant — and that is not an error.
      await conn.query(
        'UPDATE consultant_profiles SET linkedin_verified = 1, linkedin_verified_at = NOW() WHERE user_id = ?',
        [userId]
      );

      return { linked: true };
    });
  }

  /**
   * Remove the link, on the member's own request.
   *
   * Both halves together, and the flag is cleared even if no identity row was found:
   * leaving a badge behind after the proof is gone is the one outcome that must be
   * impossible.
   */
  static async unlink(provider, userId) {
    return withTransaction(async (conn) => {
      const [result] = await conn.query(
        'DELETE FROM external_identities WHERE provider = ? AND user_id = ?',
        [provider, userId]
      );

      if (provider === LINKEDIN) {
        await conn.query(
          'UPDATE consultant_profiles SET linkedin_verified = 0, linkedin_verified_at = NULL WHERE user_id = ?',
          [userId]
        );
      }

      return result.affectedRows > 0;
    });
  }

  /** For the admin overview: how many accounts carry a verified identity. */
  static async countByProvider() {
    const [rows] = await promisePool.query(
      `SELECT provider, COUNT(*) AS total, SUM(name_matched) AS name_matched
         FROM external_identities GROUP BY provider`
    );
    return rows;
  }
}

module.exports = ExternalIdentity;
