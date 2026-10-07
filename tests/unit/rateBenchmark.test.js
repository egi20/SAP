'use strict';

/**
 * The editorial day-rate model.
 *
 * Same argument as the estimator's unit tests: the function is pure so that its invariants
 * are testable, and the invariants are the product. A benchmark is a number somebody takes
 * into a negotiation, so the failure that matters is not a crash — it is a figure that
 * quietly stops matching the working printed beside it.
 */

const { benchmark, benchmarkProblems, curatedTable, normaliseInput } = require('../../utils/rateBenchmark');
const model = require('../../config/rateBenchmark');
const { BASE_DAY_RATES, RATE_ROLE_SLUGS: ROLE_SLUGS } = require('../../config/roleTaxonomy');

describe('the model asserts itself', () => {
  it('passes its own integrity check', () => {
    expect(() => model.assertBenchmarkIntegrity()).not.toThrow();
  });

  it('claims no country for two regions', () => {
    const seen = new Map();
    model.REGIONS.forEach((region) => {
      region.countries.forEach((code) => {
        expect(seen.has(code)).toBe(false);
        seen.set(code, region.key);
      });
    });
  });
});

describe('the anchor', () => {
  /*
   * The one case anybody can check by hand. A model whose "no adjustments" answer is not
   * its own published base rate has a constant hidden in it, and every figure on the site
   * is wrong by that constant without a single test failing.
   */
  it.each(ROLE_SLUGS)('%s at the anchor returns its base rate exactly', (role) => {
    const result = benchmark({
      role,
      years: 6,
      certifications: 0,
      region: model.DEFAULT_REGION,
      workMode: 'hybrid',
      contractType: 'time-and-materials'
    });
    expect(result.recommended).toBe(BASE_DAY_RATES[role]);
    expect(result.factors.every((f) => f.multiplier === 1)).toBe(true);
  });
});

describe('benchmark()', () => {
  const sample = () => benchmark({
    role: 's4-ewm', years: 12, certifications: 3, country: 'DE',
    workMode: 'onsite', contractType: 'fixed-price'
  });

  it('reconciles: the factors reproduce the figure', () => {
    expect(benchmarkProblems(sample())).toEqual([]);
  });

  it('brackets the recommended rate', () => {
    const r = sample();
    expect(r.min).toBeLessThan(r.recommended);
    expect(r.recommended).toBeLessThan(r.max);
  });

  it('derives the monthly and annual figures from stated divisors', () => {
    const r = sample();
    expect(r.monthly).toBe(r.recommended * r.assumptions.daysPerMonth);
    expect(r.annual).toBe(r.recommended * r.assumptions.daysPerYear);
  });

  it('keeps the equivalent salary below annual billings', () => {
    // It answers "what does a comparable permanent role cost an employer", which is lower
    // than the billings because holiday, sickness and the gaps between projects are paid.
    const r = sample();
    expect(r.equivalentSalary).toBeLessThan(r.annual);
  });

  it('returns null for a role it does not publish, rather than a fallback figure', () => {
    expect(benchmark({ role: 'not-a-role', years: 6 })).toBeNull();
    expect(benchmark({})).toBeNull();
  });

  it('is monotonic in experience', () => {
    const rates = [0, 4, 7, 12, 20].map((years) => benchmark({ role: 's4-fi', years }).recommended);
    rates.slice(1).forEach((rate, i) => expect(rate).toBeGreaterThan(rates[i]));
  });

  it('maps a country to its region, and an unknown one to the reference region', () => {
    expect(benchmark({ role: 's4-fi', years: 6, country: 'DE' }).input.region).toBe('dach');
    expect(benchmark({ role: 's4-fi', years: 6, country: 'IN' }).input.region).toBe('india');
    // Not a silent discount: an unmapped country lands on the anchor.
    expect(benchmark({ role: 's4-fi', years: 6, country: 'ZZ' }).input.region).toBe(model.DEFAULT_REGION);
  });
});

describe('untrusted input', () => {
  /*
   * This runs on a GET whose query string people edit by hand and share. Every field falls
   * back to the anchor rather than throwing, because a benchmark that 500s on a stale link
   * is worse than one that answers the default question and shows which answer it used.
   */
  it('clamps nonsense rather than refusing it', () => {
    const r = benchmark({ role: 's4-fi', years: -40, certifications: 9999, workMode: 'astral', contractType: 'barter' });
    expect(r.input.years).toBe(0);
    expect(r.input.certifications).toBe(20);
    expect(r.input.workMode).toBe('hybrid');
    expect(r.input.contractType).toBe('time-and-materials');
    expect(benchmarkProblems(r)).toEqual([]);
  });

  it('reads years with Number and not parseInt, so a half-numeric string is refused whole', () => {
    // parseInt('12; DROP TABLE') is 12 — it takes the leading digits and discards the rest,
    // which is the same shape as the `parseInt('44.map')` trap the :id guard exists for.
    // Number() returns NaN for the whole string, and the fallback is the anchor.
    expect(normaliseInput({ role: 's4-fi', years: '12; DROP TABLE' }).years).toBe(0);
    expect(normaliseInput({ role: 's4-fi', years: '12' }).years).toBe(12);
    expect(normaliseInput({ role: 's4-fi', years: 'abc' }).years).toBe(0);
  });
});

describe('benchmarkProblems()', () => {
  // The check is only worth having if it catches a figure that stopped matching its working.
  it('catches a recommended rate that no longer follows from the factors', () => {
    const r = benchmark({ role: 's4-fi', years: 6 });
    r.recommended += 100;
    expect(benchmarkProblems(r)).toContain('the recommended rate is not the unrounded figure rounded');
  });

  it('catches a tampered factor', () => {
    const r = benchmark({ role: 's4-fi', years: 6 });
    r.factors[0].multiplier = 2;
    expect(benchmarkProblems(r).length).toBeGreaterThan(0);
  });

  it('catches a range that does not bracket the figure', () => {
    const r = benchmark({ role: 's4-fi', years: 6 });
    r.min = r.max + 1;
    expect(benchmarkProblems(r)).toContain('the range does not bracket the recommended rate');
  });
});

describe('curatedTable()', () => {
  it('has a row per experience band, ascending', () => {
    const rows = curatedTable('s4-fi');
    expect(rows).toHaveLength(model.EXPERIENCE_BANDS.length);
    rows.slice(1).forEach((row, i) => expect(row.recommended).toBeGreaterThan(rows[i].recommended));
  });

  it('is empty for an unknown role', () => {
    expect(curatedTable('not-a-role')).toEqual([]);
  });
});

describe('what the model must not become', () => {
  /*
   * The standing refusal, pinned. DynamicsHub's equivalent multiplies a rate by a hard-coded
   * figure and presents the difference as a monthly tax saving; what somebody keeps depends
   * on where they live, how they are engaged and what year it is, and this model knows none
   * of those. The failure mode is not an error — it is a confident number.
   */
  it('produces nothing named as a saving, a deduction or a take-home figure', () => {
    const r = benchmark({ role: 's4-fi', years: 6, country: 'DE' });
    const keys = JSON.stringify(r).toLowerCase();
    ['saving', 'takehome', 'take_home', 'nett', 'aftertax', 'after_tax', 'deduction', 'taxrate']
      .forEach((word) => expect(keys).not.toContain(word));
  });
});
