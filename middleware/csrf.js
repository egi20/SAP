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
/**
 * A multipart body has not been parsed when this middleware runs — multer parses it in the
 * route — so the `_csrf` field inside it is invisible here, and every file upload on the
 * site answered "Your session expired" in a real browser. Nothing caught it because no
 * test posted a real multipart form.
 *
 * The fix DEFERS the check for those requests, and only for paths that are known upload
 * routes (`deferMultipart`, fed from middleware/fileUpload.js). Deferring for any multipart
 * request would let a cross-site multipart form reach a route that needs no body at all —
 * a "mark verified" button, say — with no check ever run. The upload helpers call
 * `verifyDeferred` as soon as multer has parsed the body, before the handler sees it.
 */
function isMultipart(req) {
  return /^multipart\/form-data/i.test(req.get('content-type') || '');
}

function verifyDeferred(req) {
  if (!req.csrfDeferred) return true;
  return Boolean(req.session) && safeEqual(presentedToken(req), req.session.csrfSecret);
}

function csrfError() {
  const err = new Error('Invalid or missing CSRF token.');
  err.status = 403;
  err.code = 'EBADCSRFTOKEN';
  return err;
}

function csrfProtection({ exempt = () => false, deferMultipart = () => false } = {}) {
  return (req, res, next) => {
    if (!req.session) return next();

    // Available to every template as a hidden field / meta tag.
    res.locals.csrfToken = tokenFor(req);

    if (SAFE_METHODS.has(req.method)) return next();
    if (exempt(req)) return next();
    if (isMultipart(req) && deferMultipart(req)) {
      req.csrfDeferred = true;
      return next();
    }

    if (safeEqual(presentedToken(req), req.session.csrfSecret)) return next();

    return next(csrfError());
  };
}

module.exports = { csrfProtection, verifyDeferred, csrfError, tokenFor, TOKEN_FIELD };
