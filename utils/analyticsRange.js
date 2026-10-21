'use strict';

/**
 * The date range every analytics screen is read over — one parser, so the GA4 screen, the
 * Cloudflare screen and the server-side panels can never be answering for different days.
 *
 * Presets match dynamicshub.net's selector (7, 28, 90, 180, 365 days) plus a custom range of
 * two dates. Everything comes from the query string and is validated here: an unknown preset
 * falls back to 28 days, a custom range that is backwards, in the future or longer than a
 * year and a bit is refused with a message rather than silently clamped — a clamped range
 * would answer a different question than the one the dates on screen ask.
 *
 * Dates are UTC calendar days, like every other date this application computes in SQL.
 */

const PRESETS = Object.freeze([
  { key: '7d', days: 7, label: 'Last 7 days' },
  { key: '28d', days: 28, label: 'Last 28 days' },
  { key: '90d', days: 90, label: 'Last 90 days' },
  { key: '180d', days: 180, label: 'Last 6 months' },
  { key: '365d', days: 365, label: 'Last 12 months' }
]);
const DEFAULT_KEY = '28d';
const MAX_CUSTOM_DAYS = 400;
const DAY_MS = 24 * 60 * 60 * 1000;

const iso = (d) => d.toISOString().slice(0, 10);

function parseDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || iso(d) !== value ? null : d;
}

/**
 * @returns {{ key, days, from, to, label, error }} — `from`/`to` are inclusive YYYY-MM-DD.
 */
function rangeFrom(query = {}, now = new Date()) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  if (query.range === 'custom') {
    const from = parseDay(query.from);
    const to = parseDay(query.to);
    let error = null;
    if (!from || !to) error = 'Pick both a start and an end date.';
    else if (from > to) error = 'The start date is after the end date.';
    else if (to > today) error = 'The end date is in the future.';
    else if ((to - from) / DAY_MS + 1 > MAX_CUSTOM_DAYS) error = `A custom range can be at most ${MAX_CUSTOM_DAYS} days.`;
    if (!error) {
      const days = Math.round((to - from) / DAY_MS) + 1;
      return { key: 'custom', days, from: iso(from), to: iso(to), label: `${iso(from)} to ${iso(to)}`, error: null };
    }
    const fallback = rangeFrom({ range: DEFAULT_KEY }, now);
    return { ...fallback, error };
  }

  const preset = PRESETS.find((p) => p.key === query.range) || PRESETS.find((p) => p.key === DEFAULT_KEY);
  const from = new Date(today.getTime() - (preset.days - 1) * DAY_MS);
  return { key: preset.key, days: preset.days, from: iso(from), to: iso(today), label: preset.label, error: null };
}

/** The query string that reproduces a range, for links that must keep it. */
function rangeQuery(range) {
  return range.key === 'custom' ? `range=custom&from=${range.from}&to=${range.to}` : `range=${range.key}`;
}

module.exports = { PRESETS, DEFAULT_KEY, MAX_CUSTOM_DAYS, rangeFrom, rangeQuery };
