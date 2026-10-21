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
 * "People" is the word that matters, and the first version did not earn it. It counted
 * every GET that was not an asset, so crawlers, uptime pings and the vulnerability
 * scanners that walk every public site asking for /wp-login.php and /.env were all
 * "page views" — the admin screens showed some 4,000 a week beside an analytics provider
 * reporting 73, and the yardstick for the analytics trial was measuring bots. So now:
 *
 *   - a request is counted only once its response has FINISHED with a 2xx status,
 *     because a 404 for /wp-admin is a scanner, not a reader, and a 302 to the sign-in
 *     page is the same visitor about to be counted on the page they land on;
 *   - a user agent that declares itself a crawler, a library or a headless browser is
 *     not counted, and neither is a request with no user agent at all — every real
 *     browser sends one;
 *   - the health check is not a visitor.
 *
 * This stays a lower-friction count than a script-based provider (no script, no consent,
 * no sampling), but it is a count of browsers, not a proof of humans: a bot that lies
 * about its user agent is still counted. Data recorded before this change still holds the
 * bots, and nothing rewrites it.
 *
 * Entirely fire-and-forget: analytics must never be able to fail a page render.
 */
const NOT_A_PERSON = /bot|crawl|spider|slurp|scan|monitor|uptime|probe|preview|headless|phantom|lighthouse|curl|wget|python|httpclient|okhttp|go-http|java\/|axios|node-fetch|undici|libwww|postman|insomnia/i;

function looksLikeAPerson(userAgent) {
  return Boolean(userAgent) && !NOT_A_PERSON.test(userAgent);
}

function visitGeo(req, res, next) {
  next();

  try {
    if (req.method !== 'GET') return;
    if (req.get('sec-fetch-dest') && req.get('sec-fetch-dest') !== 'document') return;
    if (req.xhr) return;
    if (req.path === '/healthz') return;
    if (/\.(css|js|png|jpe?g|webp|svg|ico|txt|xml|map|woff2?|php|env|ini|bak|sql|zip)$/i.test(req.path)) return;
    if (!looksLikeAPerson(req.get('user-agent'))) return;

    const country = countryFromIp(clientIp(req));
    if (!country) return;

    res.on('finish', () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return;
      promisePool
        .query(
          `INSERT INTO visit_geo_daily (day, country, visits) VALUES (CURDATE(), ?, 1)
           ON DUPLICATE KEY UPDATE visits = visits + 1`,
          [country]
        )
        .catch((err) => console.error(`visitGeo insert failed: ${err.message}`));
    });
  } catch (err) {
    console.error(`visitGeo failed: ${err.message}`);
  }
}

module.exports = { visitGeo, looksLikeAPerson };
