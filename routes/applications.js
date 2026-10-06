'use strict';

const express = require('express');
const { body } = require('express-validator');

const Application = require('../models/Application');
const Job = require('../models/Job');
const Notification = require('../models/Notification');
const { isAuthenticated, isCompany } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireIdParam } = require('../utils/ids');
const { paginationFrom, paginationMeta, pageUrl } = require('../utils/pagination');

/**
 * The board shows this many cards and says when it has reached it.
 *
 * A board cannot page — half a column is a lie about the column — so the honest answer to
 * a pipeline bigger than one screenful is to say the number and send people to the list,
 * which can filter and page.
 */
const BOARD_LIMIT = 200;

const router = express.Router();

router.use(isAuthenticated);

/**
 * Everything the two pipeline pages read out of the query string, in one place.
 *
 * Both pages — and the board, which is the same rows in a different shape — parse the
 * same controls, so a filter added to one is a filter the other already has. Every value
 * is checked against the vocabulary before it reaches the builder: `status` and `reached`
 * against `Application.STATUSES`, and the two toggles are booleans.
 */
function filtersFrom(query) {
  return {
    status: Application.STATUSES.includes(query.status) ? query.status : '',
    q: typeof query.q === 'string' ? query.q.trim().slice(0, 120) : '',
    reached: query.reached === 'interviewing' ? 'interviewing' : '',
    include_withdrawn: query.withdrawn === '1'
  };
}

/**
 * The cross-job pipeline: every candidate for every one of this company's roles.
 *
 * It is a list by default and a board with `?view=board`, and that is deliberately ONE
 * route: both read `Application.listForCompany` with the same filters, so the board can
 * never show a row the list hides. A second route would be a second place to remember
 * what a company may see.
 */
router.get(
  '/',
  isCompany,
  asyncHandler(async (req, res) => {
    const companyUserId = req.session.user.id;
    const filters = filtersFrom(req.query);
    const board = req.query.view === 'board';

    const [{ rows, total }, counts, { rows: jobs }] = await Promise.all([
      board
        ? Application.listForCompany(companyUserId, { ...filters, statuses: Application.BOARD_COLUMNS }, { limit: BOARD_LIMIT })
        : Application.listForCompany(companyUserId, filters, paginationFrom(req.query)),
      Application.countsFor({ ...filters, company_user_id: companyUserId }),
      Job.browse({ company_user_id: companyUserId, status: 'open' }, { limit: 1 })
    ]);

    const { page, perPage } = paginationFrom(req.query);

    return res.render('applications/index', {
      title: 'Candidate pipeline',
      applications: rows,
      total,
      counts,
      filters,
      statuses: Application.STATUSES,
      board,
      hasOpenRole: jobs.length > 0,
      columns: Application.BOARD_COLUMNS,
      boardLimit: BOARD_LIMIT,
      transitionsFor: (status) => Application.transitionsFor(status, { actorIsEmployer: true }),
      pagination: board ? null : paginationMeta({ page, perPage, total }),
      pageUrl: (p) => pageUrl('/applications', req.query, p)
    });
  })
);

/** The employer's pipeline for one job. The same rows, narrowed to one advert. */
router.get(
  '/job/:slug',
  asyncHandler(async (req, res) => {
    const job = await Job.findBySlug(req.params.slug);
    if (!job) return res.status(404).render('errors/404', { title: 'Not found' });

    const user = req.session.user;
    if (job.company_user_id !== user.id && !user.isAdmin) {
      return res.status(404).render('errors/404', { title: 'Not found' });
    }

    const filters = filtersFrom(req.query);
    const { page, perPage, limit, offset } = paginationFrom(req.query);

    const [{ rows, total }, counts] = await Promise.all([
      Application.listForJob(job.id, filters, { limit, offset }),
      Application.countsFor({ ...filters, job_id: job.id })
    ]);

    return res.render('applications/pipeline', {
      title: `Applicants — ${job.title}`,
      job,
      applications: rows,
      total,
      counts,
      filters,
      statuses: Application.STATUSES,
      transitionsFor: (status) => Application.transitionsFor(status, { actorIsEmployer: true }),
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (p) => pageUrl(`/applications/job/${job.slug}`, req.query, p)
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
      transitions: Application.transitionsFor(application.status, { actorIsEmployer: isEmployer })
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
