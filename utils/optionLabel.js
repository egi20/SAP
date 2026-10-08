'use strict';

const { SENIORITY_LEVELS } = require('../config/roleTaxonomy');

/**
 * The words a select shows for a stored value.
 *
 * Several selects rendered the stored value itself — "junior", "onsite", "simple",
 * "admin" — because the vocabulary is a list of slugs and the template printed the slug.
 * A value is a key for the database; a reader should see a label. This is the one place
 * that turns one into the other, so the job board, the directory and the rate index cannot
 * each capitalise "onsite" their own way.
 *
 * It renames nothing that is stored and changes no `value=""` attribute: only the text
 * between the option tags.
 */
const SENIORITY = new Map(SENIORITY_LEVELS.map((level) => [level.value, level.label]));

const WORDS = new Map(Object.entries({
  remote: 'Remote',
  hybrid: 'Hybrid',
  onsite: 'On-site',
  simple: 'Simple',
  medium: 'Medium',
  complex: 'Complex',
  admin: 'Admin',
  superadmin: 'Superadmin'
}));

function optionLabel(value) {
  const key = String(value ?? '');
  if (SENIORITY.has(key)) return SENIORITY.get(key);
  if (WORDS.has(key)) return WORDS.get(key);
  // Anything else: a slug made readable. "in_review" -> "In review".
  const words = key.replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

module.exports = { optionLabel };
