'use strict';

const express = require('express');

const ConsultantProfile = require('../models/ConsultantProfile');
const ExternalIdentity = require('../models/ExternalIdentity');
const ImageBlob = require('../models/ImageBlob');
const Skill = require('../models/Skill');
const Job = require('../models/Job');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireIdParam } = require('../utils/ids');
const { paginationFrom, paginationMeta, pageUrl } = require('../utils/pagination');
const { ROLE_CATEGORIES, isRole } = require('../config/roleTaxonomy');
const { PRODUCT_LINES, isModule } = require('../config/sapProducts');
const countries = require('../config/all-countries.json');

const router = express.Router();

const SENIORITIES = ['junior', 'mid', 'senior', 'lead'];

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const filters = {
      q: req.query.q ? String(req.query.q).slice(0, 120) : '',
      role: isRole(req.query.role) ? req.query.role : '',
      seniority: SENIORITIES.includes(req.query.seniority) ? req.query.seniority : '',
      country: /^[A-Z]{2}$/.test(req.query.country || '') ? req.query.country : '',
      work_mode: ['remote', 'hybrid', 'onsite'].includes(req.query.work_mode) ? req.query.work_mode : '',
      availability: ['immediate', 'two_weeks', 'one_month'].includes(req.query.availability) ? req.query.availability : '',
      certified: req.query.certified === '1' ? '1' : '',
      /*
       * "Who has actually delivered EWM?" — the search this ecosystem runs, and the one
       * `ConsultantProfile.buildFilter` was already written to answer. It read the delivery
       * history from the first commit and nothing passed it a module, so the capability was
       * there and unreachable; an integration test asking for `?modules=ewm` got the whole
       * directory back. Any-of, matching the job board.
       */
      modules: (Array.isArray(req.query.modules) ? req.query.modules : [req.query.modules])
        .filter((slug) => slug && isModule(slug))
        .slice(0, 20),
      min_lifecycles: /^\d{1,2}$/.test(req.query.min_lifecycles || '') ? req.query.min_lifecycles : '',
      rate_max: req.query.rate_max || ''
    };

    const { page, perPage, limit, offset } = paginationFrom(req.query);
    const sort = ['relevance', 'newest', 'rate_asc', 'rate_desc', 'lifecycles'].includes(req.query.sort)
      ? req.query.sort
      : 'relevance';

    const { rows, total } = await ConsultantProfile.browse(filters, { limit, offset, sort });
    const viewerId = req.session.user ? req.session.user.id : null;

    res.render('consultants/index', {
      title: res.locals.seo.title,
      // Redacted in the ROUTE, so the template is never handed a name it must remember not
      // to print. See ConsultantProfile.redactFor.
      consultants: ConsultantProfile.redactFor(rows, viewerId),
      signedIn: Boolean(viewerId),
      filters,
      sort,
      roleCategories: ROLE_CATEGORIES,
      productLines: PRODUCT_LINES,
      countries,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (p) => pageUrl('/consultants', req.query, p)
    });
  })
);

/**
 * Profile photo.
 *
 * ETag-cached and served straight from the database, because the disk is ephemeral.
 * A conditional request is answered from the ETag alone, without loading the bytes.
 */
router.get(
  '/photo/:id',
  requireIdParam('id'),
  asyncHandler(async (req, res) => {
    /*
     * A face identifies somebody as well as a name does, so it is behind the same account.
     * Hiding the name and serving the photograph would be anonymity that fools only the
     * person relying on it.
     */
    if (!req.session.user) return res.redirect('/images/avatar-placeholder.svg');

    const etag = await ImageBlob.getEtag('consultant_photos', req.params.id);
    if (!etag) return res.redirect('/images/avatar-placeholder.svg');

    res.set('ETag', `"${etag}"`);
    res.set('Cache-Control', 'public, max-age=86400');
    if (req.get('if-none-match') === `"${etag}"`) return res.status(304).end();

    const blob = await ImageBlob.get('consultant_photos', req.params.id);
    if (!blob) return res.redirect('/images/avatar-placeholder.svg');

    res.type(blob.content_type);
    return res.send(blob.bytes);
  })
);

router.get(
  '/:id',
  requireIdParam('id'),
  asyncHandler(async (req, res) => {
    const profile = await ConsultantProfile.findByUserId(req.params.id);
    const viewer = req.session.user;
    const isSelf = viewer && viewer.id === req.params.id;

    // A profile that is not public is visible to its owner and to admins only.
    if (!profile || (!profile.is_public && !isSelf && !(viewer && viewer.isAdmin))) {
      return res.status(404).render('errors/404', { title: 'Not found' });
    }

    const [skills, certifications, experiences, linkedInIdentity] = await Promise.all([
      Skill.forConsultant(profile.user_id),
      ConsultantProfile.listCertifications(profile.user_id),
      ConsultantProfile.listExperiences(profile.user_id),
      /*
       * The identity row, not just the mirrored flag, and only on this one-row page.
       * The badge says an account was confirmed; a reader deserves to see WHICH — the
       * name LinkedIn returned, and whether it agreed with the name on this profile.
       * Without it, the message the member is shown at verification ("people reading
       * your profile will see both") is simply untrue.
       */
      ExternalIdentity.find(ExternalIdentity.LINKEDIN, req.params.id)
    ]);

    // A conversation is always anchored to a role, so an employer can only approach this
    // consultant if they actually have one open. No open role, no approach button.
    const hiringJobs =
      viewer && viewer.isCompany && !isSelf
        ? (await Job.browse({ company_user_id: viewer.id, status: 'open' }, { limit: 50 })).rows
        : [];

    /*
     * The owner and an administrator see the profile whole; everybody else sees it the way
     * the directory shows it. `isSelf` matters here and not in the list, because somebody
     * checking their own page needs to see what they wrote, not what a stranger sees.
     */
    const canSeeIdentity = Boolean(viewer) || isSelf;
    const shown = ConsultantProfile.redactFor(profile, canSeeIdentity ? (viewer ? viewer.id : profile.user_id) : null);

    return res.render('consultants/show', {
      title: shown.name
        ? `${shown.name} — ${profile.headline || 'SAP consultant'}`
        : `${profile.headline || 'SAP consultant'} — SAP Hub`,
      profile: shown,
      signedIn: Boolean(viewer),
      skills,
      certifications,
      experiences,
      /*
       * The identity row carries the name LinkedIn returned, which is the thing the badge
       * is about — and is a name. A reader who may not see the one on the profile may not
       * see this one either, or the anonymity is theatre with a second copy behind it.
       */
      linkedInIdentity: viewer ? linkedInIdentity : null,
      isSelf,
      hiringJobs,
      // Contact details are for signed-in companies only. An open directory of
      // e-mail addresses is a scraping target, and consultants did not consent to that.
      canSeeContact: Boolean(viewer && (viewer.isCompany || viewer.isRecruiter || viewer.isAdmin))
    });
  })
);

module.exports = router;
