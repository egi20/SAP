'use strict';

const { promisePool } = require('../config/database');

/**
 * In-app notifications.
 *
 * Two rules, both learned the hard way:
 *
 *  1. FIRE AND FORGET. `emit()` never throws. A notification is a side effect of an
 *     action that has already succeeded; failing to record it must not roll back or
 *     500 the action that triggered it.
 *  2. STABLE DEDUPE KEY. Every emitter derives a deterministic key for the event, and
 *     the unique index makes the insert idempotent. Un-saving and re-saving a job, or
 *     a retried request, therefore cannot produce a second notification.
 */
class Notification {
  static async emit({ userId, type, title, body = null, link = null, dedupeKey }) {
    try {
      if (!userId || !type || !title || !dedupeKey) return false;
      const [result] = await promisePool.query(
        `INSERT IGNORE INTO notifications (user_id, type, title, body, link, dedupe_key)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [userId, type, title, body, link, String(dedupeKey).slice(0, 190)]
      );
      return result.affectedRows === 1;
    } catch (err) {
      console.error(`Notification emit failed (${type}): ${err.message}`);
      return false;
    }
  }

  static async listFor(userId, { limit = 30, offset = 0, unreadOnly = false } = {}) {
    const where = unreadOnly ? 'user_id = ? AND read_at IS NULL' : 'user_id = ?';
    const [rows] = await promisePool.query(
      `SELECT * FROM notifications WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [userId, limit, offset]
    );
    return rows;
  }

  static async unreadCount(userId) {
    const [[row]] = await promisePool.query(
      'SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND read_at IS NULL',
      [userId]
    );
    return row.count;
  }

  /** Ownership is part of the WHERE, so a guessed id cannot mark someone else's row. */
  static async markRead(userId, notificationId) {
    const [result] = await promisePool.query(
      'UPDATE notifications SET read_at = NOW() WHERE id = ? AND user_id = ? AND read_at IS NULL',
      [notificationId, userId]
    );
    return result.affectedRows === 1;
  }

  static async markAllRead(userId) {
    const [result] = await promisePool.query(
      'UPDATE notifications SET read_at = NOW() WHERE user_id = ? AND read_at IS NULL',
      [userId]
    );
    return result.affectedRows;
  }
}

module.exports = Notification;
