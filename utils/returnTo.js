'use strict';

const { safePath } = require('./safeRedirect');

/**
 * Where to send someone back to after a failed or rejected POST.
 *
 * `res.redirect('back')` is NOT usable here. It reads the `Referer` header, and this app
 * sends `Referrer-Policy: no-referrer`, so on a real browser POST that header is empty and
 * Express silently falls back to `/`. The person loses their place and it looks like a bug.
 *
 * The rule that replaces it: "go back" must come from an explicit, allow-listed value —
 * a `redirectTo` hidden field the form itself carried — with a per-call-site default when
 * the form did not carry one. Never from Referer.
 */
function returnTo(req, fallback = '/') {
  const submitted = req.body && req.body.redirectTo;
  if (submitted) return safePath(submitted, fallback);

  // A GET can safely return to itself; a POST endpoint usually cannot be rendered.
  if (req.method === 'GET') return safePath(req.originalUrl, fallback);

  return safePath(fallback, '/');
}

module.exports = { returnTo };
