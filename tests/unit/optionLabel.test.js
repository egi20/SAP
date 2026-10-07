'use strict';

/*
 * Selects used to print the stored slug — "junior", "onsite", "simple", "admin". This pins
 * the label a reader sees, and that the stored value is never what gets shown.
 */
const { optionLabel } = require('../../utils/optionLabel');
const { SENIORITY_LEVELS } = require('../../config/roleTaxonomy');

describe('optionLabel', () => {
  it('shows seniority with its band, from the taxonomy', () => {
    SENIORITY_LEVELS.forEach((level) => expect(optionLabel(level.value)).toBe(level.label));
  });

  it('names the work modes properly', () => {
    expect(optionLabel('remote')).toBe('Remote');
    expect(optionLabel('onsite')).toBe('On-site');
  });

  it('makes any other slug readable rather than printing it raw', () => {
    expect(optionLabel('in_review')).toBe('In review');
    expect(optionLabel('shortlisted')).toBe('Shortlisted');
    expect(optionLabel('')).toBe('');
    expect(optionLabel(null)).toBe('');
  });
});
