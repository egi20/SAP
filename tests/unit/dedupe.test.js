'use strict';

const { findDuplicates, normaliseName, MAX_LINES } = require('../../utils/dedupe');

describe('utils/dedupe', () => {
  it('groups lines with the same email, ignoring case and the rest of the line', () => {
    const result = findDuplicates(
      ['Anna Müller, anna.mueller@example.com', 'Muller, Anna <ANNA.MUELLER@example.com>', 'John Smith'].join('\n')
    );
    expect(result.total).toBe(3);
    expect(result.unique).toBe(2);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].reason).toBe('email');
    expect(result.groups[0].entries.map((e) => e.line)).toEqual([1, 2]);
  });

  it('matches a name written two ways when neither line has an address', () => {
    expect(normaliseName('Müller, Anna')).toBe(normaliseName('anna  MULLER'));
    const result = findDuplicates('Müller, Anna\nanna muller\n');
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].reason).toBe('name');
  });

  it('never merges two people who share a name but not an address', () => {
    const result = findDuplicates('John Smith, john@one.example\nJohn Smith, john@two.example');
    expect(result.groups).toHaveLength(0);
    expect(result.unique).toBe(2);
  });

  it('ignores blank lines and reports a list cut at the line limit', () => {
    expect(findDuplicates('\n\n  \n').total).toBe(0);
    const long = Array.from({ length: MAX_LINES + 5 }, (_, i) => `person${i}@example.com`).join('\n');
    const result = findDuplicates(long);
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(MAX_LINES);
  });
});

describe('the clean list', () => {
  it('keeps one line per person, as first written, in the order given', () => {
    const { findDuplicates } = require('../../utils/dedupe');
    const result = findDuplicates('Anna Müller, anna@example.com\nBob Jones\nMuller, Anna <ANNA@example.com>\n\nJones Bob');
    expect(result.clean).toEqual(['Anna Müller, anna@example.com', 'Bob Jones']);
    expect(result.clean).toHaveLength(result.unique);
  });
});

describe('DH Dedupe', () => {
  const { dedupeProblems, DH_DEDUPE } = require('../../config/dedupe');

  it('accepts no address at all — the card then has no button', () => {
    expect(dedupeProblems({ ...DH_DEDUPE, url: null })).toEqual([]);
  });

  it('refuses an address that is not https on dynamicshub.net', () => {
    expect(dedupeProblems({ ...DH_DEDUPE, url: 'https://dedupe.dynamicshub.net/' })).toEqual([]);
    expect(dedupeProblems({ ...DH_DEDUPE, url: 'http://dynamicshub.net/dedupe' }).join(' ')).toMatch(/https/);
    expect(dedupeProblems({ ...DH_DEDUPE, url: 'https://dynamicshub.net.evil.example/' }).join(' ')).toMatch(/dynamicshub\.net/);
    expect(dedupeProblems({ ...DH_DEDUPE, url: 'https://dynamicshub.net@evil.example/' }).length).toBeGreaterThan(0);
  });

  it('states no price — what another platform charges is that platform\'s to say', () => {
    expect(JSON.stringify(DH_DEDUPE)).not.toMatch(/€|\beur\b|price|\/month|lifetime/i);
  });
});
