'use strict';

const { promisePool } = require('../config/database');
const { containsPattern } = require('../utils/likePattern');
const { uniqueSlug } = require('../utils/slug');

class CompanyProfile {
  static async findByUserId(userId) {
    const [rows] = await promisePool.query(
      `SELECT cp.*, u.name AS owner_name, u.email AS owner_email
         FROM company_profiles cp JOIN users u ON u.id = cp.user_id
        WHERE cp.user_id = ? LIMIT 1`,
      [userId]
    );
    return rows[0] || null;
  }

  static async findBySlug(slug) {
    const [rows] = await promisePool.query(
      `SELECT cp.*, u.is_active
         FROM company_profiles cp JOIN users u ON u.id = cp.user_id
        WHERE cp.slug = ? LIMIT 1`,
      [slug]
    );
    return rows[0] || null;
  }

  static async slugTaken(slug, exceptUserId = null) {
    const [rows] = await promisePool.query(
      'SELECT user_id FROM company_profiles WHERE slug = ? LIMIT 1',
      [slug]
    );
    if (rows.length === 0) return false;
    return exceptUserId === null || rows[0].user_id !== exceptUserId;
  }

  /** Create on first use, deriving a unique slug from the company name. */
  static async ensureExists(userId, companyName) {
    const existing = await CompanyProfile.findByUserId(userId);
    if (existing) return existing;

    const slug = await uniqueSlug(companyName || `company-${userId}`, (candidate) =>
      CompanyProfile.slugTaken(candidate, userId)
    );
    await promisePool.query('INSERT INTO company_profiles (user_id, company_name, slug) VALUES (?, ?, ?)', [
      userId,
      companyName || `Company ${userId}`,
      slug
    ]);
    return CompanyProfile.findByUserId(userId);
  }

  static async update(userId, fields) {
    const allowed = [
      'company_name', 'tagline', 'about', 'industry', 'company_size',
      'company_type', 'website', 'linkedin_url', 'country', 'city', 'is_public'
    ];

    const sets = [];
    const params = [];
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(fields, key)) {
        sets.push(`${key} = ?`);
        params.push(fields[key]);
      }
    }

    // Renaming the company re-derives the slug, but only when it would actually change,
    // so an unrelated edit never breaks existing links.
    if (fields.company_name) {
      const current = await CompanyProfile.findByUserId(userId);
      const desired = await uniqueSlug(fields.company_name, (candidate) => CompanyProfile.slugTaken(candidate, userId));
      if (current && current.slug !== desired && !current.slug.startsWith(desired)) {
        sets.push('slug = ?');
        params.push(desired);
      }
    }

    if (sets.length === 0) return CompanyProfile.findByUserId(userId);
    params.push(userId);
    await promisePool.query(`UPDATE company_profiles SET ${sets.join(', ')} WHERE user_id = ?`, params);
    return CompanyProfile.findByUserId(userId);
  }

  static async setLogo(userId, pointerUrl) {
    await promisePool.query('UPDATE company_profiles SET logo = ? WHERE user_id = ?', [pointerUrl, userId]);
  }

  static async browse({ q = '', company_type = '', country = '' } = {}, { limit = 20, offset = 0 } = {}) {
    const where = ['cp.is_public = 1', 'u.is_active = 1'];
    const params = [];

    if (q) {
      where.push('(cp.company_name LIKE ? OR cp.tagline LIKE ?)');
      const like = containsPattern(q);
      params.push(like, like);
    }
    if (company_type) {
      where.push('cp.company_type = ?');
      params.push(company_type);
    }
    if (country) {
      where.push('cp.country = ?');
      params.push(country);
    }

    const clause = where.join(' AND ');
    const [rows] = await promisePool.query(
      `SELECT cp.user_id, cp.company_name, cp.slug, cp.tagline, cp.industry, cp.company_size,
              cp.company_type, cp.country, cp.city, cp.logo,
              (SELECT COUNT(*) FROM jobs j WHERE j.company_user_id = cp.user_id AND j.status = 'open') AS open_jobs
         FROM company_profiles cp JOIN users u ON u.id = cp.user_id
        WHERE ${clause}
        ORDER BY open_jobs DESC, cp.company_name ASC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const [[{ total }]] = await promisePool.query(
      `SELECT COUNT(*) AS total FROM company_profiles cp JOIN users u ON u.id = cp.user_id WHERE ${clause}`,
      params
    );
    return { rows, total };
  }
}

module.exports = CompanyProfile;
