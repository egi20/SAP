'use strict';

const { promisePool } = require('../config/database');
const { slugify } = require('../utils/slug');

/**
 * A shared, deduplicated skill vocabulary.
 *
 * Skills are matched on SLUG, so "Apex", "apex" and " APEX " are one skill. Free-text
 * skills that each user spells their own way make skill filtering worthless.
 */
class Skill {
  static async findOrCreateMany(names, { category = null } = {}) {
    const unique = new Map();
    for (const raw of names || []) {
      const name = String(raw || '').trim();
      if (!name || name.length > 120) continue;
      const slug = slugify(name);
      if (slug && !unique.has(slug)) unique.set(slug, name);
    }
    if (unique.size === 0) return [];

    const values = [...unique.entries()].map(([slug, name]) => [slug, name, category]);
    await promisePool.query('INSERT IGNORE INTO skills (slug, name, category) VALUES ?', [values]);

    const [rows] = await promisePool.query('SELECT id, slug, name FROM skills WHERE slug IN (?)', [[...unique.keys()]]);
    return rows;
  }

  static async listPopular(limit = 40) {
    const [rows] = await promisePool.query(
      `SELECT s.id, s.slug, s.name, COUNT(cs.user_id) AS usage_count
         FROM skills s
         LEFT JOIN consultant_skills cs ON cs.skill_id = s.id
        GROUP BY s.id, s.slug, s.name
        ORDER BY usage_count DESC, s.name ASC
        LIMIT ?`,
      [limit]
    );
    return rows;
  }

  static async search(term, limit = 20) {
    const [rows] = await promisePool.query(
      'SELECT id, slug, name FROM skills WHERE name LIKE ? ORDER BY name ASC LIMIT ?',
      [`%${String(term || '').trim()}%`, limit]
    );
    return rows;
  }

  static async idsForConsultant(userId) {
    const [rows] = await promisePool.query('SELECT skill_id FROM consultant_skills WHERE user_id = ?', [userId]);
    return rows.map((r) => r.skill_id);
  }

  static async setForConsultant(userId, skillIds) {
    await promisePool.query('DELETE FROM consultant_skills WHERE user_id = ?', [userId]);
    if (!skillIds || skillIds.length === 0) return;
    const values = skillIds.map((id) => [userId, id, 'proficient']);
    await promisePool.query('INSERT IGNORE INTO consultant_skills (user_id, skill_id, level) VALUES ?', [values]);
  }

  static async setForJob(jobId, skillIds) {
    await promisePool.query('DELETE FROM job_skills WHERE job_id = ?', [jobId]);
    if (!skillIds || skillIds.length === 0) return;
    const values = skillIds.map((id) => [jobId, id, 1]);
    await promisePool.query('INSERT IGNORE INTO job_skills (job_id, skill_id, required) VALUES ?', [values]);
  }

  static async forJob(jobId) {
    const [rows] = await promisePool.query(
      `SELECT s.id, s.slug, s.name, js.required
         FROM job_skills js JOIN skills s ON s.id = js.skill_id
        WHERE js.job_id = ? ORDER BY s.name`,
      [jobId]
    );
    return rows;
  }

  static async forConsultant(userId) {
    const [rows] = await promisePool.query(
      `SELECT s.id, s.slug, s.name, cs.level
         FROM consultant_skills cs JOIN skills s ON s.id = cs.skill_id
        WHERE cs.user_id = ? ORDER BY s.name`,
      [userId]
    );
    return rows;
  }
}

module.exports = Skill;
