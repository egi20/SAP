'use strict';

/**
 * The parts of search that are decidable without a database.
 *
 * The important one is the LAST describe: every source must be a call into a model's own
 * `browse`, because that is what makes visibility somebody else's problem. A search page
 * that assembled its own WHERE clause would be a second place that has to remember
 * `status = 'open'`, `is_public = 1` and `hidden_at IS NULL`, and the first one to forget
 * is the one that leaks.
 */

const {
  SOURCES,
  MIN_QUERY_LENGTH,
  normaliseQuery,
  isUsableQuery,
  searchEverything
} = require('../../services/search');

describe('the query is normalised before it becomes a LIKE pattern', () => {
  test('whitespace is collapsed, so two spellings are one query', () => {
    expect(normaliseQuery('  s/4hana   finance  ')).toBe('s/4hana finance');
  });

  test('it is bounded', () => {
    // A LIKE pattern built from a kilobyte of pasted text helps nobody.
    expect(normaliseQuery('x'.repeat(5000))).toHaveLength(120);
  });

  test('nothing at all is an empty string, never a crash', () => {
    expect(normaliseQuery(null)).toBe('');
    expect(normaliseQuery(undefined)).toBe('');
    expect(normaliseQuery(12)).toBe('12');
  });

  /*
   * Two characters, and on this site that is not an arbitrary floor: SAP module codes ARE
   * two letters — FI, CO, MM, SD, PP, QM — so "MM" is one of the most obvious searches
   * anybody would type, and a minimum of three would refuse it.
   */
  test('a two-letter module code is a usable query', () => {
    expect(MIN_QUERY_LENGTH).toBe(2);
    for (const code of ['MM', 'FI', 'CO', 'SD', 'PP', 'QM']) {
      expect(isUsableQuery(normaliseQuery(code))).toBe(true);
    }
  });

  test('one character is refused rather than answered slowly', () => {
    expect(isUsableQuery('a')).toBe(false);
    expect(isUsableQuery('')).toBe(false);
  });
});

describe('a query too short is answered without touching the database', () => {
  test('it reports itself unusable and searches nothing', async () => {
    const results = await searchEverything('a');
    expect(results.usable).toBe(false);
    expect(results.groups).toEqual([]);
    expect(results.total).toBe(0);
    expect(results.minLength).toBe(MIN_QUERY_LENGTH);
  });

  test('an empty query is the same, and keeps the box empty', async () => {
    const results = await searchEverything('   ');
    expect(results.usable).toBe(false);
    expect(results.query).toBe('');
  });
});

describe('the sources', () => {
  test('each declares everything the page needs to render it', () => {
    for (const source of SOURCES) {
      expect(typeof source.key).toBe('string');
      expect(typeof source.label).toBe('string');
      expect(typeof source.icon).toBe('string');
      expect(typeof source.empty).toBe('string');
      expect(typeof source.search).toBe('function');
      expect(typeof source.href).toBe('function');
    }
  });

  test('"see all" goes to that list page with the same query', () => {
    // The number promised beside the link is the number that page will deliver, because
    // both came from the same call with the same filter.
    const q = 'S/4HANA & EWM';
    for (const source of SOURCES) {
      const href = source.href(q);
      expect(href).toContain(`q=${encodeURIComponent(q)}`);
      expect(href.startsWith('/')).toBe(true);
    }
  });

  test('the keys are unique, so no group can overwrite another', () => {
    const keys = SOURCES.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  /*
   * The rule of the whole file, asserted rather than trusted: a source must call a model's
   * own browse and must not build SQL. Reading the function source is crude and it is
   * exactly the check that matters — the day somebody writes a query here to make one
   * result "better", this fails.
   */
  test('no source writes SQL of its own', () => {
    for (const source of SOURCES) {
      const body = source.search.toString();
      expect(body).toMatch(/\.browse\(/);
      expect(body).not.toMatch(/SELECT|WHERE|JOIN|promisePool/i);
    }
  });

  test('every source passes the query as a filter, never as an option', () => {
    for (const source of SOURCES) {
      // `{ q }` goes into the FILTER argument, which is what the builder validates and
      // escapes. Sliding it into the options object would bypass that entirely.
      expect(source.search.toString()).toMatch(/browse\(\s*\{\s*q\s*\}/);
    }
  });
});
