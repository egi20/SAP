'use strict';

/**
 * The CV builder, which is pure so that the one thing that matters about it is testable:
 * it invents nothing.
 */

const { buildCv, cvGaps } = require('../../utils/cvData');

const PROFILE = {
  name: 'Ana Pjetri',
  headline: 'S/4HANA FI/CO consultant',
  primary_role: 's4-fi',
  seniority: 'lead',
  city: 'Munich',
  country: 'DE',
  years_experience: 12,
  full_lifecycles: 0,
  bio: '<p>Finance core on <strong>S/4HANA</strong>.</p>',
  day_rate: 1100,
  currency: 'EUR',
  email: 'ana@example.test',
  linkedin_url: 'https://www.linkedin.com/in/ana'
};

const PROJECTS = [
  { name: 'Newer FI job', client: 'Client A', modules: ['fi-gl'], started_on: new Date('2024-01-01'), ended_on: new Date('2025-01-01'), is_full_lifecycle: 1, activate_phase: 'realize', description: '<b>Did</b> things.' },
  { name: 'Older EWM job', client: 'Client B', modules: ['ewm'], started_on: new Date('2022-01-01'), ended_on: new Date('2022-06-01') }
];

const base = (extra = {}) => buildCv({
  profile: PROFILE,
  skills: [{ name: 'New GL' }],
  certifications: [{ label: 'SAP Certified — Financial Accounting', earned_on: new Date('2024-05-01') }],
  experiences: [{ title: 'Freelance', company: 'Independent', started_on: new Date('2018-04-01'), is_current: 1 }],
  projects: PROJECTS,
  ...extra
});

describe('it reads the profile and nothing else', () => {
  it('turns rich text into plain text', () => {
    // A DOCX paragraph is not a place to render markup.
    expect(base().about).toBe('Finance core on S/4HANA.');
    expect(base().engagements[0].description).toBe('Did things.');
  });

  it('keeps zero full lifecycles', () => {
    // `||` would drop it for exactly the people who did not round up.
    expect(base().fullLifecycles).toBe(0);
  });

  it('refuses to be built without a profile', () => {
    expect(() => buildCv({ profile: null })).toThrow();
  });
});

describe('the two things that are off by default', () => {
  it('leaves out the rate and the contact details unless asked', () => {
    /*
     * A CV travels further than the person who wrote it expects, and a day rate on one
     * that reaches a procurement team is a negotiating position given away before the
     * conversation starts.
     */
    const cv = base();
    expect(cv.rate).toBeNull();
    expect(cv.contact).toBeNull();
    expect(JSON.stringify(cv)).not.toContain('ana@example.test');
    expect(JSON.stringify(cv)).not.toContain('1100');
  });

  it('includes them when asked', () => {
    const cv = buildCv({
      profile: PROFILE, skills: [], certifications: [], experiences: [], projects: []
    }, { includeRate: true, includeContact: true });
    expect(cv.rate).toEqual({ amount: 1100, currency: 'EUR' });
    expect(cv.contact.email).toBe('ana@example.test');
  });
});

describe('targeting', () => {
  it('reorders the engagements and marks the matching ones', () => {
    const cv = base({ job: { title: 'EWM role', modules: ['ewm'] } });
    expect(cv.engagements.map((e) => e.name)).toEqual(['Older EWM job', 'Newer FI job']);
    expect(cv.engagements[0].matchedModules.length).toBeGreaterThan(0);
    expect(cv.engagements[1].matchedModules).toEqual([]);
  });

  it('rewords nothing', () => {
    /*
     * The only honest thing "tailored to this role" can mean without a person doing the
     * tailoring. Every string on a targeted CV is also on the untargeted one.
     */
    const plain = base();
    const aimed = base({ job: { title: 'EWM role', modules: ['ewm'] } });

    const descriptions = (cv) => cv.engagements.map((e) => e.description).sort();
    expect(descriptions(aimed)).toEqual(descriptions(plain));
    expect(aimed.about).toBe(plain.about);
    expect(aimed.headline).toBe(plain.headline);
  });

  it('keeps the profile\'s own order when nothing is targeted', () => {
    expect(base().engagements.map((e) => e.name)).toEqual(['Newer FI job', 'Older EWM job']);
  });

  it('says on the document which advert it was ordered against', () => {
    // A CV is forwarded, and the reader three hops along has no idea — without this,
    // "Relevant here" is a claim with no subject.
    const cv = base({ job: { title: 'EWM role', company_name: 'Acme', modules: ['ewm'] } });
    const { moduleLabel } = require('../../config/sapProducts');
    // The label comes from the catalogue, not from a literal here: writing it out would be
    // the second copy of a vocabulary config owns, and it would drift the day it is renamed.
    expect(cv.targetedAt).toEqual({ title: 'EWM role', company: 'Acme', modules: [moduleLabel('ewm')] });
  });
});

describe('cvGaps', () => {
  it('names what is missing rather than scoring it', () => {
    // "Your CV is 60% complete" tells somebody nothing they can act on.
    const empty = buildCv({ profile: { name: 'Nobody' } });
    const gaps = cvGaps(empty);
    expect(gaps.join(' ')).toContain('headline');
    expect(gaps.join(' ')).toContain('delivery history');
    expect(gaps.every((g) => !/%/.test(g))).toBe(true);
  });

  it('is empty for a filled-in profile', () => {
    expect(cvGaps(base())).toEqual([]);
  });
});
