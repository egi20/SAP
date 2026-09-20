'use strict';

const crypto = require('crypto');
const { promisePool } = require('../config/database');
const User = require('./User');

/**
 * Single-use, hashed, expiring tokens for e-mail verification and password reset.
 *
 * Only the SHA-256 of the token is stored, so a database read (a backup, a log, an
 * injection) cannot be replayed as a working link. The raw token exists exactly once,
 * in the e-mail that is sent.
 */
const TABLES = {
  email_verification: 'email_verifications',
  password_reset: 'password_reset_tokens'
};

const DEFAULT_TTL_MINUTES = { email_verification: 60 * 24, password_reset: 60 };

function tableFor(kind) {
  const table = TABLES[kind];
  if (!table) throw new Error(`Unknown token kind: ${kind}`);
  return table;
}

class Token {
  /** @returns {{token:string, expiresAt:Date}} the RAW token, to be e-mailed and then forgotten. */
  static async issue(kind, userId, ttlMinutes = null) {
    const table = tableFor(kind);
    const token = crypto.randomBytes(32).toString('base64url');
    const ttl = ttlMinutes ?? DEFAULT_TTL_MINUTES[kind];
    const expiresAt = new Date(Date.now() + ttl * 60 * 1000);

    // Any outstanding token of the same kind is invalidated: requesting a new reset
    // link must make the previous one stop working.
    await promisePool.query(`UPDATE ${table} SET consumed_at = NOW() WHERE user_id = ? AND consumed_at IS NULL`, [userId]);
    await promisePool.query(`INSERT INTO ${table} (user_id, token_hash, expires_at) VALUES (?, ?, ?)`, [
      userId,
      User.hashToken(token),
      expiresAt
    ]);

    return { token, expiresAt };
  }

  /**
   * Consume a token atomically.
   *
   * The UPDATE is the check: a token can only be marked consumed while it is still
   * unconsumed and unexpired, so two concurrent requests cannot both succeed.
   * @returns {number|null} the user id, or null when the token is invalid.
   */
  static async consume(kind, rawToken) {
    const table = tableFor(kind);
    if (!rawToken || typeof rawToken !== 'string') return null;
    const hash = User.hashToken(rawToken);

    const [result] = await promisePool.query(
      `UPDATE ${table}
          SET consumed_at = NOW()
        WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > NOW()`,
      [hash]
    );
    if (result.affectedRows !== 1) return null;

    const [rows] = await promisePool.query(`SELECT user_id FROM ${table} WHERE token_hash = ? LIMIT 1`, [hash]);
    return rows.length ? rows[0].user_id : null;
  }

  static async purgeExpired() {
    for (const table of Object.values(TABLES)) {
      // eslint-disable-next-line no-await-in-loop
      await promisePool.query(`DELETE FROM ${table} WHERE expires_at < DATE_SUB(NOW(), INTERVAL 30 DAY)`);
    }
  }
}

module.exports = Token;
