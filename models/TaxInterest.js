'use strict';

const { promisePool } = require('../config/database');

/**
 * Who opens the tax optimisation programme, and how far they get — the panel
 * dynamicshub.net shows as "Tax Optimization · who opens it".
 *
 * Three named steps of one funnel (migration 032), recorded by `routes/index.js`. A
 * signed-in member is named; everybody signed out is ONE row per day and step (`user_key`
 * 0), counted and never identified. Nothing about the person beyond their account is
 * stored — no IP, no session id.
 *
 * `record` is fire-and-forget at the call site and must never fail a page: the reading of
 * a page is not worth a 500. Its last error is remembered in memory, so the admin panel
 * can tell "the recorder is failing" from "nobody came", which otherwise look the same.
 *
 * `summary` runs its reads INDEPENDENTLY. The people query joins several tables and is the
 * one most likely to fail; it must not take the two single-table funnel counts down with
 * it, or the panel would print zeros over figures that were sitting right there.
 */

const STEPS = Object.freeze(['landing', 'calculator', 'apply']);

const STEP_LABELS = Object.freeze({
  landing: 'Opened the page',
  calculator: 'Used the calculator',
  apply: 'Opened the application form'
});

let lastWrite = { ok: null, at: null, error: null };

async function record(step, userId) {
  if (!STEPS.includes(step)) return false;
  const id = Number.isInteger(userId) && userId > 0 ? userId : null;
  try {
    await promisePool.query(
      `INSERT INTO tax_interest_views (day, step, user_key, user_id)
       VALUES (UTC_DATE(), ?, ?, ?)
       ON DUPLICATE KEY UPDATE views = views + 1, last_at = CURRENT_TIMESTAMP`,
      [step, id || 0, id]
    );
    lastWrite = { ok: true, at: new Date(), error: null };
    return true;
  } catch (err) {
    lastWrite = { ok: false, at: new Date(), error: err.message };
    console.error(`[tax-interest] could not record ${step}: ${err.message}`);
    return false;
  }
}

async function attempt(label, run, errors) {
  try {
    return await run();
  } catch (err) {
    errors.push(`${label}: ${err.message}`);
    return null;
  }
}

/**
 * @param {{from: string, to: string}} range inclusive UTC days, from utils/analyticsRange.
 * @param {{withPeople?: boolean, limit?: number}} options `withPeople` only for a reader
 *   allowed to see names (superadmin) — the query is not even run otherwise.
 */
async function summary({ from, to }, { withPeople = false, limit = 100 } = {}) {
  const errors = [];

  const funnelRows = await attempt('funnel', async () => {
    const [rows] = await promisePool.query(
      `SELECT step,
              SUM(views) AS views,
              COUNT(DISTINCT CASE WHEN user_key > 0 THEN user_key END) AS people,
              SUM(CASE WHEN user_key = 0 THEN views ELSE 0 END) AS anonymous_views
         FROM tax_interest_views
        WHERE day BETWEEN ? AND ?
        GROUP BY step`,
      [from, to]
    );
    return rows;
  }, errors);

  const applied = await attempt('applications', async () => {
    const [[row]] = await promisePool.query(
      `SELECT COUNT(*) AS applications, COUNT(DISTINCT user_id) AS people
         FROM tax_applications
        WHERE created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)`,
      [from, to]
    );
    return { applications: Number(row.applications), people: Number(row.people) };
  }, errors);

  // Integer joins only. A text comparison between this table and `users` is how a
  // collation mismatch took the reference's version of this list down in production.
  const people = withPeople ? await attempt('people', async () => {
    const [rows] = await promisePool.query(
      `SELECT u.id, u.name, u.email, u.is_active,
              MAX(t.last_at) AS last_at,
              SUM(t.views) AS views,
              MAX(CASE t.step WHEN 'apply' THEN 3 WHEN 'calculator' THEN 2 ELSE 1 END) AS furthest,
              EXISTS (SELECT 1 FROM tax_applications a WHERE a.user_id = u.id) AS applied
         FROM tax_interest_views t
         JOIN users u ON u.id = t.user_id
        WHERE t.day BETWEEN ? AND ?
        GROUP BY u.id, u.name, u.email, u.is_active
        ORDER BY last_at DESC
        LIMIT ?`,
      [from, to, limit]
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      active: Boolean(r.is_active),
      lastAt: r.last_at,
      views: Number(r.views),
      furthest: STEPS[Number(r.furthest) - 1],
      applied: Boolean(Number(r.applied))
    }));
  }, errors) : null;

  const funnel = STEPS.map((step) => {
    const row = (funnelRows || []).find((r) => r.step === step) || {};
    return {
      step,
      label: STEP_LABELS[step],
      people: Number(row.people || 0),
      views: Number(row.views || 0),
      anonymousViews: Number(row.anonymous_views || 0)
    };
  });

  const empty = funnel.every((f) => f.views === 0);
  return {
    ok: errors.length === 0,
    errors,
    funnel: funnelRows ? funnel : null,
    applied,
    people,
    // Only asked when there is nothing to show, so the normal case costs nothing extra.
    health: empty ? await health() : null
  };
}

/** Which kind of nothing an empty panel is showing. */
async function health() {
  let rows = null;
  let lastAt = null;
  let error = null;
  try {
    const [[r]] = await promisePool.query('SELECT COUNT(*) AS n, MAX(last_at) AS last_at FROM tax_interest_views');
    rows = Number(r.n);
    lastAt = r.last_at;
  } catch (err) {
    error = err.message;
  }
  return { rows, lastAt, readError: error, lastWrite: { ...lastWrite } };
}

module.exports = { STEPS, STEP_LABELS, record, summary, health };
