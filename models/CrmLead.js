'use strict';

const { promisePool, withTransaction } = require('../config/database');
const CrmSuppression = require('./CrmSuppression');
const { containsPattern } = require('../utils/likePattern');
const {
  LIMITS,
  STALE_AFTER_DAYS,
  CONTACT_OUTCOMES,
  canTransition,
  isChannel,
  isOutcome,
  isSource,
  isStatus,
  isLeadProductLine,
  sourceNeedsDetail
} = require('../config/crm');

/**
 * Leads.
 *
 * The suppression list is consulted on EVERY write path — the form, the import, and the
 * draft screen — rather than only when something is about to go out. Checking at send time
 * is too late: by then the address is already in the database, already in an export, and
 * already in somebody's list.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function text(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function block(value, max) {
  return String(value ?? '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

/**
 * A URL, or nothing. Never a half-parsed string: a `javascript:` scheme reaching an href
 * on an internal screen is still an internal screen somebody clicks on.
 */
function url(value) {
  const raw = text(value, LIMITS.url);
  if (!raw) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:\/\//i.test(raw)) return null;
  try {
    const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!parsed.hostname.includes('.')) return null;
    return parsed.toString().slice(0, LIMITS.url);
  } catch {
    return null;
  }
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

function parseProductLines(value) {
  // mysql2 returns a JSON column parsed, but a row written before the column existed — or
  // by hand — can arrive as a string. Tolerate both rather than throwing on a page render.
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function selectedProductLines(input) {
  const raw = Array.isArray(input) ? input : [input].filter(Boolean);
  return [...new Set(raw.filter(isLeadProductLine))];
}

/**
 * Validate a lead. Pure and exported, so the form, the CSV import and anything else that
 * ever writes one share exactly the same rules — the source requirement above all.
 */
function normaliseLead(input = {}) {
  const company = text(input.company, LIMITS.company);
  if (company.length < 2) fail('COMPANY_REQUIRED', 'A lead needs a company name.');

  if (!isSource(input.source)) {
    fail('SOURCE_REQUIRED', 'Choose where this contact came from. A lead cannot be saved without one.');
  }

  const sourceDetail = text(input.source_detail, LIMITS.sourceDetail);
  if (sourceNeedsDetail(input.source) && sourceDetail.length < 3) {
    fail('SOURCE_DETAIL_REQUIRED', 'Say specifically where it came from — the category on its own is not an answer.');
  }

  const email = text(input.contact_email, LIMITS.email).toLowerCase();
  if (email && !EMAIL_RE.test(email)) fail('EMAIL_INVALID', `"${email}" is not an address anybody could write to.`);

  const country = text(input.country, 16).toUpperCase();

  return {
    company,
    contact_name: text(input.contact_name, LIMITS.contactName) || null,
    contact_email: email || null,
    contact_phone: text(input.contact_phone, LIMITS.phone) || null,
    job_title: text(input.job_title, LIMITS.jobTitle) || null,
    /*
     * Refused rather than truncated, the same rule as an agency's country: `text(x, 2)`
     * turns `DEU` into Germany by luck and `AUT` into Australia by accident.
     */
    country: /^[A-Z]{2}$/.test(country) ? country : null,
    website: url(input.website),
    linkedin_url: url(input.linkedin_url),
    product_lines: selectedProductLines(input.product_lines),
    source: input.source,
    source_detail: sourceDetail || null
  };
}

class CrmLead {
  static normaliseLead = normaliseLead;

  static parseProductLines = parseProductLines;

  static hydrate(row) {
    return row ? { ...row, product_lines: parseProductLines(row.product_lines) } : null;
  }

  /**
   * THE ONE FILTER BUILDER for leads.
   *
   * The list, its count, the CSV export AND the bulk actions all go through it. That last
   * one is why the rule exists at all: a bulk delete and the screen that showed what it
   * would delete must provably target the same rows.
   */
  static buildFilter(filters = {}) {
    const clauses = [];
    const params = [];

    if (filters.status && isStatus(filters.status)) {
      clauses.push('l.status = ?');
      params.push(filters.status);
    }
    if (filters.source && isSource(filters.source)) {
      clauses.push('l.source = ?');
      params.push(filters.source);
    }
    if (filters.country) {
      clauses.push('l.country = ?');
      params.push(String(filters.country).toUpperCase().slice(0, 2));
    }
    if (filters.product_line && isLeadProductLine(filters.product_line)) {
      // JSON_CONTAINS + JSON_QUOTE, not a LIKE over the serialised array: `LIKE
      // '%s4hana%'` would match `s4hana-supply-chain` when only `s4hana-finance` was asked
      // for. Same rule as the agency directory.
      clauses.push('JSON_CONTAINS(l.product_lines, JSON_QUOTE(?))');
      params.push(filters.product_line);
    }
    if (filters.owner_user_id) {
      clauses.push('l.owner_user_id = ?');
      params.push(Number.parseInt(filters.owner_user_id, 10) || 0);
    }
    if (filters.unowned) {
      clauses.push('l.owner_user_id IS NULL');
    }
    if (filters.stale) {
      clauses.push('(l.last_activity_at IS NULL OR l.last_activity_at < (NOW() - INTERVAL ? DAY))');
      params.push(STALE_AFTER_DAYS);
    }
    if (filters.q && String(filters.q).trim()) {
      const like = containsPattern(filters.q);
      clauses.push('(l.company LIKE ? OR l.contact_name LIKE ? OR l.contact_email LIKE ?)');
      params.push(like, like, like);
    }

    return { clause: clauses.length ? clauses.join(' AND ') : '1 = 1', params };
  }

  /**
   * Create one, or update the one that already holds this address.
   *
   * REFUSES A SUPPRESSED ADDRESS OUTRIGHT — not "creates it flagged". A row that exists is
   * a row that appears in an export, gets assigned to somebody, and is eventually written
   * to by whoever did not read the flag.
   *
   * THE SOURCE IS FIRST-TOUCH AND IS NEVER OVERWRITTEN. A later import can correct a phone
   * number; it cannot rewrite where the contact came from, because that is the lawful-basis
   * record and a record a later file can change is not one. When the two disagree the
   * second answer is written to the activity log, where it is visible and dated instead of
   * silently replacing the first. Same argument as `referral_attributions` being
   * first-touch, once, and permanent.
   */
  static async upsert(input, { actorUserId = null } = {}) {
    const fields = normaliseLead(input);

    if (fields.contact_email && (await CrmSuppression.has(fields.contact_email))) {
      fail('SUPPRESSED', 'That address is on the do-not-contact list and cannot be added.');
    }

    return withTransaction(async (conn) => {
      if (fields.contact_email) {
        const [[existing]] = await conn.query(
          'SELECT id, source, source_detail FROM crm_leads WHERE contact_email = ? FOR UPDATE',
          [fields.contact_email]
        );
        if (existing) {
          await conn.query(
            `UPDATE crm_leads
                SET company = ?, contact_name = ?, contact_phone = ?, job_title = ?,
                    country = ?, website = ?, linkedin_url = ?, product_lines = ?
              WHERE id = ?`,
            [
              fields.company, fields.contact_name, fields.contact_phone, fields.job_title,
              fields.country, fields.website, fields.linkedin_url,
              JSON.stringify(fields.product_lines), existing.id
            ]
          );

          const sameSource =
            existing.source === fields.source && (existing.source_detail || '') === (fields.source_detail || '');
          if (!sameSource) {
            await conn.query(
              `INSERT INTO crm_lead_activities (lead_id, actor_user_id, outcome, note)
               VALUES (?, ?, 'note', ?)`,
              [
                existing.id,
                actorUserId,
                `Seen again, this time as "${fields.source}"${fields.source_detail ? `: ${fields.source_detail}` : ''}. ` +
                  `The recorded source stays "${existing.source}".`
              ]
            );
          }

          return { id: existing.id, created: false, sourceKept: !sameSource };
        }
      }

      /*
       * The serialised string is bound directly rather than through `CAST(? AS JSON)`.
       * That spelling is MySQL-only: MariaDB's JSON is an alias for LONGTEXT with a
       * `json_valid()` CHECK and has no cast target, so it rejects the query outright.
       * Binding the string works on both.
       */
      const [result] = await conn.query(
        `INSERT INTO crm_leads
           (company, contact_name, contact_email, contact_phone, job_title, country,
            website, linkedin_url, product_lines, source, source_detail, created_by, owner_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          fields.company, fields.contact_name, fields.contact_email, fields.contact_phone,
          fields.job_title, fields.country, fields.website, fields.linkedin_url,
          JSON.stringify(fields.product_lines), fields.source, fields.source_detail,
          actorUserId, actorUserId
        ]
      );
      return { id: result.insertId, created: true, sourceKept: false };
    });
  }

  /**
   * Move a lead along, writing the activity in the same transaction.
   *
   * MOVING TO `unsubscribed` DOES THREE THINGS AT ONCE, and they are one transaction
   * because any two of them without the third is a half-kept promise:
   *
   *  1. writes the suppression, so a re-import cannot put them back;
   *  2. ERASES the contact details from the lead row — name, address, phone, job title,
   *     LinkedIn — because "never contact me again" is not answered by keeping the file
   *     and promising not to read it;
   *  3. keeps the company and the activity log, which carry no personal data and are the
   *     record that answers a question about what was sent and when.
   *
   * This is the same shape as `models/AccountClosure.js`: erase the identity, keep the
   * record. The reference keeps the row intact and relies on the status being read, which
   * works exactly until somebody writes a query that forgets to.
   */
  static async setStatus(id, to, { actorUserId = null, note = null, channel = null } = {}) {
    if (!isStatus(to)) fail('BAD_STATUS', 'That is not a status a lead can be in.');

    return withTransaction(async (conn) => {
      const [[lead]] = await conn.query(
        'SELECT id, status, contact_email FROM crm_leads WHERE id = ? FOR UPDATE',
        [id]
      );
      if (!lead) fail('NOT_FOUND', 'That lead no longer exists.');
      if (!canTransition(lead.status, to)) {
        fail('BAD_TRANSITION', `A lead cannot go from "${lead.status}" to "${to}".`);
      }

      await conn.query('UPDATE crm_leads SET status = ?, last_activity_at = NOW() WHERE id = ?', [to, id]);

      await conn.query(
        `INSERT INTO crm_lead_activities
           (lead_id, actor_user_id, channel, outcome, from_status, to_status, note)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          actorUserId,
          isChannel(channel) ? channel : null,
          to === 'unsubscribed' ? 'refused' : 'note',
          lead.status,
          to,
          note ? block(note, LIMITS.note) : null
        ]
      );

      let erased = false;
      if (to === 'unsubscribed') {
        if (lead.contact_email) {
          await conn.query(
            'INSERT IGNORE INTO crm_suppressions (email_hash, reason, note, created_by) VALUES (?, ?, ?, ?)',
            [
              CrmSuppression.hashOf(lead.contact_email),
              'requested',
              note ? String(note).slice(0, 500) : null,
              actorUserId
            ]
          );
        }

        await conn.query(
          `UPDATE crm_leads
              SET contact_name = NULL, contact_email = NULL, contact_phone = NULL,
                  job_title = NULL, linkedin_url = NULL, owner_user_id = NULL,
                  erased_at = NOW()
            WHERE id = ?`,
          [id]
        );
        erased = true;
      }

      return { id, from: lead.status, to, erased };
    });
  }

  /** Record what happened. Append-only; the counter moves in the same transaction. */
  static async addActivity(id, { outcome, channel = null, note = null, actorUserId = null }) {
    if (!isOutcome(outcome)) fail('BAD_OUTCOME', 'Choose what happened.');

    return withTransaction(async (conn) => {
      const [[lead]] = await conn.query('SELECT id FROM crm_leads WHERE id = ? FOR UPDATE', [id]);
      if (!lead) fail('NOT_FOUND', 'That lead no longer exists.');

      await conn.query(
        'INSERT INTO crm_lead_activities (lead_id, actor_user_id, channel, outcome, note) VALUES (?, ?, ?, ?, ?)',
        [id, actorUserId, isChannel(channel) ? channel : null, outcome, note ? block(note, LIMITS.note) : null]
      );
      await conn.query('UPDATE crm_leads SET last_activity_at = NOW() WHERE id = ?', [id]);
      return true;
    });
  }

  /** Claim it, or put it back. `null` releases. */
  static async setOwner(id, ownerUserId) {
    const [result] = await promisePool.query('UPDATE crm_leads SET owner_user_id = ? WHERE id = ?', [
      ownerUserId || null,
      id
    ]);
    return result.affectedRows === 1;
  }

  static async findById(id) {
    const [[row]] = await promisePool.query('SELECT * FROM crm_leads WHERE id = ?', [id]);
    return CrmLead.hydrate(row);
  }

  static async activitiesFor(id) {
    const [rows] = await promisePool.query(
      `SELECT a.*, COALESCE(NULLIF(TRIM(u.name), ''), 'system') AS actor_name
         FROM crm_lead_activities a
         LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE a.lead_id = ?
        ORDER BY a.created_at DESC, a.id DESC`,
      [id]
    );
    return rows;
  }

  /** Has anybody actually written to or spoken to this person? */
  static async hasBeenContacted(id) {
    const [[row]] = await promisePool.query(
      `SELECT COUNT(*) AS total FROM crm_lead_activities
        WHERE lead_id = ? AND outcome IN (${CONTACT_OUTCOMES.map(() => '?').join(',')})`,
      [id, ...CONTACT_OUTCOMES]
    );
    return Number(row.total) > 0;
  }

  static async list(filters = {}, { limit = 50, offset = 0 } = {}) {
    const { clause, params } = CrmLead.buildFilter(filters);

    const [rows] = await promisePool.query(
      `SELECT l.*, NULLIF(TRIM(u.name), '') AS owner_name
         FROM crm_leads l
         LEFT JOIN users u ON u.id = l.owner_user_id
        WHERE ${clause}
        ORDER BY COALESCE(l.last_activity_at, l.created_at) DESC, l.id DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const [[{ total }]] = await promisePool.query(
      `SELECT COUNT(*) AS total FROM crm_leads l WHERE ${clause}`,
      params
    );
    return { rows: rows.map(CrmLead.hydrate), total: Number(total) };
  }

  /** Counts per status for the board header. Derived, never cached. */
  static async statusCounts() {
    const [rows] = await promisePool.query('SELECT status, COUNT(*) AS total FROM crm_leads GROUP BY status');
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.total)]));
  }

  /**
   * Delete the rows a filter matches, with two interlocks.
   *
   * `expectedCount` is the number the screen showed; if the filtered set has changed since
   * — somebody imported, somebody deleted — this aborts and changes nothing.
   *
   * The second interlock is this project's own: A LEAD SOMEBODY HAS ACTUALLY CONTACTED IS
   * NOT DELETED HERE. Its activity log is the record that answers a complaint about that
   * contact, and the log cascades with the row. Those leads are reported back by id rather
   * than silently skipped, so the screen can say which and why; the way to remove one is
   * `unsubscribed`, which erases the person and keeps the record.
   *
   * Deleting never removes a suppression. `crm_suppressions` has no foreign key here for
   * exactly that reason.
   */
  static async deleteFiltered(filters, expectedCount) {
    const { clause, params } = CrmLead.buildFilter(filters);

    return withTransaction(async (conn) => {
      const [[{ total }]] = await conn.query(`SELECT COUNT(*) AS total FROM crm_leads l WHERE ${clause}`, params);

      if (Number.isInteger(expectedCount) && total !== expectedCount) {
        const err = new Error(
          `The filter now matches ${total} leads, not ${expectedCount}. Nothing was deleted — reload and check.`
        );
        err.code = 'BULK_COUNT_MISMATCH';
        err.actual = total;
        throw err;
      }

      const [contacted] = await conn.query(
        `SELECT l.id FROM crm_leads l
          WHERE ${clause}
            AND EXISTS (SELECT 1 FROM crm_lead_activities a
                         WHERE a.lead_id = l.id
                           AND a.outcome IN (${CONTACT_OUTCOMES.map(() => '?').join(',')}))`,
        [...params, ...CONTACT_OUTCOMES]
      );
      const keep = contacted.map((r) => r.id);

      const skipClause = keep.length ? ` AND l.id NOT IN (${keep.map(() => '?').join(',')})` : '';
      const [result] = await conn.query(`DELETE l FROM crm_leads l WHERE ${clause}${skipClause}`, [
        ...params,
        ...keep
      ]);

      return { deleted: result.affectedRows, kept: keep.length };
    });
  }

  /** Park the rows a filter matches — the reversible half of a bulk action. */
  static async parkFiltered(filters, expectedCount, { actorUserId = null } = {}) {
    const { clause, params } = CrmLead.buildFilter(filters);

    return withTransaction(async (conn) => {
      const [[{ total }]] = await conn.query(`SELECT COUNT(*) AS total FROM crm_leads l WHERE ${clause}`, params);
      if (Number.isInteger(expectedCount) && total !== expectedCount) {
        const err = new Error(`The filter now matches ${total} leads, not ${expectedCount}. Nothing was changed.`);
        err.code = 'BULK_COUNT_MISMATCH';
        err.actual = total;
        throw err;
      }

      // Only the statuses the machine allows to reach `parked`, so a bulk action cannot
      // make a move a single lead would have been refused.
      const [movable] = await conn.query(
        `SELECT l.id, l.status FROM crm_leads l WHERE ${clause}`,
        params
      );
      const ids = movable.filter((r) => canTransition(r.status, 'parked')).map((r) => r.id);
      if (ids.length === 0) return { parked: 0, skipped: movable.length };

      await conn.query(
        `UPDATE crm_leads SET status = 'parked', last_activity_at = NOW() WHERE id IN (${ids.map(() => '?').join(',')})`,
        ids
      );
      for (const id of ids) {
        // eslint-disable-next-line no-await-in-loop
        await conn.query(
          `INSERT INTO crm_lead_activities (lead_id, actor_user_id, outcome, to_status, note)
           VALUES (?, ?, 'note', 'parked', 'Parked by a bulk action.')`,
          [id, actorUserId]
        );
      }
      return { parked: ids.length, skipped: movable.length - ids.length };
    });
  }

  /** Rows for a CSV export, through the same builder the screen used. */
  static async exportRows(filters) {
    const { clause, params } = CrmLead.buildFilter(filters);
    const [rows] = await promisePool.query(
      `SELECT l.company, l.contact_name, l.contact_email, l.contact_phone, l.job_title,
              l.country, l.website, l.linkedin_url, l.source, l.source_detail, l.status,
              l.last_activity_at, l.created_at
         FROM crm_leads l
        WHERE ${clause}
        ORDER BY l.company ASC
        LIMIT 10000`,
      params
    );
    return rows;
  }

  static async staleCount() {
    const [[{ total }]] = await promisePool.query(
      `SELECT COUNT(*) AS total FROM crm_leads
        WHERE last_activity_at IS NULL OR last_activity_at < (NOW() - INTERVAL ? DAY)`,
      [STALE_AFTER_DAYS]
    );
    return Number(total);
  }
}

module.exports = CrmLead;
