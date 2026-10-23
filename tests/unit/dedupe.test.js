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
    expect(normaliseName('Müller, Anna')).toBe(normaliseName('anna  MUELLER'));
    const result = findDuplicates('Müller, Anna\nanna mueller\n');
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].reason).toBe('name');
    // Shown as written, never as its key.
    expect(result.groups[0].label).toBe('Müller, Anna');
  });

  it('folds German spelling — ü/ue, ö/oe, ä/ae, ß/ss — but never ue back to u', () => {
    expect(normaliseName('Jürgen Größe')).toBe(normaliseName('Juergen Groesse'));
    expect(normaliseName('Bär')).toBe(normaliseName('Baer'));
    // "Michael" and "Michal" must not become one exact key.
    expect(normaliseName('Michael')).not.toBe(normaliseName('Michal'));
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

describe('possible matches', () => {
  const { jaroWinkler, csvCell, POSSIBLE_THRESHOLD } = require('../../utils/dedupe');

  it('flags a name without an email beside the same name with one, and merges nothing', () => {
    const r = findDuplicates('John Smith\nJohn Smith, john@a.example');
    expect(r.groups).toHaveLength(0);
    expect(r.unique).toBe(2);
    expect(r.possible).toHaveLength(1);
    expect(r.possible[0].reason).toBe('same-name-one-email');
    expect(r.possible[0].entries.map((e) => e.line)).toEqual([1, 2]);
    expect(r.possible[0].a.email).toBe('john@a.example');
    expect(r.clean).toHaveLength(2);
  });

  it('flags a typo and Muller/Mueller as PAIRS, never joining two different addresses', () => {
    expect(jaroWinkler('john smith', 'jon smith')).toBeGreaterThanOrEqual(POSSIBLE_THRESHOLD);
    const r = findDuplicates('Anna Müller, anna@x.example\nAnna Muller\nJohn Smith\nJon Smith\nJohn Smith, js@x.example\nJohn Smith, other@x.example');
    const pairs = r.possible.map((p) => [p.a.entries[0].line, p.b.entries[0].line]);
    expect(pairs).toEqual(expect.arrayContaining([[2, 1], [4, 3], [5, 3], [6, 3], [5, 4], [6, 4]]));
    // Lines 5 and 6 have different addresses: no box ever holds both.
    r.possible.forEach((p) => {
      const lines = p.entries.map((e) => e.line);
      expect(lines.includes(5) && lines.includes(6)).toBe(false);
    });
  });

  it('counts the blank lines between entries, and strips quotes wrapping a name', () => {
    const r = findDuplicates('Anna One\n\n"O\'Brien, Pat" pat@x.example\n');
    expect(r).toMatchObject({ total: 2, blank: 1 });
    expect(r.csv.split('\r\n')[2]).toBe('"O\'Brien, Pat",pat@x.example');
  });

  it('does not flag two different addresses, nor two unrelated names', () => {
    const r = findDuplicates('John Smith, a@x.example\nJohn Smith, b@x.example\nMaria Rossi\nPeter Brown');
    expect(r.possible).toHaveLength(0);
  });

  it('stays fast on a full list', () => {
    const list = Array.from({ length: 2000 }, (_, i) => `Person${i} Acme`).join('\n');
    const started = Date.now();
    findDuplicates(list);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('writes a CSV a spreadsheet will not run as a formula', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('Smith, John')).toBe('"Smith, John"');
    const r = findDuplicates('Anna Müller, anna@x.example\nBob Lee');
    expect(r.csv.split('\r\n')).toEqual(['name,email', 'Anna Müller,anna@x.example', 'Bob Lee,']);
  });
});
