'use strict';

const express = require('express');

const User = require('../models/User');
const Job = require('../models/Job');
const Post = require('../models/Post');
const ErrorLog = require('../models/ErrorLog');
const RateSubmission = require('../models/RateSubmission');
const Payment = require('../models/Payment');
const Moderation = require('../models/Moderation');
const AppSetting = require('../models/AppSetting');
const { formatMinor } = require('../config/payments');
const { DEFINITIONS: SETTING_DEFINITIONS } = require('../config/settings');
const { roleLabel } = require('../config/roleTaxonomy');
const { returnTo } = require('../utils/returnTo');
const { promisePool } = require('../config/database');
const { isAuthenticated, isAdmin, isSuperadmin } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireIdParam } = require('../utils/ids');
const { paginationFrom, paginationMeta, pageUrl } = require('../utils/pagination');

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
    const { rows, total } = await Job.browse({ status }, { limit, offset, sort: 'newest' });

    return res.render('admin/jobs', {
      title: 'Jobs',
      jobs: rows,
      status,
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
    const cleared = await Payment.clearRefundFlag(req.params.id, {
      actorUserId: req.session.user.id,
      note: (req.body.note || '').trim() || null
    });
    req.flash(
      cleared ? 'success' : 'error',
      cleared
        ? 'Marked as refunded. The payment stays in the ledger; only the queue flag is cleared.'
        : 'That payment is not in the refund queue.'
    );
    return res.redirect(returnTo(req, '/admin/payments'));
  })
);

/* ------------------------------------------------------------------- errors */

router.get(
  '/errors',
  asyncHandler(async (req, res) => {
    const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 50 });
    const { rows, total } = await ErrorLog.list({ limit, offset });

    return res.render('admin/errors', {
      title: 'Error log',
      errors: rows,
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

module.exports = router;
