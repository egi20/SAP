'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { PUBLIC_PATHS, canonicalUrl } = require('../config/seoMeta');
const { ROLE_CATEGORIES, ROLE_SLUGS } = require('../config/roleTaxonomy');
const { PRODUCT_LINES } = require('../config/sapProducts');
const Job = require('../models/Job');
const Points = require('../models/Points');
const Notification = require('../models/Notification');
const { POST_KINDS, isPostKind, postKind } = require('../config/community');
const { homeFeed, feedCounts, JOB_KIND } = require('../services/feed');
const { toPlainText } = require('../utils/sanitize');
const { paginationFrom, paginationMeta, pageUrl } = require('../utils/pagination');
const RateSubmission = require('../models/RateSubmission');
const ConsultantProfile = require('../models/ConsultantProfile');
const config = require('../config/config');
const legalVersions = require('../config/legal-versions');
const { ENGAGEMENT_MODELS } = require('../config/engagementModels');
const Enquiry = require('../models/Enquiry');
const email = require('../utils/email');
const { ipLimiter } = require('../middleware/rateLimit');
const { body, validationResult } = require('express-validator');

const router = express.Router();

/**
 * GET /  — ONE home page, the feed, for everybody.
 *
 * It used to be two: a landing page for a visitor, the feed for a member. A comparison
 * against the reference, done logged out, is what retired that. A marketplace that shows a
 * stranger a page of claims while members see the activity hides the only evidence the
 * claims are true — and the visitor is exactly the person who needs it. So the feed is the
 * page, and the landing material it replaced is still here: the hero and the four numbers
 * above it, where they say what this is before the feed shows it happening, and the rest
 * below.
 *
 * None of that renders for a member. They have read it, and for them it would push the
 * thing they came back for below the fold.
 *
 * The feed itself is `services/feed.js`, which adds no filter of its own — see the note
 * there. Nothing in this handler decides what a stranger may see.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = req.session.user || null;

    const filters = {
      kind: isFeedKind(req.query.kind) ? req.query.kind : '',
      category_slug: req.query.category ? String(req.query.category).slice(0, 64) : '',
      unanswered: req.query.unanswered === '1' ? '1' : ''
    };

    const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 15 });

    const [feed, counts, leaderboard, newMembers, standing, unread, landing] = await Promise.all([
      homeFeed(filters, { limit, offset }, user ? user.id : null),
      feedCounts(filters, user ? user.id : null),
      Points.leaderboard({ days: 30, limit: 6 }),
      countRecentMembers(),
      user ? Points.standingFor(user.id) : Promise.resolve(null),
      user ? Notification.unreadCount(user.id) : Promise.resolve(0),
      user ? Promise.resolve(null) : landingData()
    ]);

    res.render('feed/index', {
      title: user ? 'Home' : res.locals.seo.title,
      entries: feed.entries,
      postsOnly: feed.postsOnly,
      counts,
      filters,
      standing,
      leaderboard,
      newMembers,
      unread,
      landing,
      kinds: POST_KINDS,
      jobKind: JOB_KIND,
      postKind,
      toPlainText,
      greeting: greetingFor(new Date()),
      pagination: paginationMeta({ page, perPage, total: feed.total }),
      pageUrl: (p) => pageUrl('/', req.query, p)
    });
  })
);

/** The feed's type vocabulary: the community's post kinds, plus job adverts. */
function isFeedKind(value) {
  return value === JOB_KIND || isPostKind(value);
}

/**
 * What the landing half of the page needs. Fetched only for a visitor who is not signed
 * in, because it is the only reader it renders for — a member pays for none of it.
 */
async function landingData() {
  const [jobs, consultants, rateContributors] = await Promise.all([
    Job.browse({}, { limit: 1, sort: 'newest' }),
    ConsultantProfile.browse({}, { limit: 1 }),
    RateSubmission.totalContributors()
  ]);
  return {
    totalJobs: jobs.total,
    totalConsultants: consultants.total,
    // The plain number of people who have contributed: an unverifiable scale claim is
    // worse than a small honest one.
    rateContributors,
    roleCategories: ROLE_CATEGORIES,
    productLines: PRODUCT_LINES
  };
}

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
router.get('/forum/articles', (req, res) => {
  const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  res.redirect(302, `/community/articles${qs}`);
});
router.get('/forum/category/:slug', (req, res) => {
  res.redirect(302, `/community/category/${encodeURIComponent(req.params.slug)}`);
});
router.get('/forum/user/:id', (req, res) => {
  res.redirect(302, `/community/author/${encodeURIComponent(req.params.id)}`);
});

/**
 * GET /consultant-hub  and  GET /company-hub
 *
 * One page per side of the marketplace, answering "what is here for me" before somebody
 * has to guess which menu to open.
 *
 * WHY NOT /consultants AND /companies, which is where the reference puts these. Because
 * /consultants is the consultant DIRECTORY here and is the single most valuable URL on the
 * site — it is what somebody types and what other sites link to when they want to hire an
 * SAP consultant. Handing it to a page of prose and moving the directory to
 * /companies/talent would bury the product behind the brochure and break every link
 * already pointing at it. The hub pages get their own names instead, which match the
 * labels already in the navigation, and the directories keep theirs.
 *
 * NO NUMBERS THAT MOVE, for the same reason as /about: a consultant count or an average
 * rate on a landing page is a claim somebody has to remember to update, and nobody does.
 */
router.get('/consultant-hub', (req, res) => {
  res.render('hubs/consultant', { title: 'Consultant Hub' });
});

router.get('/company-hub', (req, res) => {
  res.render('hubs/company', { title: 'Company Hub', models: ENGAGEMENT_MODELS });
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
  res.render('legal/contact', { title: 'Contact us', values: {}, errors: [] });
});

/*
 * THE SPAM DEFENCE, which is one of the three things the note on /contact said a form
 * needs before it is honest. The other two are the table (migration 018) and the queue
 * (/admin/enquiries); none of the three is worth anything alone.
 *
 * Three cheap layers rather than one clever one:
 *   - a per-IP limit, because the cost of a form is in volume;
 *   - a honeypot field a person never sees and a bot fills in;
 *   - a length floor, because "hi" is not an enquiry and is what a scripted post sends.
 * No third-party captcha: it would put every visitor who needs help behind somebody else's
 * judgement of whether they look human.
 */
const ENQUIRY_WINDOW_MS = 60 * 60 * 1000;
const ENQUIRY_MAX_PER_WINDOW = 10;

const enquiryLimiter = ipLimiter({
  windowMs: ENQUIRY_WINDOW_MS,
  // Ten an hour, not three. Both forms share the bucket, and somebody who has just found
  // three things wrong in one sitting is the most useful person on the site that day — a
  // limit tight enough to stop them is a limit that costs more than the spam it prevents.
  max: ENQUIRY_MAX_PER_WINDOW,
  message: 'You have sent a few messages already. Please give it an hour, or email us directly.'
});

/** The honeypot. Hidden from people, filled in by anything walking the DOM. */
function looksAutomated(req) {
  return Boolean(req.body.website && String(req.body.website).trim());
}

/**
 * The fields both forms share. Lengths are generous and then enforced, rather than
 * truncated: a message cut off at 2,000 characters arrives looking like the person
 * stopped mid-sentence, and nobody can tell that we did it.
 */
const ENQUIRY_RULES = [
  body('name').trim().isLength({ min: 2, max: 120 }).withMessage('Tell us what to call you.'),
  body('email').trim().isEmail().isLength({ max: 190 }).withMessage('We need an address we can reply to.'),
  body('subject').trim().isLength({ min: 3, max: 200 }).withMessage('A short subject line, please.'),
  body('message').trim().isLength({ min: 20, max: 8000 })
    .withMessage('Please say a little more — twenty characters at least, so the first reply can be useful.')
];

/**
 * Tell whoever is on support that something arrived.
 *
 * Fire and forget, like every other send here: a failed notification must never fail the
 * action that triggered it, and with no API key `utils/email.js` logs and resolves. The
 * queue is the record; this is only the nudge towards it.
 */
function notifySupport(enquiry, kind) {
  email.send({
    to: config.app.supportEmail,
    subject: `[${kind}] ${enquiry.subject}`,
    template: 'enquiry-received',
    locals: {
      kind,
      name: enquiry.name,
      fromEmail: enquiry.email,
      subject: enquiry.subject,
      body: enquiry.body,
      reviewUrl: `${config.app.baseUrl}/admin/enquiries/${enquiry.id}`
    }
  }).catch((err) => console.error(`Enquiry notification failed: ${err.message}`));
}

router.post(
  '/contact',
  enquiryLimiter,
  ENQUIRY_RULES,
  asyncHandler(async (req, res) => {
    // Applied, not merely declared. The reference puts validator rules on a route and never
    // calls validationResult, which makes every rule decorative.
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).render('legal/contact', {
        title: 'Contact us',
        values: req.body,
        errors: errors.array()
      });
    }

    /*
     * A honeypot hit is accepted and discarded, without saying so. Telling a bot it was
     * caught is telling whoever wrote it what to change. This is the one case where this
     * form drops a message on purpose, and it is why the field is marked up so that no
     * assistive technology will fill it in.
     */
    if (!looksAutomated(req)) {
      const created = await Enquiry.create({
        kind: 'contact',
        userId: req.session.user ? req.session.user.id : null,
        name: req.body.name.trim(),
        email: req.body.email.trim(),
        subject: req.body.subject.trim(),
        body: req.body.message.trim()
      });
      notifySupport({ ...created, name: req.body.name, email: req.body.email, subject: req.body.subject, body: req.body.message }, 'contact');
    }

    req.flash('success', 'Thank you — that has reached us, and a person will reply to the address you gave.');
    return res.redirect('/contact');
  })
);

/**
 * GET/POST /report-issue
 *
 * The same queue, with the three fields that make a bug report answerable: what kind of
 * problem, how badly it bites, and which page it was on. `page_url` is prefilled from the
 * link that brought somebody here, which is the difference between a report we can act on
 * and one that begins "it was on the page with the table".
 */
router.get('/report-issue', (req, res) => {
  res.render('legal/report-issue', {
    title: 'Report a problem',
    issueTypes: Enquiry.ISSUE_TYPES,
    severities: Enquiry.SEVERITIES,
    values: { page_url: typeof req.query.page === 'string' ? req.query.page.slice(0, 500) : '' },
    errors: []
  });
});

router.post(
  '/report-issue',
  enquiryLimiter,
  [
    ...ENQUIRY_RULES,
    body('issue_type').isIn(Enquiry.ISSUE_TYPES).withMessage('Pick the kind of problem.'),
    body('severity').isIn(Enquiry.SEVERITIES).withMessage('Pick how badly it affects you.'),
    body('page_url').trim().isLength({ max: 500 })
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).render('legal/report-issue', {
        title: 'Report a problem',
        issueTypes: Enquiry.ISSUE_TYPES,
        severities: Enquiry.SEVERITIES,
        values: req.body,
        errors: errors.array()
      });
    }

    if (!looksAutomated(req)) {
      const created = await Enquiry.create({
        kind: 'issue',
        userId: req.session.user ? req.session.user.id : null,
        name: req.body.name.trim(),
        email: req.body.email.trim(),
        subject: req.body.subject.trim(),
        body: req.body.message.trim(),
        issueType: req.body.issue_type,
        severity: req.body.severity,
        pageUrl: req.body.page_url ? req.body.page_url.trim() : null
      });
      notifySupport({ ...created, name: req.body.name, email: req.body.email, subject: req.body.subject, body: req.body.message }, 'issue');
    }

    req.flash('success', 'Thank you — that is in the queue, and a person works through it.');
    return res.redirect('/report-issue');
  })
);

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
      /*
       * The per-role pages are generated from the taxonomy rather than listed, so a role
       * added to the catalogue is in the sitemap the same day and a role removed from it
       * leaves. A hand-written list here would be the second copy of a vocabulary the
       * config already owns.
       */
      ...ROLE_SLUGS.map((slug) => ({ loc: canonicalUrl(`/rates/${slug}`), changefreq: 'weekly' })),
      // Same argument: the engagement models own their own slugs, so the sitemap reads them
      // rather than repeating them.
      ...ENGAGEMENT_MODELS.map((m) => ({ loc: canonicalUrl(`/companies/${m.slug}`), changefreq: 'monthly' })),
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
