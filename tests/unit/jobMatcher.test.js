'use strict';

const { matchScore, moduleScore, containsWord, WEIGHTS, MAX_SCORE } = require('../../utils/jobMatcher');

describe('alias matching is word-bounded', () => {
  /*
   * The reason this file exists. The reference asks `haystack.includes(alias)`, which is
   * safe when the shortest alias is "cpq". Every SAP module code is two letters, and every
   * SAP job advert contains the words below — so a substring match would have given every
   * consultant a partial role match against every job, and the alias signal would have been
   * pure noise. These are real strings from real adverts.
   */
  const prose = 'a committed team with specific experience of employment contracts and communication';

  test.each(['mm', 'fi', 'co', 'sd', 'pp', 'pm'])('%s does not match inside an ordinary word', (code) => {
    expect(containsWord(prose, code)).toBe(false);
  });

  test.each([
    ['s/4hana mm consultant required', 'mm'],
    ['fi/co exposure essential', 'fi'],
    ['fi/co exposure essential', 'co'],
    ['experience with SD and MM', 'sd'],
    ['EWM greenfield rollout', 'ewm']
  ])('%s matches %s', (advert, code) => {
    expect(containsWord(advert, code)).toBe(true);
  });

  test('a regex metacharacter in an alias cannot break the match', () => {
    expect(containsWord('we use c++ here', 'c++')).toBe(true);
    expect(() => containsWord('anything', '(')).not.toThrow();
  });
});

describe('module scoring reads the delivery history', () => {
  test('a job naming no modules is neutral, not zero', () => {
    expect(moduleScore([], [])).toBe(Math.round(WEIGHTS.modules * 0.5));
  });

  test('scores the proportion delivered', () => {
    expect(moduleScore(['mm-purchasing', 'ewm'], ['mm-purchasing', 'ewm'])).toBe(WEIGHTS.modules);
    expect(moduleScore(['mm-purchasing', 'ewm'], ['mm-purchasing'])).toBe(Math.round(WEIGHTS.modules / 2));
    expect(moduleScore(['mm-purchasing', 'ewm'], ['fi-gl'])).toBe(0);
  });

  test('modules a consultant delivered but the job did not ask for do not inflate the score', () => {
    expect(moduleScore(['ewm'], ['ewm', 'fi-gl', 'co-pa', 'sd-sales'])).toBe(WEIGHTS.modules);
  });
});

describe('matchScore', () => {
  const job = {
    title: 'S/4HANA EWM consultant',
    description: 'Greenfield warehouse rollout, realize phase.',
    role: 's4-ewm',
    seniority: 'senior',
    work_mode: 'remote',
    rate_min: 800,
    rate_max: 1000
  };
  const profile = {
    primary_role: 's4-ewm',
    seniority: 'senior',
    country: 'DE',
    day_rate: 900,
    availability: 'immediate'
  };

  test('the weights are a percentage, so a breakdown reads directly', () => {
    expect(MAX_SCORE).toBe(100);
  });

  test('two consultants with the same role are separated by what they have delivered', () => {
    const shared = { jobSkillIds: [], consultantSkillIds: [], jobModules: ['ewm'] };
    const delivered = matchScore(job, profile, { ...shared, deliveredModules: ['ewm'] });
    const claimed = matchScore(job, profile, { ...shared, deliveredModules: [] });

    expect(delivered.score).toBeGreaterThan(claimed.score);
    expect(delivered.score - claimed.score).toBe(WEIGHTS.modules);
    expect(claimed.breakdown.role).toBe(WEIGHTS.role); // same role, so only modules moved
  });

  test('scores stay within 0..100', () => {
    const perfect = matchScore(job, profile, { jobModules: ['ewm'], deliveredModules: ['ewm'] });
    const empty = matchScore({}, {}, {});
    expect(perfect.score).toBeLessThanOrEqual(100);
    expect(empty.score).toBeGreaterThanOrEqual(0);
  });
});
