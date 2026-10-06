'use strict';

const { promisePool, withTransaction } = require('../config/database');
const { containsPattern } = require('../utils/likePattern');
const { SECTIONS, SECTION_KEYS } = require('../config/jobSections');
const { uniqueSlug } = require('../utils/slug');
const { isRole } = require('../config/roleTaxonomy');
const { isModule } = require('../config/sapProducts');
const { ACTIVATE_PHASES } = require('../config/activatePhases');

const SORTS = {
  newest: 'j.published_at DESC, j.id DESC',
  rate_desc: 'j.rate_max IS NULL, j.rate_max DESC',
  rate_asc: 'j.rate_min IS NULL, j.rate_min ASC',
  relevance: 'j.published_at DESC, j.id DESC'
};

/**
 * Whether a paid featured window is open on this job right now.
 *
 * A correlated EXISTS rather than a column on `jobs`, because a window EXPIRES: a boolean
 * flag would need something to come round and unset it, and the day that job fails to run
 * is the day somebody keeps a placement they stopped paying for. Asking the question at
 * read time cannot go stale. Overlapping rows are expected — a renewal bought mid-window
 * appends another row (see `job_features` in migration 010).
 */
const FEATURED_EXPR = `EXISTS (
        SELECT 1 FROM job_features f
         WHERE f.job_id = j.id AND f.starts_at <= NOW() AND f.ends_at > NOW()
      )`;

/**
 * Featured jobs sort first, within whatever order was asked for.
 *
 * Prefixed rather than replacing the sort: somebody who explicitly sorted by rate still
 * gets a rate-sorted list, with the paid placements at its head. Silently overriding a
 * chosen sort would make the control look broken.
 */
function orderByFor(sort) {
  return `is_featured DESC, ${SORTS[sort] || SORTS.newest}`;
}

/**
 * THE single WHERE builder for job browsing.
 *
 * Used by the public list, the count behind it, and every bulk mutation. One builder is
 * what guarantees a bulk action provably targets the same rows the operator was looking
 * at; two builders drift, and eventually a bulk "close all filtered jobs" closes a
 * different set than the screen showed.
 *
 * @returns {{clause:string, params:Array}}
 */
/**
 * The windows the "posted" filter offers, in days. One list, used by the filter, the
 * control that renders it and the test that checks them against each other.
 */
const POSTED_WITHIN_DAYS = Object.freeze([1, 7, 14, 30, 90]);

function buildFilter(filters = {}) {
  const where = [];
  const params = [];

  // `status` defaults to the public view. An explicit status is only honoured for
  // callers that pass one (the employer's own list, admin).
  if (filters.status) {
    where.push('j.status = ?');
    params.push(filters.status);
  } else {
    where.push("j.status = 'open'");
    where.push('(j.expires_at IS NULL OR j.expires_at > NOW())');
  }

  if (filters.company_user_id) {
    where.push('j.company_user_id = ?');
    params.push(filters.company_user_id);
  }
  if (filters.role && isRole(filters.role)) {
    where.push('j.role = ?');
    params.push(filters.role);
  }
  if (filters.seniority) {
    where.push('j.seniority = ?');
    params.push(filters.seniority);
  }
  if (filters.engagement_type) {
    where.push('j.engagement_type = ?');
    params.push(filters.engagement_type);
  }
  if (filters.work_mode) {
    where.push('j.work_mode = ?');
    params.push(filters.work_mode);
  }
  if (filters.activate_phase && ACTIVATE_PHASES.includes(filters.activate_phase)) {
    where.push('j.activate_phase = ?');
    params.push(filters.activate_phase);
  }
  if (filters.country) {
    where.push('j.country = ?');
    params.push(filters.country);
  }
  /*
   * "Posted in the last N days", validated against a FIXED SET rather than taken as a
   * number. Not because an arbitrary integer here is dangerous — it is a filter, not the
   * admin purge — but because the windows are what the control offers, and accepting
   * ?posted_within=4000 produces a page that silently answers a question nobody can ask
   * from the form and that nothing else on the site agrees with.
   */
  if (POSTED_WITHIN_DAYS.includes(Number(filters.posted_within))) {
    where.push('j.published_at >= DATE_SUB(NOW(), INTERVAL ? DAY)');
    params.push(Number(filters.posted_within));
  }

  if (filters.rate_min) {
    const min = Number(filters.rate_min);
    if (Number.isFinite(min) && min > 0) {
      where.push('(j.rate_max IS NULL OR j.rate_max >= ?)');
      params.push(min);
    }
  }

  /*
   * Modules are filtered as ANY-of, not all-of, and that is the SAP-shaped decision here.
   *
   * The reference takes one module at a time, which suits an ecosystem where an engagement
   * is a Sales Cloud project. An SAP job advert lists four modules because the programme
   * touches four, and a consultant browsing it wants "anything involving MM or EWM" — not
   * "jobs that involve both". Requiring all of them returns an empty list from a filter
   * that looks like it should widen the search, which is the worst kind of empty state:
   * one the person cannot tell apart from having no jobs at all.
   *
   * Skills below stay ALL-of, because a skill filter is a competence claim rather than a
   * scope description, and narrowing is what it is for.
   */
  const modules = (Array.isArray(filters.modules) ? filters.modules : [filters.module])
    .filter((slug) => slug && isModule(slug));
  if (modules.length) {
    where.push('EXISTS (SELECT 1 FROM job_modules jm WHERE jm.job_id = j.id AND jm.module_slug IN (?))');
    params.push(modules);
  }

  if (filters.skill_ids && filters.skill_ids.length) {
    where.push(
      `j.id IN (SELECT js.job_id FROM job_skills js WHERE js.skill_id IN (?)
                 GROUP BY js.job_id HAVING COUNT(DISTINCT js.skill_id) = ?)`
    );
    params.push(filters.skill_ids, filters.skill_ids.length);
  }
  if (filters.q) {
    // LIKE rather than MATCH: the FULLTEXT index exists, but a mixed-language corpus of
    // mostly short tokens — and this ecosystem's tokens are very short, "FI", "MM", "SD" —
    // makes boolean-mode results worse than a plain substring match. MySQL's default
    // minimum word length would drop every module code on the board.
    // Every section, built from SECTION_KEYS. A job whose modules are named only under
    // "Requirements" has to be findable by searching for them.
    where.push(`(j.title LIKE ? OR ${SECTION_KEYS.map((k) => `j.${k} LIKE ?`).join(' OR ')})`);
    // Escaped, so a search for "50%" looks for "50%" and a search for "%" is not a scan
    // of the whole table. See utils/likePattern.js.
    const like = containsPattern(filters.q);
    params.push(...new Array(SECTION_KEYS.length + 1).fill(like));
  }

  return { clause: where.join(' AND '), params };
}

/** Mirrors the ENUM in scripts/migrations/003_jobs.sql, in lifecycle order. */
const STATUSES = Object.freeze(['draft', 'open', 'paused', 'filled', 'closed']);

class Job {
  static buildFilter = buildFilter;

  /**
   * The advert lifecycle, in the order a status filter should offer it.
   *
   * Here because it was written out by hand in three places — the employer's status form,
   * the route that validates what that form posts, and now the admin list — against an
   * ENUM in migration 003 that is the actual authority. Three copies of a five-item list
   * is how a status gets added to a dropdown and silently rejected by the validator behind
   * it. Changing the list is a migration, not an edit here.
   */
  static get STATUSES() {
    return STATUSES;
  }

  /**
   * Re-exported from `config/jobSections.js` so a route or a view can ask the model it is
   * already holding. The list lives there because `utils/jobMatcher.js` needs it too, and
   * a util must not reach into a model. Same arrangement as ACTIVATE_PHASES.
   */
  static get SECTIONS() {
    return SECTIONS;
  }

  static get SECTION_KEYS() {
    return SECTION_KEYS;
  }

  /** The windows the "posted" filter offers, in days. The control renders this list. */
  static get POSTED_WITHIN_DAYS() {
    return POSTED_WITHIN_DAYS;
  }

  /**
   * Re-exported from `config/activatePhases.js` so existing call sites keep working.
   * The list itself lives there because the estimator and the delivery history need it
   * too, and a second copy is a list that drifts.
   */
  static get ACTIVATE_PHASES() {
    return ACTIVATE_PHASES;
  }

  static async slugTaken(slug) {
    const [rows] = await promisePool.query('SELECT 1 FROM jobs WHERE slug = ? LIMIT 1', [slug]);
    return rows.length > 0;
  }

  static async create(companyUserId, data) {
    const slug = await uniqueSlug(`${data.title}`, Job.slugTaken);
    const [result] = await promisePool.query(
      `INSERT INTO jobs
         (company_user_id, title, slug, description, responsibilities, requirements, what_we_offer,
          role, seniority, engagement_type, work_mode,
          country, city, rate_min, rate_max, currency, rate_visible, duration_months, starts_on,
          activate_phase, status, published_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        companyUserId,
        data.title,
        slug,
        data.description,
        // `?? null` and not `|| null`: an empty string is what an untouched box posts, and
        // it must land as NULL so "not filled in" and "answered with nothing" stay the
        // same fact. The page renders neither, so the difference is only in the column —
        // which is exactly where a later question about it will be asked.
        data.responsibilities || null,
        data.requirements || null,
        data.what_we_offer || null,
        data.role,
        data.seniority,
        data.engagement_type,
        data.work_mode,
        data.country || null,
        data.city || null,
        data.rate_min ?? null,
        data.rate_max ?? null,
        data.currency || 'EUR',
        data.rate_visible ? 1 : 0,
        data.duration_months ?? null,
        data.starts_on || null,
        data.activate_phase || null,
        data.status || 'draft',
        data.status === 'open' ? new Date() : null,
        data.expires_at || null
      ]
    );
    return Job.findById(result.insertId);
  }

  static async update(jobId, companyUserId, data) {
    const allowed = [
      'title', ...SECTION_KEYS, 'role', 'seniority', 'engagement_type', 'work_mode',
      'country', 'city', 'rate_min', 'rate_max', 'currency', 'rate_visible',
      'duration_months', 'starts_on', 'activate_phase', 'expires_at'
    ];

    const sets = [];
    const params = [];
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        sets.push(`${key} = ?`);
        params.push(data[key]);
      }
    }
    if (sets.length === 0) return Job.findById(jobId);

    // Ownership is part of the WHERE, never a separate check: there is then no window
    // between "is this yours?" and "write it".
    params.push(jobId, companyUserId);
    await promisePool.query(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ? AND company_user_id = ?`, params);
    return Job.findById(jobId);
  }

  /** Publishing stamps `published_at` once, the first time only. */
  static async setStatus(jobId, companyUserId, status) {
    const [result] = await promisePool.query(
      `UPDATE jobs
          SET status = ?,
              published_at = CASE WHEN ? = 'open' AND published_at IS NULL THEN NOW() ELSE published_at END
        WHERE id = ? AND company_user_id = ?`,
      [status, status, jobId, companyUserId]
    );
    return result.affectedRows === 1;
  }

  /**
   * Bulk status change with an expectedCount interlock.
   *
   * The caller passes the number of rows the screen showed. If the filtered set has
   * changed since then — someone else edited a job, a job expired — the whole operation
   * aborts instead of acting on a set the operator never saw. Callers surface this as a
   * 409, not as a success.
   *
   * @throws {Error & {code:'BULK_COUNT_MISMATCH', actual:number, expected:number}}
   */
  static async bulkSetStatus(filters, status, expectedCount, companyUserId) {
    return withTransaction(async (conn) => {
      // The SAME builder the list view used, plus a hard ownership scope.
      const { clause, params } = buildFilter({ ...filters, company_user_id: companyUserId });

      const [[{ actual }]] = await conn.query(
        `SELECT COUNT(*) AS actual FROM jobs j WHERE ${clause} FOR UPDATE`,
        params
      );

      if (actual !== expectedCount) {
        const err = new Error(
          `Bulk update aborted: ${actual} jobs now match this filter, but the screen showed ${expectedCount}.`
        );
        err.code = 'BULK_COUNT_MISMATCH';
        err.actual = actual;
        err.expected = expectedCount;
        throw err;
      }

      const [result] = await conn.query(
        `UPDATE jobs j
            SET j.status = ?,
                j.published_at = CASE WHEN ? = 'open' AND j.published_at IS NULL THEN NOW() ELSE j.published_at END
          WHERE ${clause}`,
        [status, status, ...params]
      );
      return result.affectedRows;
    });
  }

  static async findById(jobId) {
    const [rows] = await promisePool.query(
      `SELECT j.*, cp.company_name, cp.slug AS company_slug, cp.logo AS company_logo,
              cp.website AS company_website, cp.company_type
         FROM jobs j
         LEFT JOIN company_profiles cp ON cp.user_id = j.company_user_id
        WHERE j.id = ? LIMIT 1`,
      [jobId]
    );
    return rows[0] || null;
  }

  static async findBySlug(slug) {
    const [rows] = await promisePool.query(
      `SELECT j.*, cp.company_name, cp.slug AS company_slug, cp.logo AS company_logo,
              cp.website AS company_website, cp.company_type,
              ${FEATURED_EXPR} AS is_featured
         FROM jobs j
         LEFT JOIN company_profiles cp ON cp.user_id = j.company_user_id
        WHERE j.slug = ? LIMIT 1`,
      [slug]
    );
    return rows[0] || null;
  }

  static async browse(filters = {}, { limit = 20, offset = 0, sort = 'newest' } = {}) {
    const { clause, params } = buildFilter(filters);
    const orderBy = orderByFor(sort);

    const [rows] = await promisePool.query(
      `SELECT j.id, j.title, j.slug, j.role, j.seniority, j.engagement_type, j.work_mode,
              j.country, j.city, j.rate_min, j.rate_max, j.currency, j.rate_visible,
              j.duration_months, j.activate_phase, j.published_at, j.application_count, j.status,
              cp.company_name, cp.slug AS company_slug, cp.logo AS company_logo,
              ${FEATURED_EXPR} AS is_featured
         FROM jobs j
         LEFT JOIN company_profiles cp ON cp.user_id = j.company_user_id
        WHERE ${clause}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const [[{ total }]] = await promisePool.query(`SELECT COUNT(*) AS total FROM jobs j WHERE ${clause}`, params);
    return { rows, total };
  }

  /** Counts per role for the browse sidebar, using the same filter minus `role`. */
  static async facetByRole(filters = {}) {
    const { clause, params } = buildFilter({ ...filters, role: undefined });
    const [rows] = await promisePool.query(
      `SELECT j.role, COUNT(*) AS count FROM jobs j WHERE ${clause} GROUP BY j.role ORDER BY count DESC`,
      params
    );
    return rows;
  }

  /**
   * Counts per module, for the module filter on the browse page.
   *
   * The same builder minus the module clause, joined through `job_modules`. A job that
   * names four modules contributes one to each of the four, so these counts deliberately
   * sum to more than the number of jobs — which is correct for an any-of filter and would
   * be wrong for an all-of one.
   */
  static async facetByModule(filters = {}) {
    const { clause, params } = buildFilter({ ...filters, module: undefined, modules: undefined });
    const [rows] = await promisePool.query(
      `SELECT jm.module_slug, COUNT(DISTINCT j.id) AS count
         FROM jobs j
         JOIN job_modules jm ON jm.job_id = j.id
        WHERE ${clause}
        GROUP BY jm.module_slug
        ORDER BY count DESC`,
      params
    );
    return rows;
  }

  static async incrementViews(jobId) {
    // Best effort: a lost view count is not worth failing a page render over.
    try {
      await promisePool.query('UPDATE jobs SET view_count = view_count + 1 WHERE id = ?', [jobId]);
    } catch (err) {
      console.error(`View increment failed for job ${jobId}: ${err.message}`);
    }
  }

  static async setModules(jobId, moduleSlugs) {
    await promisePool.query('DELETE FROM job_modules WHERE job_id = ?', [jobId]);
    const valid = (moduleSlugs || []).filter((slug) => isModule(slug));
    if (valid.length === 0) return;
    const values = valid.map((slug) => [jobId, slug]);
    await promisePool.query('INSERT IGNORE INTO job_modules (job_id, module_slug) VALUES ?', [values]);
  }

  static async modulesFor(jobId) {
    const [rows] = await promisePool.query('SELECT module_slug FROM job_modules WHERE job_id = ?', [jobId]);
    return rows.map((r) => r.module_slug);
  }

  static async remove(jobId, companyUserId) {
    const [result] = await promisePool.query('DELETE FROM jobs WHERE id = ? AND company_user_id = ?', [jobId, companyUserId]);
    return result.affectedRows === 1;
  }

  static async saveForUser(userId, jobId) {
    const [result] = await promisePool.query('INSERT IGNORE INTO saved_jobs (user_id, job_id) VALUES (?, ?)', [userId, jobId]);
    return result.affectedRows === 1;
  }

  static async unsaveForUser(userId, jobId) {
    const [result] = await promisePool.query('DELETE FROM saved_jobs WHERE user_id = ? AND job_id = ?', [userId, jobId]);
    return result.affectedRows === 1;
  }

  static async isSaved(userId, jobId) {
    const [rows] = await promisePool.query('SELECT 1 FROM saved_jobs WHERE user_id = ? AND job_id = ? LIMIT 1', [userId, jobId]);
    return rows.length > 0;
  }

  /**
   * When the current featured placement on a job runs out, or null if none is open.
   *
   * MAX rather than "the latest row": renewals overlap deliberately, so the window that
   * matters is the furthest-out end date, not the most recently bought one.
   */
  static async featuredUntil(jobId) {
    const [rows] = await promisePool.query(
      'SELECT MAX(ends_at) AS ends_at FROM job_features WHERE job_id = ? AND ends_at > NOW()',
      [jobId]
    );
    return (rows[0] && rows[0].ends_at) || null;
  }

  static async listSaved(userId, { limit = 20, offset = 0 } = {}) {
    const [rows] = await promisePool.query(
      `SELECT j.id, j.title, j.slug, j.role, j.status, j.rate_min, j.rate_max, j.currency,
              cp.company_name, sj.created_at AS saved_at
         FROM saved_jobs sj
         JOIN jobs j ON j.id = sj.job_id
         LEFT JOIN company_profiles cp ON cp.user_id = j.company_user_id
        WHERE sj.user_id = ?
        ORDER BY sj.created_at DESC
        LIMIT ? OFFSET ?`,
      [userId, limit, offset]
    );
    return rows;
  }
}

module.exports = Job;
