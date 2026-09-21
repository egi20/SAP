'use strict';

const crypto = require('crypto');
const { promisePool, withTransaction } = require('../config/database');
const {
  DEFAULT_RATE_BPS,
  MAX_RATE_BPS,
  ATTRIBUTION_WINDOW_DAYS,
  MIN_PAYOUT_MINOR,
  CODE_ALPHABET,
  CODE_LENGTH,
  commissionMinor,
  isCommissionableProduct,
  isValidPayoutMethod
} = require('../config/referrals');

/**
 * Referrals and the money they earn.
 *
 * THE RULE, and everything else follows from it: **the ledger is the balance.** There is
 * no cached total on the referrer row. `balanceFor()` is a SUM over
 * `commission_ledger`, exactly as a points total is a SUM over `points_ledger` — and here
 * the reason is stronger, because this is money somebody is owed. The reference
 * implementation kept `pending_earnings`, `total_earnings` and `paid_earnings` alongside
 * the rows that produced them; the first time a crash lands between two statements nobody
 * can say which number is right.
 *
 * Two more that are not negotiable:
 *
 *  - **Integers, minor units, everywhere.** The reference stored a DECIMAL percentage and
 *    reconciled payouts with `parseFloat` and a `+ 0.001` tolerance in every comparison.
 *    That tolerance is the bug made visible.
 *  - **No automatic clawback.** A refunded payment does not silently reverse a commission
 *    the referrer may already have been paid. An administrator writes a compensating
 *    entry, the same way a refund itself is a decision with a person on the other end.
 */

function generateCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

/** Codes are shared by voice and by message; compare them case-insensitively. */
function normaliseCode(value) {
  if (typeof value !== 'string') return '';
  const upper = value.trim().toUpperCase();
  return new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`).test(upper) ? upper : '';
}

class Referral {
  static generateCode = generateCode;

  static normaliseCode = normaliseCode;

  /**
   * Opt an account into the scheme, or return the profile it already has.
   *
   * The code is generated and retried on a unique-key collision rather than pre-checked:
   * a check-then-insert has a race and an insert-then-retry does not.
   */
  static async enrol(userId, { rateBps = DEFAULT_RATE_BPS } = {}) {
    const existing = await Referral.findByUserId(userId);
    if (existing) return existing;

    const rate = Math.min(Math.max(parseInt(rateBps, 10) || DEFAULT_RATE_BPS, 1), MAX_RATE_BPS);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await promisePool.query('INSERT INTO referrers (user_id, code, rate_bps) VALUES (?, ?, ?)', [
          userId,
          generateCode(),
          rate
        ]);
        // eslint-disable-next-line no-await-in-loop
        return await Referral.findByUserId(userId);
      } catch (err) {
        if (err.code !== 'ER_DUP_ENTRY') throw err;
        // A collision on user_id means a concurrent enrolment won; theirs is fine.
        // eslint-disable-next-line no-await-in-loop
        const raced = await Referral.findByUserId(userId);
        if (raced) return raced;
      }
    }
    throw new Error('Referral.enrol: could not allocate a unique code');
  }

  static async findByUserId(userId) {
    const [rows] = await promisePool.query('SELECT * FROM referrers WHERE user_id = ? LIMIT 1', [userId]);
    return rows[0] || null;
  }

  static async findByCode(code) {
    const normalised = normaliseCode(code);
    if (!normalised) return null;
    const [rows] = await promisePool.query('SELECT * FROM referrers WHERE code = ? LIMIT 1', [normalised]);
    return rows[0] || null;
  }

  static async setPayoutDetails(userId, { method, reference }) {
    if (method && !isValidPayoutMethod(method)) {
      const err = new Error('That is not a payout method we support.');
      err.code = 'BAD_PAYOUT_METHOD';
      throw err;
    }
    await promisePool.query(
      'UPDATE referrers SET payout_method = ?, payout_reference = ? WHERE user_id = ?',
      [method || null, reference ? String(reference).slice(0, 255) : null, userId]
    );
    return true;
  }

  /**
   * Attribute a newly registered account to whoever introduced them.
   *
   * FIRST TOUCH and permanent: the unique key on `referred_user_id` makes a second
   * attribution a silent no-op rather than a re-attribution. Last-touch would let anyone
   * claim someone else's introduction by getting a link in front of them the day before
   * they pay.
   *
   * Never throws. Attribution is a side effect of a registration that has already
   * succeeded, and failing to record it must not fail the account.
   *
   * @returns {Promise<boolean>} true if this call created the attribution.
   */
  static async attribute(code, referredUserId) {
    try {
      const referrer = await Referral.findByCode(code);
      if (!referrer || !referrer.is_active) return false;

      // A referrer cannot introduce themselves, and this is the whole of that check —
      // there is no path that creates a self-attribution to clean up later.
      if (referrer.user_id === referredUserId) return false;

      const earnsUntil = new Date(Date.now() + ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60 * 1000);

      const [result] = await promisePool.query(
        `INSERT IGNORE INTO referral_attributions
           (referrer_id, referred_user_id, code, rate_bps, earns_until)
         VALUES (?, ?, ?, ?, ?)`,
        [referrer.id, referredUserId, referrer.code, referrer.rate_bps, earnsUntil]
      );
      return result.affectedRows === 1;
    } catch (err) {
      console.error(`Referral.attribute failed (${code}): ${err.message}`);
      return false;
    }
  }

  /** The live attribution for a payer, or null. */
  static async attributionFor(userId) {
    const [rows] = await promisePool.query(
      `SELECT a.*, r.is_active, r.user_id AS referrer_user_id
         FROM referral_attributions a
         JOIN referrers r ON r.id = a.referrer_id
        WHERE a.referred_user_id = ? LIMIT 1`,
      [userId]
    );
    return rows[0] || null;
  }

  /**
   * Credit the commission on one settled payment.
   *
   * Called from the payment fulfilment path and nowhere else: a commission is earned when
   * money is RECEIVED, never when a quote is produced or a checkout is opened. Crediting
   * on a headline figure is how a scheme ends up owing people a percentage of revenue
   * that never arrived.
   *
   * Never throws. A commission problem must not break a service the customer has paid
   * for — the payment is already settled by the time this runs, and a thrown error here
   * would roll back a fulfilment that is not this module's to undo.
   *
   * Idempotent on the dedupe key, so a redelivered webhook racing the success page
   * produces exactly one entry.
   *
   * @returns {Promise<{credited:number, reason:string}>}
   */
  static async credit(payment) {
    try {
      if (!payment || !payment.id) return { credited: 0, reason: 'no payment' };

      const attribution = await Referral.attributionFor(payment.user_id);
      if (!attribution) return { credited: 0, reason: 'not referred' };
      if (!attribution.is_active) return { credited: 0, reason: 'referrer inactive' };

      // The window stamped at attribution, not one recomputed from today's config: a
      // policy change must not retroactively create a liability on an old introduction.
      if (new Date(attribution.earns_until) < new Date()) {
        return { credited: 0, reason: 'outside the earning window' };
      }

      const commissionable = isCommissionableProduct(payment.product);
      // Coerced HERE, once, where the driver's column types are the thing being handled —
      // rather than inside the calculation, which stays strict so a stray string from a
      // request can never reach it.
      const amount = commissionable
        ? commissionMinor(Number(payment.amount_minor), Number(attribution.rate_bps))
        : 0;

      /*
       * A zero-value entry is still written. "Your introduction bought something and it
       * earned nothing, because that product does not pay commission" is information the
       * referrer is owed; leaving a gap is what produces the email asking where their
       * money went.
       */
      const note = commissionable
        ? `${payment.product} — ${attribution.rate_bps / 100}% of ${payment.amount_minor}`
        : `${payment.product} — not a commissionable product`;

      const [result] = await promisePool.query(
        `INSERT IGNORE INTO commission_ledger
           (referrer_id, entry_type, amount_minor, currency, payment_id, referred_user_id, note, dedupe_key)
         VALUES (?, 'earned', ?, ?, ?, ?, ?, ?)`,
        [
          attribution.referrer_id,
          amount,
          payment.currency || 'EUR',
          payment.id,
          payment.user_id,
          note,
          `earn:${payment.id}`
        ]
      );

      if (result.affectedRows !== 1) return { credited: 0, reason: 'already credited' };
      return { credited: amount, reason: commissionable ? 'credited' : 'recorded, not commissionable' };
    } catch (err) {
      console.error(`Referral.credit failed for payment #${payment && payment.id}: ${err.message}`);
      return { credited: 0, reason: 'error' };
    }
  }

  /**
   * Reverse the commission on a payment that was given back.
   *
   * THE GAP THIS FILLS: the reference credits on money received and has no path that
   * un-credits it. A refunded payment therefore leaves a liability behind it forever —
   * the Hub gave the money back and still owes somebody ten per cent of it — and the only
   * correction available is a manual `adjust` that nobody is prompted to make. Since the
   * commission was computed from a row, reversing it from the same row is exact; asking
   * an administrator to retype the figure into an adjustment is how it ends up a cent out.
   *
   * This is NOT an automatic clawback, and the distinction is the same one payments make.
   * Nothing calls this from a webhook. It runs when a person records, in the admin screen,
   * that they refunded a payment — so the human decision has already been taken, and this
   * only stops that decision from leaving an untracked debt behind it.
   *
   * Written as a compensating `adjustment`, never as an edit to the earning: the original
   * credit stays visible, which is the point of an append-only ledger. A commission that
   * was already PAID OUT is still reversed — the balance goes negative and the next payout
   * settles less, which is the correct answer and a visible one, rather than quietly
   * writing off money that left on the strength of a payment that came back.
   *
   * Never throws, and idempotent on the payment id: recording the same refund twice
   * reverses once.
   *
   * @returns {Promise<{reversed:number, reason:string}>}
   */
  static async reverseForPayment(paymentId, { note = null } = {}) {
    try {
      const id = Number(paymentId);
      if (!Number.isInteger(id) || id <= 0) return { reversed: 0, reason: 'no payment' };

      const [[earned]] = await promisePool.query(
        `SELECT referrer_id, amount_minor, currency, referred_user_id
           FROM commission_ledger
          WHERE payment_id = ? AND entry_type = 'earned'
          LIMIT 1`,
        [id]
      );
      if (!earned) return { reversed: 0, reason: 'nothing was credited' };
      if (Number(earned.amount_minor) === 0) return { reversed: 0, reason: 'the entry earned nothing' };

      const amount = -Number(earned.amount_minor);
      const [result] = await promisePool.query(
        `INSERT IGNORE INTO commission_ledger
           (referrer_id, entry_type, amount_minor, currency, payment_id, referred_user_id, note, dedupe_key)
         VALUES (?, 'adjustment', ?, ?, ?, ?, ?, ?)`,
        [
          earned.referrer_id,
          amount,
          earned.currency || 'EUR',
          id,
          earned.referred_user_id,
          `Reversed — payment #${id} was refunded${note ? `: ${String(note).slice(0, 150)}` : ''}`,
          `reverse:earn:${id}`
        ]
      );

      if (result.affectedRows !== 1) return { reversed: 0, reason: 'already reversed' };
      return { reversed: amount, reason: 'reversed' };
    } catch (err) {
      console.error(`Referral.reverseForPayment failed for payment #${paymentId}: ${err.message}`);
      return { reversed: 0, reason: 'error' };
    }
  }

  /**
   * The balance, as a SUM. There is nowhere else it could come from.
   *
   * `unpaidMinor` is what a payout would settle; `lifetimeEarnedMinor` is what has ever
   * been credited. Both are derived, so neither can disagree with the history.
   */
  static async balanceFor(referrerId) {
    const [[row]] = await promisePool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN payout_id IS NULL THEN amount_minor ELSE 0 END), 0) AS unpaid_minor,
         COALESCE(SUM(CASE WHEN entry_type = 'earned' THEN amount_minor ELSE 0 END), 0) AS lifetime_earned_minor,
         COALESCE(-SUM(CASE WHEN entry_type = 'paid' THEN amount_minor ELSE 0 END), 0) AS lifetime_paid_minor,
         COUNT(*) AS entries
       FROM commission_ledger WHERE referrer_id = ?`,
      [referrerId]
    );

    const unpaid = Number(row.unpaid_minor) || 0;
    return {
      unpaidMinor: unpaid,
      lifetimeEarnedMinor: Number(row.lifetime_earned_minor) || 0,
      lifetimePaidMinor: Number(row.lifetime_paid_minor) || 0,
      entries: Number(row.entries) || 0,
      payable: unpaid >= MIN_PAYOUT_MINOR,
      minPayoutMinor: MIN_PAYOUT_MINOR
    };
  }

  static async ledgerFor(referrerId, { limit = 50, offset = 0 } = {}) {
    const [rows] = await promisePool.query(
      `SELECT l.*, p.reference AS payment_reference, p.description AS payment_description
         FROM commission_ledger l
         LEFT JOIN payments p ON p.id = l.payment_id
        WHERE l.referrer_id = ?
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT ? OFFSET ?`,
      [referrerId, limit, offset]
    );
    const [[{ total }]] = await promisePool.query(
      'SELECT COUNT(*) AS total FROM commission_ledger WHERE referrer_id = ?',
      [referrerId]
    );
    return { rows, total };
  }

  /** Who they introduced, and whether it has earned anything. No email, no name of a payer. */
  static async introductionsFor(referrerId, { limit = 50, offset = 0 } = {}) {
    const [rows] = await promisePool.query(
      `SELECT a.id, a.created_at, a.earns_until,
              COALESCE(SUM(l.amount_minor), 0) AS earned_minor,
              COUNT(l.id) AS conversions
         FROM referral_attributions a
         LEFT JOIN commission_ledger l
           ON l.referred_user_id = a.referred_user_id AND l.entry_type = 'earned'
        WHERE a.referrer_id = ?
        GROUP BY a.id, a.created_at, a.earns_until
        ORDER BY a.created_at DESC
        LIMIT ? OFFSET ?`,
      [referrerId, limit, offset]
    );
    return rows;
  }

  /**
   * Pay out everything currently unpaid.
   *
   * Deliberately NOT "pay an amount someone types in". The reference took a requested
   * figure and tried to match it against unpaid rows FIFO, which produced errors like
   * "requested €3 cannot be matched exactly by unpaid commissions" — a problem created
   * entirely by the design. Settling the whole unpaid balance has no matching problem and
   * no remainder to explain.
   *
   * Everything happens in one transaction with the ledger rows locked, so a second
   * administrator pressing the button at the same moment settles nothing rather than
   * paying twice.
   *
   * This records that money LEFT. It does not move any: a person makes the transfer.
   */
  static async payOut(referrerId, { method, reference = null, note = null, actorUserId = null }) {
    if (!isValidPayoutMethod(method)) {
      const err = new Error('That is not a payout method we support.');
      err.code = 'BAD_PAYOUT_METHOD';
      throw err;
    }

    return withTransaction(async (conn) => {
      // Lock the unpaid rows first. Anything credited after this point belongs to the
      // next payout, which is correct: it was not in the balance the operator approved.
      const [unpaidRows] = await conn.query(
        `SELECT id, amount_minor, currency FROM commission_ledger
          WHERE referrer_id = ? AND payout_id IS NULL
          ORDER BY id ASC
          FOR UPDATE`,
        [referrerId]
      );

      const amount = unpaidRows.reduce((total, row) => total + Number(row.amount_minor), 0);

      if (amount <= 0) {
        const err = new Error('There is nothing to pay out.');
        err.code = 'NOTHING_TO_PAY';
        throw err;
      }
      if (amount < MIN_PAYOUT_MINOR) {
        const err = new Error(`The balance is below the ${MIN_PAYOUT_MINOR / 100} payout minimum.`);
        err.code = 'BELOW_MINIMUM';
        err.amountMinor = amount;
        throw err;
      }

      const currency = unpaidRows[0].currency || 'EUR';

      const [payout] = await conn.query(
        `INSERT INTO commission_payouts (referrer_id, amount_minor, currency, method, reference, note, paid_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          referrerId,
          amount,
          currency,
          method,
          reference ? String(reference).slice(0, 255) : null,
          note ? String(note).slice(0, 255) : null,
          actorUserId
        ]
      );

      // The one column on the ledger that is ever updated, and only from NULL.
      await conn.query(
        'UPDATE commission_ledger SET payout_id = ? WHERE id IN (?) AND payout_id IS NULL',
        [payout.insertId, unpaidRows.map((r) => r.id)]
      );

      /*
       * The payout's own negative entry, marked as settled by itself. That keeps the
       * invariant simple and checkable: the SUM over the whole ledger is the balance
       * still owed, and the SUM of unpaid rows is what the next payout would settle.
       */
      await conn.query(
        `INSERT INTO commission_ledger
           (referrer_id, entry_type, amount_minor, currency, payout_id, note, dedupe_key)
         VALUES (?, 'paid', ?, ?, ?, ?, ?)`,
        [referrerId, -amount, currency, payout.insertId, `Payout by ${method}`, `payout:${payout.insertId}`]
      );

      return { payoutId: payout.insertId, amountMinor: amount, currency, entries: unpaidRows.length };
    });
  }

  /**
   * A manual correction: a refunded payment, a goodwill credit, a dispute settled.
   *
   * The ONLY way a commission is ever reversed, and it takes a human and a reason. There
   * is no automatic clawback: a refund is a decision with a person on the other end of it,
   * and a webhook silently debiting someone's balance on a chargeback is how a referrer
   * finds out they owe money from a dashboard.
   *
   * Written as a compensating entry, never as an edit to the original — the original
   * earning stays visible, which is the point of an append-only ledger.
   */
  static async adjust(referrerId, { amountMinor, note, actorUserId, dedupeKey = null }) {
    /*
     * `parseInt` would turn 1.5 into 1 and "150 euros" into 150. On a path that writes a
     * debt to somebody's ledger, silently truncating is worse than refusing: the caller
     * converts to whole cents deliberately (the admin route does
     * `Math.round(euros * 100)`) and anything else is a bug that should surface here.
     */
    const amount = amountMinor;
    if (!Number.isInteger(amount) || amount === 0) {
      const err = new Error('An adjustment must be a non-zero whole number of cents.');
      err.code = 'BAD_ADJUSTMENT';
      throw err;
    }
    if (!note || !String(note).trim()) {
      const err = new Error('An adjustment needs a reason. It will be visible to the referrer.');
      err.code = 'REASON_REQUIRED';
      throw err;
    }

    const key = dedupeKey || `adjust:${referrerId}:${Date.now()}:${crypto.randomBytes(4).toString('hex')}`;
    await promisePool.query(
      `INSERT IGNORE INTO commission_ledger
         (referrer_id, entry_type, amount_minor, note, dedupe_key)
       VALUES (?, 'adjustment', ?, ?, ?)`,
      [referrerId, amount, `${String(note).trim().slice(0, 200)} (by #${actorUserId})`, key]
    );
    return true;
  }

  /** The admin overview: everyone enrolled, with derived balances. */
  static async listAll({ limit = 50, offset = 0 } = {}) {
    const [rows] = await promisePool.query(
      `SELECT r.*, u.email, u.name,
              (SELECT COUNT(*) FROM referral_attributions a WHERE a.referrer_id = r.id) AS introductions,
              COALESCE((SELECT SUM(l.amount_minor) FROM commission_ledger l
                         WHERE l.referrer_id = r.id AND l.payout_id IS NULL), 0) AS unpaid_minor,
              COALESCE((SELECT SUM(l.amount_minor) FROM commission_ledger l
                         WHERE l.referrer_id = r.id AND l.entry_type = 'earned'), 0) AS earned_minor
         FROM referrers r
         JOIN users u ON u.id = r.user_id
        ORDER BY unpaid_minor DESC, r.created_at DESC
        LIMIT ? OFFSET ?`,
      [limit, offset]
    );
    const [[{ total }]] = await promisePool.query('SELECT COUNT(*) AS total FROM referrers');
    return { rows, total };
  }

  static async findById(referrerId) {
    const [rows] = await promisePool.query(
      `SELECT r.*, u.email, u.name FROM referrers r JOIN users u ON u.id = r.user_id
        WHERE r.id = ? LIMIT 1`,
      [referrerId]
    );
    return rows[0] || null;
  }

  static async setActive(referrerId, isActive) {
    await promisePool.query('UPDATE referrers SET is_active = ? WHERE id = ?', [isActive ? 1 : 0, referrerId]);
    return true;
  }

  static async setRate(referrerId, rateBps) {
    const rate = Math.min(Math.max(parseInt(rateBps, 10) || DEFAULT_RATE_BPS, 1), MAX_RATE_BPS);
    // Only future introductions are affected: `referral_attributions.rate_bps` snapshots
    // the rate in force when the introduction was made.
    await promisePool.query('UPDATE referrers SET rate_bps = ? WHERE id = ?', [rate, referrerId]);
    return rate;
  }

  static async payoutsFor(referrerId, { limit = 20 } = {}) {
    const [rows] = await promisePool.query(
      `SELECT p.*, u.name AS paid_by_name
         FROM commission_payouts p
         LEFT JOIN users u ON u.id = p.paid_by_user_id
        WHERE p.referrer_id = ?
        ORDER BY p.created_at DESC
        LIMIT ?`,
      [referrerId, limit]
    );
    return rows;
  }
}

module.exports = Referral;
