'use strict';

/**
 * The server's own page-view count is the yardstick for the analytics trial, so it must
 * count browsers, not the crawlers and scanners that walk every public site.
 */

const { looksLikeAPerson } = require('../../middleware/visitGeo');

describe('looksLikeAPerson', () => {
  it('counts ordinary browsers', () => {
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 OPR/136.0.0.0',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
    ].forEach((ua) => expect(looksLikeAPerson(ua)).toBe(true));
  });

  it('does not count crawlers, libraries, headless browsers or a missing user agent', () => {
    [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 (compatible; AhrefsBot/7.0)',
      'curl/8.5.0',
      'python-requests/2.31.0',
      'Go-http-client/1.1',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0 Safari/537.36',
      'UptimeRobot/2.0',
      '',
      undefined
    ].forEach((ua) => expect(looksLikeAPerson(ua)).toBe(false));
  });
});
