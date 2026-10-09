'use strict';

const User = require('../models/User');
const ConsultantProfile = require('../models/ConsultantProfile');
const CompanyProfile = require('../models/CompanyProfile');
const { safePath } = require('../utils/safeRedirect');

/**
 * Is this request a top-level navigation, or a background fetch?
 *
 * It decides how an auth failure is reported. A navigation gets a flash message and a
 * 302 to the login page; a background fetch gets a 401 JSON body, because redirecting
 * an XHR to an HTML login page produces a confusing "unexpected token <" in the client
 * rather than an actionable error.
 *
 * Testing consequence worth stating loudly: a plain Node HTTP client sends no
 * `Sec-Fetch-Dest`, so it is treated as a navigation and sees 302. A browser `fetch()`
 * sends `Sec-Fetch-Dest: empty` and sees 401. Assertions about gated routes must pick
 * one and be explicit about it.
 */
function isNavigation(req) {
  const dest = req.get('sec-fetch-dest');
  if (dest) return dest === 'document';
  return !req.xhr && req.accepts(['html', 'json']) === 'html';
}

function denyAuth(req, res, message) {
  if (!isNavigation(req)) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }
  req.flash('error', message);
  // Only a navigation stores a return path. A background fetch must never overwrite
  // where the person was actually heading.
  req.session.redirectAfterLogin = safePath(req.originalUrl, '/dashboard');
  return res.redirect(`/auth/login?redirect=${encodeURIComponent(req.session.redirectAfterLogin)}`);
}

function denyRole(req, res, message, redirectTo = '/') {
  if (!isNavigation(req)) {
    return res.status(403).json({ success: false, error: message });
  }
  req.flash('error', message);
  return res.redirect(redirectTo);
}

function isAuthenticated(req, res, next) {
  if (req.session && req.session.user) return next();
  return denyAuth(req, res, 'Please sign in to continue.');
}

function isGuest(req, res, next) {
  if (req.session && req.session.user) return res.redirect('/dashboard');
  return next();
}

/**
 * Role guards check the ROLE FLAG, not just the primary `user_type`.
 * An admin who is also a consultant must not be refused a consultant feature.
 */
/*
 * The three roles anybody can add to their own account (User.PUBLIC_ROLES) are refused
 * with a way IN, not a dead end. "Post a role" and "Build Profile" are linked from menus,
 * the footer and half a dozen pages, and every one of them used to bounce an account
 * without that role to the home page with "That area is for company accounts" — which
 * says no without saying what would make it yes. The roles form in settings is the one
 * control that can.
 */
const ROLES_PAGE = '/profile/settings#roles';

function isConsultant(req, res, next) {
  const user = req.session && req.session.user;
  if (!user) return denyAuth(req, res, 'Please sign in to continue.');
  if (user.isConsultant) return next();
  return denyRole(req, res, 'That area is for consultant accounts. Tick “Find work as a consultant” below to add it.', ROLES_PAGE);
}

function isCompany(req, res, next) {
  const user = req.session && req.session.user;
  if (!user) return denyAuth(req, res, 'Please sign in to continue.');
  if (user.isCompany) return next();
  return denyRole(req, res, 'That area is for company accounts. Tick “Hire SAP talent” below to add it.', ROLES_PAGE);
}

/**
 * A recruiter is an agency or headhunter placing candidates, and the guard checks the flag
 * like every other role. It lives HERE, with the other guards, and not in
 * `routes/recruiters.js`: DynamicsHub wrote a private copy of this check inside that route
 * file, which meant it redirected a background fetch to a login page instead of answering
 * 401/403 JSON, because a route-local guard does not know about `Sec-Fetch-Dest`.
 */
function isRecruiter(req, res, next) {
  const user = req.session && req.session.user;
  if (!user) return denyAuth(req, res, 'Please sign in to continue.');
  if (user.isRecruiter) return next();
  return denyRole(req, res, 'That area is for recruiter accounts. Tick “Place candidates as an agency” below to add it.', ROLES_PAGE);
}

function isAdmin(req, res, next) {
  const user = req.session && req.session.user;
  if (!user) return denyAuth(req, res, 'Please sign in to continue.');
  if (user.isAdmin) return next();
  return denyRole(req, res, 'You do not have access to that area.');
}

function isSuperadmin(req, res, next) {
  const user = req.session && req.session.user;
  if (!user) return denyAuth(req, res, 'Please sign in to continue.');
  if (user.isSuperadmin) return next();
  return denyRole(req, res, 'You do not have access to that area.');
}

function isEmailVerified(req, res, next) {
  const user = req.session && req.session.user;
  if (!user) return denyAuth(req, res, 'Please sign in to continue.');
  if (user.emailVerified || user.isAdmin) return next();
  return denyRole(req, res, 'Please verify your email address first.', '/dashboard');
}

/**
 * Global: re-read the account on every request and rebuild the session user.
 *
 * This is what makes a revoked role take effect on the NEXT request rather than at the
 * person's next sign-in, and what makes deactivating an account actually end its
 * session. It costs one indexed primary-key read per authenticated request.
 */
async function validateActiveAccount(req, res, next) {
  if (!req.session || !req.session.user) return next();

  try {
    const user = await User.findById(req.session.user.id);

    if (!user || !user.is_active) {
      return req.session.destroy(() => {
        res.redirect('/auth/login');
      });
    }

    let displayName = user.name;
    let profilePicture = null;

    if (user.is_consultant || user.user_type === 'consultant') {
      const profile = await ConsultantProfile.findByUserId(user.id);
      if (profile) profilePicture = profile.profile_picture;
    }
    if (!profilePicture && (user.is_company || user.user_type === 'company')) {
      const company = await CompanyProfile.findByUserId(user.id);
      if (company) {
        profilePicture = company.logo;
        displayName = displayName || company.company_name;
      }
    }

    req.session.user = User.buildSessionUser(user, { displayName, profilePicture });
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  isNavigation,
  isAuthenticated,
  isGuest,
  isConsultant,
  isCompany,
  isRecruiter,
  isAdmin,
  isSuperadmin,
  isEmailVerified,
  validateActiveAccount
};
