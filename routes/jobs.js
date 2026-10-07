'use strict';

const express = require('express');
const { body, validationResult } = require('express-validator');

const Job = require('../models/Job');
// The floor lives in the catalogue, where the form reads it too.
const DESCRIPTION_MIN_LENGTH = Job.SECTIONS.find((section) => section.required).minLength;
const Skill = require('../models/Skill');
const Application = require('../models/Application');
const JobTransfer = require('../models/JobTransfer');
const Notification = require('../models/Notification');
const User = require('../models/User');
const CompanyProfile = require('../models/CompanyProfile');
const ConsultantProfile = require('../models/ConsultantProfile');
const { isAuthenticated, isCompany, isConsultant, isEmailVerified } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/errorHandler');
const { paginationFrom, paginationMeta, pageUrl } = require('../utils/pagination');
const { ROLE_CATEGORIES, isRole, ROLE_SLUGS } = require('../config/roleTaxonomy');
const { PRODUCT_LINES, ALL_MODULES, isModule } = require('../config/sapProducts');
const { JOB_FEATURE_DAYS, JOB_FEATURE_PRICE_MINOR, formatMinor } = require('../config/payments');
const { jobPostingJsonLd } = require('../config/seoMeta');
const config = require('../config/config');
const { matchScore } = require('../utils/jobMatcher');
const { sanitizeRichText } = require('../utils/sanitize');
const { returnTo } = require('../utils/returnTo');
const { COUNTRIES: countries } = require('../config/countries');
const {
  DEPLOYMENTS, TRANSITIONS, DEPLOYMENT_VALUES, TRANSITION_VALUES, isDeployment, isTransition,
  deploymentLabel, transitionLabel
} = require('../config/sapDeployments');

const router = express.Router();

/*
 * The deployment and transition vocabularies, for every page this router renders: the
 * filter, the form (rendered from five places, including every re-render after a refused
 * post) and the advert. Set once here so no render call can forget them.
 */
router.use((req, res, next) => {
  res.locals.deployments = DEPLOYMENTS;
  res.locals.transitions = TRANSITIONS;
  res.locals.deploymentLabel = deploymentLabel;
  res.locals.transitionLabel = transitionLabel;
  next();
});

const SENIORITIES = ['junior', 'mid', 'senior', 'lead'];
const WORK_MODES = ['remote', 'hybrid', 'onsite'];
const ENGAGEMENTS = ['contract', 'permanent'];

/** Pull filters out of the query string, dropping anything not in the taxonomy. */
function filtersFrom(query) {
  return {
    q: query.q ? String(query.q).slice(0, 120) : '',
    role: isRole(query.role) ? query.role : '',
    seniority: SENIORITIES.includes(query.seniority) ? query.seniority : '',
    engagement_type: ENGAGEMENTS.includes(query.engagement_type) ? query.engagement_type : '',
    work_mode: WORK_MODES.includes(query.work_mode) ? query.work_mode : '',
    country: /^[A-Z]{2}$/.test(query.country || '') ? query.country : '',
    /*
     * Modules are a LIST. A job advert here names every module the programme touches, and
     * somebody browsing wants "anything involving MM or EWM" — see `Job.buildFilter`, which
     * treats them as any-of. Normalised to an array whether one value or ten arrived, so
     * neither the view nor the builder has to ask which shape it was handed. Bounded,
     * because the query string is not.
     */
    modules: (Array.isArray(query.modules) ? query.modules : [query.modules])
      .filter((slug) => slug && isModule(slug))
      .slice(0, 20),
    activate_phase: Job.ACTIVATE_PHASES.includes(query.activate_phase) ? query.activate_phase : '',
    deployment: isDeployment(query.deployment) ? query.deployment : '',
    transition_approach: isTransition(query.transition_approach) ? query.transition_approach : '',
    // Checked against the windows the control offers, so a hand-edited value cannot
    // produce a page answering a question the form cannot ask.
    posted_within: Job.POSTED_WITHIN_DAYS.includes(Number(query.posted_within))
      ? String(Number(query.posted_within))
      : '',
    rate_min: query.rate_min || ''
  };
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const filters = filtersFrom(req.query);
    const { page, perPage, limit, offset } = paginationFrom(req.query);
    const sort = ['newest', 'rate_desc', 'rate_asc'].includes(req.query.sort) ? req.query.sort : 'newest';

    const [{ rows, total }, facets, moduleFacets] = await Promise.all([
      Job.browse(filters, { limit, offset, sort }),
      Job.facetByRole(filters),
      Job.facetByModule(filters)
    ]);

    res.render('jobs/index', {
      title: res.locals.seo.title,
      jobs: rows,
      moduleFacets,
      allModules: ALL_MODULES,
      activatePhases: Job.ACTIVATE_PHASES,
      postedWindows: Job.POSTED_WITHIN_DAYS,
      filters,
      sort,
      facets,
      roleCategories: ROLE_CATEGORIES,
      productLines: PRODUCT_LINES,
      countries,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (p) => pageUrl('/jobs', req.query, p)
    });
  })
);

// Declared before `/:slug` so "new" is never treated as a job slug.
router.get(
  '/new',
  isAuthenticated,
  isCompany,
  isEmailVerified,
  asyncHandler(async (req, res) => {
    await CompanyProfile.ensureExists(req.session.user.id, req.session.user.name);
    res.render('jobs/form', {
      sections: Job.SECTIONS,
      title: 'Post a job',
      job: null,
      jobSkills: [],
      jobModules: [],
      roleCategories: ROLE_CATEGORIES,
      productLines: PRODUCT_LINES,
      countries,
      errors: [],
      values: {}
    });
  })
);

const jobValidators = [
  body('title').trim().isLength({ min: 5, max: 200 }).withMessage('Give the role a title of at least 5 characters.'),
  body('description').trim().isLength({ min: DESCRIPTION_MIN_LENGTH })
    .withMessage(`Please describe the engagement in at least ${DESCRIPTION_MIN_LENGTH} characters.`),
  /*
   * The optional sections are bounded and nothing else. `optional({ checkFalsy: true })`
   * is right here and would be wrong on a number — see `full_lifecycles` — because an
   * empty box and an unticked box both mean "not filled in" for prose, and the only
   * mistake worth catching is somebody pasting a document into one.
   */
  ...Job.SECTIONS.filter((section) => !section.required).map((section) =>
    body(section.key).optional({ checkFalsy: true }).isLength({ max: 20000 })
      .withMessage(`"${section.label}" is longer than an advert can be.`)),
  body('role').isIn(ROLE_SLUGS).withMessage('Choose a role from the list.'),
  body('seniority').isIn(SENIORITIES),
  body('engagement_type').isIn(ENGAGEMENTS),
  body('work_mode').isIn(WORK_MODES),
  // Optional: a permanent hire spans phases, and saying so is the honest answer.
  body('activate_phase').optional({ checkFalsy: true }).isIn(Job.ACTIVATE_PHASES)
    .withMessage('Choose an SAP Activate phase from the list, or leave it unset.'),
  body('deployment').optional({ checkFalsy: true }).isIn(DEPLOYMENT_VALUES)
    .withMessage('Choose a deployment from the list, or leave it unset.'),
  body('transition_approach').optional({ checkFalsy: true }).isIn(TRANSITION_VALUES)
    .withMessage('Choose a transition approach from the list, or leave it unset.'),
  body('rate_min').optional({ checkFalsy: true }).isFloat({ min: 0 }),
  body('rate_max')
    .optional({ checkFalsy: true })
    .isFloat({ min: 0 })
    .custom((value, { req }) => {
      if (req.body.rate_min && Number(value) < Number(req.body.rate_min)) {
        throw new Error('The maximum rate cannot be below the minimum.');
      }
      return true;
    })
];

/** Shared shaping of the posted form into model fields. */
function jobFieldsFrom(body_) {
  return {
    title: body_.title.trim(),
    /*
     * Every section, from the one list, through the same sanitiser. Writing `description`
     * out here and forgetting the other three would store the raw markup of three boxes
     * beside one that was cleaned.
     */
    ...Object.fromEntries(
      Job.SECTIONS.map((section) => [
        section.key,
        // An untouched box posts an empty string; it is stored as NULL so "not filled in"
        // and "answered with nothing" stay the same fact in the column.
        body_[section.key] && String(body_[section.key]).trim()
          ? sanitizeRichText(body_[section.key])
          : null
      ])
    ),
    role: body_.role,
    seniority: body_.seniority,
    engagement_type: body_.engagement_type,
    work_mode: body_.work_mode,
    country: /^[A-Z]{2}$/.test(body_.country || '') ? body_.country : null,
    city: body_.city ? String(body_.city).slice(0, 120) : null,
    rate_min: body_.rate_min || null,
    rate_max: body_.rate_max || null,
    currency: /^[A-Z]{3}$/.test(body_.currency || '') ? body_.currency : 'EUR',
    rate_visible: body_.rate_visible === 'on',
    duration_months: body_.duration_months || null,
    starts_on: body_.starts_on || null,
    activate_phase: Job.ACTIVATE_PHASES.includes(body_.activate_phase) ? body_.activate_phase : null,
    deployment: isDeployment(body_.deployment) ? body_.deployment : null,
    transition_approach: isTransition(body_.transition_approach) ? body_.transition_approach : null,
    expires_at: body_.expires_at || null,
    status: body_.publish === 'on' ? 'open' : 'draft'
  };
}

function selectedModules(body_) {
  const raw = Array.isArray(body_.modules) ? body_.modules : [body_.modules].filter(Boolean);
  return raw.filter(isModule);
}

function skillNames(body_) {
  return String(body_.skills || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 25);
}

router.post(
  '/',
  isAuthenticated,
  isCompany,
  isEmailVerified,
  writeLimiter,
  jobValidators,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).render('jobs/form', {
        sections: Job.SECTIONS,
        title: 'Post a job',
        job: null,
        jobSkills: [],
        jobModules: selectedModules(req.body),
        roleCategories: ROLE_CATEGORIES,
        productLines: PRODUCT_LINES,
        countries,
        errors: errors.array(),
        values: req.body
      });
    }

    const job = await Job.create(req.session.user.id, jobFieldsFrom(req.body));
    const skills = await Skill.findOrCreateMany(skillNames(req.body));
    await Skill.setForJob(job.id, skills.map((s) => s.id));
    await Job.setModules(job.id, selectedModules(req.body));

    req.flash('success', job.status === 'open' ? 'Job published.' : 'Job saved as a draft.');
    return res.redirect(`/jobs/${job.slug}`);
  })
);

router.get(
  '/:slug/edit',
  isAuthenticated,
  isCompany,
  asyncHandler(async (req, res) => {
    const job = await Job.findBySlug(req.params.slug);
    if (!job || job.company_user_id !== req.session.user.id) {
      return res.status(404).render('errors/404', { title: 'Not found' });
    }

    const [jobSkills, jobModules] = await Promise.all([Skill.forJob(job.id), Job.modulesFor(job.id)]);
    return res.render('jobs/form', {
      sections: Job.SECTIONS,
      title: `Edit: ${job.title}`,
      job,
      jobSkills,
      jobModules,
      roleCategories: ROLE_CATEGORIES,
      productLines: PRODUCT_LINES,
      countries,
      errors: [],
      values: job
    });
  })
);

router.post(
  '/:slug/edit',
  isAuthenticated,
  isCompany,
  writeLimiter,
  jobValidators,
  asyncHandler(async (req, res) => {
    const job = await Job.findBySlug(req.params.slug);
    if (!job || job.company_user_id !== req.session.user.id) {
      return res.status(404).render('errors/404', { title: 'Not found' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const [jobSkills, jobModules] = await Promise.all([Skill.forJob(job.id), Job.modulesFor(job.id)]);
      return res.status(422).render('jobs/form', {
        sections: Job.SECTIONS,
        title: `Edit: ${job.title}`,
        job,
        jobSkills,
        jobModules,
        roleCategories: ROLE_CATEGORIES,
        productLines: PRODUCT_LINES,
        countries,
        errors: errors.array(),
        values: req.body
      });
    }

    const fields = jobFieldsFrom(req.body);
    delete fields.status; // status changes go through the explicit publish/close actions
    await Job.update(job.id, req.session.user.id, fields);

    const skills = await Skill.findOrCreateMany(skillNames(req.body));
    await Skill.setForJob(job.id, skills.map((s) => s.id));
    await Job.setModules(job.id, selectedModules(req.body));

    req.flash('success', 'Job updated.');
    return res.redirect(`/jobs/${job.slug}`);
  })
);

router.post(
  '/:slug/status',
  isAuthenticated,
  isCompany,
  writeLimiter,
  asyncHandler(async (req, res) => {
    const allowed = Job.STATUSES;
    if (!allowed.includes(req.body.status)) {
      req.flash('error', 'Unknown status.');
      return res.redirect(returnTo(req, `/jobs/${req.params.slug}`));
    }

    const job = await Job.findBySlug(req.params.slug);
    if (!job || job.company_user_id !== req.session.user.id) {
      return res.status(404).render('errors/404', { title: 'Not found' });
    }

    await Job.setStatus(job.id, req.session.user.id, req.body.status);
    req.flash('success', `Job is now ${req.body.status}.`);
    return res.redirect(`/jobs/${job.slug}`);
  })
);

/**
 * Bulk status change from the employer's job list.
 *
 * `expected_count` is what the screen showed. The model aborts with a 409 when the
 * filtered set has changed since then, rather than acting on rows the operator never
 * saw.
 */
router.post(
  '/bulk-status',
  isAuthenticated,
  isCompany,
  writeLimiter,
  asyncHandler(async (req, res) => {
    const status = req.body.status;
    const expected = Number(req.body.expected_count);

    if (!['paused', 'closed', 'open'].includes(status) || !Number.isInteger(expected)) {
      req.flash('error', 'That bulk action is not valid.');
      return res.redirect(returnTo(req, '/dashboard/jobs'));
    }

    try {
      const affected = await Job.bulkSetStatus(filtersFrom(req.body), status, expected, req.session.user.id);
      req.flash('success', `${affected} job(s) updated.`);
      return res.redirect('/dashboard/jobs');
    } catch (err) {
      if (err.code === 'BULK_COUNT_MISMATCH') {
        req.flash('error', `${err.message} Nothing was changed — reload and try again.`);
        return res.status(409).redirect('/dashboard/jobs');
      }
      throw err;
    }
  })
);

router.get(
  '/:slug',
  asyncHandler(async (req, res) => {
    const job = await Job.findBySlug(req.params.slug);
    if (!job) return res.status(404).render('errors/404', { title: 'Not found' });

    const isOwner = req.session.user && req.session.user.id === job.company_user_id;
    // A draft, paused or closed job is visible to its owner and to admins only.
    /*
     * Two switches again. `status` is the advertiser's own; `admin_hidden_at` is a
     * moderator's. Either one closes the page to everybody but the advertiser and an
     * administrator — the advertiser still sees what they wrote, and an administrator has
     * to be able to look at what they took down.
     */
    const publiclyVisible = job.status === 'open' && !job.admin_hidden_at;
    if (!publiclyVisible && !isOwner && !(req.session.user && req.session.user.isAdmin)) {
      return res.status(404).render('errors/404', { title: 'Not found' });
    }

    const [jobSkills, jobModules, applicationCount, company] = await Promise.all([
      Skill.forJob(job.id),
      Job.modulesFor(job.id),
      Application.countForJob(job.id),
      // The advertiser's own profile, for the "About the company" card. `job` already
      // carries the name and the slug; this is the description and the rest of it.
      CompanyProfile.findByUserId(job.company_user_id)
    ]);

    let application = null;
    let saved = false;
    let match = null;

    if (req.session.user && req.session.user.isConsultant) {
      const userId = req.session.user.id;
      const [rows, isSaved, profile, consultantSkillIds, deliveredModules] = await Promise.all([
        Application.listForConsultant(userId, { limit: 200 }),
        Job.isSaved(userId, job.id),
        ConsultantProfile.findByUserId(userId),
        Skill.idsForConsultant(userId),
        ConsultantProfile.deliveredModules(userId)
      ]);
      application = rows.find((a) => a.job_id === job.id) || null;
      saved = isSaved;
      if (profile) {
        match = matchScore(job, profile, {
          jobSkillIds: jobSkills.map((s) => s.id),
          consultantSkillIds,
          jobModules,
          deliveredModules
        });
      }
    }

    if (!isOwner) Job.incrementViews(job.id);

    // Only the owner is offered the placement or the handover, so only the owner's page
    // pays for those queries.
    const [featuredUntil, transferable, pendingTransfer] = isOwner
      ? await Promise.all([
          Job.featuredUntil(job.id),
          JobTransfer.eligibility(job.id),
          JobTransfer.pendingForJob(job.id)
        ])
      : [null, null, null];

    return res.render('jobs/show', {
      sections: Job.SECTIONS,
      title: `${job.title} — ${job.company_name || 'Confidential'}`,
      job,
      jobSkills,
      jobModules,
      allModules: ALL_MODULES,
      isOwner,
      application,
      saved,
      match,
      featuredUntil,
      transferable,
      pendingTransfer,
      transferWindowDays: JobTransfer.OFFER_WINDOW_DAYS,
      applicationCount,
      company,
      // Built here, not in the template: the canonical URL is config's to decide, and a
      // share link assembled from whatever host the browser happened to use would carry
      // localhost into somebody's timeline.
      shareUrl: `${config.app.baseUrl}/jobs/${job.slug}`,
      jobStatuses: Job.STATUSES,
      jobFeatureDays: JOB_FEATURE_DAYS,
      jobFeaturePrice: formatMinor(JOB_FEATURE_PRICE_MINOR),
      jsonLd: jobPostingJsonLd(job)
    });
  })
);

router.post(
  '/:slug/apply',
  isAuthenticated,
  isConsultant,
  isEmailVerified,
  writeLimiter,
  [body('cover_letter').optional({ checkFalsy: true }).isLength({ max: 5000 })],
  asyncHandler(async (req, res) => {
    const job = await Job.findBySlug(req.params.slug);
    if (!job) return res.status(404).render('errors/404', { title: 'Not found' });

    try {
      const { created } = await Application.apply(job.id, req.session.user.id, {
        coverLetter: req.body.cover_letter ? String(req.body.cover_letter).slice(0, 5000) : null,
        dayRate: req.body.day_rate || null,
        currency: req.body.currency || 'EUR',
        availableFrom: req.body.available_from || null
      });

      // Fire and forget, with a stable key: re-submitting cannot notify twice.
      Notification.emit({
        userId: job.company_user_id,
        type: 'application_received',
        title: `New application for ${job.title}`,
        body: `${req.session.user.name} applied.`,
        link: `/applications/job/${job.slug}`,
        dedupeKey: `application:${job.id}:${req.session.user.id}`
      });

      req.flash('success', created ? 'Application sent.' : 'Application updated.');
    } catch (err) {
      if (err.code === 'JOB_NOT_OPEN' || err.code === 'APPLICATION_CLOSED') {
        req.flash('error', err.message);
      } else {
        throw err;
      }
    }

    return res.redirect(`/jobs/${job.slug}`);
  })
);

router.post(
  '/:slug/save',
  isAuthenticated,
  writeLimiter,
  asyncHandler(async (req, res) => {
    const job = await Job.findBySlug(req.params.slug);
    if (!job) return res.status(404).json({ success: false, error: 'Not found' });

    const saved = req.body.saved === 'true';
    if (saved) {
      await Job.unsaveForUser(req.session.user.id, job.id);
    } else {
      await Job.saveForUser(req.session.user.id, job.id);
    }

    if (req.get('sec-fetch-dest') && req.get('sec-fetch-dest') !== 'document') {
      return res.json({ success: true, saved: !saved });
    }
    return res.redirect(`/jobs/${job.slug}`);
  })
);

/**
 * Offer this advert to a colleague.
 *
 * The response is the SAME whether or not that address has an account here. The sender is
 * told what the mechanism is — it waits, and it expires — rather than the answer for the
 * address they typed, because this form would otherwise be an account-existence oracle
 * that any company account can query one offer at a time. The recipient, if there is one,
 * gets a notification; the sender never learns that one was sent.
 */
router.post(
  '/:slug/transfer',
  isAuthenticated,
  isCompany,
  writeLimiter,
  asyncHandler(async (req, res) => {
    const job = await Job.findBySlug(req.params.slug);
    if (!job) return res.status(404).render('errors/404', { title: 'Not found' });
    if (job.company_user_id !== req.session.user.id) {
      return res.status(404).render('errors/404', { title: 'Not found' });
    }

    try {
      const offer = await JobTransfer.offer(job.id, req.session.user.id, {
        toEmail: req.body.to_email,
        message: req.body.message
      });

      /*
       * Resolved HERE and never reported back. The lookup happens so the recipient gets a
       * bell rather than having to stumble on the offer; nothing about its result reaches
       * the sender's page, which is what keeps the handler from answering "does this
       * address have an account".
       */
      const recipient = await User.findByEmail(offer.toEmail);
      if (recipient && recipient.is_active && recipient.is_company) {
        Notification.emit({
          userId: recipient.id,
          type: 'job_transfer',
          title: `You have been offered the role "${offer.jobTitle}"`,
          link: '/dashboard/transfers',
          dedupeKey: `job-transfer:${offer.id}`
        });
      }

      req.flash(
        'success',
        `Offered to ${offer.toEmail}. It waits until somebody signed in at that address accepts, ` +
          `and expires after ${JobTransfer.OFFER_WINDOW_DAYS} days.`
      );
    } catch (err) {
      if (['INVALID_EMAIL', 'SELF_TRANSFER', 'NOT_TRANSFERABLE', 'ALREADY_OFFERED', 'TRANSFER_NOT_FOUND'].includes(err.code)) {
        req.flash('error', err.message);
      } else {
        throw err;
      }
    }

    return res.redirect(`/jobs/${job.slug}`);
  })
);

module.exports = router;
