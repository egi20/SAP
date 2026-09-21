'use strict';

const {
  PRODUCTS,
  DEPOSIT_PERCENT,
  DEPOSIT_MIN_MINOR,
  DEPOSIT_MAX_MINOR,
  JOB_FEATURE_PRICE_MINOR,
  depositForTotal,
  isValidProduct,
  productFor,
  formatMinor,
  assertPaymentIntegrity,
  WEBHOOK_PATH
} = require('../../config/payments');

describe('the catalogue asserts itself', () => {
  test('integrity', () => expect(assertPaymentIntegrity()).toBe(true));

  test('every product is a resolver, not a price tag', () => {
    for (const [key, product] of Object.entries(PRODUCTS)) {
      expect({ key, resolves: typeof product.resolve }).toEqual({ key, resolves: 'function' });
      expect(product.subjectType).toBeTruthy();
      expect(product.key).toBe(key);
    }
  });

  test('an unknown product cannot be bought, including a prototype key', () => {
    expect(isValidProduct('free_money')).toBe(false);
    // `PRODUCTS['__proto__']` is truthy, so a plain lookup guard would let this through.
    expect(isValidProduct('__proto__')).toBe(false);
    expect(productFor('__proto__')).toBeNull();
  });

  test('the webhook path is shared, not written twice', () => {
    // server.js needs it for the raw body parser AND the CSRF exemption. A webhook
    // exempted at one path while raw-parsed at another fails in a way nobody enjoys.
    expect(WEBHOOK_PATH).toBe('/payments/webhook');
  });
});

describe('the deposit says which rule set it', () => {
  test('a mid-sized quote is the plain percentage', () => {
    const deposit = depositForTotal(100000); // €100,000
    expect(deposit.basis).toBe('percent');
    expect(deposit.amountMinor).toBe(1000000); // €10,000
    expect(deposit.percentOfTotal).toBe(DEPOSIT_PERCENT);
  });

  test('an SAP-sized quote hits the cap, and reports the percentage it ACTUALLY charges', () => {
    /*
     * This is why `depositForTotal` returns a basis at all. A real programme priced by this
     * application runs to seven figures, so ten per cent is far above what a card will
     * authorise and the deposit tops out. The reference returns a bare number, and the page
     * built on it says "10% deposit" while charging 1.1% — correct arithmetic, misleading
     * sentence, on nearly every quote this application will ever price.
     */
    const deposit = depositForTotal(2237250);
    expect(deposit.basis).toBe('cap');
    expect(deposit.amountMinor).toBe(DEPOSIT_MAX_MINOR);
    expect(deposit.percentOfTotal).toBeLessThan(2);
    expect(deposit.percentOfTotal).toBeGreaterThan(1);
    expect(deposit.balanceMinor).toBe(Math.round(2237250 * 100) - DEPOSIT_MAX_MINOR);
  });

  test('the cap exactly reached is still the percentage, not the cap', () => {
    // €250,000 × 10% is exactly the cap. Nothing was clamped, so nothing should say it was.
    const deposit = depositForTotal(250000);
    expect(deposit.amountMinor).toBe(DEPOSIT_MAX_MINOR);
    expect(deposit.basis).toBe('percent');
  });

  test('a tiny quote is lifted to the floor and says so', () => {
    const deposit = depositForTotal(1000); // €1,000 → 10% is €100, below the €500 floor
    expect(deposit.basis).toBe('floor');
    expect(deposit.amountMinor).toBe(DEPOSIT_MIN_MINOR);
    expect(deposit.percentOfTotal).toBeGreaterThan(DEPOSIT_PERCENT);
  });

  test('a quote with no payable total has no deposit', () => {
    for (const bad of [0, -1, null, undefined, 'lots', NaN]) {
      expect(depositForTotal(bad)).toBeNull();
    }
  });

  test('every amount is a whole number of minor units', () => {
    for (const total of [1000, 33333.33, 100000, 987654.21, 2237250]) {
      const deposit = depositForTotal(total);
      expect(Number.isInteger(deposit.amountMinor)).toBe(true);
      expect(Number.isInteger(deposit.balanceMinor)).toBe(true);
    }
  });

  test('the deposit plus the balance is the total, to the cent', () => {
    for (const total of [1000, 100000, 2237250]) {
      const deposit = depositForTotal(total);
      expect(deposit.amountMinor + deposit.balanceMinor).toBe(Math.round(total * 100));
    }
  });
});

describe('money is formatted from minor units', () => {
  test('never from a float euro', () => {
    expect(formatMinor(14900)).toContain('149.00');
    expect(formatMinor(JOB_FEATURE_PRICE_MINOR)).toContain('149.00');
    expect(formatMinor(0)).toContain('0.00');
  });
});
