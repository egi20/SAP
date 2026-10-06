'use strict';

const { promisePool, withTransaction } = require('../config/database');
const { containsPattern } = require('../utils/likePattern');
const { isRole } = require('../config/roleTaxonomy');
const { isModule } = require('../config/sapProducts');
const { isCertificationCode, OTHER_CODE, certByCode } = require('../config/certifications');
const Points = require('./Points');
const { POINT_AWARDS } = require('../config/community');

/**
 * Fields that count towards profile completeness, with their weights.
 * A profile must reach MIN_COMPLETENESS_TO_PUBLISH before it can be listed publicly:
 * an empty profile in the talent directory wastes an employer's time and makes the
 * whole directory look thin.
 *
 * The weights are not the reference's. `full_lifecycles` is here, and `bio`, `seniority`
 * and `country` each gave up a point or two to pay for it, because in this ecosystem the
 * number of end-to-end implementations someone has delivered is the first thing a hiring
 * manager looks for and the last thing a CV leaves out.
 */
const COMPLETENESS_FIELDS = [
  { key: 'headline', weight: 10 },
  { key: 'bio', weight: 12 },
  { key: 'primary_role', weight: 15 },
  { key: 'seniority', weight: 8 },
  { key: 'country', weight: 8 },
  { key: 'day_rate', weight: 10 },
  { key: 'availability', weight: 5, satisfied: (v) => v && v !== 'not_available' },
  { key: 'profile_picture', weight: 5 },
  // Zero is a real answer and scores: somebody who has supported six landscapes and never
  // run a greenfield has told the truth, and a scale that punishes it teaches people to
  // leave it blank instead.
  { key: 'full_lifecycles', weight: 7, satisfied: (v) => v !== null && v !== undefined && v !== '' }
];

const MIN_COMPLETENESS_TO_PUBLISH = 60;

/** Pure function: 0..100 completeness for a profile row plus its child-record counts. */
function completenessOf(profile, { skillCount = 0, certificationCount = 0, projectCount = 0 } = {}) {
  let score = 0;
  for (const field of COMPLETENESS_FIELDS) {
    const value = profile ? profile[field.key] : null;
    const ok = field.satisfied ? field.satisfied(value) : value !== null && value !== undefined && String(value).trim() !== '';
    if (ok) score += field.weight;
  }
  if (skillCount >= 3) score += 8;
  if (certificationCount >= 1) score += 5;
  // Delivery history, not employment history. See `listProjects` below for why.
  if (projectCount >= 1) score += 7;
  return Math.min(100, score);
}

/**
 * THE single WHERE builder for consultant browsing.
 *
 * Every list view, count and export goes through this one function. DynamicsHub's incident
 * was a list view and a bulk mutation each building their own WHERE clause: they drifted,
 * and an operation reported on one set of rows while acting on another. One builder makes
 * that impossible by construction.
 *
 * @returns {{clause:string, params:Array}}
 */
function buildFilter(filters = {}) {
  /*
   * THREE conditions, not two. `is_public` is the member's own switch and
   * `admin_hidden_at` is a moderator's; the directory, the search sources and the feed all
   * come through here, so a profile taken down by an administrator leaves every one of
   * them without any of those pages knowing why.
   */
  const where = ['cp.is_public = 1', 'cp.admin_hidden_at IS NULL', 'u.is_active = 1'];
  const params = [];

  if (filters.role && isRole(filters.role)) {
    where.push('cp.primary_role = ?');
    params.push(filters.role);
  }
  if (filters.seniority) {
    where.push('cp.seniority = ?');
    params.push(filters.seniority);
  }
  if (filters.country) {
    where.push('cp.country = ?');
    params.push(filters.country);
  }
  if (filters.work_mode) {
    where.push('cp.work_mode = ?');
    params.push(filters.work_mode);
  }
  if (filters.availability) {
    where.push('cp.availability = ?');
    params.push(filters.availability);
  }
  if (filters.certified === '1') {
    where.push('EXISTS (SELECT 1 FROM consultant_certifications cc WHERE cc.user_id = cp.user_id)');
  }

  /*
   * "Who has actually delivered this module?" — the search this ecosystem runs and neither
   * reference can answer.
   *
   * It reads the DELIVERY HISTORY, not a self-declared skill tag. Anybody can tick EWM on a
   * skills list; this asks whether they have shipped it, which is the question a hiring
   * manager is really asking. Any-of, to match the job board's module filter.
   */
  const modules = (Array.isArray(filters.modules) ? filters.modules : [filters.module])
    .filter((slug) => slug && isModule(slug));
  if (modules.length) {
    where.push(
      `EXISTS (SELECT 1 FROM consultant_projects pr
                 JOIN consultant_project_modules pm ON pm.project_id = pr.id
                WHERE pr.user_id = cp.user_id AND pm.module_slug IN (?))`
    );
    params.push(modules);
  }

  if (filters.min_lifecycles) {
    const min = Number(filters.min_lifecycles);
    if (Number.isFinite(min) && min > 0) {
      where.push('cp.full_lifecycles >= ?');
      params.push(min);
    }
  }
  if (filters.rate_max) {
    const max = Number(filters.rate_max);
    if (Number.isFinite(max) && max > 0) {
      where.push('(cp.day_rate IS NULL OR cp.day_rate <= ?)');
      params.push(max);
    }
  }
  if (filters.skill_ids && filters.skill_ids.length) {
    where.push(
      `cp.user_id IN (SELECT cs.user_id FROM consultant_skills cs WHERE cs.skill_id IN (?)
                       GROUP BY cs.user_id HAVING COUNT(DISTINCT cs.skill_id) = ?)`
    );
    params.push(filters.skill_ids, filters.skill_ids.length);
  }
  if (filters.q) {
    where.push('(cp.headline LIKE ? OR cp.bio LIKE ? OR u.name LIKE ?)');
    const like = containsPattern(filters.q);
    params.push(like, like, like);
  }

  return { clause: where.join(' AND '), params };
}

/**
 * Ranking for the talent directory. Deliberately explicit rather than a magic ORDER BY
 * scattered across call sites: a verified LinkedIn, a certification, an immediate
 * availability and delivered lifecycles each nudge a profile up, and completeness breaks
 * ties.
 *
 * Lifecycles are capped at four. Past that the difference between candidates stops being
 * informative, and an uncapped term would let one self-reported number dominate a ranking
 * that nothing verifies.
 */
const RANK_EXPRESSION = `(
  cp.completeness
  + (cp.linkedin_verified * 3)
  + (CASE cp.availability WHEN 'immediate' THEN 6 WHEN 'two_weeks' THEN 4 WHEN 'one_month' THEN 2 ELSE 0 END)
  + LEAST(8, COALESCE(cp.full_lifecycles, 0) * 2)
  + LEAST(10, (SELECT COUNT(*) * 2 FROM consultant_certifications cc WHERE cc.user_id = cp.user_id))
)`;

const SORTS = {
  relevance: `${RANK_EXPRESSION} DESC, cp.updated_at DESC`,
  newest: 'cp.created_at DESC',
  rate_asc: 'cp.day_rate IS NULL, cp.day_rate ASC',
  rate_desc: 'cp.day_rate DESC',
  lifecycles: 'cp.full_lifecycles IS NULL, cp.full_lifecycles DESC'
};

class ConsultantProfile {
  static get MIN_COMPLETENESS_TO_PUBLISH() {
    return MIN_COMPLETENESS_TO_PUBLISH;
  }

  static completenessOf = completenessOf;

  static buildFilter = buildFilter;

  static async findByUserId(userId) {
    const [rows] = await promisePool.query(
      `SELECT cp.*, u.name, u.email, u.email_verified
         FROM consultant_profiles cp JOIN users u ON u.id = cp.user_id
        WHERE cp.user_id = ? LIMIT 1`,
      [userId]
    );
    return rows[0] || null;
  }

  static async ensureExists(userId) {
    await promisePool.query('INSERT IGNORE INTO consultant_profiles (user_id) VALUES (?)', [userId]);
    return ConsultantProfile.findByUserId(userId);
  }

  static async update(userId, fields) {
    const allowed = [
      'headline', 'bio', 'primary_role', 'seniority', 'years_experience', 'full_lifecycles',
      'country', 'city', 'timezone', 'work_mode', 'willing_to_travel',
      'day_rate', 'currency', 'availability', 'available_from',
      'linkedin_url', 'website_url', 'sap_community_url'
    ];

    const sets = [];
    const params = [];
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(fields, key)) {
        sets.push(`${key} = ?`);
        params.push(fields[key]);
      }
    }
    if (sets.length === 0) return ConsultantProfile.findByUserId(userId);

    params.push(userId);
    await promisePool.query(`UPDATE consultant_profiles SET ${sets.join(', ')} WHERE user_id = ?`, params);
    await ConsultantProfile.recomputeCompleteness(userId);
    return ConsultantProfile.findByUserId(userId);
  }

  static async setProfilePicture(userId, pointerUrl) {
    await promisePool.query('UPDATE consultant_profiles SET profile_picture = ? WHERE user_id = ?', [pointerUrl, userId]);
    await ConsultantProfile.recomputeCompleteness(userId);
  }

  /**
   * Publishing is gated on completeness, and un-publishing is always allowed.
   * @returns {{published:boolean, completeness:number}}
   */
  static async setPublic(userId, isPublic) {
    return withTransaction(async (conn) => {
      const [[row]] = await conn.query(
        'SELECT completeness, admin_hidden_at FROM consultant_profiles WHERE user_id = ? FOR UPDATE',
        [userId]
      );
      if (!row) throw new Error(`No consultant profile for user ${userId}`);

      /*
       * A profile an administrator has taken down cannot be put back by its owner. If this
       * check were missing the member would undo the decision by pressing Publish again,
       * which would make it a suggestion rather than a moderation action — and nothing on
       * their screen would even tell them a decision had been made.
       */
      if (isPublic && row.admin_hidden_at) {
        return { published: false, completeness: row.completeness, adminHidden: true };
      }

      if (isPublic && row.completeness < MIN_COMPLETENESS_TO_PUBLISH) {
        return { published: false, completeness: row.completeness };
      }
      await conn.query('UPDATE consultant_profiles SET is_public = ? WHERE user_id = ?', [isPublic ? 1 : 0, userId]);
      return { published: Boolean(isPublic), completeness: row.completeness };
    });
  }

  static async recomputeCompleteness(userId) {
    const [[profile]] = await promisePool.query('SELECT * FROM consultant_profiles WHERE user_id = ?', [userId]);
    if (!profile) return 0;

    const [[counts]] = await promisePool.query(
      `SELECT
         (SELECT COUNT(*) FROM consultant_skills WHERE user_id = ?) AS skill_count,
         (SELECT COUNT(*) FROM consultant_certifications WHERE user_id = ?) AS certification_count,
         (SELECT COUNT(*) FROM consultant_projects WHERE user_id = ?) AS project_count`,
      [userId, userId, userId]
    );

    const completeness = completenessOf(profile, {
      skillCount: counts.skill_count,
      certificationCount: counts.certification_count,
      projectCount: counts.project_count
    });

    // Falling below the publishing floor un-publishes the profile rather than leaving a
    // hollow entry in the directory.
    const stayPublic = profile.is_public && completeness >= MIN_COMPLETENESS_TO_PUBLISH ? 1 : 0;
    await promisePool.query('UPDATE consultant_profiles SET completeness = ?, is_public = ? WHERE user_id = ?', [
      completeness,
      stayPublic,
      userId
    ]);

    /*
     * `profile_completed` is the other award config/community.js declared with nothing
     * paying it. This is the one choke point every edit already goes through, so it is
     * the only place it can be paid without a second definition of "complete".
     *
     * Settled rather than awarded, because completeness moves in both directions: a
     * consultant who deletes their certifications drops below the floor and is
     * un-published two lines above, and a ledger that paid for a profile the directory no
     * longer shows would be paying for nothing. A repeat call computes a difference of
     * zero, so the ordinary case of an unrelated edit writes no row at all.
     */
    await Points.settleTo(
      userId,
      'profile_completed',
      `profile:${userId}`,
      completeness >= MIN_COMPLETENESS_TO_PUBLISH ? POINT_AWARDS.profile_completed.points : 0
    );

    return completeness;
  }

  /**
   * Hide who somebody is from a reader who is not signed in.
   *
   * WHY THE DIRECTORY IS ANONYMOUS AT ALL. The consultants most worth talking to are the
   * ones currently working, and they are the ones with most to lose from a public listing
   * their employer can read. Being findable by companies must not mean being findable by
   * the one you already have. So everything that makes somebody HIREABLE stays visible —
   * role, modules delivered, experience, country, availability, rate — and everything that
   * makes them IDENTIFIABLE goes behind an account, which is free.
   *
   * It redacts rather than filters: the row is still counted, still ranked, still matched.
   * A directory that hid the people themselves would be a directory that lies about how
   * many there are.
   *
   * THE DEFAULT IS REDACTED. A caller that forgets to pass a viewer gets anonymity, which
   * is visible breakage rather than a leak. The name is removed from the OBJECT, not
   * hidden by the template, because a template that merely declines to print it still
   * shipped it to the browser in whatever else the page serialises.
   */
  static redactFor(row, viewerUserId = null) {
    if (!row) return row;
    if (Array.isArray(row)) return row.map((r) => ConsultantProfile.redactFor(r, viewerUserId));
    if (viewerUserId) return row;

    const redacted = { ...row };
    redacted.name = null;
    redacted.profile_picture = null;
    // The links are names by another route: a LinkedIn URL and an SAP Community handle
    // both identify a person as surely as the name above them.
    redacted.linkedin_url = null;
    redacted.website_url = null;
    redacted.sap_community_url = null;
    redacted.email = null;
    redacted.redacted = true;
    return redacted;
  }

  /**
   * The delivery history, with the parts that identify a person removed for a reader who
   * is not signed in.
   *
   * The engagements themselves are the most SAP-shaped thing on a profile — which modules,
   * which phase, how many full lifecycles — and none of that identifies anybody, so it is
   * public. The CLIENT is different: an employer's name beside a role, a country and a set
   * of dates narrows "who is this" to a handful of people, and often to one. So the client
   * is redacted exactly as the name is, by the same rule and in the same place.
   *
   * Same default as `redactFor`: no viewer means redacted.
   */
  static redactProjectsFor(projects, viewerUserId = null) {
    if (!Array.isArray(projects)) return projects;
    if (viewerUserId) return projects;
    return projects.map((project) => ({ ...project, client: null, clientRedacted: true }));
  }

  static async browse(filters = {}, { limit = 20, offset = 0, sort = 'relevance' } = {}) {
    const { clause, params } = buildFilter(filters);
    const orderBy = SORTS[sort] || SORTS.relevance;

    const [rows] = await promisePool.query(
      `SELECT cp.user_id, cp.headline, cp.primary_role, cp.seniority, cp.country, cp.city,
              cp.work_mode, cp.day_rate, cp.currency, cp.availability, cp.profile_picture,
              cp.linkedin_verified, cp.completeness, cp.full_lifecycles, u.name,
              (SELECT COUNT(*) FROM consultant_certifications cc WHERE cc.user_id = cp.user_id) AS certification_count
         FROM consultant_profiles cp JOIN users u ON u.id = cp.user_id
        WHERE ${clause}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const [[{ total }]] = await promisePool.query(
      `SELECT COUNT(*) AS total FROM consultant_profiles cp JOIN users u ON u.id = cp.user_id WHERE ${clause}`,
      params
    );

    return { rows, total };
  }

  /*
   * CERTIFICATIONS ARE CODED.
   *
   * Both references store one free-text `name`, which makes "SAP Certified Associate - SAP
   * S/4HANA Financial Accounting", "C_TS4FI" and "S4 FI cert" three different credentials
   * to any filter. Here the catalogue stem is stored and `custom_name` carries text only
   * for the reserved OTHER code — enforced by a CHECK in migration 002, because a UNIQUE
   * over a nullable expression permits duplicates in SQL.
   */
  static async listCertifications(userId) {
    const [rows] = await promisePool.query(
      'SELECT * FROM consultant_certifications WHERE user_id = ? ORDER BY earned_on IS NULL, earned_on DESC, code ASC',
      [userId]
    );
    return rows.map((row) => ({
      ...row,
      // The catalogue is the display authority: a renamed exam shows its new label on every
      // profile that holds it, rather than whatever the label said on the day it was added.
      label: row.code === OTHER_CODE ? row.custom_name : (certByCode(row.code) || {}).label || row.code
    }));
  }

  static async addCertification(userId, { code, customName = null, credentialId = null, earnedOn = null, expiresOn = null }) {
    if (!isCertificationCode(code)) {
      throw new Error(`Unknown certification code: ${code}`);
    }
    if (code === OTHER_CODE && !String(customName || '').trim()) {
      throw new Error('A certification outside the catalogue needs a name.');
    }

    const catalogued = certByCode(code);
    await promisePool.query(
      `INSERT INTO consultant_certifications (user_id, code, custom_name, tier, credential_id, earned_on, expires_on)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE credential_id = VALUES(credential_id), earned_on = VALUES(earned_on),
                               expires_on = VALUES(expires_on), tier = VALUES(tier)`,
      [
        userId,
        code,
        code === OTHER_CODE ? String(customName).trim() : null,
        catalogued ? catalogued.tier : null,
        credentialId,
        earnedOn,
        expiresOn
      ]
    );
    await ConsultantProfile.recomputeCompleteness(userId);
  }

  static async removeCertification(userId, certificationId) {
    await promisePool.query('DELETE FROM consultant_certifications WHERE id = ? AND user_id = ?', [certificationId, userId]);
    await ConsultantProfile.recomputeCompleteness(userId);
  }

  static async listExperiences(userId) {
    const [rows] = await promisePool.query(
      'SELECT * FROM consultant_work_experiences WHERE user_id = ? ORDER BY is_current DESC, started_on DESC',
      [userId]
    );
    return rows;
  }

  static async addExperience(userId, exp) {
    await promisePool.query(
      `INSERT INTO consultant_work_experiences (user_id, company, title, started_on, ended_on, is_current, description)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, exp.company, exp.title, exp.startedOn, exp.endedOn || null, exp.isCurrent ? 1 : 0, exp.description || null]
    );
    await ConsultantProfile.recomputeCompleteness(userId);
  }

  static async removeExperience(userId, experienceId) {
    await promisePool.query('DELETE FROM consultant_work_experiences WHERE id = ? AND user_id = ?', [experienceId, userId]);
    await ConsultantProfile.recomputeCompleteness(userId);
  }

  /**
   * Delivery history: the engagements themselves, as distinct from employment.
   *
   * A contractor's CV is mostly "which landscapes, which modules, which phase, what did you
   * actually ship" — the employer column matters far less than it does for a permanent
   * role, and for somebody through an agency it may be the same company on every line.
   *
   * Ordered by end date with anything still running first: a current engagement is the one
   * a reader wants at the top.
   */
  static async listProjects(userId) {
    const [rows] = await promisePool.query(
      `SELECT * FROM consultant_projects WHERE user_id = ?
        ORDER BY ended_on IS NULL DESC, ended_on DESC, started_on DESC`,
      [userId]
    );
    if (rows.length === 0) return [];

    const [modules] = await promisePool.query(
      'SELECT project_id, module_slug FROM consultant_project_modules WHERE project_id IN (?)',
      [rows.map((r) => r.id)]
    );
    const byProject = new Map();
    for (const row of modules) {
      const list = byProject.get(row.project_id) || [];
      list.push(row.module_slug);
      byProject.set(row.project_id, list);
    }
    return rows.map((row) => ({ ...row, modules: byProject.get(row.id) || [] }));
  }

  /**
   * One transaction for the project and its modules.
   *
   * The two writes are one fact. A project row that committed without its modules is a
   * delivery record that says nothing — and worse, it is invisible to the module filter in
   * `buildFilter`, so the consultant silently stops appearing in the searches that were the
   * reason for entering it.
   */
  static async addProject(userId, project) {
    const modules = (project.modules || []).filter((slug) => isModule(slug));

    await withTransaction(async (conn) => {
      const [result] = await conn.query(
        `INSERT INTO consultant_projects
           (user_id, name, client, product_line, role, activate_phase, is_full_lifecycle,
            started_on, ended_on, description)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          userId,
          project.name,
          project.client || null,
          project.productLine || null,
          project.role || null,
          project.activatePhase || null,
          project.isFullLifecycle ? 1 : 0,
          project.startedOn || null,
          project.endedOn || null,
          project.description || null
        ]
      );
      if (modules.length) {
        await conn.query('INSERT IGNORE INTO consultant_project_modules (project_id, module_slug) VALUES ?', [
          modules.map((slug) => [result.insertId, slug])
        ]);
      }
      return result.insertId;
    });

    await ConsultantProfile.recomputeCompleteness(userId);
  }

  /**
   * The distinct modules this consultant has actually delivered.
   *
   * One query, because it feeds the match score on every job page a signed-in consultant
   * opens. Derived from the delivery history rather than stored on the profile: a cached
   * list would need invalidating on every project edit, and the day it is missed is the
   * day somebody silently stops matching the jobs they are best suited to.
   */
  static async deliveredModules(userId) {
    const [rows] = await promisePool.query(
      `SELECT DISTINCT pm.module_slug
         FROM consultant_project_modules pm
         JOIN consultant_projects pr ON pr.id = pm.project_id
        WHERE pr.user_id = ?`,
      [userId]
    );
    return rows.map((r) => r.module_slug);
  }

  static async removeProject(userId, projectId) {
    // The modules go with it by FK cascade (migration 002).
    await promisePool.query('DELETE FROM consultant_projects WHERE id = ? AND user_id = ?', [projectId, userId]);
    await ConsultantProfile.recomputeCompleteness(userId);
  }
}

module.exports = ConsultantProfile;
