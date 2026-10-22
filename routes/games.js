'use strict';

const express = require('express');

const Game = require('../models/Game');
const Challenge = require('../models/Challenge');
const { isAuthenticated, isEmailVerified } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/errorHandler');
const { communityWritable } = require('../middleware/settingsGates');
const games = require('../config/games');
const { QUESTIONS_PER_DAY } = require('../config/challenges');

const router = express.Router();

/**
 * The SAP games. See config/games.js for why the scored ones are graded here and the
 * practice ones store nothing.
 *
 * THE RULE, as in routes/challenges.js: before an attempt is closed, a set reaches a
 * template only through `publicFormOf`. The key and the explanations are rendered only from
 * a graded result — after the unique key on (user_id, game, game_date) has closed the day.
 *
 * Routes are resolved from the catalogue rather than written out per game, so a game added
 * to config/games.js has a page without a second list here to forget.
 */

function findGame(req, res, next) {
  const game = games.gameOf(req.params.game);
  if (!game) return next('route');
  req.game = game;
  return next();
}

/** Scored games need an account (they pay points); practice games are for everyone. */
function scoredNeedsAccount(req, res, next) {
  if (!req.game.scored) return next();
  return isAuthenticated(req, res, (err) => (err ? next(err) : isEmailVerified(req, res, next)));
}

/*
 * ONE page for every game, at the address dynamicshub.net uses: /games/challenges (owner,
 * 2026-10-22). The daily challenge is its first card, as the reference's quiz is, and the
 * menu carries one "Challenges" entry pointing here instead of a "Challenges" and an "SAP
 * Games" that were two front doors to the same thing.
 *
 * Unlike the reference it is open to a signed-out visitor: two of the games are practice
 * and need no account, and a scored card says it needs one rather than hiding.
 *
 * The cards follow the reference's order; a game missing from HUB_ORDER still appears, at
 * the end, so a game added to the catalogue is never left off the page.
 */
const HUB_ORDER = ['match', 'flashcards', 'codequiz', 'bughunter', 'typing', 'wordsearch', 'scenario'];
const hubOrdered = () => [...games.GAMES].sort((a, b) => {
  const ia = HUB_ORDER.indexOf(a.key);
  const ib = HUB_ORDER.indexOf(b.key);
  return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
});

/*
 * The floating tags across the top are the module codes from config/sapProducts.js — the
 * same vocabulary the filters and the estimator use, never a list typed into the view.
 */
const MODULE_CODES = (() => {
  const codes = [];
  require('../config/sapProducts').ALL_MODULES.forEach((m) => {
    const code = (String(m.label).match(/\(([A-Z][A-Z0-9/ -]{1,12})\)\s*$/) || [])[1];
    // Short codes only: "RAR / IFRS 15" is a label, not a tag.
    if (code && /^[A-Z]{2,5}(-[A-Z]{2,4})?$/.test(code) && !codes.includes(code)) codes.push(code);
  });
  return codes.slice(0, 18);
})();

router.get('/', (req, res) => res.redirect(301, '/games/challenges'));

router.get(
  '/challenges',
  asyncHandler(async (req, res) => {
    const date = games.serverDate();
    const user = req.session.user;
    const [played, rankings, challengeToday, streak] = await Promise.all([
      user ? Game.playedOn(user.id, date) : {},
      Game.todaysRankings(date),
      user ? Challenge.attemptFor(user.id, date) : null,
      user ? Challenge.streakFor(user.id, { today: date }) : null
    ]);
    const gamesList = hubOrdered();
    const scoredCount = gamesList.filter((g) => g.scored).length + 1; // + the daily challenge
    const playedCount = Object.keys(played).filter((k) => games.gameOf(k) && games.gameOf(k).scored).length + (challengeToday ? 1 : 0);
    res.render('games/index', {
      title: 'Daily Challenges',
      date,
      gamesList,
      played,
      rankings,
      challengeToday,
      streak,
      scoredCount,
      playedCount,
      moduleCodes: MODULE_CODES,
      challengeQuestions: QUESTIONS_PER_DAY
    });
  })
);

async function renderGame(req, res, { results = null, status = 200 } = {}) {
  const game = req.game;
  const date = games.serverDate();
  const user = req.session.user;
  let attempt = null;
  let board = [];
  if (game.scored) {
    [attempt, board] = await Promise.all([
      Game.attemptFor(user.id, game.key, date),
      Game.dailyBoard(game.key, date)
    ]);
  }
  const graded = results || (attempt ? Game.replay(attempt, game.key, date) : null);
  const set = games.dailySetFor(game.key, date);

  return res.status(status).render('games/play', {
    title: game.title,
    game,
    date,
    board,
    attempt,
    results: graded,
    // Before the day is closed, only the public form. Practice sets are their own public form.
    set: graded ? null : games.publicFormOf(game.key, set),
    gridSize: games.GRID_SIZE,
    // The card's colour on /games/challenges, carried onto the game's own page.
    tone: (hubOrdered().findIndex((g) => g.key === game.key) % 7) + 3
  });
}

/** GET /games/:game */
router.get('/:game', findGame, scoredNeedsAccount, asyncHandler((req, res) => renderGame(req, res)));

/** POST /games/:game — the chosen answers, graded here. No score, no date is read. */
router.post(
  '/:game',
  findGame,
  scoredNeedsAccount,
  communityWritable,
  writeLimiter,
  asyncHandler(async (req, res) => {
    if (!req.game.scored) return res.redirect(`/games/${req.game.key}`);
    const outcome = await Game.submit(req.session.user.id, req.game.key, req.body.answers);
    if (!outcome.recorded) {
      req.flash('info', 'You have already played this game today. A new set arrives tomorrow.');
      return res.redirect(`/games/${req.game.key}`);
    }
    // Rendered, not redirected: the explanations are the point of playing.
    return renderGame(req, res, { results: outcome.graded });
  })
);

module.exports = router;
