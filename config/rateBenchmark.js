'use strict';

const { BASE_DAY_RATES, RATE_ROLE_SLUGS: ROLE_SLUGS } = require('./roleTaxonomy');

/**
 * The editorial day-rate model, and every number that can move a benchmark.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT. The contributed index in `utils/rateAggregation.js`
 * reports what members have actually said they are paid, and withholds a bucket until
 * enough people have filled it. This file is the other thing: a model, published under its
 * own name, which answers "what should a role like this cost" on day one, when nobody has
 * contributed anything.
 *
 * THE TWO ARE NEVER BLENDED. The reference computes a single figure from a model and
 * labels it with a confidence level derived from how much community data happened to be
 * nearby — which reads as a statistical claim and is not one, and which makes the number
 * unfalsifiable: you cannot tell which part of it came from evidence. Here the model's
 * answer and the contributed answer are shown side by side, each named, and where the
 * contributed one is below the publication floor the page says how many more people are
 * needed rather than quietly leaning on the model.
 *
 * `BASE_DAY_RATES` in roleTaxonomy.js is the anchor and means: a SENIOR consultant, in the
 * reference region, on time-and-materials, working remotely, with no certifications
 * counted. Every multiplier below moves away from exactly that point, which is why the
 * senior band, the reference region and T&M are all 1.0 — a model whose "no adjustments"
 * case does not reproduce its own anchor is a model nobody can check by hand.
 */

/** The anchor's own band. Years are inclusive lower bounds. */
const EXPERIENCE_BANDS = Object.freeze([
  { key: 'junior', label: '0–2 years', minYears: 0, multiplier: 0.70 },
  { key: 'mid', label: '3–5 years', minYears: 3, multiplier: 0.86 },
  { key: 'senior', label: '6–9 years', minYears: 6, multiplier: 1.00 },
  { key: 'lead', label: '10–14 years', minYears: 10, multiplier: 1.16 },
  { key: 'principal', label: '15+ years', minYears: 15, multiplier: 1.28 }
]);

/**
 * Regions, as day rates actually differ across the ecosystem, each with the countries it
 * covers. A country is mapped rather than asked for twice: somebody knows they work in
 * Portugal, and may not agree with us about what "Southern Europe" includes.
 *
 * `DEFAULT_REGION` catches everything unlisted, and it is the reference region, so an
 * unmapped country produces the anchor rather than a silent discount.
 */
const REGIONS = Object.freeze([
  {
    key: 'dach', label: 'DACH', multiplier: 1.12,
    countries: ['DE', 'AT', 'CH', 'LI']
  },
  {
    key: 'nordics', label: 'Nordics', multiplier: 1.08,
    countries: ['SE', 'NO', 'DK', 'FI', 'IS']
  },
  {
    key: 'uki', label: 'UK & Ireland', multiplier: 1.05,
    countries: ['GB', 'IE']
  },
  {
    key: 'benelux', label: 'Benelux', multiplier: 1.05,
    countries: ['NL', 'BE', 'LU']
  },
  {
    key: 'western-europe', label: 'Western Europe', multiplier: 1.00,
    countries: ['FR', 'IT', 'ES', 'PT', 'MT', 'MC', 'AD', 'SM']
  },
  {
    key: 'cee', label: 'Central & Eastern Europe', multiplier: 0.72,
    countries: ['PL', 'CZ', 'SK', 'HU', 'RO', 'BG', 'HR', 'SI', 'RS', 'BA', 'ME', 'MK', 'AL',
      'GR', 'EE', 'LV', 'LT', 'UA', 'MD', 'XK']
  },
  {
    key: 'north-america', label: 'North America', multiplier: 1.18,
    countries: ['US', 'CA']
  },
  {
    key: 'middle-east', label: 'Middle East', multiplier: 1.02,
    countries: ['AE', 'SA', 'QA', 'KW', 'BH', 'OM', 'IL', 'TR', 'JO', 'EG']
  },
  {
    key: 'apac', label: 'Asia Pacific', multiplier: 0.92,
    countries: ['AU', 'NZ', 'SG', 'JP', 'KR', 'HK', 'MY', 'TH', 'ID', 'PH', 'VN', 'CN', 'TW']
  },
  {
    key: 'india', label: 'India & South Asia', multiplier: 0.42,
    countries: ['IN', 'PK', 'BD', 'LK', 'NP']
  },
  {
    key: 'latam', label: 'Latin America', multiplier: 0.62,
    countries: ['BR', 'MX', 'AR', 'CL', 'CO', 'PE', 'UY', 'CR', 'PA', 'EC']
  },
  {
    key: 'africa', label: 'Africa', multiplier: 0.68,
    countries: ['ZA', 'NG', 'KE', 'GH', 'MA', 'TN', 'DZ', 'ET']
  }
]);

const DEFAULT_REGION = 'western-europe';

/** Where the work is done from, not where the client is. */
const WORK_MODES = Object.freeze([
  { key: 'remote', label: 'Fully remote', multiplier: 0.96 },
  { key: 'hybrid', label: 'Hybrid', multiplier: 1.00 },
  { key: 'onsite', label: 'On site', multiplier: 1.08 }
]);

/**
 * SAP certifications, in bands rather than per certificate. A linear per-certificate
 * uplift rewards collecting them, and the market does not: the first one is evidence, the
 * fifth is a hobby.
 */
const CERTIFICATION_BANDS = Object.freeze([
  { key: 'none', label: 'None', minCount: 0, multiplier: 1.00 },
  { key: 'some', label: '1–2', minCount: 1, multiplier: 1.04 },
  { key: 'many', label: '3 or more', minCount: 3, multiplier: 1.07 }
]);

/**
 * How the work is PRICED. T&M is the anchor.
 *
 * Pricing models only. "Staff augmentation" used to sit in this list, and it is not a way
 * of pricing anything — it is an engagement model (config/engagementModels.js), usually
 * paid on time and materials. Offering it beside T&M asked the reader to choose between
 * two answers to different questions. An old link carrying it falls back to the anchor,
 * like any other unrecognised value.
 */
const CONTRACT_TYPES = Object.freeze([
  { key: 'time-and-materials', label: 'Time & materials', multiplier: 1.00 },
  { key: 'fixed-price', label: 'Fixed price', multiplier: 1.05 },
  { key: 'retainer', label: 'Retainer', multiplier: 0.95 }
]);

/**
 * The spread around the recommended figure. A single number is a negotiating position
 * nobody can use; a range is what somebody actually needs walking into the conversation.
 * It is a fixed proportion and not a statistic, and the page says so.
 */
const SPREAD_BELOW = 0.88;
const SPREAD_ABOVE = 1.15;

/**
 * Working days. These are assumptions, stated here once and printed on the page beside
 * every figure derived from them, because a monthly figure with an unstated divisor is the
 * number people quote back at you.
 */
const BILLABLE_DAYS_PER_MONTH = 20;
const BILLABLE_DAYS_PER_YEAR = 220;

/**
 * Day rate to an equivalent permanent salary.
 *
 * NOT a tax calculation and never presented as one — what somebody keeps depends on where
 * they live, how they are engaged and what year it is, and this application refuses to
 * guess at any of that. This is the other, narrower question: what gross salary buys a
 * company the same person. It is below the annual billings because a permanent employee is
 * paid through holiday, sickness and the gaps between projects, and because the employer
 * carries costs the day rate already includes.
 */
const SALARY_EQUIVALENCE = 0.68;

function bandFor(bands, value) {
  const key = Object.prototype.hasOwnProperty.call(bands[0], 'minYears') ? 'minYears' : 'minCount';
  let chosen = bands[0];
  bands.forEach((band) => {
    if (value >= band[key]) chosen = band;
  });
  return chosen;
}

function experienceBandFor(years) {
  return bandFor(EXPERIENCE_BANDS, Math.max(0, Math.floor(Number(years) || 0)));
}

function certificationBandFor(count) {
  return bandFor(CERTIFICATION_BANDS, Math.max(0, Math.floor(Number(count) || 0)));
}

function regionForCountry(code) {
  const upper = String(code || '').toUpperCase();
  const found = REGIONS.find((region) => region.countries.includes(upper));
  return found || REGIONS.find((region) => region.key === DEFAULT_REGION);
}

function regionByKey(key) {
  return REGIONS.find((region) => region.key === key) || null;
}

/**
 * Every failure below produces a WRONG NUMBER rather than an error, which is the whole
 * reason this runs at boot: a role missing from the base table benchmarks as the fallback
 * for everybody who picks it, a country claimed by two regions takes whichever was written
 * first, and a band table whose anchor is not 1.0 silently moves every figure on the site.
 */
function assertBenchmarkIntegrity() {
  const problems = [];

  ROLE_SLUGS.forEach((slug) => {
    if (!Number.isFinite(BASE_DAY_RATES[slug]) || BASE_DAY_RATES[slug] <= 0) {
      problems.push(`role ${slug} has no usable base day rate`);
    }
  });

  const anchors = [
    ['experience', EXPERIENCE_BANDS.find((b) => b.key === 'senior')],
    ['region', regionByKey(DEFAULT_REGION)],
    ['work mode', WORK_MODES.find((m) => m.key === 'hybrid')],
    ['certifications', CERTIFICATION_BANDS.find((b) => b.key === 'none')],
    ['contract type', CONTRACT_TYPES.find((c) => c.key === 'time-and-materials')]
  ];
  anchors.forEach(([name, entry]) => {
    if (!entry) problems.push(`${name} has no anchor entry`);
    else if (entry.multiplier !== 1) problems.push(`the ${name} anchor is ${entry.multiplier}, not 1`);
  });

  const seen = new Map();
  REGIONS.forEach((region) => {
    if (!Number.isFinite(region.multiplier) || region.multiplier <= 0) {
      problems.push(`region ${region.key} has no usable multiplier`);
    }
    region.countries.forEach((code) => {
      if (!/^[A-Z]{2}$/.test(code)) problems.push(`${region.key} lists "${code}", which is not a country code`);
      if (seen.has(code)) problems.push(`${code} is claimed by both ${seen.get(code)} and ${region.key}`);
      seen.set(code, region.key);
    });
  });

  [['experience', EXPERIENCE_BANDS, 'minYears'], ['certification', CERTIFICATION_BANDS, 'minCount']]
    .forEach(([name, bands, key]) => {
      bands.forEach((band, i) => {
        if (i > 0 && band[key] <= bands[i - 1][key]) {
          problems.push(`${name} band ${band.key} does not start after the one before it`);
        }
      });
      if (bands[0][key] !== 0) problems.push(`the first ${name} band must start at 0`);
    });

  if (!(SPREAD_BELOW < 1 && SPREAD_ABOVE > 1)) {
    problems.push('the spread must bracket the recommended figure');
  }
  if (!(SALARY_EQUIVALENCE > 0 && SALARY_EQUIVALENCE < 1)) {
    problems.push('the salary equivalence must be a fraction of annual billings');
  }

  if (problems.length) {
    throw new Error(`Rate benchmark model is inconsistent:\n  - ${problems.join('\n  - ')}`);
  }
}

module.exports = {
  EXPERIENCE_BANDS,
  REGIONS,
  DEFAULT_REGION,
  WORK_MODES,
  CERTIFICATION_BANDS,
  CONTRACT_TYPES,
  SPREAD_BELOW,
  SPREAD_ABOVE,
  BILLABLE_DAYS_PER_MONTH,
  BILLABLE_DAYS_PER_YEAR,
  SALARY_EQUIVALENCE,
  experienceBandFor,
  certificationBandFor,
  regionForCountry,
  regionByKey,
  assertBenchmarkIntegrity
};
