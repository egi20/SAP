'use strict';

const express = require('express');

const SuccessStory = require('../models/SuccessStory');
const SiteReview = require('../models/SiteReview');
const ImageBlob = require('../models/ImageBlob');
const { isAuthenticated } = require('../middleware/auth');
const { ipLimiter, writeLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireIdParam } = require('../utils/ids');
const { returnTo } = require('../utils/returnTo');
const { embedUrlFor } = require('../utils/videoEmbed');
const { PRODUCT_LINES } = require('../config/sapProducts');
const { paginationFrom, paginationMeta, pageUrl } = require('../utils/pagination');

const router = express.Router();

/**
 * Success stories and the reviews that sit beside them.
 *
 * Stories are written by administrators and read by anybody. Reviews are written by
 * members, approved by an administrator, and read by anybody.
 *
 * `embedUrlFor` runs HERE, at render time, over the raw stored value. The reference
 * derives the embed URL in its route too, which is right; what is added is that nothing
 * derived is ever stored, so the current rules always apply to every row rather than
 * whatever the rules were on the day an administrator pasted a link.
 */

const reviewLimiter = ipLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: 'You have submitted that a few times already. Please wait a little.'
});

/** GET /success-stories — the public list. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 12 });
    const filters = { q: req.query.q || '', family: req.query.family || '' };

    const [{ rows, total }, reviews, summary] = await Promise.all([
      SuccessStory.list(filters, { limit, offset }),
      SiteReview.list({}, { limit: 6, offset: 0 }),
      SiteReview.summary()
    ]);

    res.render('stories/index', {
      title: 'Success stories',
      stories: rows.map((s) => ({ ...s, embedUrl: embedUrlFor(s.video_url) })),
      reviews: reviews.rows,
      summary,
      filters,
      families: PRODUCT_LINES,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (p) => pageUrl('/success-stories', req.query, p)
    });
  })
);

/**
 * GET /success-stories/photo/:id — the story photo.
 *
 * Answers a conditional request from the ETag alone, without loading the bytes. Public,
 * because it is referenced directly from an `<img>` on a public page — but a photo for an
 * unpublished story is refused, so a draft's image cannot be enumerated before the story
 * itself goes live.
 */
router.get(
  '/photo/:id',
  requireIdParam('id'),
  asyncHandler(async (req, res) => {
    const story = await SuccessStory.findById(req.params.id);
    if (!story || !story.published_at || story.hidden_at) return res.status(404).end();

    const etag = await ImageBlob.getEtag('story_photos', req.params.id);
    if (!etag) return res.status(404).end();

    res.set('ETag', `"${etag}"`);
    // An hour, not a day: unpublishing a story should stop its photo at proxies too, and
    // the ETag keeps revalidation cheap.
    res.set('Cache-Control', 'public, max-age=3600');
    if (req.headers['if-none-match'] === `"${etag}"`) return res.status(304).end();

    const blob = await ImageBlob.get('story_photos', req.params.id);
    if (!blob) return res.status(404).end();

    res.type(blob.content_type);
    return res.send(blob.bytes);
  })
);

/**
 * GET /reviews — every published review, and the form.
 *
 * Mounted under the same router because a review and a story are the same kind of thing
 * to a reader: evidence that somebody used this and would say so.
 */
router.get(
  '/reviews',
  asyncHandler(async (req, res) => {
    const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 20 });

    const [{ rows, total }, summary, own] = await Promise.all([
      SiteReview.list({}, { limit, offset }),
      SiteReview.summary(),
      req.session.user ? SiteReview.forUser(req.session.user.id) : Promise.resolve(null)
    ]);

    res.render('stories/reviews', {
      title: 'What members say',
      reviews: rows,
      summary,
      own,
      minBody: SiteReview.MIN_BODY,
      maxBody: SiteReview.MAX_BODY,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (p) => pageUrl('/success-stories/reviews', req.query, p)
    });
  })
);

/**
 * POST /reviews — leave or replace a review.
 *
 * Signed in, unlike the reference, which takes a name and a role from the form. A
 * testimonial nobody can attribute is not a testimonial, and an anonymous endpoint that
 * writes rows a person has to read is a queue somebody fills with nonsense.
 *
 * The author's role is derived from the session, never read from the body: the reference
 * stores whatever `author_role` was posted, so "SAP Mentor" becomes a claim the page
 * renders as fact.
 */
router.post(
  '/reviews',
  isAuthenticated,
  reviewLimiter,
  writeLimiter,
  asyncHandler(async (req, res) => {
    try {
      await SiteReview.submit(req.session.user.id, req.body, req.session.user);
      req.flash(
        'success',
        'Thank you. Your review is with a moderator and appears once it is approved.'
      );
    } catch (err) {
      if (!['RATING_INVALID', 'BODY_TOO_SHORT'].includes(err.code)) throw err;
      req.flash('error', err.message);
    }
    return res.redirect(returnTo(req, '/success-stories/reviews'));
  })
);

/**
 * GET /success-stories/:slug — one story.
 *
 * Declared last so it cannot shadow `/photo/:id` or `/reviews`.
 */
router.get(
  '/:slug',
  asyncHandler(async (req, res, next) => {
    const story = await SuccessStory.findPublishedBySlug(String(req.params.slug || '').slice(0, 220));
    if (!story) return next();

    return res.render('stories/show', {
      title: story.title,
      story,
      embedUrl: embedUrlFor(story.video_url)
    });
  })
);

module.exports = router;
