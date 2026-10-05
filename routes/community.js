'use strict';

const express = require('express');
const { body, validationResult } = require('express-validator');

const Post = require('../models/Post');
const Points = require('../models/Points');
const Notification = require('../models/Notification');
const { isAuthenticated, isEmailVerified, isNavigation } = require('../middleware/auth');
const { writeLimiter, ipLimiter } = require('../middleware/rateLimit');
const { communityWritable } = require('../middleware/settingsGates');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireIdParam } = require('../utils/ids');
const { returnTo } = require('../utils/returnTo');
const { paginationFrom, paginationMeta, pageUrl } = require('../utils/pagination');
const { sanitizeRichText, toPlainText } = require('../utils/sanitize');
const { POST_KINDS, isPostKind, postKind } = require('../config/community');

const router = express.Router();

const postLimiter = ipLimiter({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: 'You have posted a lot recently. Please give it a few minutes.'
});

function filtersFrom(query) {
  return {
    kind: isPostKind(query.kind) ? query.kind : '',
    category_slug: query.category ? String(query.category).slice(0, 64) : '',
    q: query.q ? String(query.q).slice(0, 120) : '',
    unanswered: query.unanswered === '1' ? '1' : '',
    solved: query.solved === '1' ? '1' : ''
  };
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const filters = filtersFrom(req.query);
    const { page, perPage, limit, offset } = paginationFrom(req.query);
    const sort = ['recent', 'newest', 'top', 'busiest'].includes(req.query.sort) ? req.query.sort : 'recent';

    const [{ rows, total }, categories, counts, leaderboard] = await Promise.all([
      Post.browse(filters, { limit, offset, sort, viewerUserId: req.session.user ? req.session.user.id : null }),
      Post.listCategories(),
      Post.countsByKind(filters),
      Points.leaderboard({ days: 30, limit: 8 })
    ]);

    res.render('community/index', {
      title: 'Community',
      posts: rows,
      categories,
      counts,
      leaderboard,
      filters,
      sort,
      kinds: POST_KINDS,
      postKind,
      toPlainText,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (p) => pageUrl('/community', req.query, p)
    });
  })
);

// Declared before `/:slug` so "new" is never read as a post slug.
router.get(
  '/new',
  isAuthenticated,
  isEmailVerified,
  communityWritable,
  asyncHandler(async (req, res) => {
    const categories = await Post.listCategories();
    res.render('community/new', {
      title: 'Write a post',
      categories,
      kinds: POST_KINDS,
      values: { kind: isPostKind(req.query.kind) ? req.query.kind : 'discussion' },
      errors: []
    });
  })
);

router.post(
  '/',
  isAuthenticated,
  isEmailVerified,
  communityWritable,
  postLimiter,
  [
    body('title').trim().isLength({ min: 8, max: 200 }).withMessage('Give it a title of at least 8 characters.'),
    body('body').trim().isLength({ min: 20 }).withMessage('Write at least a couple of sentences.'),
    body('kind').custom(isPostKind).withMessage('Choose what kind of post this is.'),
    body('category_id').isInt({ min: 1 }).withMessage('Choose a category.')
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const categories = await Post.listCategories();
      return res.status(422).render('community/new', {
        title: 'Write a post',
        categories,
        kinds: POST_KINDS,
        values: req.body,
        errors: errors.array()
      });
    }

    const created = await Post.create(req.session.user.id, {
      categoryId: Number(req.body.category_id),
      kind: req.body.kind,
      title: req.body.title.trim(),
      body: sanitizeRichText(req.body.body),
      /*
       * The flag is read from the form and then checked HERE against the session, never
       * trusted from the body. A posted `is_editorial=on` from an ordinary member is
       * exactly the shape of request this has to refuse, and the model cannot tell who
       * sent it.
       */
      isEditorial: Boolean(req.session.user.isAdmin && req.body.is_editorial === 'on')
    });

    req.flash('success', 'Posted.');
    return res.redirect(`/community/${created.slug}`);
  })
);

/**
 * GET /community/articles
 *
 * Articles have their own page because they are read differently from the rest of the
 * community: a question is scanned and answered, an article is browsed and chosen. The
 * kind is FIXED here rather than being a filter somebody can clear — clearing it would
 * land them on a list that is no longer the page they opened.
 *
 * It is the same `Post.browse` the rest of the community calls, with `kind` set. There is
 * no second builder and no SQL in this file.
 *
 * NO TAG CLOUD. The reference's version has one, and tags would be a fourth vocabulary
 * beside the categories, the modules and the role taxonomy — with nothing asserting it and
 * nobody owning it. The category tree already exists, is derived from the product lines,
 * and is the same one the job board and the estimator speak.
 */
router.get(
  '/articles',
  asyncHandler(async (req, res) => {
    const authorId = /^\d+$/.test(req.query.author || '') ? Number(req.query.author) : null;
    const filters = {
      ...filtersFrom(req.query),
      kind: 'article',
      author_user_id: authorId
    };

    const { page, perPage, limit, offset } = paginationFrom(req.query);
    const sort = ['recent', 'newest', 'top', 'busiest'].includes(req.query.sort) ? req.query.sort : 'newest';

    const [{ rows, total }, categories, authors] = await Promise.all([
      Post.browse(filters, { limit, offset, sort }),
      Post.listCategories(),
      // The picker is built from the same filter minus the author, or it would only ever
      // offer the person already selected.
      Post.authorsIn({ ...filters, author_user_id: null })
    ]);

    res.render('community/articles', {
      title: 'Articles',
      posts: rows,
      total,
      categories,
      authors,
      authorId,
      filters,
      sort,
      postKind,
      toPlainText,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (p) => pageUrl('/community/articles', req.query, p)
    });
  })
);

/**
 * GET /community/author/:id
 *
 * A public page for somebody's community writing. Declared before `/:slug`, like every
 * other fixed path in this file.
 *
 * WHAT IT MAY SHOW is settled by what the community already shows: every post carries its
 * author's name in public, so collecting one person's posts in one place reveals nothing
 * the feed does not. It is NOT the consultant profile — no rate, no availability, no
 * contact route — and it deliberately does not link an account to a directory listing
 * beyond the name already on the posts.
 *
 * An inactive or missing account is a 404 rather than an empty page: a page that renders
 * for any id confirms which ids exist.
 */
router.get(
  '/author/:id',
  requireIdParam('id'),
  asyncHandler(async (req, res) => {
    const author = await Post.publicAuthor(req.params.id);
    if (!author) {
      return res.status(404).render('errors/404', { title: 'Not found' });
    }

    const { page, perPage, limit, offset } = paginationFrom(req.query);
    const filters = { author_user_id: author.id };

    const [{ rows, total }, counts, standing] = await Promise.all([
      Post.browse(filters, { limit, offset, sort: 'newest' }),
      Post.countsByKind(filters),
      Points.standingFor(author.id)
    ]);

    return res.render('community/author', {
      title: author.name,
      author,
      posts: rows,
      total,
      counts,
      standing,
      kinds: POST_KINDS,
      postKind,
      toPlainText,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (p) => pageUrl(`/community/author/${author.id}`, req.query, p)
    });
  })
);

router.get(
  '/category/:slug',
  asyncHandler(async (req, res) => {
    const category = await Post.findCategoryBySlug(req.params.slug);
    if (!category) return res.status(404).render('errors/404', { title: 'Not found' });

    const filters = { ...filtersFrom(req.query), category_slug: category.slug };
    const { page, perPage, limit, offset } = paginationFrom(req.query);
    const sort = ['recent', 'newest', 'top', 'busiest'].includes(req.query.sort) ? req.query.sort : 'recent';

    const [{ rows, total }, categories, counts] = await Promise.all([
      Post.browse(filters, { limit, offset, sort }),
      Post.listCategories(),
      Post.countsByKind(filters)
    ]);

    return res.render('community/index', {
      title: category.name,
      category,
      posts: rows,
      categories,
      counts,
      leaderboard: [],
      filters,
      sort,
      kinds: POST_KINDS,
      postKind,
      toPlainText,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (p) => pageUrl(`/community/category/${category.slug}`, req.query, p)
    });
  })
);

router.get(
  '/:slug',
  asyncHandler(async (req, res) => {
    const viewerId = req.session.user ? req.session.user.id : null;
    const post = await Post.findBySlug(req.params.slug, viewerId);
    if (!post) return res.status(404).render('errors/404', { title: 'Not found' });

    /*
     * A hidden post is a 404 for everyone except an admin, who needs to be able to open
     * the thing they just removed — and 404 rather than 403, because "this exists but you
     * may not see it" tells a spammer their post is still there and worth appealing.
     *
     * `Post.findBySlug` deliberately returns hidden posts; this is where the decision is
     * made, once, with the viewer in hand.
     */
    const isAdmin = Boolean(req.session.user && req.session.user.isAdmin);
    if (post.hidden_at && !isAdmin) {
      return res.status(404).render('errors/404', { title: 'Not found' });
    }

    const replies = await Post.replies(post.id, viewerId);
    // A hidden post must not accumulate views from the moderators checking it.
    if (!post.hidden_at && (!viewerId || viewerId !== post.author_user_id)) Post.incrementViews(post.id);

    return res.render('community/show', {
      title: post.title,
      post,
      replies,
      kind: postKind(post.kind),
      isAuthor: Boolean(viewerId && viewerId === post.author_user_id),
      canModerate: isAdmin
    });
  })
);

router.post(
  '/:slug/reply',
  isAuthenticated,
  isEmailVerified,
  communityWritable,
  writeLimiter,
  [body('body').trim().isLength({ min: 2 }).withMessage('Write something first.')],
  asyncHandler(async (req, res) => {
    const post = await Post.findBySlug(req.params.slug);
    if (!post) return res.status(404).render('errors/404', { title: 'Not found' });

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', errors.array()[0].msg);
      return res.redirect(`/community/${post.slug}`);
    }

    try {
      const { replyId } = await Post.reply(post.id, req.session.user.id, sanitizeRichText(req.body.body), {
        parentReplyId: req.body.parent_reply_id ? Number(req.body.parent_reply_id) : null
      });

      // Fire and forget, keyed on the reply, so a retried submit cannot notify twice. The
      // author is not told about their own reply.
      if (post.author_user_id !== req.session.user.id) {
        Notification.emit({
          userId: post.author_user_id,
          type: 'post_reply',
          title: `${req.session.user.name} replied to "${post.title}"`,
          body: toPlainText(req.body.body, 120),
          link: `/community/${post.slug}`,
          dedupeKey: `post-reply:${replyId}`
        });
      }
    } catch (err) {
      if (['LOCKED', 'NOT_FOUND'].includes(err.code)) {
        req.flash('error', err.message);
        return res.redirect(`/community/${post.slug}`);
      }
      throw err;
    }

    return res.redirect(`/community/${post.slug}#replies`);
  })
);

router.post(
  '/vote/:targetType/:id',
  isAuthenticated,
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const { targetType } = req.params;
    if (!['post', 'reply'].includes(targetType)) {
      return res.status(404).json({ success: false, error: 'Unknown target' });
    }

    const value = Number(req.body.value);
    try {
      const result = await Post.vote(targetType, req.params.id, req.session.user.id, value);
      if (!isNavigation(req)) return res.json({ success: true, ...result });
    } catch (err) {
      if (['SELF_VOTE', 'NOT_FOUND'].includes(err.code)) {
        if (!isNavigation(req)) return res.status(400).json({ success: false, error: err.message });
        req.flash('error', err.message);
      } else {
        throw err;
      }
    }

    /*
     * `returnTo`, not a private allow-list. The hand-rolled check only accepted paths
     * under /community, so a vote cast from the home feed threw the reader onto the
     * community index — a page they had not asked for, having lost their place in the one
     * they had. See utils/returnTo.js.
     */
    return res.redirect(returnTo(req, '/community'));
  })
);

router.post(
  '/:slug/accept/:replyId',
  isAuthenticated,
  requireIdParam('replyId'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const post = await Post.findBySlug(req.params.slug);
    if (!post) return res.status(404).render('errors/404', { title: 'Not found' });

    try {
      const { answererUserId } = await Post.acceptSolution(post.id, req.params.replyId, req.session.user.id);
      Notification.emit({
        userId: answererUserId,
        type: 'answer_accepted',
        title: `Your answer was accepted on "${post.title}"`,
        link: `/community/${post.slug}`,
        dedupeKey: `accepted:${req.params.replyId}`
      });
      req.flash('success', 'Answer accepted.');
    } catch (err) {
      if (['FORBIDDEN', 'NOT_A_QUESTION', 'NOT_FOUND'].includes(err.code)) {
        req.flash('error', err.message);
      } else {
        throw err;
      }
    }

    return res.redirect(`/community/${post.slug}`);
  })
);

router.post(
  '/:slug/delete',
  isAuthenticated,
  writeLimiter,
  asyncHandler(async (req, res) => {
    const post = await Post.findBySlug(req.params.slug);
    if (!post) return res.status(404).render('errors/404', { title: 'Not found' });

    const removed = await Post.remove(post.id, req.session.user.id, { isAdmin: req.session.user.isAdmin });
    req.flash(removed ? 'success' : 'error', removed ? 'Post deleted.' : 'That post is not yours to delete.');
    return res.redirect(removed ? '/community' : `/community/${post.slug}`);
  })
);

module.exports = router;
