'use strict';

/**
 * /s/<code> counts an open only for a person, and a link-preview fetcher is not one. The
 * filter names the FETCHERS, never the apps people browse in: it used to match "linkedin",
 * which is also LinkedIn's in-app browser, so opens from LinkedIn — where agents share their
 * links — were never counted while the sign-ups behind them were (9 sign-ups, 6 opens).
 */
const { LINK_PREVIEW } = require('../../routes/index');

describe('the sales-agent link preview filter', () => {
  it.each([
    ['LinkedIn in-app (iOS)', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]/9.30.1'],
    ['LinkedIn in-app (Android)', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0 Mobile Safari/537.36 [LinkedInApp]'],
    ['X in-app', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/10.50'],
    ['Facebook in-app', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0]']
  ])('counts a person in the %s browser', (label, ua) => {
    expect(LINK_PREVIEW.test(ua)).toBe(false);
  });

  it.each([
    'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
    'WhatsApp/2.23.20.0 A',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    'TelegramBot (like TwitterBot)',
    'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
    'Twitterbot/1.0'
  ])('does not count the preview fetcher %s', (ua) => {
    expect(LINK_PREVIEW.test(ua)).toBe(true);
  });
});
