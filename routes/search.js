'use strict';

const express = require('express');

const { searchEverything, MIN_QUERY_LENGTH } = require('../services/search');
const { ipLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/errorHandler');

const router = express.Router();

/**
 * GET /search — one box across jobs, consultants, companies and the community.
 *
 * Public, because all four things it searches are public listings already and each source
 * excludes anything a reader could not reach on its own page. Nothing HERE decides
 * visibility: every source calls the same `browse` its list view calls, so a row that is
 * hidden on `/jobs` is hidden here without this file knowing why.
 *
 * Rate limited by IP. One request runs four filtered queries and four counts; unbounded,
 * that is a cheap way to keep the database busy from a single address.
 *
 * `res.locals.seo.indexable` is false for this path (it is not in `PUBLIC_PATHS`), which
 * is what it should be: a search results page is infinite crawl space, and every query
 * string would be a separate URL a crawler would happily enumerate.
 */
const searchLimiter = ipLimiter({
  windowMs: 60 * 1000,
  max: 30,
  message: 'You are searching very quickly. Please wait a moment.'
});

router.get(
  '/',
  searchLimiter,
  asyncHandler(async (req, res) => {
    const results = await searchEverything(req.query.q);

    return res.render('search/index', {
      title: results.usable ? `Search — ${results.query}` : 'Search',
      results,
      minLength: MIN_QUERY_LENGTH
    });
  })
);

module.exports = router;
