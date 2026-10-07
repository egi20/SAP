'use strict';

/*
 * Search text into SQL. The whole-word half exists because a module code is the query
 * this site gets most, and "contains FI" finds "specific" in every SAP advert there is.
 */
const { containsPattern, wholeWordPattern, textSearchClause } = require('../../utils/likePattern');

const asJsRegExp = (pattern) => new RegExp(pattern, 'i');

describe('wholeWordPattern', () => {
  it('matches a module code as a word, and not inside another word', () => {
    const fi = asJsRegExp(wholeWordPattern('FI'));
    expect(fi.test('Senior FI/CO consultant')).toBe(true);
    expect(fi.test('fi consultant')).toBe(true);
    expect(fi.test('A specific configuration in Fiori')).toBe(false);

    const mm = asJsRegExp(wholeWordPattern('MM'));
    expect(mm.test('MM and SD')).toBe(true);
    expect(mm.test('We are committed to communication')).toBe(false);
  });

  it('applies only to short alphanumeric codes', () => {
    expect(wholeWordPattern('EWM')).not.toBeNull();
    expect(wholeWordPattern('BW4')).not.toBeNull();
    expect(wholeWordPattern('a')).toBeNull();
    expect(wholeWordPattern('S/4HANA')).toBeNull();
    expect(wholeWordPattern('finance')).toBeNull();
    expect(wholeWordPattern('50%')).toBeNull();
  });
});

describe('textSearchClause', () => {
  it('uses REGEXP for a code and binds the same value to every column', () => {
    const { clause, params } = textSearchClause(['a.x', 'a.y'], 'EWM');
    expect(clause).toBe('(a.x REGEXP ? OR a.y REGEXP ?)');
    expect(params).toEqual([wholeWordPattern('EWM'), wholeWordPattern('EWM')]);
  });

  it('keeps an escaped LIKE for anything else', () => {
    const { clause, params } = textSearchClause(['a.x'], '50%');
    expect(clause).toBe('(a.x LIKE ?)');
    expect(params).toEqual([containsPattern('50%')]);
    expect(params[0]).toBe('%50\\%%');
  });

  it('never puts the value into the SQL text', () => {
    expect(textSearchClause(['a.x'], 'EWM').clause).not.toContain('EWM');
    expect(textSearchClause(['a.x'], 'warehouse').clause).not.toContain('warehouse');
  });
});
