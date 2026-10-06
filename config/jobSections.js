'use strict';

/**
 * The advert's prose, in the order it is written and read.
 *
 * `jobs.description` was the whole advert in one box. These are the three sections every
 * job board asks for separately, and they are OPTIONAL — an advert that says everything
 * in the description is still a complete advert, and a heading with nothing under it
 * reads as an employer who could not be bothered.
 *
 * THE LIST IS THE POINT, and it is here rather than in the model because
 * `utils/jobMatcher.js` needs it too and a util must not reach into a model. The form
 * builds its boxes from it, the advert's page renders from it, `Job.buildFilter`
 * assembles the search clause from it, and the matcher builds its haystack from it. A
 * section added here is searchable and matchable the same day.
 *
 * A section added to the schema and the form alone is the silent failure this list
 * exists to prevent: an advert naming EWM only under "Requirements" would score zero
 * against an EWM consultant, appear in no search for "EWM", and nothing anywhere would
 * say why.
 */
const SECTIONS = Object.freeze([
  Object.freeze({
    key: 'description',
    label: 'About the role',
    required: true,
    rows: 10,
    help: 'What the engagement is and what it is for.'
  }),
  Object.freeze({
    key: 'responsibilities',
    label: 'Responsibilities',
    required: false,
    rows: 6,
    help: 'What this person will actually do. One line each reads best.'
  }),
  Object.freeze({
    key: 'requirements',
    label: 'Requirements',
    required: false,
    rows: 6,
    help: 'Modules, certifications and experience. Say which are essential.'
  }),
  Object.freeze({
    key: 'what_we_offer',
    label: 'What we offer',
    required: false,
    rows: 6,
    help: 'Rate aside — the team, the programme, how the work is done.'
  })
]);

/** Just the column names, which is what the model, the filter and the matcher want. */
const SECTION_KEYS = Object.freeze(SECTIONS.map((s) => s.key));

/**
 * The advert's prose as one string, for anything that reads an advert for words.
 *
 * The matcher and the CV targeting both need "everything the advert says", and both of
 * them read it through here, so neither can be left behind when the list changes.
 */
function sectionText(job) {
  if (!job) return '';
  return SECTION_KEYS.map((key) => job[key] || '').join(' ');
}

/**
 * Asserted at boot, like every other catalogue, because each failure here produces WRONG
 * OUTPUT rather than an error: a key that is not a real column silently contributes an
 * empty string to every haystack and every search, so matching gets quietly worse and no
 * page breaks.
 */
function assertJobSectionsIntegrity() {
  const problems = [];
  const seen = new Set();

  if (!SECTIONS.length) problems.push('No advert sections are declared.');
  if (SECTIONS[0].key !== 'description') {
    problems.push('The first section must be `description`: it is the one the schema requires.');
  }

  SECTIONS.forEach((section) => {
    if (!/^[a-z][a-z_]*$/.test(section.key)) {
      problems.push(`Section key "${section.key}" is not a column name.`);
    }
    if (seen.has(section.key)) problems.push(`Section "${section.key}" is declared twice.`);
    seen.add(section.key);
    if (!section.label) problems.push(`Section "${section.key}" has no label.`);
    // Every box on a form that is not self-evident needs a line saying what goes in it,
    // or it is answered with whatever the person guessed it meant.
    if (!section.help) problems.push(`Section "${section.key}" has no help text.`);
  });

  const required = SECTIONS.filter((s) => s.required);
  if (required.length !== 1) {
    problems.push('Exactly one section is required — the advert needs a body and nothing more.');
  }

  if (problems.length) {
    throw new Error(`config/jobSections.js is inconsistent:\n  - ${problems.join('\n  - ')}`);
  }
}

module.exports = { SECTIONS, SECTION_KEYS, sectionText, assertJobSectionsIntegrity };
