'use strict';

const ALL = require('./all-countries.json');

/**
 * The country list every select on the site offers, in the order a reader wants it.
 *
 * `all-countries.json` is the full ISO list and stays that way — `utils/geo.js` needs every
 * code to name wherever a request came from. A dropdown does not: two hundred and fifty
 * options opening on Afghanistan and Åland, with Antarctica and Heard & McDonald Islands in
 * the middle, ask somebody in Frankfurt to scroll past the world to find the place where
 * most SAP work is.
 *
 * So the markets where SAP contract work concentrates come first, in their own group, and
 * territories nobody lives in are left out. Leaving one out removes an option; it changes
 * no stored value, and a row that somehow carries one of these codes still renders its
 * name through `utils/geo.js`.
 */
const SAP_MARKETS = Object.freeze([
  'DE', 'CH', 'AT', 'GB', 'NL', 'BE', 'FR', 'IE', 'DK', 'SE', 'NO', 'PL', 'ES', 'IT',
  'US', 'CA', 'IN', 'AE', 'SG', 'AU'
]);

/** No permanent population: nobody hires there and nobody works there. */
const UNINHABITED = Object.freeze(['AQ', 'BV', 'HM', 'GS', 'TF', 'UM']);

const BY_CODE = new Map(ALL.map((c) => [c.code, c]));

const COUNTRIES = Object.freeze([
  ...SAP_MARKETS.map((code) => ({ ...BY_CODE.get(code), featured: true })),
  ...ALL
    .filter((c) => !SAP_MARKETS.includes(c.code) && !UNINHABITED.includes(c.code))
    .map((c) => ({ ...c, featured: false }))
]);

function assertCountriesIntegrity() {
  const problems = [];
  SAP_MARKETS.forEach((code) => {
    if (!BY_CODE.has(code)) problems.push(`SAP market ${code} is not in all-countries.json`);
  });
  const codes = COUNTRIES.map((c) => c.code);
  if (new Set(codes).size !== codes.length) problems.push('a country appears twice in the dropdown list');
  if (problems.length) throw new Error(`Country list is inconsistent:\n  - ${problems.join('\n  - ')}`);
  return true;
}

module.exports = { COUNTRIES, SAP_MARKETS, UNINHABITED, assertCountriesIntegrity };
