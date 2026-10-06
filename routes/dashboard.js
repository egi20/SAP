'use strict';

const express = require('express');

const Job = require('../models/Job');
const Application = require('../models/Application');
const JobTransfer = require('../models/JobTransfer');
const ConsultantProfile = require('../models/ConsultantProfile');
const Skill = require('../models/Skill');
const Notification = require('../models/Notification');
const User = require('../models/User');
const { isAuthenticated, isCompany, isConsultant } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { writeLimiter } = require('../middleware/rateLimit');
const { requireIdParam } = require('../utils/ids');
const { paginationFrom, paginationMeta, pageUrl } = require('../utils/pagination');
const { matchScore } = require('../utils/jobMatcher');

const router = express.Router();

router.use(isAuthenticated);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = req.session.user;

    /*
     * Saved jobs are a CONSULTANT's shortlist, and this fetched them for everybody — so a
     * company dashboard carried a "Saved jobs" card, empty and permanent, for a list it
     * has no way of adding to. A panel that cannot apply to the account reading it is the
     * dashboard telling somebody they have missed a feature they do not have.
     */
    const [unread, savedJobs] = await Promise.all([
      Notification.unreadCount(user.id),
      user.isConsultant ? Job.listSaved(user.id, { limit: 5 }) : Promise.resolve([])
    ]);

    let consultant = null;
    let company = null;

    if (user.isConsultant) {
      const [profile, applications, consultantSkillIds] = await Promise.all([
        ConsultantProfile.ensureExists(user.id),
        Application.listForConsultant(user.id, { limit: 5 }),
        Skill.idsForConsultant(user.id)
      ]);

      // Recommendations are computed from the same scorer the job page shows, so the
      // number a consultant sees on a job is the number that ranked it here.
      const { rows: openJobs } = await Job.browse({}, { limit: 60, sort: 'newest' });
      const recommended = openJobs
        .map((job) => ({ job, ...matchScore(job, profile, { consultantSkillIds }) }))
        .filter((r) => r.score >= 40)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

      consultant = { profile, applications, recommended };
    }

    if (user.isCompany) {
      const [{ rows: jobs, total }, statusCounts] = await Promise.all([
        Job.browse({ company_user_id: user.id, status: 'open' }, { limit: 5 }),
        Application.statusCountsForCompany(user.id)
      ]);
      company = { jobs, totalOpen: total, statusCounts, stages: Application.BOARD_COLUMNS };
    }

    res.render('dashboard/index', {
      title: 'Dashboard',
      unreadNotifications: unread,
      savedJobs,
      consultant,
      company
    });
  })
);

router.get(
  '/jobs',
  isCompany,
  asyncHandler(async (req, res) => {
    const status = Job.STATUSES.includes(req.query.status) ? req.query.status : '';
    const filters = { company_user_id: req.session.user.id, status: status || 'open' };

    const { page, perPage, limit, offset } = paginationFrom(req.query);
    const { rows, total } = await Job.browse(filters, { limit, offset, sort: 'newest' });

    res.render('dashboard/jobs', {
      title: 'Your jobs',
      jobs: rows,
      status: filters.status,
      // Passed to the bulk form as the interlock value: if the set has changed by the
      // time the operator submits, the model aborts rather than acting on unseen rows.
      expectedCount: total,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (p) => pageUrl('/dashboard/jobs', req.query, p)
    });
  })
);

router.get(
  '/applications',
  isConsultant,
  asyncHandler(async (req, res) => {
    const { page, perPage, limit, offset } = paginationFrom(req.query);
    const applications = await Application.listForConsultant(req.session.user.id, { limit, offset });

    res.render('dashboard/applications', {
      title: 'Your applications',
      applications,
      pagination: paginationMeta({ page, perPage, total: applications.length + offset }),
      pageUrl: (p) => pageUrl('/dashboard/applications', req.query, p)
    });
  })
);

router.get(
  '/saved',
  asyncHandler(async (req, res) => {
    const { page, perPage, limit, offset } = paginationFrom(req.query);
    const jobs = await Job.listSaved(req.session.user.id, { limit, offset });

    res.render('dashboard/saved', {
      title: 'Saved jobs',
      jobs,
      pagination: paginationMeta({ page, perPage, total: jobs.length + offset }),
      pageUrl: (p) => pageUrl('/dashboard/saved', req.query, p)
    });
  })
);

/**
 * Adverts offered to you, and adverts you have offered.
 *
 * Both halves on one page on purpose: a handover has two sides and the question somebody
 * arrives with ("where did that role go?") is answered by whichever half they did not
 * think of first.
 */
router.get(
  '/transfers',
  isCompany,
  asyncHandler(async (req, res) => {
    const [incoming, outgoing] = await Promise.all([
      JobTransfer.pendingForUser(req.session.user),
      JobTransfer.listForSender(req.session.user.id)
    ]);

    res.render('dashboard/transfers', {
      title: 'Role handovers',
      incoming,
      outgoing,
      windowDays: JobTransfer.OFFER_WINDOW_DAYS
    });
  })
);

/**
 * Accept, decline or cancel.
 *
 * One handler for the three, because they share every line of their error handling and
 * their redirect, and differ only in which model call they make. A flash from a refused
 * transfer is the whole feedback path here: the model's messages are written to be read
 * by the person who pressed the button.
 */
router.post(
  '/transfers/:id/:action',
  isCompany,
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const actions = {
      accept: () => JobTransfer.accept(req.params.id, req.session.user),
      decline: () => JobTransfer.decline(req.params.id, req.session.user),
      cancel: () => JobTransfer.cancel(req.params.id, req.session.user.id)
    };

    const run = actions[req.params.action];
    if (!run) return res.status(404).render('errors/404', { title: 'Not found' });

    try {
      const result = await run();
      if (req.params.action === 'accept') {
        req.flash(
          'success',
          result.wasPaused
            ? `"${result.jobTitle}" is yours. It has been paused so you can read what now carries your name before it goes back up.`
            : `"${result.jobTitle}" is yours.`
        );
        Notification.emit({
          userId: result.fromUserId,
          type: 'job_transfer',
          title: `Your offer of "${result.jobTitle}" was accepted`,
          link: `/jobs/${result.jobSlug}`,
          dedupeKey: `job-transfer-accepted:${req.params.id}`
        });
        return res.redirect(`/jobs/${result.jobSlug}`);
      }
      req.flash('success', req.params.action === 'decline' ? 'Offer declined.' : 'Offer withdrawn.');
    } catch (err) {
      if (['TRANSFER_NOT_FOUND', 'EXPIRED', 'MOVED', 'NOT_TRANSFERABLE', 'NOT_A_COMPANY'].includes(err.code)) {
        req.flash('error', err.message);
      } else {
        throw err;
      }
    }

    return res.redirect('/dashboard/transfers');
  })
);

router.post(
  '/onboarded',
  asyncHandler(async (req, res) => {
    await User.markOnboarded(req.session.user.id);
    res.json({ success: true });
  })
);

module.exports = router;
