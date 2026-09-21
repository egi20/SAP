'use strict';

/**
 * The agency profile's pure parts: what a submitted form becomes, and what the publish
 * gate refuses.
 *
 * Both matter more than they look. The reference declares express-validator rules on the
 * profile route and never calls `validationResult`, so every one of them is decorative
 * and an unbounded agency name reaches the column. Here the coercion is a pure function
 * and these are the rules it is actually applying.
 */

const RecruiterProfile = require('../../models/RecruiterProfile');
const { PRODUCT_LINES } = require('../../config/sapProducts');

const { normaliseProfile, missingForPublish, LIMITS, REQUIRED_TO_PUBLISH, SPECIALISM_OPTIONS } =
  RecruiterProfile;

describe('specialisms speak the site vocabulary', () => {
  test('they are the product lines, generated rather than typed', () => {
    expect(SPECIALISM_OPTIONS.map((o) => o.value)).toEqual(PRODUCT_LINES.map((l) => l.value));
  });

  /*
   * Lines, not modules. An agency recruits for "S/4HANA Finance", not for "Revenue
   * Accounting (RAR / IFRS 15)" — at fifty-seven modules nobody fills the form in
   * honestly, and a half-answered filter is worse than a coarse one.
   */
  test('it is the eight lines, not the fifty-seven modules', () => {
    expect(SPECIALISM_OPTIONS.length).toBe(PRODUCT_LINES.length);
    expect(SPECIALISM_OPTIONS.length).toBeLessThan(15);
  });
});

describe('what a submitted form becomes', () => {
  const valid = { agency_name: 'SAP Talent GmbH' };

  test('an agency needs a name', () => {
    expect(() => normaliseProfile({ agency_name: ' ' })).toThrow(/name/i);
    expect(() => normaliseProfile({ agency_name: 'A' })).toThrow(/name/i);
    try {
      normaliseProfile({});
    } catch (err) {
      expect(err.code).toBe('AGENCY_NAME_REQUIRED');
    }
  });

  test('whitespace is collapsed and every field is bounded', () => {
    const out = normaliseProfile({
      agency_name: '  SAP   Talent  ',
      tagline: 'x'.repeat(5000),
      about: 'y'.repeat(50000),
      city: 'z'.repeat(500)
    });
    expect(out.agency_name).toBe('SAP Talent');
    expect(out.tagline).toHaveLength(LIMITS.tagline);
    expect(out.about).toHaveLength(LIMITS.about);
    expect(out.city).toHaveLength(LIMITS.city);
  });

  /*
   * The one this file exists for. `text(input.country, 2)` turns "DEU" into "DE" and
   * "AUT" into "AU" — Austria silently becomes Australia. A refusal is visible; a
   * truncation is wrong forever and says nothing.
   */
  test('a three-letter country is refused, never truncated to two', () => {
    expect(normaliseProfile({ ...valid, country: 'DEU' }).country).toBeNull();
    expect(normaliseProfile({ ...valid, country: 'AUT' }).country).toBeNull();
    expect(normaliseProfile({ ...valid, country: 'de' }).country).toBe('DE');
    expect(normaliseProfile({ ...valid, country: '' }).country).toBeNull();
    expect(normaliseProfile({ ...valid, country: '12' }).country).toBeNull();
  });

  test('a URL without a scheme is repaired rather than rejected', () => {
    // People type "example.com". Refusing that is a form nobody completes.
    expect(normaliseProfile({ ...valid, website: 'example.com' }).website).toBe('https://example.com/');
    expect(normaliseProfile({ ...valid, website: 'https://example.com/x' }).website).toBe('https://example.com/x');
  });

  test('a javascript: URL never survives', () => {
    // It would land in an href on a public page.
    expect(normaliseProfile({ ...valid, website: 'javascript:alert(1)' }).website).toBeNull();
    expect(normaliseProfile({ ...valid, linkedin_url: 'data:text/html,<script>' }).linkedin_url).toBeNull();
  });

  test('specialisms are validated against the catalogue, deduplicated and capped', () => {
    const line = PRODUCT_LINES[0].value;
    const out = normaliseProfile({
      ...valid,
      specialisms: [line, line, 'not-a-line', 'SAP Finance']
    });
    expect(out.specialisms).toEqual([line]);
  });

  test('one specialism posted as a bare string still works', () => {
    // A single checkbox posts a string, not an array.
    const line = PRODUCT_LINES[1].value;
    expect(normaliseProfile({ ...valid, specialisms: line }).specialisms).toEqual([line]);
  });

  test('empty optional fields become NULL, not empty strings', () => {
    const out = normaliseProfile(valid);
    for (const field of ['contact_name', 'tagline', 'about', 'phone', 'website', 'linkedin_url', 'city']) {
      expect(out[field]).toBeNull();
    }
  });
});

describe('the publish gate', () => {
  test('it names what is missing rather than saying "incomplete"', () => {
    // "Complete your profile" with no list is the message people bounce off.
    expect(missingForPublish({ agency_name: 'A', about: null, country: 'DE' })).toEqual(['about']);
    expect(missingForPublish({ agency_name: 'A', about: '  ', country: '' })).toEqual(['about', 'country']);
  });

  test('a full profile is allowed through', () => {
    expect(missingForPublish({ agency_name: 'A', about: 'We place SAP people.', country: 'DE' })).toEqual([]);
  });

  test('no profile at all is every field missing', () => {
    expect(missingForPublish(null)).toEqual([...REQUIRED_TO_PUBLISH]);
  });
});
