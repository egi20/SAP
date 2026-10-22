'use strict';

const express = require('express');

const CertPractice = require('../models/CertPractice');
const { isAuthenticated, isEmailVerified } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/errorHandler');
const learning = require('../config/learning');

const router = express.Router();

/**
 * /consultants/learning and /consultants/certifications, at dynamicshub.net's addresses
 * (owner, 2026-10-22). Mounted in front of routes/consultants.js, whose `/:id` would
 * otherwise answer for them. Content and the rules behind it: config/learning.js.
 */

router.get('/learning', (req, res) => {
  res.render('consultants/learning', {
    title: 'Learning Paths',
    learningPaths: learning.LEARNING_PATHS,
    resources: learning.RESOURCES,
    certs: learning.practiceCerts()
  });
});

router.get(
  '/certifications',
  asyncHandler(async (req, res) => {
    const user = req.session.user;
    res.render('consultants/certifications', {
      title: 'Certification Practice',
      certs: learning.practiceCerts(),
      progress: user ? await CertPractice.progressFor(user.id) : {},
      setSize: learning.PRACTICE_SET_SIZE
    });
  })
);

function findPractice(req, res, next) {
  const cert = learning.practiceCerts().find((c) => c.code === req.params.code);
  if (!cert) return next('route');
  req.cert = cert;
  return next();
}

router.get('/certifications/:code/practice', isAuthenticated, isEmailVerified, findPractice, (req, res) => {
  res.render('consultants/cert-practice', {
    title: `${req.cert.label} — practice`,
    cert: req.cert,
    // The page gets questions and options; the answers and explanations stay here.
    questions: learning.practiceSetFor(req.cert.code),
    graded: null
  });
});

router.post(
  '/certifications/:code/practice',
  isAuthenticated,
  isEmailVerified,
  writeLimiter,
  findPractice,
  asyncHandler(async (req, res) => {
    const graded = learning.gradePractice(req.cert.code, req.body.answers);
    if (!graded) {
      req.flash('error', 'That session had no answers in it. Here is a new one.');
      return res.redirect(`/consultants/certifications/${req.cert.code}/practice`);
    }
    await CertPractice.record(req.session.user.id, req.cert.code, graded.score, graded.total);
    return res.render('consultants/cert-practice', {
      title: `${req.cert.label} — results`,
      cert: req.cert,
      questions: null,
      graded
    });
  })
);

module.exports = router;
