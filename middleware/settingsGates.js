'use strict';

const AppSetting = require('../models/AppSetting');
const { isNavigation } = require('./auth');
const { returnTo } = require('../utils/returnTo');

/**
 * The operational switches from `config/settings.js`, enforced.
 *
 * They live as middleware rather than as a check inside each handler so that turning a
 * switch off closes EVERY door at once. A gate written into three of four write handlers
 * is a gate that is off, and nobody finds the fourth until it matters.
 *
 * Both answer the way every other failed guard in this app does: a flash and a redirect
 * for a top-level navigation, JSON for a background fetch. See `middleware/auth.js`.
 */

function refuse(req, res, message, fallback) {
  if (!isNavigation(req)) {
    return res.status(403).json({ success: false, error: message });
  }
  req.flash('error', message);
  return res.redirect(returnTo(req, fallback));
}

/**
 * Applied to the registration page AND to the POST behind it. Closing sign-ups only on the
 * form leaves the endpoint open to anyone who kept the tab from before.
 */
async function registrationOpen(req, res, next) {
  const open = await AppSetting.get('registration_open');
  if (open) return next();
  return refuse(
    req,
    res,
    'New registrations are closed at the moment. Please try again later.',
    '/'
  );
}

module.exports = { registrationOpen };
