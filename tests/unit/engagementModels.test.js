'use strict';

/**
 * The engagement model catalogue.
 *
 * It is three pages of prose, which is exactly why it is a config with an assertion: a
 * missing field renders as a blank bullet and a renamed slug renders the wrong heading —
 * neither raises anything, and both are read by a client before they are noticed here.
 */

const fs = require('fs');
const path = require('path');
const { ENGAGEMENT_MODELS, engagementModel, assertEngagementIntegrity } = require('../../config/engagementModels');

describe('integrity', () => {
  it('passes its own check', () => {
    expect(() => assertEngagementIntegrity()).not.toThrow();
  });

  it('has the three models the navigation and the hub page offer', () => {
    expect(ENGAGEMENT_MODELS.map((m) => m.slug).sort())
      .toEqual(['managed-services', 'project-based', 'staff-augmentation']);
  });

  it('names no price anywhere', () => {
    /*
     * config/payments.js is the only module that decides what anything costs. A figure
     * that drifted onto one of these pages would be a second answer about money, in front
     * of a client, with nothing reconciling the two.
     */
    expect(JSON.stringify(ENGAGEMENT_MODELS)).not.toMatch(/[€$£]\s?\d/);
  });

  it('says when each model is the wrong fit', () => {
    // A page that only lists benefits is a sales sheet. The caveat is the part a reader
    // cannot get anywhere else, so it is required rather than optional.
    ENGAGEMENT_MODELS.forEach((m) => {
      expect(m.watchOut.length).toBeGreaterThan(40);
    });
  });

  it('returns null for a slug it does not have', () => {
    expect(engagementModel('bodyshopping')).toBeNull();
    expect(engagementModel('__proto__')).toBeNull();
  });
});

describe('the routes are derived from it', () => {
  /*
   * The route list is built by iterating the catalogue. This asserts that nothing has since
   * written the slugs out again beside it — the second copy is the failure mode, and it is
   * silent: a model renamed in one place answers 404 from the link the other still renders.
   */
  it('routes/companies.js builds its paths from the catalogue, not from literals', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'companies.js'), 'utf8');
    expect(source).toContain('ENGAGEMENT_MODELS.forEach');
    ENGAGEMENT_MODELS.forEach((m) => {
      expect(source).not.toContain(`'/${m.slug}'`);
    });
  });
});
