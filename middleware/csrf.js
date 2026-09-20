'use strict';

const crypto = require('crypto');

/**
 * Per-session CSRF tokens.
 *
 * Ported from Salesforce Hub unchanged, which in turn added it because DynamicsHub had
 * no CSRF middleware at all and relied on `SameSite=Lax` plus POST-only mutations. That
 * is a real defence, but it is a single one: Lax is a browser-side policy, it does not
 * cover every client, and it has had implementation gaps. A token that the attacker's
 * origin cannot read is an independent second lock.
 *
 * Design: one secret per session, and a comparison in constant time. Safe methods are
 * exempt; so is any route explicitly marked (a webhook verifying its own signature has
 * no session and no browser).
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const TOKEN_FIELD = '_csrf';
const HEADER_NAMES = ['x-csrf-token', 'x-xsrf-token'];

function ensureSecret(req) {
  if (!req.session.csrfSecret) {
    req.session.csrfSecret = crypto.randomBytes(32).toString('base64url');
  }
  return req.session.csrfSecret;
}

function tokenFor(req) {
  return ensureSecret(req);
}

function presentedToken(req) {
  if (req.body && typeof req.body[TOKEN_FIELD] === 'string') return req.body[TOKEN_FIELD];
  for (const header of HEADER_NAMES) {
    const value = req.get(header);
    if (value) return value;
  }
  return '';
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  // timingSafeEqual throws on a length mismatch, which would itself leak length.
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * @param {{exempt?: (req) => boolean}} options
 */
function csrfProtection({ exempt = () => false } = {}) {
  return (req, res, next) => {
    if (!req.session) return next();

    // Available to every template as a hidden field / meta tag.
    res.locals.csrfToken = tokenFor(req);

    if (SAFE_METHODS.has(req.method)) return next();
    if (exempt(req)) return next();

    if (safeEqual(presentedToken(req), req.session.csrfSecret)) return next();

    const err = new Error('Invalid or missing CSRF token.');
    err.status = 403;
    err.code = 'EBADCSRFTOKEN';
    return next(err);
  };
}

module.exports = { csrfProtection, tokenFor, TOKEN_FIELD };
