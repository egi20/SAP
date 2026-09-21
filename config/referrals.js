'use strict';

/**
 * The referral scheme: every number that decides what somebody is owed.
 *
 * These are BUSINESS POLICY, not implementation details, and they are gathered here so
 * that changing one is a commit with an author and a diff rather than a figure buried in
 * a query. Each is stated with the decision behind it, because the defaults are guesses
 * that the owner of this Hub should look at before anyone is paid anything.
 */

/**
 * Commission rate in BASIS POINTS, not a percentage.
 *
 * An integer, for the same reason every amount in `config/payments.js` is minor units:
 * `amount_minor * rate_bps / 10000` on integers is exact, whereas `amount * 0.10` on
 * floats produces a liability that is a cent away from what anyone can reproduce. The
 * reference implementation stored `commission_rate DECIMAL` and reconciled payouts with
 * `parseFloat` and a `+ 0.001` tolerance scattered through the comparisons — that
 * tolerance IS the bug, made visible.
 */
const DEFAULT_RATE_BPS = 1000; // 10.00%
const MAX_RATE_BPS = 3000; // nobody is negotiated above 30% by accident

/**
 * A ceiling on any single commission.
 *
 * A project deposit here is capped at €25,000 and, on an SAP-sized programme, it reaches
 * that cap almost every time (see config/payments.js) — so an uncapped 10% is not a rare
 * €2,500 liability, it is the NORMAL one, created by a single click. Whether that is the
 * right number is a business decision; what is not defensible is creating it without
 * having decided. This cap makes the worst case bounded and visible.
 */
const MAX_COMMISSION_MINOR = 50000; // €500.00

/**
 * How long an attribution earns.
 *
 * The reference has no limit, which means a link clicked once creates a claim on every
 * payment that person ever makes, forever. Twelve months is a normal affiliate window and,
 * more importantly, it is a FINITE liability. Attribution itself is permanent — the record
 * of who introduced whom does not expire — only the earning does.
 */
const ATTRIBUTION_WINDOW_DAYS = 365;

/**
 * The smallest balance that can be paid out.
 *
 * A bank transfer for €4.30 costs more to make and to reconcile than it settles. Below
 * this the balance simply keeps accruing; it is never forfeited.
 */
const MIN_PAYOUT_MINOR = 5000; // €50.00

/**
 * Which products pay commission.
 *
 * Named explicitly rather than "everything", so adding a product to
 * `config/payments.js` does not silently create a new liability. A product missing from
 * this list still records the conversion — see `Referral.credit` — it just earns nothing.
 */
const COMMISSIONABLE_PRODUCTS = Object.freeze(['job_feature', 'quote_deposit']);

/** Payout methods the admin screen offers. Free text would make reconciliation guesswork. */
const PAYOUT_METHODS = Object.freeze(['bank_transfer', 'paypal', 'credit_note']);

/**
 * The referral code alphabet: no I, L, O or U.
 *
 * Same reasoning as quote and payment references — these are read aloud and typed from a
 * message. A code that is routinely mistyped is a referral that is never attributed.
 */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8;

/**
 * Commission on one payment, in minor units.
 *
 * Integer arithmetic throughout and `Math.floor` rather than round: when a fraction of a
 * cent has to go to somebody, it goes to the party that has not yet been paid. Rounding up
 * a liability by default is how a balance ends up a cent above what the ledger can cover.
 */
function commissionMinor(amountMinor, rateBps) {
  /*
   * Strict about the TYPE, not just the value. A numeric string reaching a money
   * calculation means a caller handed it unvalidated request data, and coercing it here
   * is how a form field becomes a liability nobody checked. Both arguments come from
   * columns that are integers; anything else is a bug upstream, and returning zero makes
   * it visible as "nothing was earned" rather than hiding it behind a coincidence.
   */
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) return 0;
  if (!Number.isInteger(rateBps) || rateBps <= 0) return 0;

  const raw = Math.floor((amountMinor * Math.min(rateBps, MAX_RATE_BPS)) / 10000);
  return Math.min(raw, MAX_COMMISSION_MINOR);
}

function isCommissionableProduct(product) {
  return COMMISSIONABLE_PRODUCTS.includes(product);
}

function isValidPayoutMethod(method) {
  return PAYOUT_METHODS.includes(method);
}

/**
 * Boot assertion, in the same spirit as the taxonomy, estimation, payment and assistant
 * catalogues: a rate above its own ceiling, or a payout floor that no commission can ever
 * reach, does not fail at request time — it fails as a person asking why they have not
 * been paid.
 */
function assertReferralIntegrity() {
  if (!Number.isInteger(DEFAULT_RATE_BPS) || DEFAULT_RATE_BPS <= 0) {
    throw new Error('Referrals: the default rate must be a positive integer of basis points');
  }
  if (DEFAULT_RATE_BPS > MAX_RATE_BPS) {
    throw new Error('Referrals: the default rate is above the maximum rate');
  }
  if (!Number.isInteger(MAX_COMMISSION_MINOR) || MAX_COMMISSION_MINOR <= 0) {
    throw new Error('Referrals: the per-commission cap must be a positive integer of minor units');
  }
  if (!Number.isInteger(MIN_PAYOUT_MINOR) || MIN_PAYOUT_MINOR < 0) {
    throw new Error('Referrals: the payout floor must be a non-negative integer of minor units');
  }
  if (MIN_PAYOUT_MINOR > MAX_COMMISSION_MINOR * 20) {
    // Not impossible, but it would mean twenty capped commissions before anyone is paid,
    // which is almost certainly a typo rather than a policy.
    throw new Error('Referrals: the payout floor is implausibly high against the commission cap');
  }
  if (!COMMISSIONABLE_PRODUCTS.length) {
    throw new Error('Referrals: no product pays commission, so the scheme cannot pay anyone');
  }
  if (ATTRIBUTION_WINDOW_DAYS <= 0) {
    throw new Error('Referrals: the attribution window must be positive');
  }
  return true;
}

module.exports = {
  DEFAULT_RATE_BPS,
  MAX_RATE_BPS,
  MAX_COMMISSION_MINOR,
  ATTRIBUTION_WINDOW_DAYS,
  MIN_PAYOUT_MINOR,
  COMMISSIONABLE_PRODUCTS,
  PAYOUT_METHODS,
  CODE_ALPHABET,
  CODE_LENGTH,
  commissionMinor,
  isCommissionableProduct,
  isValidPayoutMethod,
  assertReferralIntegrity
};
