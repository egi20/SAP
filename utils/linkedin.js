'use strict';

const crypto = require('crypto');

const config = require('../config/config');
const {
  AUTHORISE_URL,
  TOKEN_URL,
  USERINFO_URL,
  SCOPES,
  STATE_TTL_MS,
  NAME_MATCH_MIN_TOKENS,
  isConfigured,
  redirectUri
} = require('../config/linkedin');

/**
 * The only module that talks to LinkedIn.
 *
 * It degrades like every other integration here: with no credentials the module loads,
 * `isConfigured()` is false, the button is not rendered and the routes answer plainly.
 *
 * Three deliberate choices about how the flow is run:
 *
 *  1. **The userinfo endpoint, not the ID token.** LinkedIn returns an `id_token` JWT and
 *     verifying it properly means fetching and caching JWKS and getting signature
 *     validation right. The access token came back over TLS from a token endpoint we
 *     authenticated to with our client secret, so calling userinfo with it is equally
 *     trustworthy and has no cryptography for us to implement badly.
 *  2. **The token is never stored.** It is used once, for one request, and dropped. See
 *     migration 014 for why.
 *  3. **`state` is compared in constant time and expires.** It is the CSRF defence for the
 *     callback, which is a GET that arrives from a third party.
 */

/** A fresh authorisation state, and the moment it stops being valid. */
function newState() {
  return { value: crypto.randomBytes(32).toString('base64url'), expiresAt: Date.now() + STATE_TTL_MS };
}

function stateMatches(stored, presented) {
  if (!stored || !stored.value || typeof presented !== 'string') return false;
  if (Date.now() > stored.expiresAt) return false;

  const a = Buffer.from(stored.value);
  const b = Buffer.from(presented);
  // timingSafeEqual throws on a length mismatch, which would itself leak the length.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function authorisationUrl(state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.linkedin.clientId,
    redirect_uri: redirectUri(),
    state,
    scope: SCOPES
  });
  return `${AUTHORISE_URL}?${params.toString()}`;
}

/** Fail fast rather than hang a browser on a provider that has stopped answering. */
async function postForm(url, body, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(body).toString(),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function exchangeCode(code) {
  if (!isConfigured()) throw new Error('LinkedIn is not configured');

  const response = await postForm(TOKEN_URL, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    client_id: config.linkedin.clientId,
    client_secret: config.linkedin.clientSecret
  });

  if (!response.ok) {
    // The body can echo the code and the client id; log the status and nothing else.
    const err = new Error(`LinkedIn token exchange failed (${response.status})`);
    err.code = 'LINKEDIN_TOKEN_EXCHANGE';
    throw err;
  }

  const data = await response.json();
  if (!data.access_token) {
    const err = new Error('LinkedIn returned no access token');
    err.code = 'LINKEDIN_TOKEN_EXCHANGE';
    throw err;
  }
  return data.access_token;
}

/**
 * @returns {Promise<{subject:string, name:string}>} the only two fields kept.
 *
 * The response also carries an email, a picture and a locale. None of them are returned:
 * the Hub has its own verified email, and personal data fetched without a purpose is
 * personal data to account for later.
 */
async function fetchIdentity(accessToken) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  let response;
  try {
    response = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const err = new Error(`LinkedIn userinfo failed (${response.status})`);
    err.code = 'LINKEDIN_USERINFO';
    throw err;
  }

  const data = await response.json();
  if (!data || !data.sub) {
    const err = new Error('LinkedIn returned no subject');
    err.code = 'LINKEDIN_USERINFO';
    throw err;
  }

  const name = [data.name, [data.given_name, data.family_name].filter(Boolean).join(' ')]
    .map((value) => (value || '').trim())
    .find(Boolean) || '';

  return { subject: String(data.sub).slice(0, 191), name: name.slice(0, 200) };
}

/**
 * Do the two names plausibly belong to the same person?
 *
 * Deliberately loose, and the looseness is the point. People legitimately differ between
 * the two sides — a middle name on one, a married name on the other, a diacritic dropped
 * by one system, an order reversed. This asks only whether the names share a distinctive
 * token, and the answer is RECORDED AND SHOWN rather than used to refuse the link: a
 * stricter rule would reject real people to catch a case it cannot catch anyway, since
 * nothing here proves the LinkedIn account belongs to the person holding it.
 *
 * Pure, so the rule can be argued with in a test rather than discovered in production.
 */
function namesAgree(hubName, providerName) {
  const tokenise = (value) =>
    String(value || '')
      .normalize('NFD')
      // Strip combining marks, so "Pjetri" and "Pjetrí" are the same token.
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 1);

  const hub = new Set(tokenise(hubName));
  const provider = tokenise(providerName);
  if (!hub.size || !provider.length) return false;

  const shared = provider.filter((token) => hub.has(token));
  return shared.length >= NAME_MATCH_MIN_TOKENS;
}

module.exports = {
  isConfigured,
  redirectUri,
  newState,
  stateMatches,
  authorisationUrl,
  exchangeCode,
  fetchIdentity,
  namesAgree
};
