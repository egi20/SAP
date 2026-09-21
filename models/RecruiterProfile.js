'use strict';

const { promisePool } = require('../config/database');
const { uniqueSlug } = require('../utils/slug');
const { containsPattern } = require('../utils/likePattern');
const { PRODUCT_LINES, lineByValue } = require('../config/sapProducts');

/**
 * Agency and headhunter profiles.
 *
 * Two corrections to the reference implementation, both small and both real.
 *
 * 1. IT DOES NOT SELF-HEAL ON A GET. The reference's dashboard and profile handlers both
 *    do `if (!recruiter) recruiter = await RecruiterProfile.createForUser(...)`, so every
 *    page view is a potential INSERT. A read that writes is a read that cannot be cached,
 *    cannot be retried safely, and creates rows for anyone who merely looked. Here a
 *    profile is created by the POST that fills it in, and the page before that says so.
 *
 * 2. VALIDATION IS ACTUALLY APPLIED. The reference declares
 *    `body('agency_name').trim().isLength({ max: 200 })` and imports `validationResult` —
 *    and never calls it. The rules are decorative; a 10,000-character agency name reaches
 *    the column and MySQL truncates or errors depending on strict mode. Every value here
 *    goes through `normaliseProfile`, which is pure and tested.
 */

const LIMITS = Object.freeze({
  agencyName: 200,
  contactName: 200,
  tagline: 255,
  about: 4000,
  phone: 40,
  url: 255,
  city: 120,
  specialisms: 12
});

/**
 * What a profile needs before its owner may list it publicly.
 *
 * The same instinct as the consultant completeness gate: a directory of half-empty cards
 * teaches visitors that the directory is not worth reading.
 */
const REQUIRED_TO_PUBLISH = Object.freeze(['agency_name', 'about', 'country']);

/*
 * Specialisms are PRODUCT LINES, not individual modules.
 *
 * An agency recruits for "S/4HANA Finance", not for "Revenue Accounting (RAR / IFRS 15)".
 * The module-level list runs to fifty-seven entries and nobody would fill it in honestly;
 * at eight lines it is a set of tick boxes somebody actually completes. Derived from
 * config/sapProducts.js, so adding a product line adds a specialism with no edit here —
 * the same way it adds a community category.
 */
const SPECIALISM_OPTIONS = Object.freeze(
  PRODUCT_LINES.map((line) => ({ value: line.value, label: line.label }))
);

function text(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function block(value, max) {
  return String(value ?? '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

/**
 * Accept only an absolute http(s) URL, and store it normalised.
 *
 * A bare `example.com` typed into a website field becomes a RELATIVE link when rendered
 * in an anchor, so the visitor lands on `/recruiters/example.com` on this site rather than
 * on the agency's. `https://` is therefore added when — and only when — the value carries
 * NO scheme at all.
 *
 * Checking for a scheme first matters, and a test caught it: prepending unconditionally
 * turned `file:///etc/passwd` into `https://file///etc/passwd`, a link to a host that does
 * not exist. It was not dangerous, but it was silently not what the agency typed, and a
 * refusal they can see beats a value they cannot explain.
 */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function url(value) {
  const raw = text(value, LIMITS.url);
  if (!raw) return null;
  // A value that names a scheme must name an allowed one. Only a schemeless value is
  // completed.
  if (HAS_SCHEME.test(raw) && !/^https?:\/\//i.test(raw)) return null;

  let parsed;
  try {
    parsed = new URL(HAS_SCHEME.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname || !parsed.hostname.includes('.')) return null;
  return parsed.toString().slice(0, LIMITS.url);
}

/**
 * Coerce whatever the form posted into the row that will be written.
 *
 * Pure, exported and tested — so the rules cannot differ between the profile route and
 * anything else that ever writes a recruiter profile.
 */
function normaliseProfile(input = {}) {
  const agencyName = text(input.agency_name, LIMITS.agencyName);
  if (agencyName.length < 2) {
    const err = new Error('Please give your agency a name.');
    err.code = 'AGENCY_NAME_REQUIRED';
    throw err;
  }

  // Bounded generously and then pattern-checked, NEVER truncated to two characters.
  // `text(input.country, 2)` turns `DEU` into `DE` and `AUT` into Australia — the same
  // mistake this codebase already documents under Tax advisory, repeated here and caught
  // by a test. A refusal is visible; a truncation is wrong forever and silent.
  const country = text(input.country, 16).toUpperCase();

  // Validated against config/sapProducts.js rather than stored as typed: the directory
  // filters on these, and a free-text "SAP Finance" never matches "s4hana-finance".
  const submitted = Array.isArray(input.specialisms)
    ? input.specialisms
    : input.specialisms
      ? [input.specialisms]
      : [];
  const specialisms = [...new Set(submitted.filter((s) => Boolean(lineByValue(s))))].slice(0, LIMITS.specialisms);

  return {
    agency_name: agencyName,
    contact_name: text(input.contact_name, LIMITS.contactName) || null,
    tagline: text(input.tagline, LIMITS.tagline) || null,
    about: block(input.about, LIMITS.about) || null,
    phone: text(input.phone, LIMITS.phone) || null,
    website: url(input.website),
    linkedin_url: url(input.linkedin_url),
    country: /^[A-Z]{2}$/.test(country) ? country : null,
    city: text(input.city, LIMITS.city) || null,
    specialisms
  };
}

/** Which required fields are still empty. Pure, so the gate is testable. */
function missingForPublish(profile) {
  return REQUIRED_TO_PUBLISH.filter((field) => {
    const value = profile ? profile[field] : null;
    return value === null || value === undefined || String(value).trim() === '';
  });
}

class RecruiterProfile {
  static get LIMITS() {
    return LIMITS;
  }

  static get REQUIRED_TO_PUBLISH() {
    return REQUIRED_TO_PUBLISH;
  }

  static get SPECIALISM_OPTIONS() {
    return SPECIALISM_OPTIONS;
  }

  static normaliseProfile = normaliseProfile;

  static missingForPublish = missingForPublish;

  static async findByUserId(userId) {
    const [[row]] = await promisePool.query('SELECT * FROM recruiter_profiles WHERE user_id = ?', [userId]);
    if (!row) return null;
    return { ...row, specialisms: RecruiterProfile.parseSpecialisms(row.specialisms) };
  }

  static async findBySlug(slug) {
    const [[row]] = await promisePool.query(
      `SELECT rp.*, u.is_active
         FROM recruiter_profiles rp JOIN users u ON u.id = rp.user_id
        WHERE rp.slug = ? AND rp.is_public = 1 AND u.is_active = 1`,
      [slug]
    );
    if (!row) return null;
    return { ...row, specialisms: RecruiterProfile.parseSpecialisms(row.specialisms) };
  }

  /**
   * `JSON` columns come back parsed from mysql2, but a row written before the column
   * existed — or by hand — can arrive as a string. Tolerate both rather than throwing on
   * a page render.
   */
  static parseSpecialisms(value) {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string' || !value) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  static async slugTaken(candidate, exceptUserId = null) {
    const [rows] = await promisePool.query(
      'SELECT user_id FROM recruiter_profiles WHERE slug = ? AND user_id <> ? LIMIT 1',
      [candidate, exceptUserId || 0]
    );
    return rows.length > 0;
  }

  /**
   * Create or update. Called only from the POST — never from a page render.
   *
   * The slug follows the agency name, and is re-derived when the name changes. It is
   * unique-checked against the table rather than assumed, because two agencies called
   * "SAP Talent" is the ordinary case, not the odd one.
   */
  /*
   * A NOTE ON THE JSON COLUMN, because the obvious spelling is not portable.
   *
   * The reference writes `CAST(? AS JSON)`. That is MySQL 8 syntax and MariaDB rejects it
   * outright with a parse error — MariaDB's `JSON` is an alias for LONGTEXT with a
   * `json_valid()` CHECK, and it has no JSON cast target. Binding the serialised string
   * directly works on both: MySQL parses a valid JSON string into the column, MariaDB
   * stores it and the CHECK accepts it. This is the first place the MySQL-8-versus-MariaDB
   * caveat in docs/PORT-PLAN.md has actually bitten, and it was found by running the save
   * against a real database rather than by reading the query.
   */
  static async save(userId, input) {
    const fields = normaliseProfile(input);
    const existing = await RecruiterProfile.findByUserId(userId);

    const slug =
      existing && existing.agency_name === fields.agency_name
        ? existing.slug
        : await uniqueSlug(fields.agency_name, (candidate) => RecruiterProfile.slugTaken(candidate, userId));

    if (!existing) {
      await promisePool.query(
        `INSERT INTO recruiter_profiles
           (user_id, agency_name, slug, contact_name, tagline, about, phone, website,
            linkedin_url, country, city, specialisms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          userId, fields.agency_name, slug, fields.contact_name, fields.tagline, fields.about,
          fields.phone, fields.website, fields.linkedin_url, fields.country, fields.city,
          JSON.stringify(fields.specialisms)
        ]
      );
      return { created: true, slug };
    }

    await promisePool.query(
      `UPDATE recruiter_profiles
          SET agency_name = ?, slug = ?, contact_name = ?, tagline = ?, about = ?, phone = ?,
              website = ?, linkedin_url = ?, country = ?, city = ?, specialisms = ?
        WHERE user_id = ?`,
      [
        fields.agency_name, slug, fields.contact_name, fields.tagline, fields.about, fields.phone,
        fields.website, fields.linkedin_url, fields.country, fields.city,
        JSON.stringify(fields.specialisms), userId
      ]
    );
    return { created: false, slug };
  }

  /**
   * Publish or unpublish.
   *
   * Publishing is refused while a required field is empty, and the refusal NAMES the
   * fields — "complete your profile" with no list is the message people bounce off.
   */
  static async setPublic(userId, isPublic) {
    if (isPublic) {
      const profile = await RecruiterProfile.findByUserId(userId);
      const missing = missingForPublish(profile);
      if (missing.length) {
        const err = new Error(`Add these before listing your agency: ${missing.join(', ').replace(/_/g, ' ')}.`);
        err.code = 'INCOMPLETE_PROFILE';
        err.missing = missing;
        throw err;
      }
    }
    const [result] = await promisePool.query(
      'UPDATE recruiter_profiles SET is_public = ? WHERE user_id = ?',
      [isPublic ? 1 : 0, userId]
    );
    return result.affectedRows === 1;
  }

  static async setLogo(userId, pointerUrl) {
    await promisePool.query('UPDATE recruiter_profiles SET logo = ? WHERE user_id = ?', [pointerUrl, userId]);
  }

  /**
   * THE ONE FILTER BUILDER for the agency directory.
   *
   * Same shape as `CompanyProfile.browse` on purpose: the visibility rule
   * (`is_public = 1 AND u.is_active = 1`) lives here and nowhere else, so a list and its
   * count cannot describe different rows and the site search gets it for free.
   */
  static async browse({ q = '', country = '', specialism = '' } = {}, { limit = 20, offset = 0 } = {}) {
    const where = ['rp.is_public = 1', 'u.is_active = 1'];
    const params = [];

    if (q) {
      const like = containsPattern(q);
      where.push('(rp.agency_name LIKE ? OR rp.tagline LIKE ?)');
      params.push(like, like);
    }
    if (country) {
      where.push('rp.country = ?');
      params.push(String(country).toUpperCase().slice(0, 2));
    }
    if (specialism && lineByValue(specialism)) {
      // JSON_CONTAINS rather than a LIKE over the serialised array: `LIKE '%s4hana%'`
      // would also match "s4hana-supply-chain" when only "s4hana-finance" was asked for.
      where.push('JSON_CONTAINS(rp.specialisms, JSON_QUOTE(?))');
      params.push(specialism);
    }

    const clause = where.join(' AND ');
    const [rows] = await promisePool.query(
      `SELECT rp.user_id, rp.agency_name, rp.slug, rp.tagline, rp.country, rp.city, rp.logo,
              rp.specialisms,
              (SELECT COUNT(*) FROM jobs j WHERE j.company_user_id = rp.user_id AND j.status = 'open') AS open_jobs
         FROM recruiter_profiles rp JOIN users u ON u.id = rp.user_id
        WHERE ${clause}
        ORDER BY open_jobs DESC, rp.agency_name ASC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const [[{ total }]] = await promisePool.query(
      `SELECT COUNT(*) AS total FROM recruiter_profiles rp JOIN users u ON u.id = rp.user_id WHERE ${clause}`,
      params
    );

    return {
      rows: rows.map((r) => ({ ...r, specialisms: RecruiterProfile.parseSpecialisms(r.specialisms) })),
      total
    };
  }

  /**
   * The dashboard's numbers, read live.
   *
   * A recruiter's roles are ordinary `jobs` rows owned by their account, so these come
   * from the same tables the job board uses. No counter column: the reference's stats are
   * the only thing its dashboard shows, and a stale one would be the whole page.
   */
  static async statsFor(userId) {
    const [[row]] = await promisePool.query(
      `SELECT
         (SELECT COUNT(*) FROM jobs j WHERE j.company_user_id = ?)                        AS jobs_total,
         (SELECT COUNT(*) FROM jobs j WHERE j.company_user_id = ? AND j.status = 'open')  AS jobs_open,
         (SELECT COUNT(*) FROM applications a JOIN jobs j ON j.id = a.job_id
           WHERE j.company_user_id = ?)                                                   AS applications_total,
         (SELECT COUNT(*) FROM applications a JOIN jobs j ON j.id = a.job_id
           WHERE j.company_user_id = ? AND a.status = 'submitted')                        AS applications_new`,
      [userId, userId, userId, userId]
    );
    return row;
  }
}

module.exports = RecruiterProfile;
