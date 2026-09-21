'use strict';

const crypto = require('crypto');
const { promisePool } = require('../config/database');

/**
 * A payment attempt and its outcome.
 *
 * The rule that shapes this class: NOTHING here decides an amount. The amount arrives
 * already derived by `config/payments.js` from a row the payer owns. A model method that
 * accepted a price from a caller would put the price-tampering hole back one layer down.
 *
 * `markPaid` is a CLAIM, not a setter. It updates conditionally and reports whether this
 * call is the one that moved the row, so a redelivered webhook and a success-page refresh
 * racing each other produce exactly one fulfilment between them.
 */

// No I, L, O or U: those are the characters people mistype reading a reference off an
// invoice or over the phone. Same reasoning as Quote.generateReference.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function generateReference() {
  const bytes = crypto.randomBytes(12);
  let out = 'PAY-';
  for (let i = 0; i < 10; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** JSON columns come back parsed on some driver paths and as a string on others. */
function hydrate(row) {
  if (!row) return null;
  const out = { ...row };
  if (typeof out.price_basis === 'string') {
    try {
      out.price_basis = JSON.parse(out.price_basis);
    } catch {
      out.price_basis = null;
    }
  }
  return out;
}

class Payment {
  static get STATUSES() {
    return ['pending', 'paid', 'failed', 'cancelled', 'refunded'];
  }

  static generateReference = generateReference;

  /**
   * Record the intent to pay, BEFORE the Stripe session exists.
   *
   * Order matters. The row is written first so that a Stripe call which succeeds and
   * then fails to return still has something for the webhook to find by
   * `metadata.payment_id`; an abandoned pending row is a harmless audit trace of an
   * attempt. The reverse order loses the payment if the insert fails after money moved.
   */
  static async create({
    userId,
    product,
    subjectType,
    subjectId = null,
    amountMinor,
    currency,
    description,
    priceBasis = null
  }) {
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
      throw new Error('Payment.create: amountMinor must be a positive integer of minor units');
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const reference = generateReference();
      try {
        // eslint-disable-next-line no-await-in-loop
        const [result] = await promisePool.query(
          `INSERT INTO payments
             (reference, user_id, product, subject_type, subject_id, amount_minor, currency,
              price_basis, description)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            reference,
            userId,
            product,
            subjectType,
            subjectId,
            amountMinor,
            currency,
            priceBasis ? JSON.stringify(priceBasis) : null,
            String(description).slice(0, 255)
          ]
        );
        // eslint-disable-next-line no-await-in-loop
        return await Payment.findById(result.insertId);
      } catch (err) {
        // Retry rather than pre-check: a check-then-insert has a race, an
        // insert-then-retry does not.
        if (err.code !== 'ER_DUP_ENTRY') throw err;
      }
    }
    throw new Error('Payment.create: could not allocate a unique reference');
  }

  static async attachSession(id, stripeSessionId) {
    const [result] = await promisePool.query(
      'UPDATE payments SET stripe_session_id = ? WHERE id = ? AND stripe_session_id IS NULL',
      [stripeSessionId, id]
    );
    return result.affectedRows === 1;
  }

  static async findById(id) {
    const [rows] = await promisePool.query('SELECT * FROM payments WHERE id = ? LIMIT 1', [id]);
    return hydrate(rows[0]);
  }

  static async findByReference(reference) {
    const [rows] = await promisePool.query('SELECT * FROM payments WHERE reference = ? LIMIT 1', [
      reference
    ]);
    return hydrate(rows[0]);
  }

  static async findBySessionId(sessionId) {
    const [rows] = await promisePool.query(
      'SELECT * FROM payments WHERE stripe_session_id = ? LIMIT 1',
      [sessionId]
    );
    return hydrate(rows[0]);
  }

  /**
   * Claim this payment as settled.
   *
   * @returns {Promise<boolean>} true only for the caller that actually moved the row.
   *   A redelivered webhook, or the success page arriving first, gets false and must
   *   not fulfil. This is the ONE place that decides who fulfils.
   */
  static async markPaid(id, { stripeSessionId = null, stripePaymentIntentId = null } = {}) {
    const [result] = await promisePool.query(
      `UPDATE payments
          SET status = 'paid',
              paid_at = NOW(),
              stripe_session_id = COALESCE(stripe_session_id, ?),
              stripe_payment_intent_id = COALESCE(?, stripe_payment_intent_id)
        WHERE id = ? AND status <> 'paid'`,
      [stripeSessionId, stripePaymentIntentId, id]
    );
    return result.affectedRows === 1;
  }

  /**
   * A terminal non-paid outcome. Guarded on `status = 'pending'` so a late "expired"
   * webhook can never walk a settled payment backwards out of 'paid'.
   */
  static async markUnpaid(id, status) {
    if (!['failed', 'cancelled'].includes(status)) {
      throw new Error(`Payment.markUnpaid: refusing status "${status}"`);
    }
    const [result] = await promisePool.query(
      "UPDATE payments SET status = ? WHERE id = ? AND status = 'pending'",
      [status, id]
    );
    return result.affectedRows === 1;
  }

  /**
   * Money arrived that we cannot fulfil (its subject was settled by another payment).
   *
   * Deliberately NOT an automatic Stripe refund. Reversing a charge from inside a
   * webhook handler is an irreversible action taken on a partial view of the world; this
   * puts the row in a queue a person works instead.
   */
  static async flagRefundRequired(id, reason) {
    await promisePool.query('UPDATE payments SET needs_refund = 1 WHERE id = ?', [id]);
    await Payment.recordEvent({ paymentId: id, eventType: 'refund_required', detail: reason });
    return true;
  }

  /**
   * Append-only history. Never throws: recording that something happened must not be
   * able to fail the thing that happened.
   *
   * `stripeEventId` makes a redelivery an INSERT IGNORE no-op, so history does not grow
   * a duplicate line every time Stripe retries.
   */
  static async recordEvent({ paymentId = null, eventType, stripeEventId = null, detail = null }) {
    try {
      const [result] = await promisePool.query(
        `INSERT IGNORE INTO payment_events (payment_id, event_type, stripe_event_id, detail)
         VALUES (?, ?, ?, ?)`,
        [paymentId, eventType, stripeEventId, detail ? String(detail).slice(0, 500) : null]
      );
      return result.affectedRows === 1;
    } catch (err) {
      console.error(`Payment.recordEvent failed (${eventType}): ${err.message}`);
      return false;
    }
  }

  static async eventsFor(paymentId) {
    const [rows] = await promisePool.query(
      'SELECT * FROM payment_events WHERE payment_id = ? ORDER BY created_at ASC, id ASC',
      [paymentId]
    );
    return rows;
  }

  static async listFor(userId, { limit = 25, offset = 0 } = {}) {
    const [rows] = await promisePool.query(
      `SELECT p.*, i.id AS invoice_id, i.number AS invoice_number
         FROM payments p
         LEFT JOIN invoices i ON i.payment_id = p.id
        WHERE p.user_id = ?
        ORDER BY p.created_at DESC
        LIMIT ? OFFSET ?`,
      [userId, limit, offset]
    );
    const [[{ total }]] = await promisePool.query(
      'SELECT COUNT(*) AS total FROM payments WHERE user_id = ?',
      [userId]
    );
    return { rows: rows.map(hydrate), total };
  }

  /**
   * The settled deposit against a quote, or null.
   *
   * Lives here rather than on Quote because `quote_deposits` is a fulfilment table: the
   * quote does not know it has been paid for, and giving it a column that says so would
   * be a second place for the same fact to be wrong.
   */
  static async depositForQuote(quoteId) {
    const [rows] = await promisePool.query(
      `SELECT d.*, p.reference AS payment_reference, i.id AS invoice_id, i.number AS invoice_number
         FROM quote_deposits d
         JOIN payments p ON p.id = d.payment_id
         LEFT JOIN invoices i ON i.payment_id = p.id
        WHERE d.quote_id = ? LIMIT 1`,
      [quoteId]
    );
    return rows[0] || null;
  }

  /** The admin queue: paid money that could not be fulfilled. */
  static async listNeedingRefund({ limit = 50 } = {}) {
    const [rows] = await promisePool.query(
      `SELECT p.*, u.email
         FROM payments p
         JOIN users u ON u.id = p.user_id
        WHERE p.needs_refund = 1
        ORDER BY p.created_at DESC
        LIMIT ?`,
      [limit]
    );
    return rows.map(hydrate);
  }
}

module.exports = Payment;
