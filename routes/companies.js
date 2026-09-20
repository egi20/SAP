'use strict';

const express = require('express');

const CompanyProfile = require('../models/CompanyProfile');
const ImageBlob = require('../models/ImageBlob');
const Job = require('../models/Job');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireIdParam } = require('../utils/ids');
const { paginationFrom, paginationMeta, pageUrl } = require('../utils/pagination');
const countries = require('../config/all-countries.json');

const router = express.Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const filters = {
      q: req.query.q ? String(req.query.q).slice(0, 120) : '',
      company_type: ['end_customer', 'consulting_partner', 'isv', 'staffing'].includes(req.query.company_type)
        ? req.query.company_type
        : '',
      country: /^[A-Z]{2}$/.test(req.query.country || '') ? req.query.country : ''
    };

    const { page, perPage, limit, offset } = paginationFrom(req.query);
    const { rows, total } = await CompanyProfile.browse(filters, { limit, offset });

    res.render('companies/index', {
      title: res.locals.seo.title,
      companies: rows,
      filters,
      countries,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (p) => pageUrl('/companies', req.query, p)
    });
  })
);

router.get(
  '/logo/:id',
  requireIdParam('id'),
  asyncHandler(async (req, res) => {
    const etag = await ImageBlob.getEtag('company_logos', req.params.id);
    if (!etag) return res.redirect('/images/logo-placeholder.svg');

    res.set('ETag', `"${etag}"`);
    res.set('Cache-Control', 'public, max-age=86400');
    if (req.get('if-none-match') === `"${etag}"`) return res.status(304).end();

    const blob = await ImageBlob.get('company_logos', req.params.id);
    if (!blob) return res.redirect('/images/logo-placeholder.svg');

    res.type(blob.content_type);
    return res.send(blob.bytes);
  })
);

router.get(
  '/:slug',
  asyncHandler(async (req, res) => {
    const company = await CompanyProfile.findBySlug(req.params.slug);
    if (!company || !company.is_active) {
      return res.status(404).render('errors/404', { title: 'Not found' });
    }

    const { rows: jobs } = await Job.browse({ company_user_id: company.user_id }, { limit: 50 });

    return res.render('companies/show', {
      title: `${company.company_name} — jobs and profile`,
      company,
      jobs
    });
  })
);

module.exports = router;
