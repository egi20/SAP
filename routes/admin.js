'use strict';

const express = require('express');

const User = require('../models/User');
const Job = require('../models/Job');
const Post = require('../models/Post');
const ErrorLog = require('../models/ErrorLog');
const RateSubmission = require('../models/RateSubmission');
const Payment = require('../models/Payment');
const Moderation = require('../models/Moderation');
const Application = require('../models/Application');
const AppSetting = require('../models/AppSetting');
const Referral = require('../models/Referral');
const SuccessStory = require('../models/SuccessStory');
const SiteReview = require('../models/SiteReview');
const Enquiry = require('../models/Enquiry');
const ImageBlob = require('../models/ImageBlob');
const ApiUsage = require('../models/ApiUsage');
const assistantConfig = require('../config/assistant');
const draftingConfig = require('../config/drafting');
const { budgetStatus } = require('../utils/aiBudget');
const { formatMinor } = require('../config/payments');
const { DEFINITIONS: SETTING_DEFINITIONS } = require('../config/settings');
const { PAYOUT_METHODS, MIN_PAYOUT_MINOR, DEFAULT_RATE_BPS } = require('../config/referrals');
const { PRODUCT_LINES } = require('../config/sapProducts');
const { singleImage } = require('../middleware/fileUpload');
const { roleLabel } = require('../config/roleTaxonomy');
const { returnTo } = require('../utils/returnTo');
const { promisePool } = require('../config/database');
const { isAuthenticated, isAdmin, isSuperadmin } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireIdParam } = require('../utils/ids');
const { paginationFrom, paginationMeta, pageUrl } = require('../utils/pagination');

/**
 * How long a submitted application sits before the oversight screen calls it stalled.
 *
 * Two weeks: long enough that a company with a slow week is not accused of ignoring
 * somebody, short enough that a candidate waiting that long has already given up.
 */
const STALLED_AFTER_DAYS = 14;

const router = express.Router();

/*
 * One guard, applied once, at the top.
 *
 * Every handler below is behind `isAdmin`, and the narrower ones add `isSuperadmin` on
 * top. Per-route guards on a surface this size is how one route ends up without one — and
 * the guards themselves live in middleware/auth.js and nowhere else, because a
 * route-local copy does not know about `Sec-Fetch-Dest` and answers a background fetch
 * with a redirect to the login page.
 */
router.use(isAuthenticated, isAdmin);

/* ---------------------------------------------------------------- dashboard */

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const [[counts]] = await promisePool.query(
      `SELECT
         (SELECT COUNT(*) FROM users)                                   AS users,
         (SELECT COUNT(*) FROM users WHERE is_active = 1)               AS active_users,
         (SELECT COUNT(*) FROM users WHERE email_verified = 1)          AS verified_users,
         (SELECT COUNT(*) FROM consultant_profiles WHERE is_public = 1) AS public_consultants,
         (SELECT COUNT(*) FROM company_profiles)                        AS companies,
         (SELECT COUNT(*) FROM jobs)                                    AS jobs,
         (SELECT COUNT(*) FROM jobs WHERE status = 'open')              AS open_jobs,
         (SELECT COUNT(*) FROM applications)                            AS applications,
         (SELECT COUNT(*) FROM quotes)                                  AS quotes,
         (SELECT COUNT(*) FROM posts WHERE hidden_at IS NULL)           AS posts,
         (SELECT COUNT(*) FROM payments WHERE needs_refund = 1)         AS refunds_due,
         (SELECT COUNT(*) FROM error_logs
           WHERE created_at > DATE_SUB(NOW(), INTERVAL 7 DAY))          AS recent_errors`
    );

    const [geo] = await promisePool.query(
      `SELECT country, SUM(visits) AS visits
         FROM visit_geo_daily
        WHERE day > DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        GROUP BY country
        ORDER BY visits DESC
        LIMIT 12`
    );

    return res.render('admin/index', {
      title: 'Admin',
      counts,
      geo,
      rateContributors: await RateSubmission.totalContributors()
    });
  })
);

/* -------------------------------------------------------------------- users */

router.get(
  '/users',
  asyncHandler(async (req, res) => {
    const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 30 });
    const { rows, total } = await User.list({
      search: req.query.q || '',
      role: User.ALL_ROLES.includes(req.query.role) ? req.query.role : '',
      // Checked against a fixed pair in the model as well; this is the screen's half.
      status: ['active', 'inactive'].includes(req.query.status) ? req.query.status : '',
      limit,
      offset
    });

    return res.render('admin/users', {
      title: 'Users',
      /*
       * Roles are derived by `User.rolesOf`, never re-derived in the template. The flags
       * and the primary `user_type` do not line up one-to-one — `admin` has no flag
       * column of its own, and every flag implies its role while the primary type also
       * counts as one — so a view that read the columns directly would disagree with the
       * guards about who is what.
       */
      users: rows.map((row) => ({ ...row, roles: User.rolesOf(row) })),
      roles: User.ALL_ROLES,
      query: req.query,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (n) => pageUrl('/admin/users', req.query, n)
    });
  })
);

/**
 * The only path that removes a role or grants a privileged one — see CLAUDE.md.
 *
 * Superadmin-gated, because granting `admin` from this form is a full escalation, and
 * refused on your own account: an administrator who removes their own last privileged
 * role locks themselves out of the screen they would need to undo it.
 */
router.post(
  '/users/:id/roles',
  isSuperadmin,
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    if (req.params.id === req.session.user.id) {
      req.flash('error', 'You cannot change your own roles here.');
      return res.redirect('/admin/users');
    }

    const submitted = Array.isArray(req.body.roles) ? req.body.roles : [req.body.roles].filter(Boolean);
    const roles = await User.adminSetRoles(req.params.id, submitted, { primary: req.body.primary || null });
    req.flash('success', `Roles set to: ${roles.join(', ') || 'none'}.`);
    return res.redirect(returnTo(req, '/admin/users'));
  })
);

router.post(
  '/users/:id/active',
  isSuperadmin,
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    if (req.params.id === req.session.user.id) {
      req.flash('error', 'You cannot deactivate your own account.');
      return res.redirect('/admin/users');
    }
    await User.setActive(req.params.id, req.body.is_active === 'on');
    /*
     * No session to invalidate here, and that is deliberate rather than an omission:
     * `validateActiveAccount` rebuilds req.session.user from the database on every
     * request, so a deactivated account is signed out on its next one. A privilege cache
     * anywhere else would be a second answer to the same question.
     */
    req.flash('success', 'Account updated. It takes effect on that account’s next request.');
    return res.redirect(returnTo(req, '/admin/users'));
  })
);

/**
 * Force-verify an address.
 *
 * Without this an account whose owner never received the confirmation e-mail can never
 * sign in at all — the verification guard refuses them and the resend goes to the same
 * unreachable inbox. Ordinary admin rather than superadmin: it grants no privilege, it
 * only completes a step the person had already taken.
 */
router.post(
  '/users/:id/verify',
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    await User.setEmailVerified(req.params.id);
    req.flash('success', 'Email marked as verified.');
    return res.redirect(returnTo(req, '/admin/users'));
  })
);

/* --------------------------------------------------------------------- jobs */

/**
 * GET /admin/jobs — every advert, at any status.
 *
 * Through `Job.browse`, which is the same builder the public board and the bulk actions
 * use. An admin list assembled from its own query is a list that can disagree with the
 * one an employer sees about which rows exist — and this screen exists precisely to
 * answer "what is actually on the board".
 */
router.get(
  '/jobs',
  asyncHandler(async (req, res) => {
    const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 30 });
    const status = Job.STATUSES.includes(req.query.status) ? req.query.status : 'open';
    /*
     * The status parameter has been honoured here since this screen was written and the
     * page offered no control for it — a filter nothing can reach is a filter nobody uses.
     * The search goes through the same builder, so the list and its count agree.
     */
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 120) : '';
    const { rows, total } = await Job.browse({ status, q }, { limit, offset, sort: 'newest' });

    return res.render('admin/jobs', {
      title: 'Jobs',
      jobs: rows,
      status,
      q,
      query: req.query,
      statuses: Job.STATUSES,
      roleLabel,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (n) => pageUrl('/admin/jobs', req.query, n)
    });
  })
);

/* --------------------------------------------------------------- moderation */

/**
 * GET /admin/moderation — what has been taken down, and what could be.
 *
 * Content is hidden, never deleted, so this screen is as much about putting things back as
 * about removing them: every hidden item is listed with who hid it and why, and one button
 * restores it. A moderation tool that can only remove is a tool nobody dares use.
 */
router.get(
  '/moderation',
  asyncHandler(async (req, res) => {
    const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 30 });

    const [hidden, log, recent] = await Promise.all([
      Moderation.hiddenContent({ limit: 50 }),
      Moderation.events({ limit, offset }),
      // The same builder the public list uses, with the one documented opt-in, so the
      // moderator is provably looking at the rows a reader would.
      Post.browse({ include_hidden: true }, { limit: 20, offset: 0, sort: 'recent' })
    ]);

    return res.render('admin/moderation', {
      title: 'Moderation',
      hidden,
      events: log.rows,
      recentPosts: recent.rows,
      pagination: paginationMeta({ page, perPage, total: log.total }),
      pageUrl: (n) => pageUrl('/admin/moderation', req.query, n)
    });
  })
);

/**
 * The three content actions, from one factory.
 *
 * Each is a single POST that flips a flag one way or the other, so there is no "delete"
 * verb anywhere in the admin surface for user-written content. `Moderation` is the only
 * module that touches these columns — it also moves the reply counter, the
 * accepted-answer mark and the points ledger, none of which a bare UPDATE here would
 * remember to do.
 */
function moderationAction(handler, describe) {
  return asyncHandler(async (req, res) => {
    const back = returnTo(req, '/admin/moderation');
    const on = req.body.hidden === 'true';
    const reason = (req.body.reason || '').trim() || null;

    try {
      const result = await handler(req.params.id, on, {
        actorUserId: req.session.user.id,
        reason
      });
      req.flash(
        'success',
        result.changed ? describe(on) : 'Nothing to do — it was already in that state.'
      );
    } catch (err) {
      if (err.code !== 'NOT_FOUND') throw err;
      req.flash('error', err.message);
    }

    return res.redirect(back);
  });
}

router.post(
  '/moderation/posts/:id',
  requireIdParam('id'),
  writeLimiter,
  moderationAction(
    (id, hide, options) => Moderation.setPostHidden(id, hide, options),
    (hide) => (hide ? 'Post hidden. Its author keeps the text; you can restore it.' : 'Post restored.')
  )
);

router.post(
  '/moderation/replies/:id',
  requireIdParam('id'),
  writeLimiter,
  moderationAction(
    (id, hide, options) => Moderation.setReplyHidden(id, hide, options),
    (hide) => (hide ? 'Reply hidden, and the thread count corrected.' : 'Reply restored.')
  )
);

/**
 * A rate submission is VOIDED rather than hidden, and the wording matters: this is not
 * moderation of speech, it is excluding a figure from an average. Superadmin-gated,
 * because the screen it is operated from shows contributed rates next to the people who
 * gave them, which is the one place the index's promise of aggregation is set aside.
 */
router.post(
  '/moderation/rates/:id',
  isSuperadmin,
  requireIdParam('id'),
  writeLimiter,
  moderationAction(
    (id, voided, options) => Moderation.setRateVoided(id, voided, options),
    (voided) => (voided ? 'Submission voided and removed from every aggregate.' : 'Submission reinstated.')
  )
);

/**
 * GET /admin/rates — contributed figures, with a hint about which look wrong.
 *
 * Superadmin-only. Everywhere else in this application a rate is only ever seen inside an
 * aggregate over at least three people, and this screen deliberately breaks that — so it
 * carries the narrowest guard in the app, and `outlier` is a hint about where to look
 * rather than anything automatic. An unusually high day rate is far more often a real
 * senior contractor than a mistake.
 */
router.get(
  '/rates',
  isSuperadmin,
  asyncHandler(async (req, res) => {
    const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 40 });
    const includeVoided = req.query.voided === '1';
    const { rows, total } = await RateSubmission.listForReview({ limit, offset, includeVoided });

    return res.render('admin/rates', {
      title: 'Rate submissions',
      submissions: rows,
      includeVoided,
      roleLabel,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (n) => pageUrl('/admin/rates', req.query, n)
    });
  })
);

/* ----------------------------------------------------------------- payments */

/**
 * GET /admin/payments — the money view, and the refund queue.
 *
 * The queue is the point of the page. A payment flagged `needs_refund` is money that
 * arrived and could not be fulfilled — almost always two checkout tabs open against one
 * quote, where the schema let exactly one of them settle it. Nothing reverses those
 * automatically: a refund is a decision with a person on the other end of it, and a
 * webhook handler issuing one has neither the context nor the accountability for it.
 */
router.get(
  '/payments',
  asyncHandler(async (req, res) => {
    const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 30 });

    const [[totals]] = await promisePool.query(
      `SELECT
         (SELECT COUNT(*) FROM payments WHERE status = 'paid')                       AS paid_count,
         (SELECT COALESCE(SUM(amount_minor), 0) FROM payments WHERE status = 'paid') AS paid_minor,
         (SELECT COUNT(*) FROM payments WHERE status = 'pending')                    AS pending_count,
         (SELECT COUNT(*) FROM payments WHERE needs_refund = 1)                      AS refund_count,
         (SELECT COUNT(*) FROM invoices)                                             AS invoices`
    );

    const [rows] = await promisePool.query(
      `SELECT p.*, u.email, i.number AS invoice_number
         FROM payments p
         JOIN users u ON u.id = p.user_id
         LEFT JOIN invoices i ON i.payment_id = p.id
        ORDER BY p.created_at DESC
        LIMIT ? OFFSET ?`,
      [limit, offset]
    );
    const [[{ total }]] = await promisePool.query('SELECT COUNT(*) AS total FROM payments');

    return res.render('admin/payments', {
      title: 'Payments',
      totals,
      payments: rows,
      refunds: await Payment.listNeedingRefund({ limit: 20 }),
      formatMinor,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (n) => pageUrl('/admin/payments', req.query, n)
    });
  })
);

/**
 * POST /admin/payments/:id/refunded — record that a refund was actually made.
 *
 * It clears the flag and writes an event. It does NOT call Stripe: the refund is issued in
 * Stripe by a person, and this screen records that it happened. A button here that moved
 * money would be a second system of record for the same fact, and the one that is wrong
 * when they disagree is always this one.
 */
router.post(
  '/payments/:id/refunded',
  isSuperadmin,
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const note = (req.body.note || '').trim() || null;
    const recorded = await Payment.recordRefund(req.params.id, {
      actorUserId: req.session.user.id,
      note
    });

    if (!recorded) {
      req.flash('error', 'That payment is not in a state that can be refunded.');
      return res.redirect(returnTo(req, '/admin/payments'));
    }

    /*
     * And take back the commission it earned.
     *
     * NOT an automatic clawback — the distinction matters and it is the same one the rest
     * of payments makes. Nothing in a webhook debits anybody: this runs because a person
     * pressed this button, having already decided to give the money back. What it stops is
     * that decision leaving an untracked debt behind it, which is what happens when the
     * only correction available is a separate manual adjustment nobody is prompted to
     * make. Reversing from the stored entry is also exact, where retyping the figure into
     * an adjustment is how a balance ends up a cent out.
     */
    const { reversed } = await Referral.reverseForPayment(req.params.id, { note });

    req.flash(
      'success',
      reversed
        ? `Marked as refunded, and ${formatMinor(Math.abs(reversed))} of commission reversed. Both stay in their ledgers.`
        : 'Marked as refunded. The payment stays in the ledger; its status now says so.'
    );
    return res.redirect(returnTo(req, '/admin/payments'));
  })
);

/* ---------------------------------------------------------------- assistant */

/**
 * GET /admin/ai — what the assistant has cost.
 *
 * The number that matters is month-to-date against the cap, because that cap is the only
 * thing bounding a public endpoint that spends money per request. Everything else on this
 * page is context for it — including which model is answering and at what price, since
 * those two are what the budget arithmetic is built on and the pair most likely to drift
 * apart when somebody changes the model through the environment.
 */
router.get(
  '/ai',
  asyncHandler(async (req, res) => {
    const [budget, daily] = await Promise.all([budgetStatus(), ApiUsage.dailyCost({ days: 30 })]);

    return res.render('admin/ai', {
      title: 'Assistant usage',
      budget,
      daily,
      model: assistantConfig.MODEL,
      effort: assistantConfig.EFFORT,
      configured: assistantConfig.isConfigured(),
      priceInput: assistantConfig.PRICE_PER_MTOK_INPUT,
      priceOutput: assistantConfig.PRICE_PER_MTOK_OUTPUT,
      /*
       * The CRM's drafting model and ITS prices, printed on the same page, because there
       * are now two models spending from one budget. The failure this screen exists for —
       * a model changed without the prices beside it, so the breaker charges the wrong
       * rate silently — is one a second feature can have on its own.
       */
      drafting: {
        model: draftingConfig.MODEL,
        effort: draftingConfig.EFFORT,
        priceInput: draftingConfig.PRICE_PER_MTOK_INPUT,
        priceOutput: draftingConfig.PRICE_PER_MTOK_OUTPUT,
        sameAsAssistant: draftingConfig.MODEL === assistantConfig.MODEL
      }
    });
  })
);

/**
 * POST /admin/users/:id/talent — take a consultant profile out of the public directory,
 * or put it back.
 *
 * ADMIN, not superadmin, and that is deliberate: this is moderation, which is what an
 * ordinary administrator is for. It is also why it is not the deactivate button — the
 * account keeps working, and the only thing that goes is the public listing.
 *
 * `Moderation.setProfileHidden` is the single writer, so the decision lands in the same
 * log as every other one and the directory, the search source and the match all drop the
 * profile through `ConsultantProfile.buildFilter` without any of them knowing why.
 */
router.post(
  '/users/:id/talent',
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    // The same rule as the roles form and the deactivate button: not on your own account.
    if (req.params.id === req.session.user.id) {
      req.flash('error', 'That is your own profile.');
      return res.redirect(returnTo(req, '/admin/users'));
    }

    const hidden = req.body.hidden === 'on';
    try {
      const result = await Moderation.setProfileHidden(req.params.id, hidden, {
        actorUserId: req.session.user.id,
        reason: req.body.reason
      });
      if (!result.changed) {
        req.flash('info', 'Somebody had already done that.');
      } else {
        req.flash(
          'success',
          hidden
            ? 'Taken out of the directory. The account still works; only the public listing is gone.'
            : 'Our decision is cleared. Whether it appears again is their own publish switch.'
        );
      }
    } catch (err) {
      if (err.code !== 'NOT_FOUND') throw err;
      req.flash('error', err.message);
    }
    return res.redirect(returnTo(req, '/admin/users'));
  })
);

/**
 * POST /admin/jobs/:id/hidden — take an advert out of the board, or put it back.
 *
 * NOT "delete the job", and not a status change. The applications made to it, their audit
 * events and the conversations anchored to it belong to other people; and an advertiser
 * moves their own `status` freely, so a moderator writing `closed` there would be overruled
 * by the next press of Reopen.
 *
 * There is also no admin path that CREATES or EDITS an advert, deliberately. An advert
 * belongs to a company account: it carries that company's "About the company" box, its
 * applications land in that account's pipeline, and the threads about it are anchored to
 * that account. An advert written here would name a company that did not write it.
 */
router.post(
  '/jobs/:id/hidden',
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const hidden = req.body.hidden === 'on';
    try {
      const result = await Moderation.setJobHidden(req.params.id, hidden, {
        actorUserId: req.session.user.id,
        reason: req.body.reason
      });
      if (!result.changed) {
        req.flash('info', 'Somebody had already done that.');
      } else {
        req.flash(
          'success',
          hidden
            ? `"${result.job.title}" is off the board. The applications already made to it stay.`
            : 'Our decision is cleared. Whether it is live again is the advertiser\'s own status.'
        );
      }
    } catch (err) {
      if (err.code !== 'NOT_FOUND') throw err;
      req.flash('error', err.message);
    }
    return res.redirect(returnTo(req, '/admin/jobs'));
  })
);

/**
 * GET /admin/errors/export.csv — the same rows the screen showed.
 *
 * The stack trace is left out deliberately. It is the one field here that can carry a file
 * path, a query fragment or a value from the request that produced it, and an export is a
 * file that leaves the machine and gets attached to things.
 */
router.get(
  '/errors/export.csv',
  asyncHandler(async (req, res) => {
    const rows = await ErrorLog.exportRows(errorFiltersFrom(req.query));

    const header = ['created_at', 'status_code', 'method', 'path', 'message', 'user_id'];
    // Every cell quoted and every quote doubled: a message containing a comma is the
    // ordinary case here, not the odd one.
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [header.join(','), ...rows.map((r) => header.map((h) => cell(r[h])).join(','))].join('\r\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="errors.csv"');
    res.setHeader('Cache-Control', 'private, no-store');
    return res.send(csv);
  })
);

/* ------------------------------------------------------- applications oversight */

/**
 * GET /admin/applications — every application on the platform.
 *
 * SUPERADMIN, like `/admin/rates`, and for the same reason: this is the one screen that
 * can enumerate what candidates wrote to employers. It shows the STATE of each application
 * and never its content — the cover letter and the day rate live on
 * `/applications/:id`, which carries the same guard.
 *
 * The question it exists to answer is not "who applied", which a company's own pipeline
 * already answers better. It is whether the marketplace is working: a candidate spends an
 * evening on an application, and a board where those sit untouched for a month is broken
 * in a way no count of adverts shows. That is what `stalled` is.
 *
 * It goes through `Application.buildFilter` like the two pipelines do, with `unscoped`
 * said out loud — the builder still throws for a caller that simply forgot a scope.
 */
router.get(
  '/applications',
  isSuperadmin,
  asyncHandler(async (req, res) => {
    const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 50 });

    const stalledDays = Number.parseInt(req.query.stalled, 10);
    const filters = {
      unscoped: true,
      status: Application.STATUSES.includes(req.query.status) ? req.query.status : '',
      q: typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 120) : '',
      reached: req.query.reached === 'interviewing' ? 'interviewing' : '',
      include_withdrawn: req.query.withdrawn === '1',
      stalled_days: Number.isFinite(stalledDays) && stalledDays > 0 ? stalledDays : null
    };

    const [{ rows, total }, counts, stalled] = await Promise.all([
      Application.list(filters, { limit, offset }),
      Application.countsFor({ ...filters, stalled_days: null }),
      // The headline number, and it is deliberately NOT affected by the stage filter: it
      // is the one figure somebody opens this screen for.
      Application.list({ unscoped: true, stalled_days: STALLED_AFTER_DAYS }, { limit: 1 })
    ]);

    return res.render('admin/applications', {
      title: 'Applications',
      applications: rows,
      total,
      counts,
      filters,
      statuses: Application.STATUSES,
      stalledAfterDays: STALLED_AFTER_DAYS,
      stalledCount: stalled.total,
      query: req.query,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (n) => pageUrl('/admin/applications', req.query, n)
    });
  })
);

/* ---------------------------------------------------------------- referrals */

/**
 * GET /admin/referrals — who is owed what.
 *
 * Every balance on this page is a SUM over `commission_ledger`. There is no cached total
 * anywhere to disagree with it, which is the whole reason the scheme has no balance
 * columns: the first time a stored figure and its own history diverge, nobody can say
 * which one somebody is actually owed.
 */
router.get(
  '/referrals',
  isSuperadmin,
  asyncHandler(async (req, res) => {
    const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 30 });
    const { rows, total } = await Referral.listAll({ limit, offset });

    res.render('admin/referrals', {
      title: 'Referrals and payouts',
      referrers: rows,
      payoutMethods: PAYOUT_METHODS,
      minPayoutMinor: MIN_PAYOUT_MINOR,
      defaultRateBps: DEFAULT_RATE_BPS,
      formatMinor,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (p) => pageUrl('/admin/referrals', req.query, p)
    });
  })
);

/**
 * POST /admin/referrals/:id/payout — record that a transfer was made.
 *
 * It settles the WHOLE unpaid balance, not an amount typed into a box. The reference took
 * a requested figure and matched it against unpaid rows FIFO, which produced refusals like
 * "requested €3 cannot be matched exactly by unpaid commissions" — a problem created
 * entirely by that design. Settling everything unpaid has no remainder to explain.
 *
 * This records that money LEFT; it does not move any. There is no automated transfer here
 * and there should not be: Stripe collects, a person pays out, and the gap between them is
 * where somebody looks at the number before it goes.
 */
router.post(
  '/referrals/:id/payout',
  isSuperadmin,
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    try {
      const result = await Referral.payOut(req.params.id, {
        method: req.body.method,
        reference: req.body.reference || null,
        note: req.body.note || null,
        actorUserId: req.session.user.id
      });
      req.flash(
        'success',
        `Recorded a payout of ${formatMinor(result.amountMinor, result.currency)} covering ${result.entries} entries.`
      );
    } catch (err) {
      if (!['NOTHING_TO_PAY', 'BELOW_MINIMUM', 'BAD_PAYOUT_METHOD'].includes(err.code)) throw err;
      req.flash('error', err.message);
    }
    return res.redirect('/admin/referrals');
  })
);

/**
 * POST /admin/referrals/:id/adjust — a compensating entry.
 *
 * The only way a commission is ever reversed, and it takes a human and a reason that the
 * referrer will see. There is deliberately no automatic clawback on a refund: a webhook
 * silently debiting somebody's balance is how a referrer discovers from a dashboard that
 * they owe money.
 */
router.post(
  '/referrals/:id/adjust',
  isSuperadmin,
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    try {
      await Referral.adjust(req.params.id, {
        // Entered in euros because that is what a person reading a refund thinks in;
        // stored in cents because that is the only thing the ledger holds.
        amountMinor: Math.round(Number(req.body.amount_eur) * 100),
        note: req.body.note,
        actorUserId: req.session.user.id
      });
      req.flash('success', 'Adjustment recorded. It is visible to the referrer with its reason.');
    } catch (err) {
      if (!['BAD_ADJUSTMENT', 'REASON_REQUIRED'].includes(err.code)) throw err;
      req.flash('error', err.message);
    }
    return res.redirect('/admin/referrals');
  })
);

router.post(
  '/referrals/:id/active',
  isSuperadmin,
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    await Referral.setActive(req.params.id, req.body.is_active === 'true');
    // Note what this does NOT do: a retired referrer keeps every attribution and every
    // entry already earned. Deactivating stops new introductions, it does not take money
    // back.
    req.flash('success', 'Referrer updated. Existing attributions and balances are untouched.');
    return res.redirect('/admin/referrals');
  })
);

router.post(
  '/referrals/:id/rate',
  isSuperadmin,
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const rate = await Referral.setRate(req.params.id, req.body.rate_bps);
    // Only future introductions: `referral_attributions.rate_bps` snapshots the rate in
    // force when the introduction was made, so nobody is repriced retroactively.
    req.flash('success', `Rate set to ${rate / 100}% for introductions made from now on.`);
    return res.redirect('/admin/referrals');
  })
);

/* ------------------------------------------------------------------- errors */

/**
 * What the error screen reads out of the query string, in one place — the list, the top
 * paths and the export all take the same object, so the summary cannot describe a
 * different set of rows from the table under it.
 */
function errorFiltersFrom(query) {
  return {
    q: typeof query.q === 'string' ? query.q.trim().slice(0, 200) : '',
    statusCode: query.status_code || '',
    from: query.from || '',
    to: query.to || ''
  };
}

router.get(
  '/errors',
  asyncHandler(async (req, res) => {
    const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 50 });
    const filters = errorFiltersFrom(req.query);

    const [{ rows, total }, topPaths, statusCodes] = await Promise.all([
      ErrorLog.list(filters, { limit, offset }),
      // Of what is on the screen, not of everything ever recorded — which is the number
      // somebody wants when they have just narrowed to one day.
      ErrorLog.topPaths(filters, { limit: 10 }),
      ErrorLog.statusCodes()
    ]);

    return res.render('admin/errors', {
      title: 'Error log',
      errors: rows,
      topPaths,
      statusCodes,
      filters,
      query: req.query,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (n) => pageUrl('/admin/errors', req.query, n)
    });
  })
);

/**
 * POST /admin/errors/purge — drop entries older than a chosen window.
 *
 * The table grows without bound otherwise, and an error log nobody can load is an error
 * log nobody reads. The window is checked against a fixed set rather than taken as a
 * number: `INTERVAL ? DAY` with a zero deletes everything, and a purge is the one action
 * on this screen that cannot be undone.
 */
router.post(
  '/errors/purge',
  isSuperadmin,
  writeLimiter,
  asyncHandler(async (req, res) => {
    const ALLOWED_DAYS = [30, 90, 180, 365];
    const days = Number.parseInt(req.body.days, 10);
    if (!ALLOWED_DAYS.includes(days)) {
      req.flash('error', 'Choose one of the offered retention windows.');
      return res.redirect('/admin/errors');
    }

    const removed = await ErrorLog.purgeOlderThan(days);
    req.flash('success', `Removed ${removed} entries older than ${days} days.`);
    return res.redirect('/admin/errors');
  })
);

/* ------------------------------------------------- stories and reviews */

/**
 * GET /admin/stories — write and manage case studies.
 *
 * Admin, not superadmin: a story is marketing copy about work that was done, not a screen
 * showing somebody's private circumstances.
 */
router.get(
  '/stories',
  asyncHandler(async (req, res) => {
    const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 20 });
    const { rows, total } = await SuccessStory.list({ include_unpublished: true }, { limit, offset });

    res.render('admin/stories', {
      title: 'Success stories',
      stories: rows,
      families: PRODUCT_LINES,
      limits: SuccessStory.LIMITS,
      editing: req.query.edit ? await SuccessStory.findById(parseInt(req.query.edit, 10) || 0) : null,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (p) => pageUrl('/admin/stories', req.query, p)
    });
  })
);

router.post(
  '/stories',
  writeLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { slug } = await SuccessStory.create(req.body, { actorUserId: req.session.user.id });
      req.flash('success', `Story created as a draft. Publish it when you are ready (${slug}).`);
    } catch (err) {
      if (!['TITLE_REQUIRED', 'BODY_REQUIRED'].includes(err.code)) throw err;
      req.flash('error', err.message);
    }
    return res.redirect('/admin/stories');
  })
);

router.post(
  '/stories/:id',
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    try {
      await SuccessStory.update(req.params.id, req.body);
      req.flash('success', 'Story saved.');
    } catch (err) {
      if (!['TITLE_REQUIRED', 'BODY_REQUIRED', 'NOT_FOUND'].includes(err.code)) throw err;
      req.flash('error', err.message);
    }
    return res.redirect(returnTo(req, '/admin/stories'));
  })
);

/**
 * Publish and hide are separate switches, and neither is a delete.
 *
 * Unpublished means "not finished"; hidden means "was live and should not be". Collapsing
 * them into one flag loses the difference between a draft and a retraction, and the
 * retraction is the one somebody will ask about later.
 */
router.post(
  '/stories/:id/state',
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    if (req.body.field === 'published') {
      await SuccessStory.setPublished(req.params.id, req.body.value === 'true');
      req.flash('success', req.body.value === 'true' ? 'Story published.' : 'Story unpublished.');
    } else if (req.body.field === 'hidden') {
      await SuccessStory.setHidden(req.params.id, req.body.value === 'true');
      req.flash('success', req.body.value === 'true' ? 'Story hidden. Nothing was deleted.' : 'Story restored.');
    } else {
      req.flash('error', 'Unknown field.');
    }
    return res.redirect(returnTo(req, '/admin/stories'));
  })
);

/**
 * The story photo. Same pipeline as every other image here: multer keeps it in memory,
 * sharp re-encodes it to a bounded WebP — which is also the real sanitiser, since anything
 * that is not an image fails to decode — and the bytes go to a side table, never the disk
 * and never a column on a row that gets SELECT *'d.
 */
router.post(
  '/stories/:id/photo',
  requireIdParam('id'),
  writeLimiter,
  singleImage('photo'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      req.flash('error', 'Choose an image first.');
      return res.redirect(returnTo(req, '/admin/stories'));
    }
    await ImageBlob.put('story_photos', req.params.id, req.file.buffer, { size: 1200 });
    await SuccessStory.setPhoto(req.params.id, ImageBlob.pointerUrl('/success-stories/photo', req.params.id));
    req.flash('success', 'Photo saved.');
    return res.redirect(returnTo(req, '/admin/stories'));
  })
);

/**
 * GET /admin/reviews — the approval queue.
 *
 * Three actions and none of them is delete. The reference's bulk action calls
 * `SiteReview.delete`, a hard DELETE from a list view; after it runs nobody can say what
 * was removed or by whom.
 */
router.get(
  '/reviews',
  asyncHandler(async (req, res) => {
    const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 25 });
    const status = ['pending', 'hidden', 'approved'].includes(req.query.status) ? req.query.status : 'pending';

    const filters =
      status === 'approved'
        ? {}
        : { include_pending: true, include_hidden: true, status };

    const [{ rows, total }, summary, pending] = await Promise.all([
      SiteReview.list(filters, { limit, offset }),
      SiteReview.summary(),
      SiteReview.pendingCount()
    ]);

    res.render('admin/reviews', {
      title: 'Member reviews',
      reviews: rows,
      status,
      summary,
      pending,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (p) => pageUrl('/admin/reviews', req.query, p)
    });
  })
);

router.post(
  '/reviews/:id/state',
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    if (req.body.field === 'approved') {
      await SiteReview.setApproved(req.params.id, req.body.value === 'true', {
        actorUserId: req.session.user.id
      });
      req.flash('success', req.body.value === 'true' ? 'Review approved.' : 'Approval withdrawn.');
    } else if (req.body.field === 'hidden') {
      await SiteReview.setHidden(req.params.id, req.body.value === 'true');
      req.flash('success', req.body.value === 'true' ? 'Review hidden. The row is kept.' : 'Review restored.');
    } else {
      req.flash('error', 'Unknown field.');
    }
    return res.redirect(returnTo(req, '/admin/reviews'));
  })
);

/* ----------------------------------------------------------------- settings */

router.get(
  '/settings',
  isSuperadmin,
  asyncHandler(async (req, res) => {
    return res.render('admin/settings', {
      title: 'Settings',
      definitions: SETTING_DEFINITIONS,
      values: await AppSetting.all()
    });
  })
);

/**
 * Superadmin-gated: these switches close registration and freeze the community, which is
 * not something an ordinary admin account should be able to do alone.
 *
 * `AppSetting.setMany` iterates the DECLARED keys rather than the submitted body, so an
 * unticked box (which posts nothing at all) is correctly read as false and an unknown
 * field is a no-op rather than a new row. Catalogue values are NOT here and never will be:
 * roles, modules, effort baselines and day rates live in config/*.js, where a change has
 * an author, a diff and a review.
 */
router.post(
  '/settings',
  isSuperadmin,
  writeLimiter,
  asyncHandler(async (req, res) => {
    await AppSetting.setMany(req.body);
    req.flash('success', 'Settings saved. They take effect within a minute on every instance.');
    return res.redirect('/admin/settings');
  })
);

/* ---------------------------------------------------------------- analytics */

/**
 * GET /admin/analytics — growth, one query per series.
 *
 * Read-only and deliberately plain: counts per month for the handful of things that say
 * whether the marketplace is alive. No charting library — the CSP allows no CDN, and a
 * table of numbers is what somebody actually reads off a screen like this.
 */
router.get(
  '/analytics',
  asyncHandler(async (req, res) => {
    const MONTHS = 12;

    /*
     * One shape for every series, so the view has one loop rather than six.
     *
     * GROUP BY the EXPRESSION, not the alias. `GROUP BY period` looks equivalent and is
     * not: MySQL resolves the name against the table's real columns first, and
     * `rate_submissions.period` exists — it holds the rate's own period (`2026-09`),
     * nothing to do with this grouping. That one series would silently group by the wrong
     * column and then fail `only_full_group_by`, which is on by default in MySQL 8. The
     * reference hit exactly this, on this exact table, and it was a 500 on one page rather
     * than an obviously broken query, so it survived to be found against a real database.
     *
     * The table and column names are fixed literals from this file, never from a request.
     */
    const series = async (label, table, column = 'created_at', extraWhere = '1 = 1') => {
      const [rows] = await promisePool.query(
        `SELECT DATE_FORMAT(${column}, '%Y-%m') AS period, COUNT(*) AS count
           FROM ${table}
          WHERE ${extraWhere}
            AND ${column} >= DATE_SUB(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL ? MONTH)
          GROUP BY DATE_FORMAT(${column}, '%Y-%m')
          ORDER BY DATE_FORMAT(${column}, '%Y-%m')`,
        [MONTHS - 1]
      );
      return { label, rows };
    };

    const collected = await Promise.all([
      series('Sign-ups', 'users'),
      series('Jobs posted', 'jobs'),
      series('Applications', 'applications'),
      series('Quotes', 'quotes'),
      series('Community posts', 'posts', 'created_at', 'hidden_at IS NULL'),
      series('Rate contributions', 'rate_submissions', 'created_at', 'voided_at IS NULL')
    ]);

    // Every period present in ANY series, so a month with no sign-ups still has a row.
    const periods = [...new Set(collected.flatMap((s) => s.rows.map((r) => r.period)))].sort();

    return res.render('admin/analytics', {
      title: 'Analytics',
      periods,
      series: collected.map((s) => ({
        label: s.label,
        byPeriod: Object.fromEntries(s.rows.map((r) => [r.period, r.count]))
      }))
    });
  })
);

/**
 * THE ENQUIRY QUEUE.
 *
 * This screen is the reason /contact and /report-issue are allowed to be forms at all. The
 * note on the contact page said a form needs somewhere to put what it collects, a spam
 * defence and SOMEBODY WATCHING A QUEUE; the first two are a migration and three cheap
 * checks, and this is the third. Without it the forms would be exactly what that note
 * refused: a way to drop a message while both sides believe it was sent.
 *
 * Ordinary admin, not superadmin. Answering people who write in is the most routine work
 * on this surface, and a queue only one or two accounts can open is a queue that waits for
 * them to be back from holiday.
 */
router.get(
  '/enquiries',
  asyncHandler(async (req, res) => {
    const filters = {
      status: Enquiry.STATUSES.includes(req.query.status) ? req.query.status : '',
      kind: Enquiry.KINDS.includes(req.query.kind) ? req.query.kind : '',
      q: req.query.q ? String(req.query.q).slice(0, 120) : ''
    };
    const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 25 });

    const [{ rows, total }, openCount] = await Promise.all([
      Enquiry.browse(filters, { limit, offset }),
      Enquiry.openCount()
    ]);

    res.render('admin/enquiries', {
      title: 'Enquiries',
      enquiries: rows,
      filters,
      openCount,
      kinds: Enquiry.KINDS,
      statuses: Enquiry.STATUSES,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (p) => pageUrl('/admin/enquiries', req.query, p)
    });
  })
);

router.get(
  '/enquiries/:id',
  requireIdParam('id'),
  asyncHandler(async (req, res) => {
    const enquiry = await Enquiry.find(req.params.id);
    if (!enquiry) return res.status(404).render('errors/404', { title: 'Not found' });

    return res.render('admin/enquiry', {
      title: `Enquiry #${enquiry.id}`,
      enquiry,
      statuses: Enquiry.STATUSES
    });
  })
);

/**
 * Move one through the queue, and optionally leave a note.
 *
 * No reply is sent from here. The answer goes to the address the person gave, from a
 * mailbox a human is already reading — a reply composed on this screen would make the Hub
 * a second place where the conversation partly lives, and the half that is missing is
 * always the half somebody needs later.
 */
router.post(
  '/enquiries/:id/status',
  requireIdParam('id'),
  asyncHandler(async (req, res) => {
    const moved = await Enquiry.setStatus(
      req.params.id,
      req.body.status,
      req.session.user.id,
      req.body.admin_note
    );
    req.flash(moved ? 'success' : 'error', moved ? 'Updated.' : 'That enquiry no longer exists.');
    return res.redirect(returnTo(req, `/admin/enquiries/${req.params.id}`));
  })
);

module.exports = router;
