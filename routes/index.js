'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { PUBLIC_PATHS, canonicalUrl } = require('../config/seoMeta');
const { ROLE_CATEGORIES } = require('../config/roleTaxonomy');
const { PRODUCT_LINES } = require('../config/sapProducts');
const Job = require('../models/Job');
const RateSubmission = require('../models/RateSubmission');
const ConsultantProfile = require('../models/ConsultantProfile');
const config = require('../config/config');
const legalVersions = require('../config/legal-versions');

const router = express.Router();

/*
 * ONE HOME PAGE, for signed-in and signed-out alike.
 *
 * The reference splits here: a marketing landing page for a visitor, a community feed for
 * a member. The feed is a community feature and the community is a later area, so a split
 * now would mean a signed-in member landing on an emptier page than the one they saw
 * before they joined. When the community lands, the feed takes this route's signed-in
 * branch — the shape is in the reference and it is worth keeping.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const [latestJobs, featuredConsultants, contributors] = await Promise.all([
      Job.browse({}, { limit: 6, sort: 'newest' }),
      ConsultantProfile.browse({}, { limit: 6 }),
      RateSubmission.totalContributors()
    ]);

    res.render('index', {
      title: res.locals.seo.title,
      latestJobs: latestJobs.rows,
      totalJobs: latestJobs.total,
      featuredConsultants: featuredConsultants.rows,
      totalConsultants: featuredConsultants.total,
      // Stated as the plain number of people who have contributed, because an
      // unverifiable scale claim is worse than a small honest one.
      rateContributors: contributors,
      roleCategories: ROLE_CATEGORIES,
      productLines: PRODUCT_LINES
    });
  })
);

router.get('/legal/privacy', (req, res) => {
  res.render('legal/privacy', { title: 'Privacy policy', version: legalVersions.PRIVACY_VERSION });
});

router.get('/legal/terms', (req, res) => {
  res.render('legal/terms', { title: 'Terms of service', version: legalVersions.TERMS_VERSION });
});

/**
 * robots.txt and the sitemap are generated from the SAME allowlist, so the sitemap can
 * never advertise a URL that robots.txt disallows.
 */
router.get('/robots.txt', (req, res) => {
  const lines = ['User-agent: *', 'Disallow: /admin', 'Disallow: /dashboard', 'Disallow: /profile', 'Disallow: /auth', ''];
  lines.push(`Sitemap: ${config.app.baseUrl}/sitemap.xml`);
  res.type('text/plain').send(lines.join('\n'));
});

router.get(
  '/sitemap.xml',
  asyncHandler(async (req, res) => {
    const { rows: jobs } = await Job.browse({}, { limit: 5000, sort: 'newest' });

    const urls = [
      ...PUBLIC_PATHS.map((p) => ({ loc: canonicalUrl(p), changefreq: 'daily' })),
      ...jobs.map((j) => ({
        loc: canonicalUrl(`/jobs/${j.slug}`),
        lastmod: j.published_at ? new Date(j.published_at).toISOString() : undefined,
        changefreq: 'weekly'
      }))
    ];

    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      ...urls.map((u) =>
        [
          '  <url>',
          `    <loc>${u.loc}</loc>`,
          u.lastmod ? `    <lastmod>${u.lastmod}</lastmod>` : null,
          u.changefreq ? `    <changefreq>${u.changefreq}</changefreq>` : null,
          '  </url>'
        ]
          .filter(Boolean)
          .join('\n')
      ),
      '</urlset>'
    ].join('\n');

    res.type('application/xml').send(xml);
  })
);

/** Liveness only: deliberately does not touch the database, so a slow query cannot
 *  make the platform restart a process that is serving fine. */
router.get('/healthz', (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()) });
});

module.exports = router;
