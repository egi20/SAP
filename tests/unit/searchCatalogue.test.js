'use strict';

/*
 * The search box's knowledge of SAP itself: which modules and roles a query names. It
 * reads config only, so it answers on an empty site — which is when "0 results for EWM"
 * did the most damage.
 */
const fs = require('fs');
const path = require('path');
const { matchCatalogue } = require('../../services/searchCatalogue');

const values = (list) => list.map((item) => item.value);

describe('matchCatalogue', () => {
  it('finds a module and its role from the module code', () => {
    const result = matchCatalogue('EWM');
    expect(values(result.modules)).toContain('ewm');
    expect(values(result.roles)).toContain('s4-ewm');
  });

  it('matches whole words, so a two-letter code does not find words that contain it', () => {
    // "FI" is inside "Fiori"; "MM" is inside "Commerce". Neither is a match.
    expect(values(matchCatalogue('fi').roles)).not.toContain('fiori-developer');
    expect(values(matchCatalogue('mm').modules)).not.toContain('cx-commerce');
  });

  it('finds the technical and industry modules a Basis or utilities consultant delivers', () => {
    expect(values(matchCatalogue('basis').modules)).toContain('basis');
    expect(values(matchCatalogue('IS-U').modules)).toContain('is-u');
  });

  it('links a rate page only for a role the SAP rate index covers', () => {
    const recruiter = matchCatalogue('recruiter').roles.find((r) => r.value === 'recruiter');
    expect(recruiter.ratesHref).toBeNull();
    const ewm = matchCatalogue('EWM').roles.find((r) => r.value === 's4-ewm');
    expect(ewm.ratesHref).toBe('/rates/s4-ewm');
  });

  it('answers nothing for a query too short to mean anything', () => {
    expect(matchCatalogue('a')).toEqual({ modules: [], roles: [], lines: [] });
  });

  it('reads config and nothing else', () => {
    // Directions, not results: no SQL, no model, nothing that could reveal a listing.
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'services', 'searchCatalogue.js'), 'utf8');
    expect(source).not.toMatch(/require\(['"]\.\.\/models\//);
    expect(source).not.toMatch(/\bSELECT\b/);
  });
});
