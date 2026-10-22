'use strict';

/**
 * Where a CV's rows come from, for the two pages that build one: `/profile/cv` and the
 * public `/cv-generator`. One loader, so the page that advertises the builder and the
 * builder itself can never read a member's profile two different ways.
 *
 * Everything here reads THIS member's own rows by the session's user id. There is no id in
 * any path that reaches it: a CV endpoint that takes one is a CV endpoint somebody will
 * enumerate.
 */

const ConsultantProfile = require('../models/ConsultantProfile');
const Skill = require('../models/Skill');
const Job = require('../models/Job');
const Application = require('../models/Application');
const { buildCv } = require('../utils/cvData');

async function cvFor(userId, jobSlug, options) {
  const profile = await ConsultantProfile.findByUserId(userId);
  if (!profile) return null;

  const [skills, certifications, experiences, projects] = await Promise.all([
    Skill.forConsultant(userId),
    ConsultantProfile.listCertifications(userId),
    ConsultantProfile.listExperiences(userId),
    ConsultantProfile.listProjects(userId)
  ]);

  /*
   * The advert is loaded only to ORDER the engagements, and only when it is one anybody
   * could read: `Job.findBySlug` plus the open check, so a draft cannot be probed through
   * the CV builder by somebody guessing slugs.
   */
  let job = null;
  if (jobSlug) {
    const found = await Job.findBySlug(jobSlug);
    if (found && found.status === 'open') {
      job = { ...found, modules: await Job.modulesFor(found.id) };
    }
  }

  return buildCv({ profile, skills, certifications, experiences, projects, job }, options);
}

function cvOptionsFrom(query) {
  return {
    // Both off unless asked for, every time. A CV travels further than the person who
    // wrote it expects, and a day rate on a document that reaches a procurement team is a
    // negotiating position given away before the conversation starts.
    includeRate: query.rate === '1',
    includeContact: query.contact === '1',
    length: query.length === 'short' ? 'short' : 'full'
  };
}

/**
 * The adverts a CV can be ordered against from a dropdown: the OPEN ones this member saved
 * or applied to. Those are the roles they have already said they care about, and an open
 * advert is one anybody can read — the same rule `cvFor` applies, so the list cannot offer
 * something the builder would then ignore. Any other open advert works from its own page.
 */
async function orderingAdverts(userId) {
  const [saved, applied] = await Promise.all([
    Job.listSaved(userId, { limit: 30 }),
    Application.listForConsultant(userId, { limit: 30 })
  ]);
  const seen = new Map();
  for (const a of applied) {
    if (a.job_status === 'open' && !seen.has(a.job_slug)) {
      seen.set(a.job_slug, { slug: a.job_slug, title: a.job_title, company: a.company_name || null, why: 'applied' });
    }
  }
  for (const j of saved) {
    if (j.status === 'open' && !seen.has(j.slug)) {
      seen.set(j.slug, { slug: j.slug, title: j.title, company: j.company_name || null, why: 'saved' });
    }
  }
  return [...seen.values()];
}

/** The query string for a download that carries exactly the choices the preview showed. */
function cvQuery(options, jobSlug) {
  const params = new URLSearchParams({
    rate: options.includeRate ? '1' : '0',
    contact: options.includeContact ? '1' : '0',
    length: options.length
  });
  if (jobSlug) params.set('job', jobSlug);
  return params.toString();
}

module.exports = { cvFor, cvOptionsFrom, orderingAdverts, cvQuery };
