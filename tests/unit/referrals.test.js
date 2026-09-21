'use strict';

/**
 * The commission arithmetic, as pure functions.
 *
 * This is money somebody is owed, computed from two integers. Every case here is one
 * where a float, a coercion or a rounding choice would produce a liability that nobody
 * can reproduce from the ledger.
 */

const {
  DEFAULT_RATE_BPS,
  MAX_RATE_BPS,
  MAX_COMMISSION_MINOR,
  MIN_PAYOUT_MINOR,
  COMMISSIONABLE_PRODUCTS,
  commissionMinor,
  isCommissionableProduct,
  isValidPayoutMethod,
  assertReferralIntegrity
} = require('../../config/referrals');
const { PRODUCTS, DEPOSIT_MAX_MINOR, JOB_FEATURE_PRICE_MINOR } = require('../../config/payments');
const Referral = require('../../models/Referral');

describe('the scheme asserts itself', () => {
  test('integrity', () => expect(assertReferralIntegrity()).toBe(true));

  test('every commissionable product is a real product', () => {
    // A product named here that does not exist in config/payments.js pays commission on
    // nothing; one that exists and is missing here silently earns nobody anything. Both
    // are only visible by comparing the two lists.
    for (const product of COMMISSIONABLE_PRODUCTS) {
      expect(Object.keys(PRODUCTS)).toContain(product);
    }
  });
});

describe('what a commission comes to', () => {
  test('it is a share of the amount, in whole cents', () => {
    expect(commissionMinor(10000, 1000)).toBe(1000); // 10% of €100.00
    expect(commissionMinor(14900, 1000)).toBe(1490); // a featured placement
  });

  test('a fraction of a cent goes to the party not yet paid', () => {
    // Math.floor, not round: rounding a liability up by default is how a balance ends up
    // a cent above what the ledger can cover.
    expect(commissionMinor(999, 1000)).toBe(99);
    expect(commissionMinor(1, 1000)).toBe(0);
  });

  test('the per-commission cap binds, and on this marketplace it is the normal case', () => {
    /*
     * An SAP deposit reaches its own €25,000 cap on almost every quote, so the
     * uncapped 10% here is not a rare large liability — it is the usual one. That is the
     * whole argument for having a ceiling at all.
     */
    const uncapped = (DEPOSIT_MAX_MINOR * DEFAULT_RATE_BPS) / 10000;
    expect(uncapped).toBeGreaterThan(MAX_COMMISSION_MINOR);
    expect(commissionMinor(DEPOSIT_MAX_MINOR, DEFAULT_RATE_BPS)).toBe(MAX_COMMISSION_MINOR);
  });

  test('a negotiated rate cannot exceed the maximum, however it is stored', () => {
    expect(commissionMinor(100000, 9999)).toBe(
      Math.min(Math.floor((100000 * MAX_RATE_BPS) / 10000), MAX_COMMISSION_MINOR)
    );
  });

  test('a non-integer argument earns nothing rather than guessing', () => {
    /*
     * Strict about the TYPE, not only the value. A numeric string reaching a money
     * calculation means a caller handed it unvalidated request data; coercing it here is
     * how a form field becomes a liability nobody checked.
     */
    expect(commissionMinor('10000', 1000)).toBe(0);
    expect(commissionMinor(10000, '1000')).toBe(0);
    expect(commissionMinor(10000.5, 1000)).toBe(0);
    expect(commissionMinor(-10000, 1000)).toBe(0);
    expect(commissionMinor(null, undefined)).toBe(0);
  });

  test('a featured placement earns less than the payout floor, on purpose', () => {
    // It takes several introductions before a transfer is worth making, which is what the
    // floor is for — a bank transfer for €4.30 costs more to make than it settles.
    expect(commissionMinor(JOB_FEATURE_PRICE_MINOR, DEFAULT_RATE_BPS)).toBeLessThan(MIN_PAYOUT_MINOR);
  });

  test('only the named products pay', () => {
    expect(isCommissionableProduct('job_feature')).toBe(true);
    expect(isCommissionableProduct('something_new')).toBe(false);
  });

  test('a payout method is checked against a list, not accepted as free text', () => {
    expect(isValidPayoutMethod('bank_transfer')).toBe(true);
    expect(isValidPayoutMethod('cash in an envelope')).toBe(false);
  });
});

describe('referral codes', () => {
  test('a generated code is the declared shape', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(Referral.generateCode()).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/);
    }
  });

  test('the alphabet excludes the characters people mistype', () => {
    // Read aloud and typed from a message; I/L/O/U are where that goes wrong.
    const codes = Array.from({ length: 200 }, () => Referral.generateCode()).join('');
    expect(codes).not.toMatch(/[ILOU]/);
  });

  test('a code is normalised case-insensitively and validated', () => {
    const code = Referral.generateCode();
    expect(Referral.normaliseCode(code.toLowerCase())).toBe(code);
    expect(Referral.normaliseCode(` ${code} `)).toBe(code);
    expect(Referral.normaliseCode('TOO-SHORT')).toBe('');
    expect(Referral.normaliseCode('IIIIIIII')).toBe('');
    expect(Referral.normaliseCode(null)).toBe('');
  });
});
