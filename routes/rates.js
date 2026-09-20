'use strict';

const express = require('express');
const { body, validationResult } = require('express-validator');

const RateSubmission = require('../models/RateSubmission');
const { isAuthenticated, isConsultant, isEmailVerified } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/errorHandler');
const { ROLE_CATEGORIES, ROLE_SLUGS, isRole, baseDayRate } = require('../config/roleTaxonomy');
const { MIN_SAMPLE } = require('../utils/rateAggregation');
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
      countries,
      // The editorial baseline is shown clearly labelled as editorial, never blended
      // into the contributed figures — mixing the two would make the index unfalsifiable.
      curatedBaseline: filters.role ? baseDayRate(filters.role) : null
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
      roleCategories: ROLE_CATEGORIES,
      currencies: RateSubmission.SUPPORTED_CURRENCIES,
      countries,
      minSample: MIN_SAMPLE,
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
    body('engagement_type').isIn(['contract', 'permanent']),
    body('work_mode').isIn(['remote', 'hybrid', 'onsite']),
    body('country').matches(/^[A-Z]{2}$/).withMessage('Choose your country.'),
    body('amount').isFloat({ min: 1, max: 1000000 }).withMessage('Enter the amount as a number.'),
    body('currency').isIn(RateSubmission.SUPPORTED_CURRENCIES).withMessage('Choose a supported currency.')
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const own = await RateSubmission.findOwnLatest(req.session.user.id);
      return res.status(422).render('rates/submit', {
        title: 'Contribute your rate',
        own,
        roleCategories: ROLE_CATEGORIES,
        currencies: RateSubmission.SUPPORTED_CURRENCIES,
        countries,
        minSample: MIN_SAMPLE,
        errors: errors.array()
      });
    }

    await RateSubmission.submit(req.session.user.id, {
      role: req.body.role,
      seniority: req.body.seniority,
      engagementType: req.body.engagement_type,
      workMode: req.body.work_mode,
      country: req.body.country,
      amount: req.body.amount,
      currency: req.body.currency
    });

    req.flash(
      'success',
      `Thank you. Your figure counts towards this month, and no bucket is published until at least ${config.rates.minSampleSize} people have contributed to it.`
    );
    return res.redirect(`/rates?role=${encodeURIComponent(req.body.role)}`);
  })
);

/*
 * NO CONTRACT RATE CALCULATOR YET.
 *
 * It belongs to consultant tooling, which is a later area, and it is listed here rather
 * than half-built because its interesting part is not the arithmetic. The reference's
 * projection is entirely BEFORE TAX and says so on every line — deliberately, because
 * DynamicsHub's version multiplied by a hard-coded rate and presented the result as a
 * saving. Whatever lands here inherits that constraint, and the refusal of a tax figure
 * that is really a guess, from `docs/PORT-PLAN.md`.
 */

module.exports = router;
