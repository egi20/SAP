'use strict';

const crypto = require('crypto');
const sharp = require('sharp');
const { promisePool } = require('../config/database');

/**
 * Durable image storage.
 *
 * The application host's disk is ephemeral, so uploaded bytes live in MySQL. They live
 * in a SEPARATE table from the profile they belong to, because profile and talent-list
 * queries select whole rows and inlining megabytes of image data would drag them into
 * every list query.
 *
 * The owning row stores only a pointer URL carrying a cache-busting `?v=<timestamp>`,
 * and the serving route is ETag-cached.
 */
/**
 * The blob tables, and the column each keys on.
 *
 * A map rather than a set because not every owner is a user: a success story's photo
 * belongs to the story, which has no account behind it. The column name is taken from
 * here and interpolated into the SQL, which is safe precisely BECAUSE it comes from this
 * frozen list and never from a caller — every VALUE is still parameterised.
 */
const ALLOWED_TABLES = Object.freeze({
  consultant_photos: 'user_id',
  company_logos: 'user_id',
  recruiter_logos: 'user_id',
  story_photos: 'story_id'
});

function ownerColumn(table) {
  // hasOwnProperty, not a truthiness check: `ALLOWED_TABLES['__proto__']` is
  // `Object.prototype`, which is truthy — the same trap `config/settings.js` documents.
  if (!Object.prototype.hasOwnProperty.call(ALLOWED_TABLES, table)) {
    throw new Error(`Unknown blob table: ${table}`);
  }
  return ALLOWED_TABLES[table];
}

function assertTable(table) {
  ownerColumn(table);
  return table;
}

class ImageBlob {
  /**
   * Normalise an upload to a bounded WebP and store it.
   * Re-encoding is also the sanitiser: whatever metadata, polyglot payload or
   * oversized canvas arrived, what gets stored is what sharp produced.
   */
  static async put(table, ownerId, buffer, { size = 512 } = {}) {
    assertTable(table);

    const bytes = await sharp(buffer)
      .rotate() // honour EXIF orientation before stripping the EXIF
      .resize(size, size, { fit: 'cover', position: 'attention' })
      .webp({ quality: 82 })
      .toBuffer();

    const etag = crypto.createHash('md5').update(bytes).digest('hex');

    await promisePool.query(
      `INSERT INTO ${table} (${ownerColumn(table)}, content_type, bytes, byte_size, etag)
       VALUES (?, 'image/webp', ?, ?, ?)
       ON DUPLICATE KEY UPDATE bytes = VALUES(bytes), byte_size = VALUES(byte_size),
                               etag = VALUES(etag), content_type = VALUES(content_type)`,
      [ownerId, bytes, bytes.length, etag]
    );

    return { etag, byteSize: bytes.length };
  }

  static async get(table, ownerId) {
    assertTable(table);
    const [rows] = await promisePool.query(
      `SELECT content_type, bytes, etag, updated_at FROM ${table} WHERE ${ownerColumn(table)} = ? LIMIT 1`,
      [ownerId]
    );
    return rows[0] || null;
  }

  /** ETag only, for a cheap conditional-request answer without loading the bytes. */
  static async getEtag(table, ownerId) {
    assertTable(table);
    const [rows] = await promisePool.query(
      `SELECT etag FROM ${table} WHERE ${ownerColumn(table)} = ? LIMIT 1`,
      [ownerId]
    );
    return rows.length ? rows[0].etag : null;
  }

  static async remove(table, ownerId) {
    assertTable(table);
    await promisePool.query(`DELETE FROM ${table} WHERE ${ownerColumn(table)} = ?`, [ownerId]);
  }

  /** Pointer URL with a cache buster, stored on the owning profile row. */
  static pointerUrl(basePath, ownerId) {
    return `${basePath}/${ownerId}?v=${Date.now()}`;
  }
}

module.exports = ImageBlob;
