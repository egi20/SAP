'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { PUBLIC_PATHS, canonicalUrl } = require('../config/seoMeta');
const { ROLE_CATEGORIES } = require('../config/roleTaxonomy');
const { PRODUCT_LINES } = require('../config/sapProducts');
const Job = require('../models/Job');
const Post = require('../models/Post');
const Points = require('../models/Points');
const Notification = require('../models/Notification');
const { POST_KINDS, isPostKind, postKind } = require('../config/community');
const { toPlainText } = require('../utils/sanitize');
const { paginationFrom, paginationMeta, pageUrl } = require('../utils/pagination');
const RateSubmission = require('../models/RateSubmission');
const ConsultantProfile = require('../models/ConsultantProfile');
const config = require('../config/config');
const legalVersions = require('../config/legal-versions');

const router = express.Router();

/*
 * TWO HOME PAGES: a landing page for a visitor, the community feed for a member.
 *
 * The core commit deliberately served one page to both, because the feed is a community
 * feature and a signed-in member would otherwise have landed on something emptier than
 * what they saw before they joined. The community is here now, so the split is too.
 */
router.get(
  '/',
  asyncHandler(async (req, res, next) => {
    if (req.session.user) return feedHandler(req, res, next);

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

/**
 * The signed-in feed.
 *
 * Deliberately one query set and no personalisation beyond the filters: a feed that tries
 * to guess what somebody wants, on a community this size, mostly hides things.
 */
const feedHandler = asyncHandler(async (req, res) => {
  const filters = {
    kind: isPostKind(req.query.kind) ? req.query.kind : '',
    category_slug: req.query.category ? String(req.query.category).slice(0, 64) : '',
    unanswered: req.query.unanswered === '1' ? '1' : ''
  };

  const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 15 });

  const [{ rows: posts, total }, counts, standing, leaderboard, newMembers, unread, latestJobs] = await Promise.all([
    Post.browse(filters, { limit, offset, sort: 'recent' }),
    Post.countsByKind(filters),
    Points.standingFor(req.session.user.id),
    Points.leaderboard({ days: 30, limit: 6 }),
    countRecentMembers(),
    Notification.unreadCount(req.session.user.id),
    Job.browse({}, { limit: 4, sort: 'newest' })
  ]);

  res.render('feed/index', {
    title: 'Home',
    posts,
    counts,
    filters,
    standing,
    leaderboard,
    newMembers,
    unread,
    latestJobs: latestJobs.rows,
    kinds: POST_KINDS,
    postKind,
    toPlainText,
    greeting: greetingFor(new Date()),
    pagination: paginationMeta({ page, perPage, total }),
    pageUrl: (p) => pageUrl('/', req.query, p)
  });
});

/** People who joined in the last seven days — the "new this week" line. */
async function countRecentMembers() {
  const { promisePool } = require('../config/database');
  const [[row]] = await promisePool.query(
    'SELECT COUNT(*) AS count FROM users WHERE is_active = 1 AND created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)'
  );
  return row.count;
}

/**
 * Time-of-day greeting, from the SERVER's clock.
 *
 * Worth knowing rather than discovering: a user in another timezone will be greeted with
 * the server's idea of evening. Storing a per-user timezone would fix it; until then this
 * is a deliberate, small inaccuracy rather than a bug.
 */
function greetingFor(now) {
  const hour = now.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/*
 * SHORT ALIASES.
 *
 * Both are 301s and both exist because they are what people type and what other sites
 * link to. The canonical paths stay under /legal, because that is where the versioned
 * documents live and a policy URL that moves is a policy URL in somebody's contract that
 * stops resolving.
 */
router.get('/privacy', (req, res) => res.redirect(301, '/legal/privacy'));
router.get('/terms', (req, res) => res.redirect(301, '/legal/terms'));

/*
 * /forum is the reference's name for what is /community here. A 302 rather than a 301:
 * which of the two is canonical is a decision this port has not finished making, and a
 * permanent redirect is cached by browsers in a way that is painful to take back.
 */
router.get('/forum', (req, res) => res.redirect(302, '/community'));
router.get('/forum/category/:slug', (req, res) => {
  res.redirect(302, `/community/category/${encodeURIComponent(req.params.slug)}`);
});

/**
 * GET /about
 *
 * What the Hub is, who it is for and what it deliberately does not do. The last part is
 * the reason it is a page and not a paragraph on the home page: a marketplace that
 * publishes day rates and prices programmes is asked the same three questions by everybody
 * who lands on it for the first time, and answering them in public is cheaper than
 * answering them one email at a time.
 *
 * NO NUMBERS THAT MOVE. No consultant count, no "average rate", no founder's photograph
 * over a figure — the reference's about page carries several, and every one of them is a
 * claim somebody has to remember to update. What is here is true on the day the site has
 * no members at all.
 */
router.get('/about', (req, res) => {
  res.render('legal/about', { title: `About ${config.app.name}` });
});

/**
 * GET /faq
 *
 * Every answer here is a fact about how the code behaves, and each one links to the page
 * that proves it. An FAQ whose answers were written from intention rather than from the
 * implementation is a second description of the system, and it is always the one that
 * goes stale.
 */
router.get('/faq', (req, res) => {
  res.render('legal/faq', { title: 'Frequently asked questions', minSample: config.rates.minSampleSize });
});

router.get('/legal/privacy', (req, res) => {
  res.render('legal/privacy', { title: 'Privacy policy', version: legalVersions.PRIVACY_VERSION });
});

router.get('/legal/terms', (req, res) => {
  res.render('legal/terms', { title: 'Terms of service', version: legalVersions.TERMS_VERSION });
});

/**
 * GET /contact
 *
 * An address and what to say in the message, not a form. A contact form needs somewhere
 * to put what it collects, a spam defence and somebody watching a queue; until all three
 * exist, a mailto is the honest version — it cannot silently drop a message the way an
 * unwatched form can.
 *
 * It exists because two things already pointed here: the pricing page's "ask us and we
 * will invoice you directly", and the assistant, which is told to send every
 * account-specific question to a person. Both were links to a 404 — found by the test
 * that opens every path the assistant may name.
 */
router.get('/contact', (req, res) => {
  res.render('legal/contact', { title: 'Contact us' });
});

/**
 * robots.txt and the sitemap are generated from the SAME allowlist, so the sitemap can
 * never advertise a URL that robots.txt disallows.
 */
router.get('/robots.txt', (req, res) => {
  /*
   * `/search` is disallowed as well as being noindex on the page itself. A results page
   * is infinite crawl space — every query string is a distinct URL a crawler will happily
   * enumerate — and a meta tag only stops it being INDEXED after it has already been
   * fetched. This stops the fetching.
   */
  const lines = [
    'User-agent: *',
    'Disallow: /admin',
    'Disallow: /dashboard',
    'Disallow: /profile',
    'Disallow: /auth',
    'Disallow: /search',
    ''
  ];
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
