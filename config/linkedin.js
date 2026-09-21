'use strict';

const config = require('./config');

/**
 * LinkedIn identity verification.
 *
 * READ THIS BEFORE CHANGING ANYTHING HERE, because the whole design turns on it:
 *
 * LinkedIn's OpenID Connect userinfo response contains `sub`, `name`, `given_name`,
 * `family_name`, `picture`, `locale`, `email` and `email_verified`. It does NOT contain
 * the member's vanity URL, their headline, their positions or their employer. There is no
 * scope available to an ordinary application that returns any of those.
 *
 * The consequence is the thing the reference implementation got wrong. It asked people for
 * their `linkedin.com/in/...` URL, ran an OAuth flow, extracted the username from the URL
 * they had typed, logged it next to the `sub` from LinkedIn — and then set
 * `linkedin_verified = true` without ever comparing the two, because there is nothing to
 * compare it against. The badge said a specific profile had been verified when what had
 * actually happened was that the person had *a* LinkedIn account. The URL could have been
 * anyone's.
 *
 * So this integration verifies exactly one thing and says exactly that: **this person
 * controls a LinkedIn account, and here is the name on it.** The claimed profile URL stays
 * a claim.
 */

// The OIDC discovery endpoints, pinned rather than discovered: one fewer network call on
// a path where a failure is a confusing redirect loop, and these have been stable.
const AUTHORISE_URL = 'https://www.linkedin.com/oauth/v2/authorization';
const TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
const USERINFO_URL = 'https://api.linkedin.com/v2/userinfo';

/**
 * `openid profile email`, and deliberately NOT `w_member_social`.
 *
 * The reference requests posting permission it uses for a "share your achievement"
 * feature. Asking someone for the ability to post as them, in order to check who they are,
 * is a much larger permission than the task needs — and the consent screen says so, which
 * is the first thing that makes people abandon the flow.
 */
const SCOPES = 'openid profile email';

/** The authorisation state is short-lived: a stale one is an abandoned flow, not a retry. */
const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * How close the LinkedIn name has to be to the Hub profile name.
 *
 * This is the ONE cross-check that is actually available. It is deliberately loose —
 * people legitimately differ between "Ana Pjetri" and "Ana Maria Pjetri", or carry a
 * married name on one and not the other — so a mismatch is SURFACED to the member rather
 * than used to refuse the link. Refusing on a name comparison would reject real people to
 * catch a case that a name comparison cannot catch anyway.
 */
const NAME_MATCH_MIN_TOKENS = 1;

function isConfigured() {
  return Boolean(config.linkedin.clientId && config.linkedin.clientSecret);
}

/** Where LinkedIn sends the member back. Must match the app's registered redirect exactly. */
function redirectUri() {
  return `${config.app.baseUrl}/linkedin/callback`;
}

/**
 * Boot assertion. A half-configured integration is worse than an absent one: the button
 * appears, the member is sent to LinkedIn, and the failure lands after they have already
 * granted access.
 */
function assertLinkedInIntegrity() {
  const { clientId, clientSecret } = config.linkedin;
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new Error('LinkedIn: set both LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET, or neither');
  }
  if (isConfigured() && !config.app.baseUrl.startsWith('http')) {
    throw new Error('LinkedIn: APP_BASE_URL must be an absolute URL for the OAuth redirect');
  }
  return true;
}

module.exports = {
  AUTHORISE_URL,
  TOKEN_URL,
  USERINFO_URL,
  SCOPES,
  STATE_TTL_MS,
  NAME_MATCH_MIN_TOKENS,
  isConfigured,
  redirectUri,
  assertLinkedInIntegrity
};
