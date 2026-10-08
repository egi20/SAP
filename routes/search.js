'use strict';

const express = require('express');

const { searchEverything, MIN_QUERY_LENGTH } = require('../services/search');
const { matchCatalogue } = require('../services/searchCatalogue');
const ConsultantProfile = require('../models/ConsultantProfile');
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

    /*
     * Consultant rows are anonymised here for the same reason they are on /consultants, and
     * at the same boundary — the route that renders them. `services/search.js` stays a
     * module that adds nothing of its own, including this: it calls the same browse the
     * list page calls, and what a reader may SEE of a row it is allowed to find is a
     * question about the reader, not about the search.
     */
    const viewerId = req.session.user ? req.session.user.id : null;
    results.groups.forEach((group) => {
      if (group.key === 'consultants') {
        group.rows = ConsultantProfile.redactFor(group.rows, viewerId);
      }
    });

    return res.render('search/index', {
      title: results.usable ? `Search — ${results.query}` : 'Search',
      results,
      // Directions, not results: which SAP modules and roles the query names, and where they
      // live on the site. Read from config only, and never counted into the total.
      catalogue: results.usable ? matchCatalogue(results.query) : { modules: [], roles: [], lines: [] },
      minLength: MIN_QUERY_LENGTH
    });
  })
);

module.exports = router;
