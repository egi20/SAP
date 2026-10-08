'use strict';

const { BASE_DAY_RATES, roleLabel, isRateRole: isRole } = require('../config/roleTaxonomy');
const model = require('../config/rateBenchmark');

/**
 * The editorial day-rate benchmark: pure, no database, no clock.
 *
 * It is pure for the same reason `utils/sapEstimation.js` is: the invariants are the
 * product, and they are only testable if the function is. A benchmark is a number somebody
 * will take into a negotiation, so the one thing it must never do is be unable to show its
 * working — `benchmarkProblems()` re-derives every figure from the factors the result
 * carries, and `routes/rates.js` throws rather than render a result that fails it.
 *
 * Nothing here reads a contributed rate. The model and the contributed index are two
 * separate answers to the same question and the page shows both; blending them would make
 * either one impossible to check.
 */

const ROUND_TO = 5;

function roundTo(value, step) {
  return Math.round(value / step) * step;
}

/**
 * Normalise whatever arrived from a query string into the model's own vocabulary.
 *
 * Every field falls back to the anchor rather than being rejected, because this runs on a
 * GET that people share and edit by hand: a benchmark that 400s on a stale link is worse
 * than one that answers the default question and shows which answer it used.
 */
function normaliseInput(input = {}) {
  const role = isRole(input.role) ? input.role : null;

  const years = Math.min(50, Math.max(0, Math.floor(Number(input.years)) || 0));
  const certifications = Math.min(20, Math.max(0, Math.floor(Number(input.certifications)) || 0));

  // A country is the question people can answer; the region is derived. An explicit region
  // still wins, because the per-role pages link straight to one.
  const country = /^[A-Za-z]{2}$/.test(input.country || '') ? String(input.country).toUpperCase() : '';
  const region = model.regionByKey(input.region) || (country ? model.regionForCountry(country) : model.regionByKey(model.DEFAULT_REGION));

  const workMode = model.WORK_MODES.find((m) => m.key === input.workMode)
    || model.WORK_MODES.find((m) => m.key === 'hybrid');
  const contractType = model.CONTRACT_TYPES.find((c) => c.key === input.contractType)
    || model.CONTRACT_TYPES.find((c) => c.key === 'time-and-materials');

  return { role, years, certifications, country, region, workMode, contractType };
}

/**
 * @returns {null|object} null when the role is unknown — the caller renders the empty form
 *   rather than a benchmark for a role nobody asked about.
 */
function benchmark(input = {}) {
  const chosen = normaliseInput(input);
  if (!chosen.role) return null;

  const base = BASE_DAY_RATES[chosen.role];
  const experience = model.experienceBandFor(chosen.years);
  const certification = model.certificationBandFor(chosen.certifications);

  /*
   * The factors are a LIST, in the order they are applied, and the page prints it. A model
   * that hands back only its answer is one the reader has to trust; one that hands back the
   * five numbers it multiplied is one they can argue with, which is the only useful kind.
   */
  const factors = [
    { key: 'experience', label: 'Experience', choice: experience.label, multiplier: experience.multiplier },
    { key: 'region', label: 'Region', choice: chosen.region.label, multiplier: chosen.region.multiplier },
    { key: 'workMode', label: 'Work arrangement', choice: chosen.workMode.label, multiplier: chosen.workMode.multiplier },
    { key: 'certifications', label: 'SAP certifications', choice: certification.label, multiplier: certification.multiplier },
    { key: 'contractType', label: 'Pricing model', choice: chosen.contractType.label, multiplier: chosen.contractType.multiplier }
  ];

  const product = factors.reduce((acc, factor) => acc * factor.multiplier, 1);
  const raw = base * product;
  const recommended = roundTo(raw, ROUND_TO);
  const min = roundTo(recommended * model.SPREAD_BELOW, ROUND_TO);
  const max = roundTo(recommended * model.SPREAD_ABOVE, ROUND_TO);

  return {
    role: chosen.role,
    roleLabel: roleLabel(chosen.role),
    input: {
      years: chosen.years,
      certifications: chosen.certifications,
      country: chosen.country,
      region: chosen.region.key,
      workMode: chosen.workMode.key,
      contractType: chosen.contractType.key
    },
    base,
    factors,
    raw,
    recommended,
    min,
    max,
    monthly: recommended * model.BILLABLE_DAYS_PER_MONTH,
    annual: recommended * model.BILLABLE_DAYS_PER_YEAR,
    equivalentSalary: roundTo(recommended * model.BILLABLE_DAYS_PER_YEAR * model.SALARY_EQUIVALENCE, 500),
    assumptions: {
      daysPerMonth: model.BILLABLE_DAYS_PER_MONTH,
      daysPerYear: model.BILLABLE_DAYS_PER_YEAR,
      salaryEquivalence: model.SALARY_EQUIVALENCE,
      spreadBelow: model.SPREAD_BELOW,
      spreadAbove: model.SPREAD_ABOVE
    }
  };
}

/**
 * Re-derive everything the result claims, from the factors it carries.
 *
 * Same role as `reconciliationProblems()` in the estimator, and for the same reason: the
 * page prints the working next to the answer, so the two disagreeing is a bug that would
 * otherwise be visible only to a reader with a calculator.
 */
function benchmarkProblems(result) {
  if (!result) return ['no benchmark'];
  const problems = [];

  const product = result.factors.reduce((acc, factor) => acc * factor.multiplier, 1);
  const raw = result.base * product;
  if (Math.abs(raw - result.raw) > 0.000001) {
    problems.push('the factors do not reproduce the unrounded figure');
  }
  if (Math.abs(result.recommended - raw) > ROUND_TO / 2) {
    problems.push('the recommended rate is not the unrounded figure rounded');
  }
  result.factors.forEach((factor) => {
    if (!Number.isFinite(factor.multiplier) || factor.multiplier <= 0) {
      problems.push(`factor ${factor.key} has no usable multiplier`);
    }
  });

  if (!(result.min < result.recommended && result.recommended < result.max)) {
    problems.push('the range does not bracket the recommended rate');
  }
  if (result.monthly !== result.recommended * result.assumptions.daysPerMonth) {
    problems.push('the monthly figure is not the day rate times the billable days');
  }
  if (result.annual !== result.recommended * result.assumptions.daysPerYear) {
    problems.push('the annual figure is not the day rate times the billable days');
  }
  if (result.equivalentSalary >= result.annual) {
    problems.push('the equivalent salary is not below annual billings');
  }

  return problems;
}

/**
 * The curated table a per-role page shows: the same model across the experience bands,
 * holding everything else at the anchor. One row per band, so the shape of the progression
 * is visible without anybody filling a form in five times.
 */
function curatedTable(role, { country = '', region = '' } = {}) {
  if (!isRole(role)) return [];
  return model.EXPERIENCE_BANDS.map((band) => {
    const row = benchmark({ role, years: band.minYears, country, region });
    return { band: band.label, key: band.key, min: row.min, recommended: row.recommended, max: row.max };
  });
}

module.exports = { benchmark, benchmarkProblems, curatedTable, normaliseInput, ROUND_TO };
