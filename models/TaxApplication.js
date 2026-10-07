'use strict';

const { promisePool } = require('../config/database');
const { APPLY_COUNTRIES, APPLY_OPTIONS, estimate } = require('../config/taxProgram');

/**
 * Applications to the tax optimisation programme, from /tax/apply.
 *
 * `normalise` is PURE and is the whole of the validation: every select is checked against
 * its list in config/taxProgram.js, every number against a range, every text against a
 * length — refused, never truncated, because a cut-off answer reads as the person having
 * stopped mid-sentence. The estimate is computed HERE from the gross and net posted; the
 * hidden fields the reference reads from the browser do not exist.
 */

const STATUSES = Object.freeze(['new', 'open', 'closed']);

const TEXT_LIMITS = Object.freeze({
  fullName: 200, email: 190, phone: 50, linkedinUrl: 500, city: 120, currentEmployer: 200,
  jobTitle: 200, primarySkills: 1000, certifications: 1000, languages: 500, clientIndustries: 500,
  referralCode: 40, additionalNotes: 5000, specificQuestions: 5000
});

const REQUIRED = Object.freeze(['fullName', 'email', 'phone', 'currentCountry', 'employmentType',
  'currentGrossMonthly', 'currentNetMonthly', 'jobTitle', 'primarySkills', 'agreeTerms']);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function ticked(value) {
  return value === 'on' || value === 'true' || value === '1';
}

/** `Number`, not `parseInt`: `parseInt('12; DROP TABLE')` is 12. */
function wholeNumber(value) {
  const s = text(value);
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * @returns {{ values: object, errors: object }} `values` is ready for `create` when
 *   `errors` is empty; `errors` is keyed by form field, with a sentence for the person.
 */
function normalise(body) {
  const b = body || {};
  const errors = {};
  const v = {};

  Object.entries(TEXT_LIMITS).forEach(([key, max]) => {
    const t = text(b[key]);
    if (t.length > max) errors[key] = `Please keep this under ${max} characters.`;
    v[key] = t || null;
  });

  if (v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) errors.email = 'That does not look like an email address.';
  if (v.linkedinUrl && !/^https:\/\/([a-z]{2,3}\.)?linkedin\.com\//i.test(v.linkedinUrl)) {
    errors.linkedinUrl = 'A linkedin.com address, starting with https://.';
  }

  const closed = { currentCountry: APPLY_COUNTRIES, ...APPLY_OPTIONS };
  Object.entries(closed).forEach(([key, list]) => {
    const t = text(b[key]);
    if (t && !list.includes(t)) errors[key] = 'Please pick one of the options.';
    v[key] = t || null;
  });
  v.billingCurrency = v.billingCurrency || 'EUR';

  ['contractEndDate', 'availabilityDate'].forEach((key) => {
    const t = text(b[key]);
    if (t && !(DATE_RE.test(t) && !Number.isNaN(Date.parse(t)))) errors[key] = 'Please give a date.';
    v[key] = t || null;
  });

  const ranges = {
    currentGrossMonthly: [1000, 1000000, 'At least €1,000 a month.'],
    currentNetMonthly: [500, 1000000, 'At least €500 a month.'],
    currentDailyRate: [100, 100000, 'At least €100 a day.'],
    desiredDailyRate: [100, 100000, 'At least €100 a day.'],
    currentTaxRatePercent: [0, 100, 'Between 0 and 100.']
  };
  Object.entries(ranges).forEach(([key, [min, max, message]]) => {
    const n = wholeNumber(b[key]);
    if (n !== null && (Number.isNaN(n) || n < min || n > max)) errors[key] = message;
    v[key] = n === null || Number.isNaN(n) ? null : n;
  });
  ['currentGrossMonthly', 'currentNetMonthly', 'currentDailyRate', 'desiredDailyRate'].forEach((key) => {
    if (v[key] !== null) v[key] = Math.round(v[key]);
  });

  v.hasVatNumber = ticked(b.hasVatNumber);
  v.hasExistingClients = ticked(b.hasExistingClients);
  v.openToTravel = ticked(b.openToTravel);
  v.agreeTerms = ticked(b.agreeTerms);

  REQUIRED.forEach((key) => {
    if (key === 'agreeTerms') {
      if (!v.agreeTerms) errors.agreeTerms = 'We need your consent to contact you about this.';
    } else if (v[key] === null || v[key] === '') {
      errors[key] = errors[key] || 'Required.';
    }
  });

  const est = estimate(v.currentGrossMonthly, v.currentNetMonthly);
  v.estimatedMonthlySavings = est ? est.monthly : null;
  v.estimatedAnnualSavings = est ? est.annual : null;

  return { values: v, errors };
}

class TaxApplication {
  static get STATUSES() { return STATUSES; }

  static normalise = normalise;

  static async create(values, userId = null) {
    const v = values;
    const [result] = await promisePool.query(
      `INSERT INTO tax_applications
         (user_id, full_name, email, phone, linkedin_url, city, timezone,
          current_country, employment_type, current_employer, notice_period,
          contract_end_date, availability_date,
          current_gross_monthly, current_net_monthly, current_daily_rate, desired_daily_rate,
          current_tax_rate_percent, billing_currency, has_vat_number,
          job_title, years_experience, primary_skills, certifications, languages, client_industries,
          remote_preference, availability_hours_per_week, has_existing_clients, open_to_travel,
          how_heard_about_us, referral_code, additional_notes, specific_questions,
          estimated_monthly_savings, estimated_annual_savings, consented_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        userId, v.fullName, v.email, v.phone, v.linkedinUrl, v.city, v.timezone,
        v.currentCountry, v.employmentType, v.currentEmployer, v.noticePeriod,
        v.contractEndDate, v.availabilityDate,
        v.currentGrossMonthly, v.currentNetMonthly, v.currentDailyRate, v.desiredDailyRate,
        v.currentTaxRatePercent, v.billingCurrency, v.hasVatNumber ? 1 : 0,
        v.jobTitle, v.yearsExperience, v.primarySkills, v.certifications, v.languages, v.clientIndustries,
        v.remotePreference, v.availabilityHoursPerWeek, v.hasExistingClients ? 1 : 0, v.openToTravel ? 1 : 0,
        v.howHeardAboutUs, v.referralCode, v.additionalNotes, v.specificQuestions,
        v.estimatedMonthlySavings, v.estimatedAnnualSavings
      ]
    );
    return { id: result.insertId };
  }

  static async browse({ status = '' } = {}, { limit = 25, offset = 0 } = {}) {
    const where = STATUSES.includes(status) ? 't.status = ?' : '1 = 1';
    const params = STATUSES.includes(status) ? [status] : [];
    const [rows] = await promisePool.query(
      `SELECT t.id, t.full_name, t.email, t.current_country, t.job_title, t.employment_type,
              t.estimated_monthly_savings, t.status, t.created_at, h.name AS handler_name
         FROM tax_applications t
         LEFT JOIN users h ON h.id = t.handled_by
        WHERE ${where}
        ORDER BY t.created_at DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const [[{ total }]] = await promisePool.query(`SELECT COUNT(*) AS total FROM tax_applications t WHERE ${where}`, params);
    return { rows, total };
  }

  static async find(id) {
    const [rows] = await promisePool.query(
      `SELECT t.*, h.name AS handler_name
         FROM tax_applications t
         LEFT JOIN users h ON h.id = t.handled_by
        WHERE t.id = ?`,
      [id]
    );
    return rows[0] || null;
  }

  static async openCount() {
    const [[row]] = await promisePool.query(
      "SELECT COUNT(*) AS count FROM tax_applications WHERE status IN ('new', 'open')"
    );
    return row.count;
  }

  /** Same shape as Enquiry.setStatus: an empty note keeps the note that is there. */
  static async setStatus(id, status, adminUserId, note = null) {
    if (!STATUSES.includes(status)) throw new Error(`Unknown status: ${status}`);
    const sets = ['status = ?', 'handled_by = ?', 'handled_at = NOW()'];
    const params = [status, adminUserId];
    if (note !== null && String(note).trim()) {
      sets.push('admin_note = ?');
      params.push(String(note).trim().slice(0, 5000));
    }
    const [result] = await promisePool.query(
      `UPDATE tax_applications SET ${sets.join(', ')} WHERE id = ?`,
      [...params, id]
    );
    return result.affectedRows === 1;
  }
}

module.exports = TaxApplication;
