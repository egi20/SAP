'use strict';

const config = require('../config/config');

/**
 * Privacy floor for the rate index.
 *
 * These are the rules, each of which exists because breaking it leaks an individual's
 * pay in a small bucket:
 *
 *   1. Count PEOPLE, not rows. One person submitting three times is a sample of one.
 *   2. De-duplicate AFTER filtering, never before. Filtering a pre-deduplicated set
 *      can leave a bucket whose apparent contributor count is higher than the number
 *      of people who actually match the filter.
 *   3. Below the floor, keep the COUNT and null the VALUES. The UI must be able to say
 *      "2 contributors, not enough to publish" rather than pretend the bucket is empty.
 *   4. A suppressed point in a trend series is a GAP, not a zero and not an
 *      interpolation. Drawing a line through it invents data.
 *
 * Everything here is a pure function over already-fetched rows so it can be tested
 * without a database.
 */

const MIN_SAMPLE = config.rates.minSampleSize;

function median(sortedNumbers) {
  const n = sortedNumbers.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sortedNumbers[mid - 1] + sortedNumbers[mid]) / 2 : sortedNumbers[mid];
}

/**
 * Nearest-rank percentile on an ascending array. `p` is 0..1.
 * Nearest-rank (rather than linear interpolation) is deliberate: an interpolated
 * percentile can emit a value that no contributor actually submitted.
 */
function percentile(sortedNumbers, p) {
  const n = sortedNumbers.length;
  if (n === 0) return null;
  const rank = Math.max(1, Math.ceil(p * n));
  return sortedNumbers[rank - 1];
}

/**
 * Reduce raw submission rows to one aggregate.
 *
 * @param {Array<{user_id:number, amount_eur:number|string}>} rows already filtered
 * @param {number} minSample override for tests
 * @returns {{contributors:number, suppressed:boolean, median:number|null,
 *            p25:number|null, p75:number|null, min:number|null, max:number|null}}
 */
function aggregate(rows, minSample = MIN_SAMPLE) {
  // Rule 1 + 2: de-duplicate by person, on the already-filtered set. Where one person
  // has several submissions in scope, their median stands in for them so a single
  // outlier submission cannot move the bucket.
  const byPerson = new Map();
  for (const row of rows || []) {
    const amount = Number(row.amount_eur);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const list = byPerson.get(row.user_id) || [];
    list.push(amount);
    byPerson.set(row.user_id, list);
  }

  const perPerson = [];
  for (const amounts of byPerson.values()) {
    amounts.sort((a, b) => a - b);
    perPerson.push(median(amounts));
  }
  perPerson.sort((a, b) => a - b);

  const contributors = perPerson.length;

  // Rule 3: keep the count, drop the values.
  if (contributors < minSample) {
    return { contributors, suppressed: true, median: null, p25: null, p75: null, min: null, max: null };
  }

  return {
    contributors,
    suppressed: false,
    median: Math.round(median(perPerson)),
    p25: Math.round(percentile(perPerson, 0.25)),
    p75: Math.round(percentile(perPerson, 0.75)),
    min: Math.round(perPerson[0]),
    max: Math.round(perPerson[perPerson.length - 1])
  };
}

/**
 * Group rows by a key and aggregate each group independently.
 * @returns {Map<string, ReturnType<typeof aggregate>>}
 */
function aggregateBy(rows, keyFn, minSample = MIN_SAMPLE) {
  const groups = new Map();
  for (const row of rows || []) {
    const key = keyFn(row);
    if (key === null || key === undefined) continue;
    const list = groups.get(key) || [];
    list.push(row);
    groups.set(key, list);
  }

  const out = new Map();
  for (const [key, groupRows] of groups) {
    out.set(key, aggregate(groupRows, minSample));
  }
  return out;
}

/**
 * Build a trend series over an ordered list of periods.
 *
 * Rule 4: a suppressed or absent period yields `{ value: null }`, which chart code must
 * render as a gap. Never substitute 0, and never carry the previous value forward.
 */
function trendSeries(rows, periods, minSample = MIN_SAMPLE) {
  const byPeriod = aggregateBy(rows, (r) => r.period, minSample);
  return periods.map((period) => {
    const agg = byPeriod.get(period);
    if (!agg || agg.suppressed) {
      return { period, value: null, contributors: agg ? agg.contributors : 0, suppressed: true };
    }
    return { period, value: agg.median, contributors: agg.contributors, suppressed: false };
  });
}

/** The last `count` YYYY-MM periods, oldest first, ending with the month of `from`. */
function recentPeriods(count, from = new Date()) {
  const periods = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  for (let i = 0; i < count; i += 1) {
    const y = cursor.getUTCFullYear();
    const m = String(cursor.getUTCMonth() + 1).padStart(2, '0');
    periods.unshift(`${y}-${m}`);
    cursor.setUTCMonth(cursor.getUTCMonth() - 1);
  }
  return periods;
}

function currentPeriod(from = new Date()) {
  return recentPeriods(1, from)[0];
}

module.exports = {
  MIN_SAMPLE,
  aggregate,
  aggregateBy,
  trendSeries,
  recentPeriods,
  currentPeriod,
  median,
  percentile
};
