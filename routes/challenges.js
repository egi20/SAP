'use strict';

const express = require('express');

const Challenge = require('../models/Challenge');
const { isAuthenticated, isEmailVerified } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/errorHandler');
const { communityWritable } = require('../middleware/settingsGates');
const {
  QUESTIONS_PER_DAY,
  POINTS_PER_CORRECT,
  bankSize,
  dailySetFor,
  publicFormOf,
  serverDate
} = require('../config/challenges');

const router = express.Router();

/**
 * The daily challenge.
 *
 * THE ONE RULE: an answer key never leaves this process. `dailySetFor()` returns the full
 * question including `answer`, and every path out of this file maps it through
 * `publicFormOf` first. A test asserts this module never renders a raw question and never
 * names the `answer` or `explain` fields outside a graded result.
 *
 * Signed in and email-verified, because the attempt awards points against the shared
 * ledger. An anonymous or unverified account playing would let one person farm a
 * leaderboard from a mailbox they do not control.
 *
 * Gated by `communityWritable` for the same reason posts are: the challenge writes to the
 * points ledger, so the switch that stops the community growing has to stop this too. A
 * gate written into three of four write paths is a gate that is off.
 */

/** Everything the page needs whether or not today has been played. */
async function pageModel(userId, { date = serverDate() } = {}) {
  const [attempt, streak, stats, daily, allTime] = await Promise.all([
    Challenge.attemptFor(userId, date),
    Challenge.streakFor(userId, { today: date }),
    Challenge.statsFor(userId),
    Challenge.dailyLeaderboard(date),
    Challenge.allTimeLeaderboard()
  ]);

  return { date, attempt, streak, stats, daily, allTime };
}

/**
 * GET /challenges — today's five questions, or today's result.
 *
 * Note what is passed to the template: `dailySetFor(date).map(publicFormOf)`. The set is
 * derived from the DATE, so it is the same five questions for everybody and the same five
 * on a reload — which is what lets a daily leaderboard mean anything, and what lets a
 * disputed score be reconstructed later.
 */
router.get(
  '/',
  isAuthenticated,
  isEmailVerified,
  asyncHandler(async (req, res) => {
    const model = await pageModel(req.session.user.id);

    res.render('challenges/index', {
      title: 'Daily challenge',
      ...model,
      questions: model.attempt ? [] : dailySetFor(model.date).map(publicFormOf),
      questionsPerDay: QUESTIONS_PER_DAY,
      pointsPerCorrect: POINTS_PER_CORRECT,
      bankSize: bankSize(),
      /*
       * Today's result, rebuilt from the stored attempt, so a reload does not throw the
       * explanations away — they are the reason to play, and in the reference they exist
       * only in the response to the POST. The set is derived from the date and the row
       * holds what was chosen, so the rebuild is exact; and the key is only shown for an
       * attempt the unique key has already closed.
       */
      results: model.attempt ? Challenge.replay(model.attempt, model.date) : null
    });
  })
);

/**
 * POST /challenges — submit the chosen options and get them graded.
 *
 * The body carries `answers[]` — the OPTION INDEX chosen for each question, in the order
 * they were shown — and nothing else that matters. There is no `score` field and no
 * `gameDate` field to read, which is the whole point: the reference reads both out of
 * `req.body` and writes them to its leaderboard.
 *
 * `duration_ms` IS read from the body and stored, but only ever displayed. It is not
 * ranked on and the model says so, because a client-reported duration is precisely the
 * kind of number that should not decide a position.
 */
router.post(
  '/',
  isAuthenticated,
  isEmailVerified,
  communityWritable,
  writeLimiter,
  asyncHandler(async (req, res) => {
    // Passed through as it arrived. The grader keys on the question id and treats
    // anything it cannot read as unanswered, so a hostile or malformed body produces a
    // low score rather than an error — and cannot reach a question it was not asked.
    const answers = req.body.answers;

    const durationRaw = Number.parseInt(req.body.duration_ms, 10);

    const outcome = await Challenge.submit(req.session.user.id, answers, {
      durationMs: Number.isFinite(durationRaw) ? durationRaw : null
    });

    if (!outcome.recorded) {
      req.flash('info', 'You have already played today. Come back tomorrow for a new set.');
      return res.redirect('/challenges');
    }

    const model = await pageModel(req.session.user.id, { date: outcome.date });

    // Rendered rather than redirected, because the explanations are the reason to play and
    // a redirect would throw them away. This is the only place `explain` and `answer` are
    // ever sent to a browser — after the attempt is closed by the unique key.
    return res.status(200).render('challenges/index', {
      title: 'Daily challenge',
      ...model,
      questions: [],
      questionsPerDay: QUESTIONS_PER_DAY,
      pointsPerCorrect: POINTS_PER_CORRECT,
      bankSize: bankSize(),
      results: outcome.graded
    });
  })
);

/** GET /challenges/leaderboard — the same two tables, on their own page. */
router.get(
  '/leaderboard',
  isAuthenticated,
  asyncHandler(async (req, res) => {
    const date = serverDate();
    const [daily, allTime] = await Promise.all([
      Challenge.dailyLeaderboard(date, { limit: 25 }),
      Challenge.allTimeLeaderboard({ limit: 25 })
    ]);

    res.render('challenges/leaderboard', {
      title: 'Challenge leaderboard',
      date,
      daily,
      allTime
    });
  })
);

module.exports = router;
