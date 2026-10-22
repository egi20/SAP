'use strict';

const { BOUNDS } = require('../config/rateBounds');
const { median, recentPeriods } = require('./rateAggregation');

/**
 * What OPEN job adverts on SAP Hub offer — the "Daily Rate Budgets" and "Annual Salaries"
 * sections dynamicshub.net shows beside its community index.
 *
 * Pure: the rows are fetched by `Job.advertisedRateRows`, through `Job.buildFilter`, so an
 * advert that is a draft, closed or taken down by a moderator never reaches this file.
 *
 * Three rules, each a decision rather than a default:
 *
 *  - An advert whose company chose to HIDE its rate is not counted. Aggregating it would
 *    publish, one role at a time, a figure the company decided not to publish.
 *  - No contributor floor. These are figures already printed on public adverts, which is
 *    why dynamicshub.net does not suppress them either; the floor in rateAggregation.js
 *    protects people who told us their pay privately, and nobody here did.
 *  - A figure outside `config/rateBounds.js` is left out, and the count says how many.
 *    Those are the bounds the contribution form enforces; an advert typed with a salary in
 *    the day-rate box would otherwise move every average for that role.
 *
 * Advert figures are what companies OFFER, contributed figures are what people are PAID,
 * and the page keeps them in separate sections for the same reason the editorial baseline
 * is never blended in: where they disagree, the disagreement is the useful part.
 */

function round(n) {
  return n === null || n === undefined ? null : Math.round(n);
}

function avg(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function monthOf(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 7);
}

/**
 * Rows into EUR points. `toEur(amount, currency)` is passed in rather than required, so a
 * util does not reach into a model.
 */
function normalise(rows, engagementType, toEur) {
  const bounds = BOUNDS[engagementType];
  const points = [];
  let outOfBounds = 0;
  for (const row of rows || []) {
    if (!Number(row.rate_visible)) continue;
    const rawMin = row.rate_min === null || row.rate_min === undefined ? null : Number(row.rate_min);
    const rawMax = row.rate_max === null || row.rate_max === undefined ? null : Number(row.rate_max);
    const lo = rawMin ?? rawMax;
    const hi = rawMax ?? rawMin;
    if (lo === null || !(lo > 0)) continue;
    const min = toEur(lo, row.currency || 'EUR');
    const max = toEur(hi, row.currency || 'EUR');
    if (min === null || max === null) continue;
    if (min < bounds.minEur || max > bounds.maxEur || max < min) {
      outOfBounds += 1;
      continue;
    }
    points.push({
      role: row.role,
      seniority: row.seniority,
      month: monthOf(row.published_at),
      min,
      max,
      mid: (min + max) / 2
    });
  }
  return { points, outOfBounds };
}

function summarise(points) {
  if (!points.length) return { adverts: 0, avgMin: null, avgMax: null, median: null, low: null, high: null };
  const mids = points.map((p) => p.mid).sort((a, b) => a - b);
  return {
    adverts: points.length,
    avgMin: round(avg(points.map((p) => p.min))),
    avgMax: round(avg(points.map((p) => p.max))),
    median: round(median(mids)),
    low: round(Math.min(...points.map((p) => p.min))),
    high: round(Math.max(...points.map((p) => p.max)))
  };
}

/** One summary per key, largest median first. */
function groupBy(points, keyFn) {
  const groups = new Map();
  points.forEach((p) => {
    const key = keyFn(p);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  });
  return [...groups.entries()]
    .map(([key, list]) => ({ key, ...summarise(list) }))
    .sort((a, b) => (b.median ?? -1) - (a.median ?? -1));
}

/** Median offer by month of publication, last `months` months; an empty month is null. */
function byMonth(points, months = 12, from = new Date()) {
  return recentPeriods(months, from).map((period) => {
    const list = points.filter((p) => p.month === period);
    return { period, value: list.length ? round(median(list.map((p) => p.mid).sort((a, b) => a - b))) : null, adverts: list.length };
  });
}

/** Everything one section of the page needs. */
function advertRates(rows, engagementType, toEur, { from = new Date() } = {}) {
  const { points, outOfBounds } = normalise(rows, engagementType, toEur);
  return {
    engagementType,
    summary: summarise(points),
    byRole: groupBy(points, (p) => p.role),
    bySeniority: groupBy(points, (p) => p.seniority),
    byMonth: byMonth(points, 12, from),
    outOfBounds
  };
}

module.exports = { advertRates, normalise, summarise, groupBy, byMonth };
