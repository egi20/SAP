'use strict';

const express = require('express');
const { body, validationResult } = require('express-validator');

const User = require('../models/User');
const Token = require('../models/Token');
const Referral = require('../models/Referral');
const ConsultantProfile = require('../models/ConsultantProfile');
const CompanyProfile = require('../models/CompanyProfile');
const { isGuest, isAuthenticated } = require('../middleware/auth');
const { loginLimiter, registerLimiter, passwordLimiter } = require('../middleware/rateLimit');
const { registrationOpen } = require('../middleware/settingsGates');
const { asyncHandler } = require('../middleware/errorHandler');
const { safePath } = require('../utils/safeRedirect');
const { countryFromIp, clientIp, packIp } = require('../utils/geo');
const email = require('../utils/email');
const config = require('../config/config');
const legalVersions = require('../config/legal-versions');
const { SIGNUP_SOURCES } = require('../config/signupSources');

const router = express.Router();

const PASSWORD_RULE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;

const registerValidators = [
  body('name')
    .trim()
    .isLength({ min: 2, max: 200 })
    .withMessage('Please enter your name.')
    // Two words, because a directory of single-token names is unusable for employers.
    .matches(/\S+\s+\S+/)
    .withMessage('Please enter your first and last name.'),
  body('email').trim().isEmail().withMessage('Please enter a valid email address.'),
  body('password')
    .matches(PASSWORD_RULE)
    .withMessage('Your password needs at least 8 characters, including an uppercase letter, a lowercase letter and a number.'),
  body('confirm_password')
    .custom((value, { req }) => value === req.body.password)
    .withMessage('The two passwords do not match.'),
  body('terms').equals('on').withMessage('Please accept the terms to continue.'),
  body('gender').optional({ checkFalsy: true }).isIn(['male', 'female', 'non_binary', 'other']),
  body('date_of_birth')
    .optional({ checkFalsy: true })
    .isISO8601()
    .custom((value) => {
      const dob = new Date(value);
      const now = new Date();
      if (dob > now) throw new Error('That date is in the future.');
      const age = (now - dob) / (365.25 * 24 * 60 * 60 * 1000);
      if (age < 16 || age > 100) throw new Error('Please enter a valid date of birth.');
      return true;
    })
];

router.get('/register', isGuest, registrationOpen, (req, res) => {
  res.render('auth/register', {
    signupSources: SIGNUP_SOURCES,
    title: 'Create an account',
    values: {},
    errors: [],
    redirect: safePath(req.query.redirect, '')
  });
});

router.post(
  '/register',
  isGuest,
  // On the POST as well as the page: closing sign-ups only on the form leaves the
  // endpoint open to anyone with the tab still loaded from before.
  registrationOpen,
  registerLimiter,
  registerValidators,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).render('auth/register', {
    signupSources: SIGNUP_SOURCES,
        title: 'Create an account',
        values: req.body,
        errors: errors.array(),
        redirect: safePath(req.body.redirect, '')
      });
    }

    // SECURITY BOUNDARY, not a convenience: whatever the form posts, only the two
    // marketplace roles can be created here. Every privileged role is admin-onboarded.
    const submitted = Array.isArray(req.body.user_types) ? req.body.user_types : [req.body.user_types].filter(Boolean);
    const roles = User.unionRoles([], submitted, { allowed: User.PUBLIC_ROLES });
    const finalRoles = roles.length ? roles : ['consultant'];

    if (await User.emailExists(req.body.email)) {
      return res.status(422).render('auth/register', {
    signupSources: SIGNUP_SOURCES,
        title: 'Create an account',
        values: req.body,
        errors: [{ path: 'email', msg: 'An account with that email already exists.' }],
        redirect: safePath(req.body.redirect, '')
      });
    }

    const ip = clientIp(req);
    const user = await User.create({
      email: req.body.email,
      password: req.body.password,
      name: req.body.name,
      roles: finalRoles,
      // Only this route stamps consent, and it stamps the exact versions accepted.
      consent: { termsVersion: legalVersions.TERMS_VERSION, privacyVersion: legalVersions.PRIVACY_VERSION },
      gender: req.body.gender || null,
      dateOfBirth: req.body.date_of_birth || null,
      signupIp: packIp(ip),
      signupCountry: countryFromIp(ip),
      // Optional, and checked against the closed list in User.create rather than here —
      // one validator, so a value cannot pass the route and fail the column.
      heardAbout: req.body.heard_about || null
    });

    if (finalRoles.includes('consultant')) await ConsultantProfile.ensureExists(user.id);
    if (finalRoles.includes('company')) await CompanyProfile.ensureExists(user.id, req.body.company_name || user.name);

    /*
     * Referral attribution, at the one moment it can happen.
     *
     * The SESSION value is read before the form field, and that order is the security of
     * the whole scheme: the session value was put there by `captureReferralCode` from the
     * link this visitor actually followed, while the field is whatever the browser posted
     * and could name anybody. A form-first read would let one referrer claim another's
     * introduction by posting their code.
     *
     * Never throws and is not awaited for correctness: attribution is a side effect of a
     * registration that has already succeeded, and failing to record who introduced
     * somebody must not fail the account.
     */
    const referralCode = req.session.referralCode || req.body.ref || null;
    if (referralCode) await Referral.attribute(referralCode, user.id);
    delete req.session.referralCode;


    const { token } = await Token.issue('email_verification', user.id);
    email.send({
      to: user.email,
      subject: `Confirm your ${config.app.name} account`,
      template: 'verify',
      locals: { name: user.name, verifyUrl: `${config.app.baseUrl}/auth/verify?token=${encodeURIComponent(token)}` }
    });

    req.flash('success', 'Account created. Check your email for a confirmation link.');
    return res.redirect('/auth/login');
  })
);

router.get('/login', isGuest, (req, res) => {
  res.render('auth/login', {
    title: 'Sign in',
    values: {},
    errors: [],
    redirect: safePath(req.query.redirect, '')
  });
});

router.post(
  '/login',
  isGuest,
  loginLimiter,
  [body('email').trim().isEmail(), body('password').notEmpty()],
  asyncHandler(async (req, res) => {
    const fail = () =>
      res.status(401).render('auth/login', {
        title: 'Sign in',
        values: { email: req.body.email },
        // One message for both "no such account" and "wrong password", so the form
        // cannot be used to enumerate which addresses are registered.
        errors: [{ msg: 'That email and password combination is not correct.' }],
        redirect: safePath(req.body.redirect, '')
      });

    const errors = validationResult(req);
    if (!errors.isEmpty()) return fail();

    const user = await User.findByEmail(req.body.email);
    if (!user) return fail();

    const ok = await User.verifyPassword(user, req.body.password);
    if (!ok) return fail();

    if (!user.is_active) {
      req.flash('error', 'That account has been deactivated.');
      return res.redirect('/auth/login');
    }

    // Admins are exempt so an admin-created account is never locked out of the very
    // panel that could verify it.
    if (!user.email_verified && user.user_type !== 'admin') {
      req.flash('error', 'Please confirm your email address first. Check your inbox for the link.');
      return res.redirect('/auth/login');
    }

    // Session fixation: regenerate, carrying across only the two values that are safe
    // to preserve and that the person would otherwise lose.
    const redirectAfterLogin = safePath(req.body.redirect || req.session.redirectAfterLogin, '/dashboard');

    return req.session.regenerate(async (err) => {
      if (err) throw err;
      req.session.user = User.buildSessionUser(user);

      /*
       * "Remember me" lengthens THIS session's cookie, and nothing else.
       *
       * Not a second long-lived token in a table, which is the usual shape and is a second
       * credential to leak, revoke and expire. The session already exists, the store
       * already has a row, and `rolling: true` already refreshes it on every request — so
       * the whole feature is one number, and signing out still ends it exactly as before.
       *
       * Set AFTER regenerate(), or it is written onto the session being thrown away.
       */
      if (req.body.remember === 'on') {
        req.session.cookie.maxAge = config.session.rememberMeMaxAge;
      }

      await User.recordLogin(user.id);
      req.flash('success', `Welcome back, ${req.session.user.name}.`);
      return res.redirect(redirectAfterLogin);
    });
  })
);

router.post('/logout', isAuthenticated, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('sfhub.sid');
    res.redirect('/');
  });
});

router.get(
  '/verify',
  asyncHandler(async (req, res) => {
    const userId = await Token.consume('email_verification', req.query.token);
    if (!userId) {
      req.flash('error', 'That confirmation link is invalid or has expired. Request a new one from your dashboard.');
      return res.redirect('/auth/login');
    }
    await User.setEmailVerified(userId);
    req.flash('success', 'Email confirmed. You can sign in now.');
    return res.redirect('/auth/login');
  })
);

router.get('/forgot-password', isGuest, (req, res) => {
  res.render('auth/forgot-password', { title: 'Reset your password', errors: [], values: {} });
});

router.post(
  '/forgot-password',
  isGuest,
  passwordLimiter,
  [body('email').trim().isEmail()],
  asyncHandler(async (req, res) => {
    const user = await User.findByEmail(req.body.email);

    if (user) {
      const { token } = await Token.issue('password_reset', user.id);
      email.send({
        to: user.email,
        subject: `Reset your ${config.app.name} password`,
        template: 'reset-password',
        locals: { name: user.name, resetUrl: `${config.app.baseUrl}/auth/reset-password/${encodeURIComponent(token)}` }
      });
    }

    // The same answer either way: whether an address is registered is not something an
    // anonymous form should reveal.
    req.flash('info', 'If that address has an account, a reset link is on its way.');
    return res.redirect('/auth/login');
  })
);

router.get('/reset-password/:token', isGuest, (req, res) => {
  res.render('auth/reset-password', { title: 'Choose a new password', token: req.params.token, errors: [] });
});

router.post(
  '/reset-password/:token',
  isGuest,
  passwordLimiter,
  [
    body('password').matches(PASSWORD_RULE).withMessage('Your password needs at least 8 characters, including an uppercase letter, a lowercase letter and a number.'),
    body('confirm_password').custom((v, { req }) => v === req.body.password).withMessage('The two passwords do not match.')
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).render('auth/reset-password', {
        title: 'Choose a new password',
        token: req.params.token,
        errors: errors.array()
      });
    }

    const userId = await Token.consume('password_reset', req.params.token);
    if (!userId) {
      req.flash('error', 'That reset link is invalid or has expired.');
      return res.redirect('/auth/forgot-password');
    }

    await User.updatePassword(userId, req.body.password);
    req.flash('success', 'Password updated. You can sign in now.');
    return res.redirect('/auth/login');
  })
);

router.post(
  '/resend-verification',
  isAuthenticated,
  passwordLimiter,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.session.user.id);
    if (user && !user.email_verified) {
      const { token } = await Token.issue('email_verification', user.id);
      email.send({
        to: user.email,
        subject: `Confirm your ${config.app.name} account`,
        template: 'verify',
        locals: { name: user.name, verifyUrl: `${config.app.baseUrl}/auth/verify?token=${encodeURIComponent(token)}` }
      });
    }
    req.flash('info', 'Confirmation email sent.');
    return res.redirect('/dashboard');
  })
);

module.exports = router;
