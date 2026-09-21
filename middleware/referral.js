'use strict';

const Referral = require('../models/Referral');

const { normaliseCode } = Referral;

/**
 * Remember the referral code on the link somebody actually followed.
 *
 * `?ref=CODE` on ANY page puts the code in the session, and `POST /auth/register` reads it
 * from there in preference to the posted form field. That order is the security of the
 * whole scheme: the session value came from a link this visitor clicked, while a posted
 * field is whatever the browser sent and could name anybody — a form-first read lets one
 * referrer claim another's introduction by posting their code.
 *
 * FIRST TOUCH WINS, and it wins here rather than in the model. An existing value is never
 * overwritten, so somebody who arrives through one person's link and later browses in
 * through another's stays attributed to the first. Last-touch would mean an introduction
 * can be taken from the person who actually made it by getting a link in front of the
 * visitor the day before they sign up, and a scheme whose attribution can be stolen is a
 * scheme with a fight in it. (`referral_attributions` is UNIQUE on the referred account
 * for the same reason, so this is belt and braces on purpose.)
 *
 * Only the CODE is stored — no referrer id, no name, nothing resolved. Resolution happens
 * at registration against the live referrer row, so a code that was deactivated between
 * the click and the sign-up attributes nothing.
 */
function captureReferralCode(req, res, next) {
  const raw = req.query && req.query.ref;
  if (!raw || typeof raw !== 'string') return next();
  if (req.session.referralCode) return next();

  const code = normaliseCode(raw);
  // Length-checked before it is stored: the session is a cookie-backed store and there is
  // no reason for anything but a code-shaped string to end up in it.
  if (code) req.session.referralCode = code;
  return next();
}

module.exports = { captureReferralCode };
