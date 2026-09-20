'use strict';

const { promisePool, withTransaction } = require('../config/database');

/**
 * Anchored conversations.
 *
 * Every thread has a subject — an application, or an enquiry about a specific job — and
 * membership is a row in `conversation_participants`. Both facts shape every query here:
 *
 *  - The subject makes the thread's identity deterministic, so opening one is an
 *    idempotent upsert rather than a check-then-insert with a race.
 *  - Membership as a row makes "is this thread mine?" a JOIN condition on every read and
 *    every write, rather than a separate authorisation check that a future query can
 *    forget to make. There is no method here that returns a conversation without also
 *    proving the caller is in it.
 */

const MAX_BODY_LENGTH = 5000;
const KINDS = Object.freeze(['application', 'enquiry']);

/**
 * Deterministic subject key. Pure, so the rule is unit-testable.
 *
 * An enquiry key sorts the two user ids, so whichever side starts the thread produces the
 * same key and a second thread cannot be created for the same pair and job.
 *
 * A JOB IS REQUIRED FOR AN ENQUIRY. The reference defaults it — `enquiry:${jobId || 0}:…` —
 * and that key is an unanchored direct message between two accounts, which is the one thing
 * the schema comment says this design does not have. Its route happens to always pass a
 * job, so the hole is unreachable today; a rule that holds only because of what one caller
 * happens to do is not a rule. Migration 008 refuses the row as well, so this throw is the
 * readable failure rather than the only one.
 */
function dedupeKeyFor(kind, { applicationId = null, jobId = null, userIds = [] } = {}) {
  if (kind === 'application') {
    if (!applicationId) throw new Error('An application conversation needs an applicationId.');
    return `application:${applicationId}`;
  }

  if (kind === 'enquiry') {
    if (!jobId) throw new Error('An enquiry conversation needs a jobId — there is no unanchored inbox.');
    const ids = [...userIds].map(Number).filter(Number.isInteger).sort((a, b) => a - b);
    if (ids.length !== 2) throw new Error('An enquiry conversation needs exactly two participants.');
    return `enquiry:${jobId}:${ids[0]}:${ids[1]}`;
  }

  throw new Error(`Unknown conversation kind: ${kind}`);
}

/**
 * Display name for a participant.
 *
 * Falls back to a NEUTRAL label, never the email local part. That fallback is the one
 * DynamicsHub got wrong: an account with no profile leaked a `firstname.lastname` email
 * prefix to anyone who could open a thread with it.
 */
const DISPLAY_NAME_SQL = `COALESCE(
  NULLIF(TRIM(u.name), ''),
  NULLIF(TRIM(comp.company_name), ''),
  'SAP Hub user'
)`;

function normaliseBody(body) {
  return String(body || '')
    .replace(/\r\n/g, '\n')
    .trim()
    .slice(0, MAX_BODY_LENGTH);
}

class Conversation {
  static get MAX_BODY_LENGTH() {
    return MAX_BODY_LENGTH;
  }

  static get KINDS() {
    return KINDS;
  }

  static dedupeKeyFor = dedupeKeyFor;

  static normaliseBody = normaliseBody;

  /**
   * Open the thread for a subject, creating it if it does not exist.
   *
   * The INSERT ... ON DUPLICATE KEY on `dedupe_key` is the concurrency control: two people
   * clicking "message" at the same moment get the same thread, not two.
   */
  static async findOrCreate({ kind, applicationId = null, jobId = null, participantIds, createdByUserId }) {
    const dedupeKey = dedupeKeyFor(kind, { applicationId, jobId, userIds: participantIds });

    return withTransaction(async (conn) => {
      await conn.query(
        `INSERT INTO conversations (kind, dedupe_key, job_id, application_id, created_by_user_id)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
        [kind, dedupeKey, jobId, applicationId, createdByUserId]
      );

      const [[row]] = await conn.query('SELECT id FROM conversations WHERE dedupe_key = ? LIMIT 1', [dedupeKey]);
      const conversationId = row.id;

      const values = participantIds.map((userId) => [conversationId, userId]);
      await conn.query('INSERT IGNORE INTO conversation_participants (conversation_id, user_id) VALUES ?', [values]);

      return conversationId;
    });
  }

  /**
   * Fetch a thread AS a participant.
   *
   * The participant join is part of the query, so a non-member gets null rather than a
   * conversation plus a hope that the caller checks.
   */
  static async forParticipant(conversationId, userId) {
    const [rows] = await promisePool.query(
      `SELECT c.*, cp.last_read_at,
              j.title AS job_title, j.slug AS job_slug, j.role AS job_role,
              a.status AS application_status
         FROM conversations c
         JOIN conversation_participants cp ON cp.conversation_id = c.id AND cp.user_id = ?
         LEFT JOIN jobs j ON j.id = c.job_id
         LEFT JOIN applications a ON a.id = c.application_id
        WHERE c.id = ?
        LIMIT 1`,
      [userId, conversationId]
    );
    return rows[0] || null;
  }

  static async participants(conversationId) {
    const [rows] = await promisePool.query(
      `SELECT cp.user_id, cp.last_read_at, ${DISPLAY_NAME_SQL} AS display_name,
              con.profile_picture, comp.logo
         FROM conversation_participants cp
         JOIN users u ON u.id = cp.user_id
         LEFT JOIN consultant_profiles con ON con.user_id = u.id
         LEFT JOIN company_profiles comp ON comp.user_id = u.id
        WHERE cp.conversation_id = ?`,
      [conversationId]
    );
    return rows;
  }

  /**
   * Inbox. One row per thread, with the other party, the last message and the unread count.
   *
   * TWO QUERIES, NOT ONE, and that is the fix rather than a compromise.
   *
   * The reference joins `conversation_participants` a second time to pick up "the other
   * party". That produces one inbox row PER other participant — so the moment a thread has
   * three people in it, it appears in the inbox twice, with a different name each time. The
   * schema anticipates more than two (read state is per participant precisely because "a
   * single is_read would be wrong the moment a thread has more than two people in it"), so
   * the inbox contradicts the table it reads from.
   *
   * Grouping it away in SQL means either an aggregate over the columns a reader needs — a
   * name, a photo, an id — or `only_full_group_by` rejecting the query. Fetching the threads
   * and then their participants in ONE batched second query is shorter, correct for any
   * number of people, and cannot silently duplicate a row.
   *
   * The unread count is computed against this participant's `last_read_at`, and a message
   * the participant sent themselves never counts as unread — otherwise sending a reply
   * lights up your own inbox.
   */
  static async listForUser(userId, { limit = 30, offset = 0 } = {}) {
    const [rows] = await promisePool.query(
      `SELECT c.id, c.kind, c.job_id, c.application_id, c.last_message_at,
              j.title AS job_title, j.slug AS job_slug,
              (SELECT m.body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_body,
              (SELECT m.sender_user_id FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_sender_id,
              (SELECT COUNT(*) FROM messages m
                WHERE m.conversation_id = c.id
                  AND m.sender_user_id <> ?
                  AND (me.last_read_at IS NULL OR m.created_at > me.last_read_at)) AS unread_count
         FROM conversations c
         JOIN conversation_participants me ON me.conversation_id = c.id AND me.user_id = ?
         LEFT JOIN jobs j ON j.id = c.job_id
        ORDER BY c.last_message_at IS NULL, c.last_message_at DESC, c.id DESC
        LIMIT ? OFFSET ?`,
      [userId, userId, limit, offset]
    );

    const [[{ total }]] = await promisePool.query(
      'SELECT COUNT(*) AS total FROM conversation_participants WHERE user_id = ?',
      [userId]
    );

    if (rows.length === 0) return { rows, total };

    // The others, for every thread on this page, in one query.
    const [others] = await promisePool.query(
      `SELECT cp.conversation_id, cp.user_id, ${DISPLAY_NAME_SQL} AS display_name,
              con.profile_picture, comp.logo
         FROM conversation_participants cp
         JOIN users u ON u.id = cp.user_id
         LEFT JOIN consultant_profiles con ON con.user_id = u.id
         LEFT JOIN company_profiles comp ON comp.user_id = u.id
        WHERE cp.conversation_id IN (?) AND cp.user_id <> ?
        ORDER BY cp.user_id ASC`,
      [rows.map((r) => r.id), userId]
    );

    const byConversation = new Map();
    for (const row of others) {
      const list = byConversation.get(row.conversation_id) || [];
      list.push(row);
      byConversation.set(row.conversation_id, list);
    }

    return {
      rows: rows.map((row) => {
        const people = byConversation.get(row.id) || [];
        const first = people[0] || null;
        return {
          ...row,
          others: people,
          other_user_id: first ? first.user_id : null,
          // A deterministic representative plus a count, so a three-person thread reads
          // "Katrin Bauer and 1 other" instead of appearing twice.
          other_name: first ? first.display_name : 'SAP Hub user',
          other_photo: first ? first.profile_picture : null,
          other_logo: first ? first.logo : null,
          other_count: people.length
        };
      }),
      total
    };
  }

  static async messages(conversationId, { limit = 200 } = {}) {
    const [rows] = await promisePool.query(
      `SELECT m.id, m.sender_user_id, m.body, m.created_at, ${DISPLAY_NAME_SQL} AS sender_name
         FROM messages m
         JOIN users u ON u.id = m.sender_user_id
         LEFT JOIN company_profiles comp ON comp.user_id = u.id
        WHERE m.conversation_id = ?
        ORDER BY m.created_at ASC, m.id ASC
        LIMIT ?`,
      [conversationId, limit]
    );
    return rows;
  }

  /**
   * Post a message.
   *
   * The participant check is inside the transaction and inside the WHERE, so there is no
   * window between "are you a member?" and the insert. Sending also marks the thread read
   * for the sender: you have by definition seen everything up to your own reply.
   *
   * @throws {Error & {code:'NOT_A_PARTICIPANT'|'EMPTY_MESSAGE'}}
   */
  static async postMessage(conversationId, senderUserId, rawBody) {
    const body = normaliseBody(rawBody);
    if (!body) {
      const err = new Error('A message cannot be empty.');
      err.code = 'EMPTY_MESSAGE';
      throw err;
    }

    return withTransaction(async (conn) => {
      const [[membership]] = await conn.query(
        'SELECT user_id FROM conversation_participants WHERE conversation_id = ? AND user_id = ? FOR UPDATE',
        [conversationId, senderUserId]
      );
      if (!membership) {
        const err = new Error('That conversation is not yours.');
        err.code = 'NOT_A_PARTICIPANT';
        throw err;
      }

      const [result] = await conn.query(
        'INSERT INTO messages (conversation_id, sender_user_id, body) VALUES (?, ?, ?)',
        [conversationId, senderUserId, body]
      );

      await conn.query('UPDATE conversations SET last_message_at = NOW() WHERE id = ?', [conversationId]);
      await conn.query(
        'UPDATE conversation_participants SET last_read_at = NOW() WHERE conversation_id = ? AND user_id = ?',
        [conversationId, senderUserId]
      );

      const [recipients] = await conn.query(
        'SELECT user_id FROM conversation_participants WHERE conversation_id = ? AND user_id <> ?',
        [conversationId, senderUserId]
      );

      return { messageId: result.insertId, body, recipientIds: recipients.map((r) => r.user_id) };
    });
  }

  /** Ownership is in the WHERE, so a guessed id cannot mark someone else's thread read. */
  static async markRead(conversationId, userId) {
    const [result] = await promisePool.query(
      'UPDATE conversation_participants SET last_read_at = NOW() WHERE conversation_id = ? AND user_id = ?',
      [conversationId, userId]
    );
    return result.affectedRows === 1;
  }

  /** Total unread across every thread, for the navigation badge. */
  static async unreadCount(userId) {
    const [[row]] = await promisePool.query(
      `SELECT COUNT(*) AS count
         FROM messages m
         JOIN conversation_participants cp ON cp.conversation_id = m.conversation_id AND cp.user_id = ?
        WHERE m.sender_user_id <> ?
          AND (cp.last_read_at IS NULL OR m.created_at > cp.last_read_at)`,
      [userId, userId]
    );
    return row.count;
  }
}

module.exports = Conversation;
