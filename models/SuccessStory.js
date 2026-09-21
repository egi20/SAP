'use strict';

const { promisePool } = require('../config/database');
const { uniqueSlug } = require('../utils/slug');
const { containsPattern } = require('../utils/likePattern');
const { lineByValue } = require('../config/sapProducts');
const { sanitizeRichText } = require('../utils/sanitize');

/**
 * Editorial case studies, written by an administrator.
 *
 * TWO DEPARTURES FROM THE REFERENCE, and the first one is the point of the feature.
 *
 * 1. NO MONEY. The reference's stories carry `gross_before`, `net_before`, `gross_after`
 *    and `net_after`, and its tax page filters to the ones that have all four so it can
 *    render the difference as a monthly saving. That is the savings calculator this
 *    codebase refuses, wearing a different hat — and worse, presented as somebody's real
 *    pay. A testimonial saying "we shipped in nine weeks" is evidence. One saying "I went
 *    from 3,400 to 5,700" is a financial claim the Hub cannot stand behind, about a person
 *    who is named on the page.
 *
 * 2. The photo goes in the shared blob store, and the video URL is converted to an embed
 *    at RENDER time by `utils/videoEmbed.js` rather than stored as a derived value.
 */

const LIMITS = Object.freeze({
  title: 200,
  subject: 200,
  summary: 500,
  quote: 600,
  body: 40_000,
  videoUrl: 500
});

function text(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

class SuccessStory {
  static get LIMITS() {
    return LIMITS;
  }

  /**
   * THE ONE FILTER BUILDER for stories.
   *
   * `published_at IS NOT NULL AND hidden_at IS NULL` is a fixed fragment, and the only
   * opt-in is `include_unpublished`, used solely by the admin screens. Same rule as
   * `Post.buildFilter`: one builder, so a list and its count cannot disagree about what
   * is in scope.
   */
  static buildFilter(filters = {}) {
    const clauses = [];
    const params = [];

    if (!filters.include_unpublished) {
      clauses.push('s.published_at IS NOT NULL', 's.hidden_at IS NULL');
    }

    if (filters.family && lineByValue(filters.family)) {
      clauses.push('s.family = ?');
      params.push(filters.family);
    }

    if (filters.q && String(filters.q).trim()) {
      const like = containsPattern(filters.q);
      clauses.push('(s.title LIKE ? OR s.summary LIKE ? OR s.subject_name LIKE ?)');
      params.push(like, like, like);
    }

    return { clause: clauses.length ? clauses.join(' AND ') : '1 = 1', params };
  }

  /**
   * Validate and shape a submission. Pure and exported, so the admin route and anything
   * else that ever writes a story share one set of rules.
   */
  static normalise(input = {}) {
    const title = text(input.title, LIMITS.title);
    if (title.length < 3) {
      const err = new Error('A story needs a title.');
      err.code = 'TITLE_REQUIRED';
      throw err;
    }

    const rawBody = String(input.body ?? '').slice(0, LIMITS.body);
    // `sanitizeRichText` is the only thing whose output may reach `<%- %>`. An admin is
    // trusted to write a case study; they are not trusted to paste a `<script>` they
    // copied out of somebody's CMS.
    const body = sanitizeRichText(rawBody);
    if (!body.trim()) {
      const err = new Error('A story needs a body.');
      err.code = 'BODY_REQUIRED';
      throw err;
    }

    const family = text(input.family, 64);

    return {
      title,
      subject_name: text(input.subject_name, LIMITS.subject) || null,
      subject_role: text(input.subject_role, LIMITS.subject) || null,
      summary: text(input.summary, LIMITS.summary) || null,
      body,
      quote: text(input.quote, LIMITS.quote) || null,
      quote_author: text(input.quote_author, LIMITS.subject) || null,
      family: lineByValue(family) ? family : null,
      // Stored exactly as typed. It is only ever rendered through `embedUrlFor`, which
      // refuses anything it does not recognise, so an unusable value is visibly missing
      // rather than silently framed.
      video_url: text(input.video_url, LIMITS.videoUrl) || null
    };
  }

  static async slugTaken(candidate, exceptId = null) {
    const [rows] = await promisePool.query(
      'SELECT id FROM success_stories WHERE slug = ? AND id <> ? LIMIT 1',
      [candidate, exceptId || 0]
    );
    return rows.length > 0;
  }

  static async create(input, { actorUserId = null } = {}) {
    const fields = SuccessStory.normalise(input);
    const slug = await uniqueSlug(fields.title, (candidate) => SuccessStory.slugTaken(candidate));

    const [result] = await promisePool.query(
      `INSERT INTO success_stories
         (slug, title, subject_name, subject_role, summary, body, quote, quote_author,
          family, video_url, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        slug, fields.title, fields.subject_name, fields.subject_role, fields.summary,
        fields.body, fields.quote, fields.quote_author, fields.family, fields.video_url,
        actorUserId
      ]
    );
    return { id: result.insertId, slug };
  }

  static async update(id, input) {
    const fields = SuccessStory.normalise(input);
    const existing = await SuccessStory.findById(id);
    if (!existing) {
      const err = new Error('That story no longer exists.');
      err.code = 'NOT_FOUND';
      throw err;
    }

    const slug =
      existing.title === fields.title
        ? existing.slug
        : await uniqueSlug(fields.title, (candidate) => SuccessStory.slugTaken(candidate, id));

    await promisePool.query(
      `UPDATE success_stories
          SET slug = ?, title = ?, subject_name = ?, subject_role = ?, summary = ?, body = ?,
              quote = ?, quote_author = ?, family = ?, video_url = ?
        WHERE id = ?`,
      [
        slug, fields.title, fields.subject_name, fields.subject_role, fields.summary,
        fields.body, fields.quote, fields.quote_author, fields.family, fields.video_url, id
      ]
    );
    return { id, slug };
  }

  /**
   * Publish, unpublish, hide and restore — four states from two nullable timestamps, and
   * NO delete.
   *
   * Same rule as every other piece of content here: a hide is reversible and a delete is
   * not. The reference's `SiteReview.delete` is a hard DELETE reachable from a bulk action
   * on a list view; this codebase does not have that verb for content anywhere.
   */
  static async setPublished(id, published) {
    const [result] = await promisePool.query(
      'UPDATE success_stories SET published_at = ? WHERE id = ?',
      [published ? new Date() : null, id]
    );
    return result.affectedRows === 1;
  }

  static async setHidden(id, hidden) {
    const [result] = await promisePool.query(
      'UPDATE success_stories SET hidden_at = ? WHERE id = ?',
      [hidden ? new Date() : null, id]
    );
    return result.affectedRows === 1;
  }

  static async setPhoto(id, pointerUrl) {
    await promisePool.query('UPDATE success_stories SET photo = ? WHERE id = ?', [pointerUrl, id]);
  }

  static async findById(id) {
    const [[row]] = await promisePool.query('SELECT * FROM success_stories WHERE id = ?', [id]);
    return row || null;
  }

  /**
   * One published story by slug.
   *
   * Re-checks published and not-hidden here rather than trusting that the list was the
   * only way in — a slug is guessable and a link outlives an unpublish.
   */
  static async findPublishedBySlug(slug) {
    const [[row]] = await promisePool.query(
      'SELECT * FROM success_stories WHERE slug = ? AND published_at IS NOT NULL AND hidden_at IS NULL',
      [slug]
    );
    return row || null;
  }

  static async list(filters = {}, { limit = 20, offset = 0 } = {}) {
    const { clause, params } = SuccessStory.buildFilter(filters);

    const [rows] = await promisePool.query(
      `SELECT s.id, s.slug, s.title, s.subject_name, s.subject_role, s.summary, s.quote,
              s.quote_author, s.family, s.video_url, s.photo, s.published_at, s.hidden_at,
              s.created_at
         FROM success_stories s
        WHERE ${clause}
        ORDER BY COALESCE(s.published_at, s.created_at) DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const [[{ total }]] = await promisePool.query(
      `SELECT COUNT(*) AS total FROM success_stories s WHERE ${clause}`,
      params
    );
    return { rows, total };
  }
}

module.exports = SuccessStory;
