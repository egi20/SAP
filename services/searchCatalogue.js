'use strict';

const { ALL_MODULES, PRODUCT_LINES } = require('../config/sapProducts');
const { ROLE_CATEGORIES, ROLE_ALIASES, isRateRole } = require('../config/roleTaxonomy');
const { containsWord } = require('../utils/jobMatcher');

/**
 * What the search box knows about SAP before anybody has posted anything.
 *
 * `services/search.js` looks in the LISTINGS — adverts, profiles, companies, posts — and
 * on a young site every one of those can be empty. Searching "EWM" then answered "0
 * results", from a site whose module filter, role taxonomy and rate index all have EWM in
 * them. That reads as a site that does not know what EWM is, which is the one impression
 * an SAP marketplace cannot afford.
 *
 * So this answers the other question: which modules and roles does the query NAME, and
 * where on the site are they — the job board filtered to the module, the directory
 * filtered to it, the rate page for the role. It reads the config catalogues and nothing
 * else: no SQL, no listing, nothing that could show a row its own list page would not.
 * It is kept out of `search.js`'s SOURCES on purpose, because those are counted into the
 * result total and these are not results, they are directions.
 *
 * Matching is WHOLE-WORD, through the matcher's own `containsWord`, for the reason that
 * function documents: "FI" must not find "Fiori", and "MM" must not find "Commerce".
 */
const MODULE_LIMIT = 8;
const ROLE_LIMIT = 6;

function moduleHaystack(module) {
  return `${module.label} ${module.value.replace(/-/g, ' ')}`;
}

function matchCatalogue(rawQuery) {
  const q = String(rawQuery ?? '').replace(/\s+/g, ' ').trim();
  if (q.length < 2) return { modules: [], roles: [], lines: [] };
  const lower = q.toLowerCase();

  const lines = PRODUCT_LINES
    .filter((line) => containsWord(line.label, q))
    .map((line) => ({ value: line.value, label: line.label }));
  const lineValues = new Set(lines.map((l) => l.value));

  const modules = ALL_MODULES
    // A query that names a whole product line ("SuccessFactors") lists the line, not its
    // every module; a query that names a module lists the module.
    .filter((m) => !lineValues.has(m.line) && containsWord(moduleHaystack(m), q))
    .slice(0, MODULE_LIMIT)
    .map((m) => ({
      value: m.value,
      label: m.label,
      lineLabel: m.lineLabel,
      jobsHref: `/jobs?modules=${encodeURIComponent(m.value)}`,
      consultantsHref: `/consultants?modules=${encodeURIComponent(m.value)}`
    }));

  const roles = ROLE_CATEGORIES
    .flatMap((category) => category.roles.map((role) => ({ ...role, category: category.category })))
    .filter((role) => containsWord(role.label, q) || (ROLE_ALIASES[role.value] || []).includes(lower))
    .slice(0, ROLE_LIMIT)
    .map((role) => ({
      value: role.value,
      label: role.label,
      category: role.category,
      jobsHref: `/jobs?role=${encodeURIComponent(role.value)}`,
      consultantsHref: `/consultants?role=${encodeURIComponent(role.value)}`,
      ratesHref: isRateRole(role.value) ? `/rates/${encodeURIComponent(role.value)}` : null
    }));

  return { modules, roles, lines };
}

module.exports = { matchCatalogue, MODULE_LIMIT, ROLE_LIMIT };
