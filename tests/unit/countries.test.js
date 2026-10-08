'use strict';

/*
 * The country list every select renders. Two hundred and fifty options opening on
 * Afghanistan, with Antarctica in the middle, asked somebody in Frankfurt to scroll past
 * the world to find the place where most SAP work is.
 */
const { COUNTRIES, SAP_MARKETS, UNINHABITED, assertCountriesIntegrity } = require('../../config/countries');
const ALL = require('../../config/all-countries.json');

describe('the dropdown country list', () => {
  it('passes its own check', () => {
    expect(assertCountriesIntegrity()).toBe(true);
  });

  it('opens on the SAP markets, in the declared order', () => {
    expect(COUNTRIES.slice(0, SAP_MARKETS.length).map((c) => c.code)).toEqual([...SAP_MARKETS]);
    expect(COUNTRIES.slice(0, SAP_MARKETS.length).every((c) => c.featured)).toBe(true);
  });

  it('leaves out territories nobody lives in, and nothing else', () => {
    const offered = new Set(COUNTRIES.map((c) => c.code));
    UNINHABITED.forEach((code) => expect(offered.has(code)).toBe(false));
    expect(COUNTRIES.length).toBe(ALL.length - UNINHABITED.length);
  });

  it('does not touch the full list utils/geo.js needs', () => {
    expect(ALL.some((c) => c.code === 'AQ')).toBe(true);
  });
});
