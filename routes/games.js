'use strict';

const express = require('express');

const Game = require('../models/Game');
const Challenge = require('../models/Challenge');
const { isAuthenticated, isEmailVerified } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/errorHandler');
const { communityWritable } = require('../middleware/settingsGates');
const games = require('../config/games');

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

/** GET /games — the hub: every game, what you played today, and today's combined board. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const date = games.serverDate();
    const user = req.session.user;
    const [played, board, challengeToday] = await Promise.all([
      user ? Game.playedOn(user.id, date) : {},
      Game.combinedBoard(date),
      user ? Challenge.attemptFor(user.id, date) : null
    ]);
    res.render('games/index', {
      title: 'SAP games',
      date,
      gamesList: games.GAMES,
      played,
      board,
      challengeToday
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
    gridSize: games.GRID_SIZE
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
