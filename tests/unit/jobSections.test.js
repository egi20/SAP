'use strict';

/**
 * The advert's sections.
 *
 * Three new columns is three more places the text of one job lives, and that cost is only
 * worth paying if every reader of an advert's prose reads all four. The failure this file
 * exists to catch is silent in the worst way: an advert naming EWM only under
 * "Requirements" would score zero against an EWM consultant and appear in no search for
 * EWM, with nothing anywhere saying why.
 */

const { wholeWordPattern } = require('../../utils/likePattern');
const fs = require('fs');
const path = require('path');
const { SECTIONS, SECTION_KEYS, sectionText, assertJobSectionsIntegrity } = require('../../config/jobSections');
const Job = require('../../models/Job');
const { matchScore } = require('../../utils/jobMatcher');

const root = path.join(__dirname, '..', '..');

function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/<%#[\s\S]*?%>/g, '');
}

describe('config/jobSections.js', () => {
  it('asserts its own integrity', () => {
    expect(() => assertJobSectionsIntegrity()).not.toThrow();
  });

  it('is asserted at boot, like every other catalogue', () => {
    const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    expect(server).toContain('assertJobSectionsIntegrity()');
  });

  it('names columns that migration 021 actually adds', () => {
    const sql = fs.readFileSync(path.join(root, 'scripts', 'migrations', '021_job_sections.sql'), 'utf8');
    SECTION_KEYS.filter((key) => key !== 'description').forEach((key) => {
      expect(sql).toMatch(new RegExp(`ADD COLUMN ${key}\\b`));
    });
    // `description` predates this migration and is NOT added again.
    expect(sql).not.toMatch(/ADD COLUMN description\b/);
  });

  it('requires exactly one section, the advert body', () => {
    const required = SECTIONS.filter((s) => s.required);
    expect(required).toHaveLength(1);
    expect(required[0].key).toBe('description');
  });
});

describe('every reader of an advert reads every section', () => {
  /*
   * Both shapes of query: a phrase is a contains-LIKE, a module code is a whole-word
   * REGEXP (utils/likePattern.js) so "FI" does not find "specific". Either way every
   * section is searched, with one bound value per column.
   */
  it.each([
    ['warehouse', 'LIKE', '%warehouse%'],
    ['ewm', 'REGEXP', wholeWordPattern('ewm')]
  ])('the search clause for "%s" names all of them', (q, op) => {
    const { clause } = Job.buildFilter({ q });
    SECTION_KEYS.forEach((key) => expect(clause).toContain(`j.${key} ${op} ?`));
  });

  it.each([
    ['warehouse', 'LIKE', '%warehouse%'],
    ['ewm', 'REGEXP', wholeWordPattern('ewm')]
  ])('and binds one pattern per column it named for "%s"', (q, op, bound) => {
    const { clause, params } = Job.buildFilter({ q });
    const placeholders = (clause.match(new RegExp(`${op} \\?`, 'g')) || []).length;
    // Title plus every section. A mismatch here silently shifts every later parameter.
    expect(placeholders).toBe(SECTION_KEYS.length + 1);
    expect(params.filter((p) => p === bound)).toHaveLength(placeholders);
  });

  it('the matcher scores a role named only under Requirements', () => {
    const profile = { primary_role: 's4-ewm', years_experience: 8 };
    const inDescription = matchScore(
      { title: 'Consultant', description: 'An extended warehouse management rollout.', role: 'other' },
      profile,
      {}
    );
    const inRequirements = matchScore(
      { title: 'Consultant', description: 'A rollout.', requirements: 'An extended warehouse management background.', role: 'other' },
      profile,
      {}
    );
    // The point is not the exact figure; it is that the section counted at all.
    expect(inRequirements.score).toBe(inDescription.score);
    expect(inRequirements.score).toBeGreaterThan(
      matchScore({ title: 'Consultant', description: 'A rollout.', role: 'other' }, profile, {}).score
    );
  });

  it('`sectionText` tolerates a row that predates the columns', () => {
    // Every advert written before migration 021 has NULL in three of the four.
    expect(sectionText({ description: 'Only this.' })).toContain('Only this.');
    expect(sectionText(null)).toBe('');
  });
});

describe('the list is the only copy', () => {
  it('the form builds its boxes from it rather than naming them', () => {
    const form = withoutComments(fs.readFileSync(path.join(root, 'views', 'jobs', 'form.ejs'), 'utf8'));
    SECTION_KEYS.filter((key) => key !== 'description').forEach((key) => {
      // `name="requirements"` typed into the template is a box the search clause and the
      // match haystack would know nothing about.
      expect(form).not.toContain(`"${key}"`);
    });
    expect(form).toContain('sections.forEach');
  });

  it('the advert page renders from it too', () => {
    const show = withoutComments(fs.readFileSync(path.join(root, 'views', 'jobs', 'show.ejs'), 'utf8'));
    expect(show).toContain('sections.forEach');
    expect(show).not.toContain('job.requirements');
  });
});
