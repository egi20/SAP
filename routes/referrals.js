'use strict';

const express = require('express');
const { body, validationResult } = require('express-validator');

const config = require('../config/config');
const Referral = require('../models/Referral');
const { isAuthenticated } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/errorHandler');
const { paginationFrom, paginationMeta, pageUrl } = require('../utils/pagination');
const { formatMinor } = require('../config/payments');
const {
  DEFAULT_RATE_BPS,
  MIN_PAYOUT_MINOR,
  MAX_COMMISSION_MINOR,
  ATTRIBUTION_WINDOW_DAYS,
  COMMISSIONABLE_PRODUCTS,
  PAYOUT_METHODS
} = require('../config/referrals');

const router = express.Router();

/**
 * GET /referrals/go/:code — the link a referrer shares.
 *
 * Records the code in the SESSION and redirects to the front door. Deliberately not a
 * long-lived tracking cookie: this application already has a session cookie the visitor
 * has been told about, and adding a second one that follows people for thirty days is a
 * consent question nobody asked. The trade is honest and worth stating — an attribution
 * that survives a browser restart is lost, and the `?ref=` on the registration link is
 * what covers the common case.
 *
 * Writing to the session is what CREATES it for an anonymous visitor: with
 * `saveUninitialized: false` nothing is stored until something is put in it.
 *
 * Public, unauthenticated, and it validates the code before storing anything — an
 * arbitrary string in the session would only surface later as a failed attribution.
 */
router.get(
  '/go/:code',
  asyncHandler(async (req, res) => {
    const referrer = await Referral.findByCode(req.params.code);

    if (referrer && referrer.is_active) {
      req.session.referralCode = referrer.code;
      return res.redirect(`/auth/register?ref=${encodeURIComponent(referrer.code)}`);
    }

    // An unknown or retired code is not an error worth showing a stranger: send them to
    // the front door and let them decide for themselves.
    return res.redirect('/');
  })
);

router.use(isAuthenticated);

/**
 * GET /referrals — the referrer's own view.
 *
 * Enrolment is on request rather than automatic: an account that has not asked to be in a
 * commission scheme should not silently be in one.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const referrer = await Referral.findByUserId(req.session.user.id);

    if (!referrer) {
      return res.render('referrals/join', {
        title: 'Refer someone',
        rateBps: DEFAULT_RATE_BPS,
        minPayout: formatMinor(MIN_PAYOUT_MINOR),
        maxCommission: formatMinor(MAX_COMMISSION_MINOR),
        windowDays: ATTRIBUTION_WINDOW_DAYS,
        commissionableProducts: COMMISSIONABLE_PRODUCTS
      });
    }

    const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 25 });
    const [balance, ledger, introductions, payouts] = await Promise.all([
      Referral.balanceFor(referrer.id),
      Referral.ledgerFor(referrer.id, { limit, offset }),
      Referral.introductionsFor(referrer.id, { limit: 25 }),
      Referral.payoutsFor(referrer.id)
    ]);

    return res.render('referrals/dashboard', {
      title: 'Your referrals',
      referrer,
      balance,
      ledger: ledger.rows,
      introductions,
      payouts,
      shareUrl: `${config.app.baseUrl}/referrals/go/${referrer.code}`,
      payoutMethods: PAYOUT_METHODS,
      windowDays: ATTRIBUTION_WINDOW_DAYS,
      commissionableProducts: COMMISSIONABLE_PRODUCTS,
      formatMinor,
      pagination: paginationMeta({ page, perPage, total: ledger.total }),
      pageUrl: (p) => pageUrl('/referrals', req.query, p)
    });
  })
);

router.post(
  '/join',
  writeLimiter,
  asyncHandler(async (req, res) => {
    await Referral.enrol(req.session.user.id);
    req.flash('success', 'You are in. Share your link and anything it brings in is credited when it is paid.');
    return res.redirect('/referrals');
  })
);

/**
 * Where the money goes. Stored as free text and never transmitted anywhere by this
 * application: an administrator reads it and makes the transfer by hand.
 */
router.post(
  '/payout-details',
  writeLimiter,
  [body('reference').optional({ checkFalsy: true }).trim().isLength({ max: 255 })],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', 'That payout reference is too long.');
      return res.redirect('/referrals');
    }

    try {
      await Referral.setPayoutDetails(req.session.user.id, {
        method: req.body.method || null,
        reference: req.body.reference || null
      });
      req.flash('success', 'Payout details saved.');
    } catch (err) {
      if (err.code !== 'BAD_PAYOUT_METHOD') throw err;
      req.flash('error', err.message);
    }

    return res.redirect('/referrals');
  })
);

module.exports = router;
