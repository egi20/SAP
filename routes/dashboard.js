'use strict';

const express = require('express');

const Job = require('../models/Job');
const Application = require('../models/Application');
const ConsultantProfile = require('../models/ConsultantProfile');
const Skill = require('../models/Skill');
const Notification = require('../models/Notification');
const User = require('../models/User');
const { isAuthenticated, isCompany, isConsultant } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { paginationFrom, paginationMeta, pageUrl } = require('../utils/pagination');
const { matchScore } = require('../utils/jobMatcher');

const router = express.Router();

router.use(isAuthenticated);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = req.session.user;

    const [unread, savedJobs] = await Promise.all([
      Notification.unreadCount(user.id),
      Job.listSaved(user.id, { limit: 5 })
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
      company = { jobs, totalOpen: total, statusCounts };
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
    const status = ['draft', 'open', 'paused', 'filled', 'closed'].includes(req.query.status) ? req.query.status : '';
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

router.post(
  '/onboarded',
  asyncHandler(async (req, res) => {
    await User.markOnboarded(req.session.user.id);
    res.json({ success: true });
  })
);

module.exports = router;
