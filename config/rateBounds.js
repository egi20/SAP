'use strict';

/**
 * What a contributed rate is allowed to be.
 *
 * A QA pass submitted 5 EUR/day for a senior FI consultant and the server took it. The
 * only bound was `isFloat({ min: 1, max: 1000000 })` — one range for both a day rate and
 * an annual salary, which are a factor of two hundred apart, so neither was bounded in any
 * useful sense. A figure that absurd does not announce itself: it lands in a bucket, the
 * bucket publishes at three contributors, and the percentile it moves is read by somebody
 * deciding what to ask for.
 *
 * The bounds live here rather than in the validator because the FORM has to state the same
 * ones. That is the other half of the same bug: the amount field carried `min="1"` with
 * `step="10"`, so the browser accepted 1, 11, 21 … and refused 600 and 1000 — the two most
 * likely figures anybody would type — with a message about the nearest valid values. Two
 * places describing one rule, disagreeing. `boundsFor()` is read by both.
 *
 * Declared in EUR and converted per currency through the same frozen `FX_TO_EUR` table the
 * submission itself is normalised with, so adding a currency needs no new bounds and a
 * bound can never be stated in one currency and enforced in another.
 */

const BOUNDS = Object.freeze({
  contract: Object.freeze({ minEur: 50, maxEur: 5000, label: 'a day rate' }),
  permanent: Object.freeze({ minEur: 12000, maxEur: 500000, label: 'an annual salary' })
});

const ENGAGEMENT_TYPES = Object.freeze(Object.keys(BOUNDS));

/**
 * Whole units, always.
 *
 * NOT a round `step="10"`: an HTML `step` is counted FROM `min`, so any step above 1
 * refuses legitimate figures — 605 with a floor of 50 and a step of 10 is rejected by the
 * browser before the form is ever posted. Nobody contributing a rate is helped by being
 * told their own day rate is not a valid number.
 */
const STEP = 1;

/** Is this a declared engagement type? */
function isEngagementType(value) {
  return Object.prototype.hasOwnProperty.call(BOUNDS, value);
}

/**
 * The bounds for one engagement type in one currency, as whole units.
 *
 * Returns null for an engagement type or currency that is not declared, so a caller that
 * has not validated those first cannot accidentally receive a permissive range.
 */
function boundsFor(engagementType, currency) {
  if (!isEngagementType(engagementType)) return null;
  // Required lazily: the model pulls in the database pool, and this config is read at boot.
  const { SUPPORTED_CURRENCIES, toEur } = require('../models/RateSubmission');
  if (!SUPPORTED_CURRENCIES.includes(currency)) return null;

  const { minEur, maxEur, label } = BOUNDS[engagementType];
  // toEur multiplies; the rate per unit of the target currency is its reciprocal.
  const perUnit = toEur(1, currency);
  if (!perUnit) return null;

  return {
    min: Math.max(1, Math.floor(minEur / perUnit)),
    max: Math.ceil(maxEur / perUnit),
    step: STEP,
    label
  };
}

/**
 * Every failure here produces a wrong number rather than an error, which is why it is
 * checked at boot with somebody watching the log: a floor of zero takes any figure, a
 * ceiling below the floor takes none and the form renders an impossible field, and two
 * ranges that overlap make a mis-picked engagement type unfalsifiable — the one mistake
 * on this form that a bound could otherwise catch for free.
 */
function assertRateBoundsIntegrity() {
  const problems = [];

  for (const [type, bound] of Object.entries(BOUNDS)) {
    const { minEur, maxEur, label } = bound;
    if (!Number.isInteger(minEur) || minEur <= 0) problems.push(`${type}: minEur must be a positive integer`);
    if (!Number.isInteger(maxEur) || maxEur <= 0) problems.push(`${type}: maxEur must be a positive integer`);
    if (minEur >= maxEur) problems.push(`${type}: minEur must be below maxEur`);
    if (!label) problems.push(`${type}: needs a label naming what the figure is`);
  }

  if (BOUNDS.contract.maxEur >= BOUNDS.permanent.minEur) {
    problems.push('contract and permanent ranges must not overlap, or a mis-picked engagement type cannot be refused');
  }

  if (problems.length) {
    throw new Error(`config/rateBounds.js integrity: ${problems.join('; ')}`);
  }
}

module.exports = { BOUNDS, ENGAGEMENT_TYPES, STEP, isEngagementType, boundsFor, assertRateBoundsIntegrity };
