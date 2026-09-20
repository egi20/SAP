'use strict';

const crypto = require('crypto');
const { promisePool, withTransaction } = require('../config/database');
const { isModule } = require('../config/sapProducts');

/**
 * Saved scope estimates.
 *
 * The stored `estimate` JSON is the breakdown exactly as it was presented. It is never
 * recomputed on read: a quote is a statement made to a client on a date, and silently
 * re-deriving it after someone edits a base effort or a day rate would change history.
 * `catalogue_version` records which catalogue produced it, so a stale quote can be
 * identified rather than quietly trusted.
 */
const TRANSITIONS = Object.freeze({
  draft: ['sent'],
  sent: ['accepted', 'declined', 'expired', 'draft'],
  accepted: [],
  declined: [],
  expired: ['draft']
});

function canTransition(from, to) {
  return Boolean(TRANSITIONS[from] && TRANSITIONS[from].includes(to));
}

/**
 * A short, human-quotable reference.
 *
 * Crockford-style alphabet without I, L, O, U: those are the characters people mistype
 * when reading a reference off a document or a phone call.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function generateReference() {
  const bytes = crypto.randomBytes(8);
  let out = 'Q-';
  for (let i = 0; i < 8; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

class Quote {
  static get TRANSITIONS() {
    return TRANSITIONS;
  }

  static canTransition = canTransition;

  static generateReference = generateReference;

  /**
   * Persist a computed estimate.
   *
   * The reference is generated here and retried on the (vanishingly unlikely) unique-key
   * collision rather than being pre-checked, because a check-then-insert has a race and an
   * insert-then-retry does not.
   *
   * ONE TRANSACTION for the quote, its first audit event and its modules. The reference
   * writes the quote and then the event as two statements: a failure between them leaves a
   * quote whose history says it was never created, which is exactly the question the
   * history exists to answer. The modules are the same argument as on a consultant's
   * engagement — a quote row without them is invisible to every question asked across
   * quotes by module.
   */
  static async create(ownerUserId, { client, project, inputs, estimate, catalogueVersion }) {
    const modules = (inputs.selectedModules || []).filter((slug) => isModule(slug));

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const reference = generateReference();
      try {
        // Sequential by design: each attempt must see whether the previous one collided.
        // eslint-disable-next-line no-await-in-loop
        const id = await withTransaction(async (conn) => {
          const [result] = await conn.query(
            `INSERT INTO quotes
               (reference, owner_user_id, client_name, client_company, client_email,
                client_industry, company_size, project_name, project_summary,
                transition_approach, inputs, estimate, catalogue_version,
                total_man_days, total_budget, currency, duration_weeks)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              reference,
              ownerUserId,
              client.name,
              client.company,
              client.email || null,
              client.industry || null,
              client.size || null,
              project.name,
              project.summary || null,
              inputs.transitionApproach || 'greenfield',
              JSON.stringify(inputs),
              JSON.stringify(estimate),
              catalogueVersion,
              estimate.totalManDays,
              estimate.totalBudget,
              estimate.currency,
              estimate.projectDurationWeeks
            ]
          );

          await conn.query('INSERT INTO quote_events (quote_id, actor_user_id, to_status) VALUES (?, ?, ?)', [
            result.insertId,
            ownerUserId,
            'draft'
          ]);

          if (modules.length) {
            await conn.query('INSERT IGNORE INTO quote_modules (quote_id, module_slug) VALUES ?', [
              modules.map((slug) => [result.insertId, slug])
            ]);
          }

          return result.insertId;
        });

        // eslint-disable-next-line no-await-in-loop
        return await Quote.findById(id);
      } catch (err) {
        if (err.code !== 'ER_DUP_ENTRY') throw err;
      }
    }
    throw new Error('Could not allocate a unique quote reference.');
  }

  static async findById(id) {
    const [rows] = await promisePool.query('SELECT * FROM quotes WHERE id = ? LIMIT 1', [id]);
    return rows[0] ? Quote.hydrate(rows[0]) : null;
  }

  static async findByReference(reference) {
    const [rows] = await promisePool.query('SELECT * FROM quotes WHERE reference = ? LIMIT 1', [reference]);
    return rows[0] ? Quote.hydrate(rows[0]) : null;
  }

  /**
   * mysql2 returns a JSON column already parsed, but a column written by an older driver
   * or restored from a text dump can come back as a string. Handle both rather than
   * assuming, because the failure mode is a 500 on a page that used to work.
   */
  static hydrate(row) {
    const parse = (value) => {
      if (value === null || typeof value === 'object') return value;
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    };
    return { ...row, inputs: parse(row.inputs), estimate: parse(row.estimate) };
  }

  static async modulesFor(quoteId) {
    const [rows] = await promisePool.query('SELECT module_slug FROM quote_modules WHERE quote_id = ?', [quoteId]);
    return rows.map((r) => r.module_slug);
  }

  static async listForOwner(ownerUserId, { status = '', approach = '', limit = 20, offset = 0 } = {}) {
    const where = ['owner_user_id = ?'];
    const params = [ownerUserId];

    if (status) {
      where.push('status = ?');
      params.push(status);
    }
    if (approach) {
      where.push('transition_approach = ?');
      params.push(approach);
    }
    const clause = where.join(' AND ');

    const [rows] = await promisePool.query(
      `SELECT id, reference, client_company, project_name, transition_approach, total_man_days,
              total_budget, currency, duration_weeks, status, created_at, sent_at
         FROM quotes
        WHERE ${clause}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const [[{ total }]] = await promisePool.query(`SELECT COUNT(*) AS total FROM quotes WHERE ${clause}`, params);
    return { rows, total };
  }

  /**
   * Move a quote through its lifecycle, writing the audit event in the same transaction
   * so the history can never be missing for a transition that happened.
   */
  static async transition(quoteId, actorUserId, toStatus, { note = null } = {}) {
    return withTransaction(async (conn) => {
      const [[quote]] = await conn.query('SELECT id, status, owner_user_id FROM quotes WHERE id = ? FOR UPDATE', [
        quoteId
      ]);
      if (!quote) {
        const err = new Error('Quote not found.');
        err.code = 'NOT_FOUND';
        throw err;
      }
      if (quote.owner_user_id !== actorUserId) {
        const err = new Error('That quote belongs to another account.');
        err.code = 'FORBIDDEN';
        throw err;
      }
      if (!canTransition(quote.status, toStatus)) {
        const err = new Error(`A quote cannot go from "${quote.status}" to "${toStatus}".`);
        err.code = 'INVALID_TRANSITION';
        throw err;
      }

      const stamps = [];
      if (toStatus === 'sent') stamps.push('sent_at = NOW()');
      if (['accepted', 'declined'].includes(toStatus)) stamps.push('decided_at = NOW()');

      await conn.query(`UPDATE quotes SET status = ?${stamps.length ? `, ${stamps.join(', ')}` : ''} WHERE id = ?`, [
        toStatus,
        quoteId
      ]);
      await conn.query(
        'INSERT INTO quote_events (quote_id, actor_user_id, from_status, to_status, note) VALUES (?, ?, ?, ?, ?)',
        [quoteId, actorUserId, quote.status, toStatus, note]
      );

      return { ...quote, status: toStatus, previousStatus: quote.status };
    });
  }

  static async events(quoteId) {
    const [rows] = await promisePool.query(
      `SELECT qe.*, u.name AS actor_name
         FROM quote_events qe
         LEFT JOIN users u ON u.id = qe.actor_user_id
        WHERE qe.quote_id = ?
        ORDER BY qe.created_at ASC, qe.id ASC`,
      [quoteId]
    );
    return rows;
  }

  static async remove(quoteId, ownerUserId) {
    // Only a draft can be deleted. Once a quote has been sent it is a record of something
    // that was said to a client, and it is withdrawn by status, not erased.
    const [result] = await promisePool.query(
      "DELETE FROM quotes WHERE id = ? AND owner_user_id = ? AND status = 'draft'",
      [quoteId, ownerUserId]
    );
    return result.affectedRows === 1;
  }

  /**
   * Record that a deliverable was produced.
   *
   * Fire and forget, for the same reason notifications are: a failure to write the audit
   * row must not deny somebody the document they asked for. The row records the catalogue
   * the quote was priced under, because a document is only meaningful alongside its basis.
   */
  static async recordDownload(quoteId, actorUserId, kind, catalogueVersion, byteSize) {
    try {
      await promisePool.query(
        `INSERT INTO quote_downloads (quote_id, actor_user_id, kind, catalogue_version, byte_size)
         VALUES (?, ?, ?, ?, ?)`,
        [quoteId, actorUserId, kind, catalogueVersion, byteSize]
      );
    } catch (err) {
      console.error(`Could not record a ${kind} download for quote ${quoteId}: ${err.message}`);
    }
  }

  static async downloads(quoteId, { limit = 20 } = {}) {
    const [rows] = await promisePool.query(
      `SELECT qd.*, u.name AS actor_name
         FROM quote_downloads qd
         LEFT JOIN users u ON u.id = qd.actor_user_id
        WHERE qd.quote_id = ?
        ORDER BY qd.created_at DESC, qd.id DESC
        LIMIT ?`,
      [quoteId, limit]
    );
    return rows;
  }

  /** Headline counts for the owner's quote list. */
  static async statsForOwner(ownerUserId) {
    const [[row]] = await promisePool.query(
      `SELECT COUNT(*) AS total,
              SUM(status = 'draft') AS drafts,
              SUM(status = 'sent') AS sent,
              SUM(status = 'accepted') AS accepted
         FROM quotes WHERE owner_user_id = ?`,
      [ownerUserId]
    );
    return {
      total: Number(row.total) || 0,
      drafts: Number(row.drafts) || 0,
      sent: Number(row.sent) || 0,
      accepted: Number(row.accepted) || 0
    };
  }
}

module.exports = Quote;
