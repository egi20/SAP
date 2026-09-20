'use strict';

const express = require('express');
const { body } = require('express-validator');

const Application = require('../models/Application');
const Job = require('../models/Job');
const Notification = require('../models/Notification');
const { isAuthenticated } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireIdParam } = require('../utils/ids');

const router = express.Router();

router.use(isAuthenticated);

/** The employer's pipeline for one job. */
router.get(
  '/job/:slug',
  asyncHandler(async (req, res) => {
    const job = await Job.findBySlug(req.params.slug);
    if (!job) return res.status(404).render('errors/404', { title: 'Not found' });

    const user = req.session.user;
    if (job.company_user_id !== user.id && !user.isAdmin) {
      return res.status(404).render('errors/404', { title: 'Not found' });
    }

    const status = ['submitted', 'reviewing', 'shortlisted', 'interviewing', 'offered', 'hired', 'rejected', 'withdrawn'].includes(
      req.query.status
    )
      ? req.query.status
      : '';

    const { rows, total } = await Application.listForJob(job.id, { status });

    return res.render('applications/pipeline', {
      title: `Applicants — ${job.title}`,
      job,
      applications: rows,
      total,
      status,
      transitions: Application.TRANSITIONS
    });
  })
);

router.get(
  '/:id',
  requireIdParam('id'),
  asyncHandler(async (req, res) => {
    const application = await Application.findById(req.params.id);
    if (!application) return res.status(404).render('errors/404', { title: 'Not found' });

    const user = req.session.user;
    const isEmployer = application.company_user_id === user.id;
    const isApplicant = application.consultant_user_id === user.id;
    if (!isEmployer && !isApplicant && !user.isAdmin) {
      return res.status(404).render('errors/404', { title: 'Not found' });
    }

    const events = await Application.events(application.id);

    return res.render('applications/show', {
      title: `Application — ${application.job_title}`,
      application,
      events,
      isEmployer,
      isApplicant,
      transitions: Application.TRANSITIONS[application.status] || []
    });
  })
);

router.post(
  '/:id/transition',
  requireIdParam('id'),
  writeLimiter,
  [body('to_status').notEmpty()],
  asyncHandler(async (req, res) => {
    const application = await Application.findById(req.params.id);
    if (!application) return res.status(404).render('errors/404', { title: 'Not found' });

    const user = req.session.user;
    const isEmployer = application.company_user_id === user.id || user.isAdmin;
    const isApplicant = application.consultant_user_id === user.id;
    if (!isEmployer && !isApplicant) {
      return res.status(404).render('errors/404', { title: 'Not found' });
    }

    try {
      const updated = await Application.transition(application.id, user.id, req.body.to_status, {
        note: req.body.note ? String(req.body.note).slice(0, 500) : null,
        actorIsEmployer: isEmployer
      });

      // Notify the other party. Fire and forget, keyed on the exact transition so a
      // retried submit cannot notify twice.
      const recipientId = isEmployer ? application.consultant_user_id : application.company_user_id;
      Notification.emit({
        userId: recipientId,
        type: 'application_status',
        title: `Application for ${application.job_title} is now "${updated.status}"`,
        link: `/applications/${application.id}`,
        dedupeKey: `application-status:${application.id}:${updated.previousStatus}:${updated.status}`
      });

      req.flash('success', `Application moved to "${updated.status}".`);
    } catch (err) {
      if (['INVALID_TRANSITION', 'FORBIDDEN', 'NOT_FOUND'].includes(err.code)) {
        req.flash('error', err.message);
      } else {
        throw err;
      }
    }

    return res.redirect(`/applications/${application.id}`);
  })
);

module.exports = router;
