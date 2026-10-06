'use strict';

const { ROLE_ALIASES, roleLabel } = require('../config/roleTaxonomy');
const { sectionText } = require('../config/jobSections');

/**
 * Score how well a consultant profile matches a job, 0..100.
 *
 * Pure function over plain objects so it is unit-testable and so the same scoring is used
 * by the "recommended jobs" panel, the employer's candidate ranking and any matching
 * digest. Divergent copies of this logic were how DynamicsHub ended up with a list view
 * and an alert that disagreed.
 *
 * The weights are editorial, not learned. They are stated here rather than buried so they
 * can be argued with, and they are NOT the reference's:
 *
 *   `modules` is new, and it costs `role` eight points and `skills` seven.
 *
 * In a CRM ecosystem the role IS the specialism — a Service Cloud consultant does Service
 * Cloud. In SAP the role and the modules are different questions: "FI/CO consultant" is
 * the job title, and "has delivered CO-PC and Group Reporting" is what the hiring manager
 * is actually short of. Two candidates with the same role slug can be unusable and ideal
 * for the same job, and only the module overlap tells them apart.
 */
const WEIGHTS = {
  role: 32,
  modules: 22, // delivered, not claimed — see moduleScore
  skills: 18,
  seniority: 10,
  location: 8,
  rate: 6,
  availability: 4
};

const MAX_SCORE = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);

const SENIORITY_ORDER = ['junior', 'mid', 'senior', 'lead'];

function normaliseText(value) {
  return String(value || '').toLowerCase();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Does `haystack` contain `term` as a WHOLE WORD?
 *
 * The reference asks `haystack.includes(alias)`, which is safe when the shortest alias in
 * the catalogue is "cpq" or "sfmc". It is not safe here. This ecosystem's aliases are the
 * module codes, and they are two letters: `includes('mm')` matches "committed" and
 * "communication", `includes('fi')` matches "specific", "configuration" and "Fiori",
 * `includes('pm')` matches "employment". Every SAP job advert contains those words, so
 * every consultant would have scored a partial role match against every job, and the
 * signal the aliases exist to provide would have been noise instead.
 *
 * The boundary is applied PER EDGE, and only where the term's own edge is a word
 * character. A bare `\b...\b` looks right and quietly fails for any term ending in
 * punctuation: `\bc++\b` can never match "c++ ", because `\b` after `+` asks for a word
 * character on one side of a position that has none. A test caught it; the aliases that
 * exist today all start and end with letters, so it would have sat here correctly-looking
 * until the first one did not.
 *
 * A code written "FI/CO" still matches as a whole, because both its edges are letters.
 */
function containsWord(haystack, term) {
  const trimmed = String(term || '').trim();
  if (!trimmed) return false;
  const left = /^\w/.test(trimmed) ? '\\b' : '';
  const right = /\w$/.test(trimmed) ? '\\b' : '';
  return new RegExp(`${left}${escapeRegExp(trimmed)}${right}`, 'i').test(haystack);
}

/** Role match: exact slug, else alias overlap against the job's title/description. */
function roleScore(job, profile) {
  if (!profile.primary_role || !job.role) return 0;
  if (profile.primary_role === job.role) return WEIGHTS.role;

  // Every section of the advert, through `sectionText`, not the description alone: an
  // advert naming its modules only under "Requirements" must still match the consultant
  // who has them. The list lives in config/jobSections.js and is read by the search
  // clause and the form from the same place.
  const haystack = `${normaliseText(job.title)} ${normaliseText(sectionText(job))}`;
  const aliases = ROLE_ALIASES[profile.primary_role] || [];
  const label = normaliseText(roleLabel(profile.primary_role));

  if (label && haystack.includes(label)) return Math.round(WEIGHTS.role * 0.7);
  if (aliases.some((alias) => containsWord(haystack, alias))) return Math.round(WEIGHTS.role * 0.5);
  return 0;
}

/**
 * Proportion of the job's modules the consultant has DELIVERED.
 *
 * The consultant side comes from `consultant_project_modules` — the delivery history —
 * not from a self-declared skills list. Anybody can tick EWM; this asks whether they have
 * shipped it.
 *
 * A job that names no modules scores neutral rather than zero, for the same reason the
 * skills term does: silence from the employer is not evidence against the candidate.
 */
function moduleScore(jobModules, deliveredModules) {
  const required = new Set(jobModules || []);
  if (required.size === 0) return Math.round(WEIGHTS.modules * 0.5);
  const delivered = new Set(deliveredModules || []);
  let hits = 0;
  for (const slug of required) if (delivered.has(slug)) hits += 1;
  return Math.round(WEIGHTS.modules * (hits / required.size));
}

/** Proportion of the job's required skills the consultant holds. */
function skillScore(jobSkillIds, consultantSkillIds) {
  const required = new Set(jobSkillIds || []);
  if (required.size === 0) return Math.round(WEIGHTS.skills * 0.5); // no stated skills: neutral
  const held = new Set(consultantSkillIds || []);
  let hits = 0;
  for (const id of required) if (held.has(id)) hits += 1;
  return Math.round(WEIGHTS.skills * (hits / required.size));
}

/** Exact seniority scores full; one level either side scores half; further scores 0. */
function seniorityScore(job, profile) {
  const jobIndex = SENIORITY_ORDER.indexOf(job.seniority);
  const profileIndex = SENIORITY_ORDER.indexOf(profile.seniority);
  if (jobIndex < 0 || profileIndex < 0) return 0;
  const distance = Math.abs(jobIndex - profileIndex);
  if (distance === 0) return WEIGHTS.seniority;
  if (distance === 1) return Math.round(WEIGHTS.seniority / 2);
  return 0;
}

/** A remote job matches anyone; otherwise country must agree. */
function locationScore(job, profile) {
  if (job.work_mode === 'remote') return WEIGHTS.location;
  if (!job.country || !profile.country) return 0;
  if (job.country === profile.country) return WEIGHTS.location;
  return profile.willing_to_travel ? Math.round(WEIGHTS.location / 2) : 0;
}

/**
 * Rate fit. A consultant whose rate sits inside the band scores full. Below the band
 * is not penalised (the employer is under budget); above the band decays to zero at
 * 25% over the maximum.
 */
function rateScore(job, profile) {
  const rate = Number(profile.day_rate);
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  const min = Number(job.rate_min);
  const max = Number(job.rate_max);
  if (!Number.isFinite(max) || max <= 0) return Math.round(WEIGHTS.rate * 0.5);
  if (Number.isFinite(min) && rate < min) return WEIGHTS.rate;
  if (rate <= max) return WEIGHTS.rate;
  const overshoot = (rate - max) / max;
  if (overshoot >= 0.25) return 0;
  return Math.round(WEIGHTS.rate * (1 - overshoot / 0.25));
}

function availabilityScore(profile) {
  switch (profile.availability) {
    case 'immediate':
      return WEIGHTS.availability;
    case 'two_weeks':
      return Math.round(WEIGHTS.availability * 0.8);
    case 'one_month':
      return Math.round(WEIGHTS.availability * 0.5);
    default:
      return 0;
  }
}

/**
 * @returns {{score:number, breakdown:Object}} score is 0..100.
 */
function matchScore(
  job,
  profile,
  { jobSkillIds = [], consultantSkillIds = [], jobModules = [], deliveredModules = [] } = {}
) {
  const breakdown = {
    role: roleScore(job, profile),
    modules: moduleScore(jobModules, deliveredModules),
    skills: skillScore(jobSkillIds, consultantSkillIds),
    seniority: seniorityScore(job, profile),
    location: locationScore(job, profile),
    rate: rateScore(job, profile),
    availability: availabilityScore(profile)
  };

  const raw = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { score: Math.round((raw / MAX_SCORE) * 100), breakdown };
}

module.exports = { matchScore, moduleScore, containsWord, WEIGHTS, MAX_SCORE };
