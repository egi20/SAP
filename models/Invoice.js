'use strict';

const { promisePool } = require('../config/database');

/**
 * The invoice raised against a settled payment.
 *
 * Two decisions worth stating, because both were tempting to do the other way:
 *
 *  1. THE NUMBER IS DERIVED, not allocated. `INV-<year>-<payment id, padded>` is unique
 *     because the payment id is, so there is no counter row to lock, no gap when a
 *     transaction rolls back, and no two-invoices-share-a-number race under load.
 *  2. THE BUYER IS SNAPSHOT. An invoice states who was billed on a date. Joining the
 *     name off the profile would let an edit two years later rewrite a document someone
 *     has already filed with their accountant.
 *
 * Creation is INSERT IGNORE against a UNIQUE key on `payment_id`, so billing twice for
 * one payment is impossible regardless of how many callers try.
 */

function numberFor(paymentId, issuedAt = new Date()) {
  const year = issuedAt.getUTCFullYear();
  return `INV-${year}-${String(paymentId).padStart(6, '0')}`;
}

class Invoice {
  static numberFor = numberFor;

  /**
   * @param {object} executor a pooled connection inside a transaction, or the pool.
   * @returns {Promise<boolean>} true if this call raised the invoice, false if one
   *   already existed (a duplicate webhook, or the success page having got there first).
   */
  static async createFor(executor, { payment, billTo }) {
    const number = numberFor(payment.id);
    const [result] = await executor.query(
      `INSERT IGNORE INTO invoices
         (number, payment_id, user_id, bill_to_name, bill_to_email, bill_to_company,
          description, subtotal_minor, tax_minor, total_minor, currency)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        number,
        payment.id,
        payment.user_id,
        String(billTo.name || 'Customer').slice(0, 200),
        String(billTo.email || '').slice(0, 255),
        billTo.company ? String(billTo.company).slice(0, 200) : null,
        String(payment.description).slice(0, 255),
        payment.amount_minor,
        payment.amount_minor,
        payment.currency
      ]
    );
    return result.affectedRows === 1;
  }

  /**
   * Scoped by user on purpose. An invoice is fetched by "mine with this id", never by id
   * alone, so there is no path where an ownership check is a separate step someone can
   * forget to write.
   */
  static async findForUser(id, userId) {
    const [rows] = await promisePool.query(
      `SELECT i.*, p.reference AS payment_reference, p.product, p.paid_at, p.price_basis
         FROM invoices i
         JOIN payments p ON p.id = i.payment_id
        WHERE i.id = ? AND i.user_id = ? LIMIT 1`,
      [id, userId]
    );
    return rows[0] || null;
  }

  static async listFor(userId, { limit = 25, offset = 0 } = {}) {
    const [rows] = await promisePool.query(
      `SELECT i.*, p.reference AS payment_reference, p.product
         FROM invoices i
         JOIN payments p ON p.id = i.payment_id
        WHERE i.user_id = ?
        ORDER BY i.issued_at DESC
        LIMIT ? OFFSET ?`,
      [userId, limit, offset]
    );
    const [[{ total }]] = await promisePool.query(
      'SELECT COUNT(*) AS total FROM invoices WHERE user_id = ?',
      [userId]
    );
    return { rows, total };
  }
}

module.exports = Invoice;
