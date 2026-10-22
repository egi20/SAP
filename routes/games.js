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
/* Each topic challenge has its own colour; the daily games take theirs by position. */
const TOPIC_TONES = Object.freeze({ fiori: 10, hana: 11, sapphire: 12, aiagents: 13, memory: 4, lightning: 9, snake: 7 });
const hubOrdered = () => [...games.GAMES].sort((a, b) => {
  const ia = HUB_ORDER.indexOf(a.key);
  const ib = HUB_ORDER.indexOf(b.key);
  return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
});

function toneFor(game) {
  if (TOPIC_TONES[game.key]) return TOPIC_TONES[game.key];
  return (hubOrdered().filter((g) => !g.topic).findIndex((g) => g.key === game.key) % 7) + 3;
}

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
      gamesList: gamesList.filter((g) => !g.topic && !g.arcade),
      topicGames: gamesList.filter((g) => g.topic),
      arcadeGames: gamesList.filter((g) => g.arcade),
      toneFor,
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
  // A Memory board half-played before a reload: the cards already paired, so the page can lay them back.
  const mem = game.key === 'memory' && req.session.arcade && req.session.arcade.memory;
  const memoryProgress = mem && mem.board && !mem.done && mem.date === date
    ? { turns: mem.turns, matched: mem.matched.map((i) => ({ i, face: mem.board[i].face, side: mem.board[i].side })) }
    : null;
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
    // Arcade games need only the public shape (Memory: how many cards); the content arrives with each move.
    arcadeSet: game.arcade ? games.publicFormOf(game.key, set) : null,
    memoryProgress,
    // The card's colour on /games/challenges, carried onto the game's own page.
    tone: toneFor(game)
  });
}

/* ------------------------------------------------------------------ arcade games */
/*
 * Memory, Lightning and Snake keep their state in the player's SESSION — the board, the start
 * time, the locked answers — and these endpoints are the only way it moves. The browser says
 * what it did (this card, this answer, I am finished) and never what it scored. A first run
 * of the day is the attempt; once the day's attempt exists, a run is PRACTICE: the same game,
 * graded the same way, stored nowhere and paying nothing. Signed-in only: anonymous state would
 * need a session, and a session needs the one cookie, which is issued only to the signed-in.
 */
function arcade(key) {
  return [
    (req, res, next) => { req.game = games.gameOf(key); next(); },
    scoredNeedsAccount
  ];
}

function arcadeState(req, key, { fresh = false } = {}) {
  const date = games.serverDate();
  req.session.arcade = req.session.arcade || {};
  const current = req.session.arcade[key];
  if (fresh || !current || current.date !== date || current.done) {
    req.session.arcade[key] = { date, startedAt: Date.now(), done: false };
  }
  return req.session.arcade[key];
}

async function finishArcade(req, res, key, submitted) {
  const date = games.serverDate();
  const user = req.session.user;
  const state = req.session.arcade && req.session.arcade[key];
  if (state) state.done = true;
  const existing = await Game.attemptFor(user.id, key, date);
  if (existing) {
    const graded = games.grade(key, games.dailySetFor(key, date), submitted);
    return res.json({ practice: true, score: graded.score, total: graded.total });
  }
  const outcome = await Game.submit(user.id, key, submitted);
  return res.json({ practice: false, recorded: outcome.recorded, score: outcome.graded.score, total: outcome.graded.total, redirect: `/games/${key}` });
}

const asIndex = (raw, length) => (/^\d{1,3}$/.test(String(raw)) && Number(raw) < length ? Number(raw) : null);

/* Memory: a face is revealed one flip at a time; the server keeps the board and counts turns. */
router.post('/memory/flip', ...arcade('memory'), communityWritable, asyncHandler(async (req, res) => {
  let state = req.session.arcade && req.session.arcade.memory;
  if (!state || state.date !== games.serverDate() || state.done) {
    state = arcadeState(req, 'memory', { fresh: true });
  }
  if (!state.board) {
    state.board = games.memoryBoard(games.dailySetFor('memory', state.date));
    state.turns = 0;
    state.found = [];
    state.matched = [];
    state.open = null;
  }
  const i = asIndex(req.body.card, state.board.length);
  if (i === null) return res.status(400).json({ error: 'No such card.' });
  if (state.matched.includes(i)) return res.status(409).json({ error: 'That card is already matched.' });
  const card = state.board[i];
  if (state.open === null || state.open === i) {
    state.open = i;
    return res.json({ face: card.face, side: card.side });
  }
  const first = state.open;
  state.open = null;
  state.turns += 1;
  const match = state.board[first].pair === card.pair;
  if (match) {
    state.found.push(card.pair);
    state.matched.push(first, i);
  }
  return res.json({
    face: card.face, side: card.side, match, pair: [first, i],
    turns: state.turns, found: state.found.length, complete: state.found.length === games.MEMORY_PAIRS
  });
}));

router.post('/memory/finish', ...arcade('memory'), communityWritable, writeLimiter, asyncHandler(async (req, res) => {
  const state = req.session.arcade && req.session.arcade.memory;
  if (!state || !state.board) return res.status(400).json({ error: 'Flip a card first.' });
  return finishArcade(req, res, 'memory', { turns: state.turns, found: state.found.slice() });
}));

/* Lightning: the statements arrive with the START, which is when the server's clock starts. */
router.post('/lightning/start', ...arcade('lightning'), communityWritable, asyncHandler(async (req, res) => {
  const state = arcadeState(req, 'lightning');
  const set = games.dailySetFor('lightning', state.date);
  const elapsed = Math.floor((Date.now() - state.startedAt) / 1000);
  return res.json({ ...games.publicFormOf('lightning', set), remaining: Math.max(0, set.seconds - elapsed) });
}));

router.post('/lightning/finish', ...arcade('lightning'), communityWritable, writeLimiter, asyncHandler(async (req, res) => {
  const state = req.session.arcade && req.session.arcade.lightning;
  if (!state) return res.status(400).json({ error: 'Start the round first.' });
  // Only answers the server locked inside its own clock count; nothing in this body is read.
  return finishArcade(req, res, 'lightning', { ...(state.answers || {}) });
}));

/* Each answer is LOCKED as it is given, inside the server's clock; the reply says if it was right. */
router.post('/lightning/answer', ...arcade('lightning'), communityWritable, asyncHandler(async (req, res) => {
  const state = req.session.arcade && req.session.arcade.lightning;
  if (!state || state.done || state.date !== games.serverDate()) return res.status(400).json({ error: 'Start the round first.' });
  if (Date.now() - state.startedAt > (games.LIGHTNING_SECONDS + games.LIGHTNING_GRACE_SECONDS) * 1000) {
    return res.status(409).json({ error: 'Time is up.', timeUp: true });
  }
  const item = games.dailySetFor('lightning', state.date).items.find((i) => i.id === req.body.id);
  if (!item) return res.status(400).json({ error: 'No such statement.' });
  state.answers = state.answers || {};
  if (!Object.prototype.hasOwnProperty.call(state.answers, item.id)) {
    if (req.body.value !== 'true' && req.body.value !== 'false' && req.body.value !== true && req.body.value !== false) {
      return res.status(400).json({ error: 'True or false.' });
    }
    state.answers[item.id] = req.body.value === true || req.body.value === 'true';
  }
  return res.json({ correct: state.answers[item.id] === item.answer, truth: item.answer, meaning: item.meaning });
}));

/* Snake: every bite is locked by the server as it happens; the finish grades the locks. */
router.post('/snake/start', ...arcade('snake'), communityWritable, asyncHandler(async (req, res) => {
  const state = arcadeState(req, 'snake');
  state.choices = state.choices || {};
  const set = games.dailySetFor('snake', state.date);
  return res.json({ ...games.publicFormOf('snake', set), locked: Object.keys(state.choices) });
}));

router.post('/snake/eat', ...arcade('snake'), communityWritable, asyncHandler(async (req, res) => {
  const state = req.session.arcade && req.session.arcade.snake;
  if (!state || state.done || state.date !== games.serverDate()) return res.status(400).json({ error: 'Start a run first.' });
  const item = games.dailySetFor('snake', state.date).items.find((i) => i.id === req.body.id);
  if (!item) return res.status(400).json({ error: 'No such question.' });
  if (!Object.prototype.hasOwnProperty.call(state.choices, item.id)) {
    const chosen = asIndex(req.body.choice, item.options.length);
    if (chosen === null) return res.status(400).json({ error: 'No such answer.' });
    state.choices[item.id] = chosen;
  }
  const chosen = state.choices[item.id];
  return res.json({ correct: chosen === item.answer, answer: item.options[item.answer], explain: item.explain });
}));

router.post('/snake/finish', ...arcade('snake'), communityWritable, writeLimiter, asyncHandler(async (req, res) => {
  const state = req.session.arcade && req.session.arcade.snake;
  if (!state) return res.status(400).json({ error: 'Start a run first.' });
  return finishArcade(req, res, 'snake', { ...(state.choices || {}) });
}));

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
    // Practice games post nothing; arcade games finish through their own endpoints above.
    if (!req.game.scored || req.game.arcade) return res.redirect(`/games/${req.game.key}`);
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
