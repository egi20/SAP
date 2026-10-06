'use strict';

const express = require('express');
const { body, validationResult } = require('express-validator');

const RateSubmission = require('../models/RateSubmission');
const Points = require('../models/Points');
const { isAuthenticated, isConsultant, isEmailVerified } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/errorHandler');
const { ROLE_CATEGORIES, ROLE_SLUGS, isRole, baseDayRate, roleLabel } = require('../config/roleTaxonomy');
const { MIN_SAMPLE } = require('../utils/rateAggregation');
const { benchmark, benchmarkProblems, curatedTable } = require('../utils/rateBenchmark');
const benchmarkModel = require('../config/rateBenchmark');
const { POINT_AWARDS } = require('../config/community');
const { BOUNDS, STEP, isEngagementType, boundsFor } = require('../config/rateBounds');
const countries = require('../config/all-countries.json');
const config = require('../config/config');
const router = express.Router();

const SENIORITIES = ['junior', 'mid', 'senior', 'lead'];

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const filters = {
      role: isRole(req.query.role) ? req.query.role : '',
      seniority: SENIORITIES.includes(req.query.seniority) ? req.query.seniority : '',
      engagementType: req.query.engagement_type === 'permanent' ? 'permanent' : 'contract',
      country: /^[A-Z]{2}$/.test(req.query.country || '') ? req.query.country : ''
    };

    const [summary, byRole, bySeniority, trend, contributors] = await Promise.all([
      RateSubmission.summary(filters),
      RateSubmission.byRole(filters),
      filters.role ? RateSubmission.bySeniority(filters) : Promise.resolve([]),
      filters.role ? RateSubmission.trend(filters) : Promise.resolve([]),
      RateSubmission.totalContributors()
    ]);

    res.render('rates/index', {
      title: res.locals.seo.title,
      filters,
      summary,
      byRole,
      bySeniority,
      trend,
      contributors,
      minSample: MIN_SAMPLE,
      roleCategories: ROLE_CATEGORIES,
      /*
       * EVERY role, with its published base rate — not only the roles somebody has
       * contributed to. The contributed table below it can be empty for months on a new
       * install, and an index whose only navigation is a table of what people happened to
       * fill in leaves most of the site unreachable and looks broken besides.
       */
      roleIndex: ROLE_CATEGORIES.map((group) => ({
        category: group.category,
        roles: group.roles.map((role) => ({ ...role, base: baseDayRate(role.value) }))
      })),
      countries,
      // The editorial baseline is shown clearly labelled as editorial, never blended
      // into the contributed figures — mixing the two would make the index unfalsifiable.
      curatedBaseline: filters.role ? baseDayRate(filters.role) : null
    });
  })
);

/**
 * GET /rates/calculator
 *
 * A GET with the answers in the query string, not a POST. The result is then a link
 * somebody can bookmark, send to a client or paste into a negotiation, the back button
 * works, and the page needs no scripting to produce a number. The reference posts the form
 * and renders the answer into a page with no address of its own, so the one thing anybody
 * wants to do with a benchmark — show it to somebody else — cannot be done.
 *
 * Nothing here is stored. A benchmark is a calculation over public catalogue values, and
 * recording who asked what about their own pay would be collecting the most sensitive
 * thing on the site for no purpose the person asking gets anything back from.
 */
router.get(
  '/calculator',
  asyncHandler(async (req, res) => {
    const result = benchmark({
      role: req.query.role,
      years: req.query.years,
      certifications: req.query.certifications,
      country: req.query.country,
      region: req.query.region,
      workMode: req.query.work_mode,
      contractType: req.query.contract_type
    });

    /*
     * Same rule as the estimator: a figure that cannot reconcile against the factors
     * printed beside it is a bug in the model, and showing it anyway is how a number
     * nobody can reproduce ends up in somebody's rate card. 500 rather than a quiet
     * fallback, because there is no correct number to fall back to.
     */
    const problems = result ? benchmarkProblems(result) : [];
    if (problems.length) {
      throw new Error(`Rate benchmark did not reconcile: ${problems.join('; ')}`);
    }

    // The contributed index for the same question, fetched so the page can put the two
    // answers side by side. It is never merged into the model's figure.
    const community = result
      ? await RateSubmission.summary({
        role: result.role,
        seniority: '',
        engagementType: 'contract',
        country: result.input.country
      })
      : null;

    res.render('rates/calculator', {
      title: 'Benchmark your day rate',
      result,
      community,
      minSample: MIN_SAMPLE,
      roleCategories: ROLE_CATEGORIES,
      countries,
      model: benchmarkModel,
      submitted: Boolean(req.query.role)
    });
  })
);

router.get(
  '/submit',
  isAuthenticated,
  isConsultant,
  asyncHandler(async (req, res) => {
    const own = await RateSubmission.findOwnLatest(req.session.user.id);
    res.render('rates/submit', {
      title: 'Contribute your rate',
      own,
      form: {},
      roleCategories: ROLE_CATEGORIES,
      currencies: RateSubmission.SUPPORTED_CURRENCIES,
      countries,
      minSample: MIN_SAMPLE,
      amountBounds: BOUNDS,
      amountStep: STEP,
      errors: []
    });
  })
);

router.post(
  '/submit',
  isAuthenticated,
  isConsultant,
  isEmailVerified,
  writeLimiter,
  [
    body('role').isIn(ROLE_SLUGS).withMessage('Choose your role.'),
    body('seniority').isIn(SENIORITIES).withMessage('Choose your seniority.'),
    body('engagement_type').custom(isEngagementType).withMessage('Choose whether this is a day rate or an annual salary.'),
    body('work_mode').isIn(['remote', 'hybrid', 'onsite']),
    body('country').matches(/^[A-Z]{2}$/).withMessage('Choose your country.'),
    /*
     * The bound depends on the other two answers, so it cannot be a fixed range. A day
     * rate and an annual salary share this field and are two hundred times apart; one
     * range covering both bounds neither. `boundsFor` returns null when the engagement
     * type or the currency is not declared — those have their own messages, and refusing
     * here as well would print two complaints for one mistake.
     */
    body('amount').custom((value, { req }) => {
      const bounds = boundsFor(req.body.engagement_type, req.body.currency);
      if (!bounds) return true;
      const amount = Number(value);
      if (!Number.isFinite(amount) || !Number.isInteger(amount)) {
        throw new Error(`Enter ${bounds.label} as a whole number.`);
      }
      if (amount < bounds.min || amount > bounds.max) {
        throw new Error(
          `For ${bounds.label} in ${req.body.currency}, enter a figure between `
          + `${bounds.min.toLocaleString('en-GB')} and ${bounds.max.toLocaleString('en-GB')}.`
        );
      }
      return true;
    }),
    body('currency').isIn(RateSubmission.SUPPORTED_CURRENCIES).withMessage('Choose a supported currency.')
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const own = await RateSubmission.findOwnLatest(req.session.user.id);
      return res.status(422).render('rates/submit', {
        title: 'Contribute your rate',
        own,
        // What they typed, so a refused figure is corrected rather than retyped.
        form: req.body,
        roleCategories: ROLE_CATEGORIES,
        currencies: RateSubmission.SUPPORTED_CURRENCIES,
        countries,
        minSample: MIN_SAMPLE,
        amountBounds: BOUNDS,
        amountStep: STEP,
        errors: errors.array()
      });
    }

    const submission = await RateSubmission.submit(req.session.user.id, {
      role: req.body.role,
      seniority: req.body.seniority,
      engagementType: req.body.engagement_type,
      workMode: req.body.work_mode,
      country: req.body.country,
      amount: req.body.amount,
      currency: req.body.currency
    });

    /*
     * `rate_contributed` was declared in config/community.js with nothing paying it — the
     * same shape this codebase keeps finding: a capability nothing reaches. It matters
     * here rather than merely being tidy, because the moderation screen settles this
     * subject back to nothing when a figure is voided, and a reversal of an award that
     * was never made would take points off somebody for a contribution they were never
     * paid for.
     *
     * Settled rather than awarded, and against the SUBMISSION, so a correction within the
     * month computes a difference of zero and pays nothing twice.
     */
    if (submission.id) {
      await Points.settleTo(
        req.session.user.id,
        'rate_contributed',
        `rate:${submission.id}`,
        submission.voided ? 0 : POINT_AWARDS.rate_contributed.points
      );
    }

    req.flash(
      'success',
      submission.voided
        ? 'Your figure has been saved, but this submission is currently voided and is not counted in any published bucket. Contact us if you think that is wrong.'
        : `Thank you. Your figure counts towards this month, and no bucket is published until at least ${config.rates.minSampleSize} people have contributed to it.`
    );
    return res.redirect(`/rates?role=${encodeURIComponent(req.body.role)}`);
  })
);

/**
 * GET /rates/:role
 *
 * One page per role: the model across the experience bands, and what members have actually
 * contributed for that role beside it. DECLARED LAST, after /calculator and /submit, or a
 * role slug would shadow them — `/rates/submit` is a perfectly good-looking role parameter.
 *
 * An unknown slug is a 404 and not a redirect to the index. These URLs are the ones that
 * get linked to from outside, and a silent redirect turns a typo nobody notices into a
 * page that quietly answers a different question.
 */
router.get(
  '/:role',
  asyncHandler(async (req, res) => {
    const role = req.params.role;
    if (!isRole(role)) {
      return res.status(404).render('errors/404', { title: 'Not found' });
    }

    const filters = { role, seniority: '', engagementType: 'contract', country: '' };
    const [community, bySeniority] = await Promise.all([
      RateSubmission.summary(filters),
      RateSubmission.bySeniority(filters)
    ]);

    const table = curatedTable(role);
    // Each row is a benchmark like any other, so each row reconciles like any other.
    const problems = table.length ? [] : ['no curated table for a known role'];
    if (problems.length) {
      throw new Error(`Rate benchmark did not reconcile: ${problems.join('; ')}`);
    }

    return res.render('rates/role', {
      title: `${roleLabel(role)} day rates`,
      role,
      roleLabel: roleLabel(role),
      table,
      community,
      bySeniority,
      minSample: MIN_SAMPLE,
      baseRate: baseDayRate(role)
    });
  })
);

module.exports = router;
