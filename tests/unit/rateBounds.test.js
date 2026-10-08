'use strict';

/**
 * The bounds a contributed rate has to fall inside.
 *
 * Two bugs met here and they were the same bug: the server took any figure from 1 to a
 * million for both a day rate and an annual salary, so 5 EUR/day was stored for a senior
 * consultant; and the form's own `min="1" step="10"` refused 600 and 1000 while accepting
 * 611. One rule, described in two places, neither of them right.
 */

const fs = require('fs');
const path = require('path');
const {
  BOUNDS, ENGAGEMENT_TYPES, STEP, isEngagementType, boundsFor, assertRateBoundsIntegrity
} = require('../../config/rateBounds');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');

describe('the catalogue', () => {
  it('passes its own integrity check', () => {
    expect(() => assertRateBoundsIntegrity()).not.toThrow();
  });

  it('declares both engagement types the submission form offers', () => {
    // Copied before sorting: the catalogue is frozen, and sort mutates in place.
    expect([...ENGAGEMENT_TYPES].sort()).toEqual(['contract', 'permanent']);
    expect(isEngagementType('contract')).toBe(true);
    expect(isEngagementType('permanent')).toBe(true);
    expect(isEngagementType('__proto__')).toBe(false);
  });

  it('keeps the two ranges apart', () => {
    // Overlapping ranges make a mis-picked engagement type impossible to refuse.
    expect(BOUNDS.contract.maxEur).toBeLessThan(BOUNDS.permanent.minEur);
  });
});

describe('boundsFor', () => {
  it('returns the declared range unchanged in EUR', () => {
    expect(boundsFor('contract', 'EUR')).toMatchObject({ min: 50, max: 5000 });
    expect(boundsFor('permanent', 'EUR')).toMatchObject({ min: 12000, max: 500000 });
  });

  it('converts into the currency the figure is given in', () => {
    // ALL is worth about a hundredth of a euro, so the same floor is a much larger number.
    const all = boundsFor('contract', 'ALL');
    expect(all.min).toBeGreaterThan(boundsFor('contract', 'EUR').min * 50);
  });

  it('refuses rather than widens when it is asked about something undeclared', () => {
    // A caller that has not validated these must not receive a permissive range.
    expect(boundsFor('freelance', 'EUR')).toBeNull();
    expect(boundsFor('contract', 'XXX')).toBeNull();
    expect(boundsFor(undefined, undefined)).toBeNull();
  });

  it('rejects the figure that was actually stored, and accepts the round ones', () => {
    const { min, max } = boundsFor('contract', 'EUR');
    expect(5).toBeLessThan(min);
    expect(99999999).toBeGreaterThan(max);
    [600, 1000, 605].forEach((amount) => {
      expect(amount).toBeGreaterThanOrEqual(min);
      expect(amount).toBeLessThanOrEqual(max);
    });
  });
});

describe('the form states the rule the server enforces', () => {
  const view = read('views/rates/submit.ejs');

  it('steps in whole units', () => {
    /*
     * An HTML `step` counts FROM `min`, so anything above 1 refuses legitimate figures —
     * which is the complaint that started this: "the two nearest valid values are 601 and
     * 611" for somebody typing their own day rate.
     */
    expect(STEP).toBe(1);
    expect(view).toContain('step="<%= amountStep %>"');
    expect(view).not.toMatch(/name="amount"[^>]*step="10"/);
  });

  it('carries no min or max attribute on the amount, because the real bound is not fixed', () => {
    // It depends on the engagement type AND the currency, which are two other controls.
    const field = view.slice(view.indexOf('id="amount"'), view.indexOf('id="amount"') + 400);
    expect(field).not.toMatch(/\bmin="/);
    expect(field).not.toMatch(/\bmax="/);
  });
});

describe('the route reads the catalogue rather than repeating it', () => {
  const route = read('routes/rates.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('has no hand-written amount range left in it', () => {
    // The literal this replaced. Comments are stripped first: a test that greps for a
    // forbidden string also matches the sentence explaining why it is forbidden.
    expect(route).not.toContain('min: 1, max: 1000000');
    expect(route).toContain('boundsFor(');
  });
});
