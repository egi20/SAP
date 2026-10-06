'use strict';

const { roleLabel } = require('./../config/roleTaxonomy');
const { moduleLabel } = require('./../config/sapProducts');
const { phaseLabel } = require('./../config/activatePhases');
const { toPlainText } = require('./sanitize');

/**
 * Assemble a CV from the profile somebody has already filled in.
 *
 * THE WHOLE DESIGN IS THAT THERE IS NO WIZARD. The reference asks people to type their
 * career into a form, which produces a second copy of a CV that immediately starts drifting
 * from the profile the directory searches. Everything a CV needs is already here —
 * headline, years, lifecycles, skills, certifications, employment, and the delivery history
 * with the modules each engagement touched. So this reads the profile and nothing else, and
 * a CV is always a rendering of what the directory would show.
 *
 * IT INVENTS NOTHING. No generated summary, no rewritten bullet, no inferred seniority.
 * Every line is something the member wrote or a label from a config catalogue. A document
 * that puts sentences in somebody's mouth is a document they then send to an employer under
 * their own name, and the first they hear of a claim they cannot stand behind is in the
 * interview.
 *
 * TARGETING REORDERS, IT DOES NOT REWRITE. Given a job, the engagements that touched that
 * advert's modules come first and are marked as the matching ones. Nothing is added,
 * removed or reworded — the reader simply sees the relevant work at the top, which is the
 * only honest thing "tailored to this role" can mean without a person doing the tailoring.
 *
 * Pure: no database, no clock beyond one timestamp. The renderer in
 * `utils/documents/cvDocx.js` formats what this returns and computes nothing.
 */

/** YYYY-MM, or null. Dates arrive from mysql2 as JS Dates, not strings. */
function monthOf(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 7);
}

function periodOf(from, to, isCurrent) {
  const start = monthOf(from);
  const end = isCurrent ? 'present' : monthOf(to);
  if (!start && !end) return '';
  if (!start) return end;
  return `${start} — ${end || 'present'}`;
}

/**
 * @param {object} input
 * @param {object} input.profile      consultant_profiles row, joined with the user
 * @param {Array}  input.skills
 * @param {Array}  input.certifications  already carrying `label` from the catalogue
 * @param {Array}  input.experiences
 * @param {Array}  input.projects     delivery history, each with `modules`
 * @param {object|null} input.job     the advert to order against, with `modules`
 * @param {object} options
 * @param {boolean} options.includeRate     the member's choice, off by default
 * @param {boolean} options.includeContact  the member's choice, off by default
 */
function buildCv({ profile, skills = [], certifications = [], experiences = [], projects = [], job = null }, options = {}) {
  if (!profile) throw new Error('A CV needs a profile');

  const jobModules = job && Array.isArray(job.modules) ? job.modules.filter(Boolean) : [];
  const wanted = new Set(jobModules);

  const engagements = projects.map((project) => {
    const modules = Array.isArray(project.modules) ? project.modules.filter(Boolean) : [];
    const matched = modules.filter((slug) => wanted.has(slug));
    return {
      name: project.name,
      client: project.client || null,
      role: project.role || null,
      phase: project.activate_phase ? phaseLabel(project.activate_phase) : null,
      period: periodOf(project.started_on, project.ended_on, !project.ended_on),
      isFullLifecycle: Boolean(project.is_full_lifecycle),
      modules: modules.map((slug) => ({ slug, label: moduleLabel(slug) })),
      matchedModules: matched.map((slug) => moduleLabel(slug)),
      // Plain text: the description is rich text on the profile and a DOCX paragraph is
      // not a place to render markup.
      description: toPlainText(project.description || '')
    };
  });

  /*
   * A stable sort, matched first. `Array.prototype.sort` is stable in every engine this
   * runs on, so engagements that match equally keep the order the profile gave them —
   * which is already newest-first. Sorting on the count would reorder a person's career by
   * how many boxes each line ticked.
   */
  const ordered = jobModules.length
    ? [...engagements].sort((a, b) => (b.matchedModules.length > 0) - (a.matchedModules.length > 0))
    : engagements;

  return {
    name: profile.name,
    headline: profile.headline || null,
    role: profile.primary_role ? roleLabel(profile.primary_role) : null,
    seniority: profile.seniority || null,
    location: [profile.city, profile.country].filter(Boolean).join(', ') || null,
    workMode: profile.work_mode || null,
    willingToTravel: Boolean(profile.willing_to_travel),

    // `??`, not `||`. Zero full lifecycles is a real answer and the honest one; `||` drops
    // it for exactly the people who did not round up.
    yearsExperience: profile.years_experience ?? null,
    fullLifecycles: profile.full_lifecycles ?? null,

    about: toPlainText(profile.bio || ''),

    // Both off unless asked for. A CV travels further than the person who wrote it
    // expects, and a day rate on a document that reaches a procurement team is a
    // negotiating position given away before the conversation starts.
    rate: options.includeRate && profile.day_rate
      ? { amount: profile.day_rate, currency: profile.currency || 'EUR' }
      : null,
    contact: options.includeContact
      ? { email: profile.email || null, linkedin: profile.linkedin_url || null }
      : null,

    skills: skills.map((s) => s.name).filter(Boolean),
    certifications: certifications.map((c) => ({
      label: c.label,
      earned: monthOf(c.earned_on)
    })),
    experiences: experiences.map((e) => ({
      title: e.title,
      company: e.company,
      period: periodOf(e.started_on, e.ended_on, e.is_current),
      description: toPlainText(e.description || '')
    })),
    engagements: ordered,

    targetedAt: job ? { title: job.title, company: job.company_name || null, modules: jobModules.map(moduleLabel) } : null,
    generatedAt: new Date()
  };
}

/**
 * What is missing before this is worth sending.
 *
 * Named rather than counted: "your CV is 60% complete" tells somebody nothing they can act
 * on, and the fix for each of these is one field.
 */
function cvGaps(cv) {
  const gaps = [];
  if (!cv.headline) gaps.push('a headline — the one line a reader sees first');
  if (!cv.about) gaps.push('the About section, which becomes your summary');
  if (!cv.engagements.length) gaps.push('at least one engagement in your delivery history');
  if (!cv.skills.length) gaps.push('some skills');
  if (cv.yearsExperience === null) gaps.push('your years of experience');
  return gaps;
}

module.exports = { buildCv, cvGaps };
