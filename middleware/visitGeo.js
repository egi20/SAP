'use strict';

const { promisePool } = require('../config/database');
const { countryFromIp, clientIp } = require('../utils/geo');

/**
 * PII-free visitor geography.
 *
 * Records one increment per country per day for real page navigations only, and stores
 * nothing else — no address, no path, no identifier. Asset requests and background
 * fetches are ignored so the count means "people who looked at a page".
 *
 * Entirely fire-and-forget: analytics must never be able to fail a page render.
 */
function visitGeo(req, res, next) {
  next();

  try {
    if (req.method !== 'GET') return;
    if (req.get('sec-fetch-dest') && req.get('sec-fetch-dest') !== 'document') return;
    if (req.xhr) return;
    if (/\.(css|js|png|jpe?g|webp|svg|ico|txt|xml|map|woff2?)$/i.test(req.path)) return;

    const country = countryFromIp(clientIp(req));
    if (!country) return;

    promisePool
      .query(
        `INSERT INTO visit_geo_daily (day, country, visits) VALUES (CURDATE(), ?, 1)
         ON DUPLICATE KEY UPDATE visits = visits + 1`,
        [country]
      )
      .catch((err) => console.error(`visitGeo insert failed: ${err.message}`));
  } catch (err) {
    console.error(`visitGeo failed: ${err.message}`);
  }
}

module.exports = { visitGeo };
