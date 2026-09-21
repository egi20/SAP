'use strict';

const express = require('express');

const countries = require('../config/all-countries.json');
const RecruiterProfile = require('../models/RecruiterProfile');
const { isAuthenticated, isRecruiter } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/errorHandler');
const { returnTo } = require('../utils/returnTo');
const { paginationFrom, paginationMeta, pageUrl } = require('../utils/pagination');

const router = express.Router();

/**
 * Recruiters: a public agency directory, plus a dashboard and profile for the account.
 *
 * The guard comes from `middleware/auth.js` rather than being written again here. The
 * reference implementation defines its own `isRecruiter` inside its route file, which
 * means it answers a failed check with a flash and a redirect even when the request is a
 * background fetch — the shared guard knows about `Sec-Fetch-Dest` and answers 401/403
 * JSON for those. One copy, one behaviour.
 */

/**
 * GET /recruiters — the public agency directory.
 *
 * Open to anyone, like `/companies`. Visibility is decided entirely inside
 * `RecruiterProfile.browse`, so this handler cannot accidentally widen it.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 24 });
    const filters = {
      q: req.query.q || '',
      country: req.query.country || '',
      specialism: req.query.specialism || ''
    };

    const { rows, total } = await RecruiterProfile.browse(filters, { limit, offset });

    res.render('recruiters/index', {
      title: 'Recruitment agencies',
      recruiters: rows,
      filters,
      countries,
      specialisms: RecruiterProfile.SPECIALISM_OPTIONS,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (p) => pageUrl('/recruiters', req.query, p)
    });
  })
);

/**
 * GET /recruiters/dashboard — the agency's own home.
 *
 * Note what this does NOT do: it does not create a profile row. The reference's version
 * self-heals with `if (!recruiter) createForUser(...)`, so merely opening the page writes
 * to the database. A GET that inserts cannot be retried safely and creates rows for
 * anyone who only looked; here a missing profile renders a prompt to fill one in.
 */
router.get(
  '/dashboard',
  isAuthenticated,
  isRecruiter,
  asyncHandler(async (req, res) => {
    const userId = req.session.user.id;
    const [profile, stats] = await Promise.all([
      RecruiterProfile.findByUserId(userId),
      RecruiterProfile.statsFor(userId)
    ]);

    res.render('recruiters/dashboard', {
      title: 'Recruiter dashboard',
      profile,
      stats,
      missing: profile ? RecruiterProfile.missingForPublish(profile) : RecruiterProfile.REQUIRED_TO_PUBLISH
    });
  })
);

/** GET /recruiters/profile — the edit form. Also does not write. */
router.get(
  '/profile',
  isAuthenticated,
  isRecruiter,
  asyncHandler(async (req, res) => {
    const profile = await RecruiterProfile.findByUserId(req.session.user.id);

    res.render('recruiters/profile', {
      title: 'Agency profile',
      profile,
      countries,
      specialisms: RecruiterProfile.SPECIALISM_OPTIONS,
      limits: RecruiterProfile.LIMITS,
      required: RecruiterProfile.REQUIRED_TO_PUBLISH,
      missing: profile ? RecruiterProfile.missingForPublish(profile) : RecruiterProfile.REQUIRED_TO_PUBLISH
    });
  })
);

/**
 * POST /recruiters/profile — save it.
 *
 * Every field goes through `RecruiterProfile.normaliseProfile`, which is pure and tested.
 * The reference declares express-validator rules on this route and never calls
 * `validationResult`, so none of them do anything — the rules are decorative and an
 * unbounded agency name reaches the column.
 */
router.post(
  '/profile',
  isAuthenticated,
  isRecruiter,
  writeLimiter,
  asyncHandler(async (req, res) => {
    try {
      await RecruiterProfile.save(req.session.user.id, req.body);
      req.flash('success', 'Agency profile saved.');
    } catch (err) {
      if (err.code !== 'AGENCY_NAME_REQUIRED') throw err;
      req.flash('error', err.message);
    }
    return res.redirect(returnTo(req, '/recruiters/profile'));
  })
);

/**
 * POST /recruiters/profile/visibility — list or unlist the agency.
 *
 * Refused while a required field is empty, and the refusal names the fields. "Complete
 * your profile" with no list is the message people bounce off.
 */
router.post(
  '/profile/visibility',
  isAuthenticated,
  isRecruiter,
  writeLimiter,
  asyncHandler(async (req, res) => {
    const wantPublic = req.body.is_public === 'true';
    try {
      const changed = await RecruiterProfile.setPublic(req.session.user.id, wantPublic);
      if (!changed) {
        req.flash('error', 'Save your profile first, then list it.');
      } else {
        req.flash('success', wantPublic ? 'Your agency is now in the directory.' : 'Your agency is hidden from the directory.');
      }
    } catch (err) {
      if (err.code !== 'INCOMPLETE_PROFILE') throw err;
      req.flash('error', err.message);
    }
    return res.redirect(returnTo(req, '/recruiters/profile'));
  })
);

/**
 * GET /recruiters/:slug — one public agency page.
 *
 * Last, so it cannot shadow `/dashboard` or `/profile`. Matched on the slug rather than
 * an id, so there is no `:id` to validate — and `findBySlug` re-checks `is_public` and
 * `is_active` itself rather than trusting that the directory was the only way in.
 */
router.get(
  '/:slug',
  asyncHandler(async (req, res, next) => {
    const profile = await RecruiterProfile.findBySlug(String(req.params.slug || '').slice(0, 220));
    if (!profile) return next();

    return res.render('recruiters/show', {
      title: profile.agency_name,
      profile,
      specialisms: RecruiterProfile.SPECIALISM_OPTIONS
    });
  })
);

module.exports = router;
