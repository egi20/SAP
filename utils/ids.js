'use strict';

/**
 * Route `:id` params must be validated as all-digits BEFORE they reach SQL.
 *
 * `parseInt` is not enough, and this is a real incident rather than a hypothetical:
 * `parseInt('44.map')` is `44`, so sourcemap probes like `/jobs/44.map` passed a
 * parseInt guard and the raw string reached an UPDATE, which MySQL strict mode
 * rejected with "Truncated incorrect DOUBLE value". A fully non-numeric id serialised
 * as a bare `NaN` literal and produced "Unknown column 'NaN'".
 *
 * Returns the number, or null when the value is not a plain positive integer.
 */
function parseId(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Express middleware factory: 404 on a malformed `:id`-style param. */
function requireIdParam(paramName = 'id') {
  return (req, res, next) => {
    const id = parseId(req.params[paramName]);
    if (id === null) {
      return res.status(404).render('errors/404', { title: 'Not found' });
    }
    req.params[paramName] = id;
    return next();
  };
}

module.exports = { parseId, requireIdParam };
