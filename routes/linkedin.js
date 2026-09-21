'use strict';

const express = require('express');

const linkedin = require('../utils/linkedin');
const ExternalIdentity = require('../models/ExternalIdentity');
const User = require('../models/User');
const ErrorLog = require('../models/ErrorLog');
const { isAuthenticated } = require('../middleware/auth');
const { ipLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/errorHandler');
const { safePath } = require('../utils/safeRedirect');

const router = express.Router();

/**
 * LinkedIn identity verification.
 *
 * **LINKING ONLY. NEVER A SIGN-IN METHOD.** Both routes require an authenticated session,
 * and there is no path here that creates an account or starts one. That is a security
 * decision, not a product one: an OAuth provider that can also sign you in has to decide
 * what to do when the provider's email matches an existing Hub account, and every answer
 * to that is a documented account-takeover pattern. Requiring an existing session removes
 * the question entirely — the member has already proved who they are here before LinkedIn
 * is involved at all.
 *
 * What it proves: this person controls a LinkedIn account, and here is the name on it.
 * What it does NOT prove, because no ordinary LinkedIn scope returns it: that the
 * `linkedin.com/in/...` URL on their profile is that account, or their job title, or their
 * employer. See `config/linkedin.js` for the finding behind that.
 */

// Keyed on IP. The flow makes two outbound calls to a third party, so a loop on this
// endpoint is a way to spend somebody else's rate limit with LinkedIn as well as ours.
const startLimiter = ipLimiter({
  windowMs: 10 * 60 * 1000,
  max: 20,
  message: 'Too many verification attempts. Please wait a few minutes.'
});

function notAvailable(req, res) {
  req.flash('error', 'LinkedIn verification is not switched on for this deployment.');
  return res.redirect('/profile/settings');
}

/**
 * GET /linkedin/start — send the member to LinkedIn.
 *
 * `returnTo` is stored in the session as an allow-listed same-origin path, never read back
 * from `Referer` at the callback: the callback is a GET arriving from a third party, and
 * a redirect target taken from a header at that point is an open redirect.
 */
router.get(
  '/start',
  isAuthenticated,
  startLimiter,
  asyncHandler(async (req, res) => {
    if (!linkedin.isConfigured()) return notAvailable(req, res);

    const state = linkedin.newState();
    req.session.linkedinState = state;
    req.session.linkedinReturnTo = safePath(req.query.returnTo, '/profile/settings');

    /*
     * The session is saved EXPLICITLY before redirecting away.
     *
     * The store write is asynchronous, and the member's browser is about to leave for
     * linkedin.com and come back on a different request. Without this the callback can
     * arrive before the state has landed, and the flow fails as "security verification
     * failed" on a request that was entirely legitimate.
     */
    await new Promise((resolve, reject) => {
      req.session.save((err) => (err ? reject(err) : resolve()));
    });

    return res.redirect(linkedin.authorisationUrl(state.value));
  })
);

/**
 * GET /linkedin/callback — LinkedIn sends the member back here.
 *
 * Authenticated, like everything else in this file. A callback that worked without a
 * session would be a sign-in path by another name.
 */
router.get(
  '/callback',
  isAuthenticated,
  asyncHandler(async (req, res) => {
    const returnTo = safePath(req.session.linkedinReturnTo, '/profile/settings');
    const state = req.session.linkedinState;

    // Consumed on the way in, whatever happens next: a state that survives a failed
    // attempt is a state that can be replayed.
    delete req.session.linkedinState;
    delete req.session.linkedinReturnTo;

    if (!linkedin.isConfigured()) return notAvailable(req, res);

    if (req.query.error) {
      // Cancelling is the ordinary case, not a failure worth alarming anyone about.
      const cancelled = /cancel|denied/i.test(String(req.query.error));
      req.flash(cancelled ? 'info' : 'error', cancelled
        ? 'LinkedIn verification was cancelled. Nothing has changed.'
        : 'LinkedIn could not complete the verification. Please try again.');
      return res.redirect(returnTo);
    }

    if (!linkedin.stateMatches(state, req.query.state)) {
      // Either a cross-site attempt or a flow left open for longer than the state lives.
      req.flash('error', 'That verification link has expired or did not match. Please start again.');
      return res.redirect(returnTo);
    }

    if (typeof req.query.code !== 'string' || !req.query.code) {
      req.flash('error', 'LinkedIn did not send an authorisation code. Please try again.');
      return res.redirect(returnTo);
    }

    let identity;
    try {
      const accessToken = await linkedin.exchangeCode(req.query.code);
      identity = await linkedin.fetchIdentity(accessToken);
      // The token goes out of scope here and is never written anywhere. This application
      // has no further use for LinkedIn, so holding a credential that can act as the
      // member would be a liability with no purpose.
    } catch (err) {
      await ErrorLog.record(err, req, 502);
      req.flash('error', 'LinkedIn did not answer. Please try again in a moment.');
      return res.redirect(returnTo);
    }

    const user = await User.findById(req.session.user.id);
    // One `name` column in this schema, not a split first/last pair.
    const hubName = (user.name || '').trim();
    const nameMatched = linkedin.namesAgree(hubName, identity.name);

    const result = await ExternalIdentity.linkLinkedIn(req.session.user.id, {
      subject: identity.subject,
      displayName: identity.name,
      nameMatched
    });

    if (!result.linked) {
      // Refused rather than moved. Naming the other account would tell whoever tried this
      // that it exists, so the message says only that the account is in use.
      req.flash('error', 'That LinkedIn account already confirms another SAP Hub account.');
      return res.redirect(returnTo);
    }

    req.flash(
      'success',
      nameMatched
        ? `LinkedIn account confirmed as ${identity.name}.`
        : `LinkedIn account confirmed as ${identity.name} — which does not match the name on your profile. `
          + 'That is fine if both are yours, but people reading your profile will see both.'
    );
    return res.redirect(returnTo);
  })
);

/**
 * POST /linkedin/disconnect — the member's own request.
 *
 * Clears the badge as well as the identity, in one transaction. A badge outliving its
 * proof is the one outcome that must be impossible.
 */
router.post(
  '/disconnect',
  isAuthenticated,
  asyncHandler(async (req, res) => {
    await ExternalIdentity.unlink(ExternalIdentity.LINKEDIN, req.session.user.id);
    req.flash('success', 'LinkedIn disconnected. The verified badge has been removed.');
    return res.redirect(safePath(req.body.redirectTo, '/profile/settings'));
  })
);

module.exports = router;
