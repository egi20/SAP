'use strict';

/**
 * The SAP games as served: a scored game is graded on the server, paid once, and played
 * once a day; the page before grading carries no key; practice games are open to anyone.
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');
const User = require('../../models/User');
const games = require('../../config/games');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const PLAYER = 'games-player@example.test';
const PASSWORD = 'Games-Player-Pass-1';
const CSRF = /name="_csrf" value="([^"]+)"/;

let app;

// The page escapes what it prints; compare against that, as the challenge tests do.
const asRendered = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&#34;').replace(/'/g, '&#39;');
let playerId;

async function signIn() {
  const agent = request.agent(app);
  const page = await agent.get('/auth/login');
  await agent.post('/auth/login').type('form').send({ _csrf: page.text.match(CSRF)[1], email: PLAYER, password: PASSWORD });
  return agent;
}

beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');
  await promisePool.query('DELETE FROM users WHERE email = ?', [PLAYER]);
  const u = await User.create({ email: PLAYER, password: PASSWORD, name: 'Games Player', roles: ['consultant'] });
  await User.setEmailVerified(u.id);
  playerId = u.id;
});

maybe()('a scored game', () => {
  it('asks a signed-out visitor to sign in', async () => {
    const res = await request(app).get('/games/scenario');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/login/);
  });

  it('shows the set without its answers, grades it on the server, pays once and refuses a second go', async () => {
    const agent = await signIn();
    const page = await agent.get('/games/scenario');
    expect(page.status).toBe(200);
    const set = games.dailySetFor('scenario', games.serverDate());
    set.items.forEach((item) => expect(page.text).not.toContain(asRendered(item.explain)));

    const body = { _csrf: page.text.match(CSRF)[1] };
    set.items.forEach((item) => { body[`answers[${item.id}]`] = String(item.answer); });
    body.score = '999';
    const res = await agent.post('/games/scenario').type('form').send(body);
    expect(res.status).toBe(200);
    expect(res.text).toContain(`${set.items.length} / ${set.items.length}`);
    expect(res.text).toContain(asRendered(set.items[0].explain));

    const [[row]] = await promisePool.query("SELECT score, total FROM game_attempts WHERE user_id = ? AND game = 'scenario'", [playerId]);
    expect(row).toEqual({ score: set.items.length, total: set.items.length });
    const [[paid]] = await promisePool.query("SELECT COALESCE(SUM(points), 0) AS p FROM points_ledger WHERE user_id = ? AND reason LIKE 'game_completed%'", [playerId]);
    expect(Number(paid.p)).toBe(2);

    const again = await agent.post('/games/scenario').type('form').send({ _csrf: page.text.match(CSRF)[1] });
    expect(again.status).toBe(302);
    const [[{ n }]] = await promisePool.query("SELECT COUNT(*) AS n FROM game_attempts WHERE user_id = ? AND game = 'scenario'", [playerId]);
    expect(n).toBe(1);

    const reload = await agent.get('/games/scenario');
    expect(reload.text).toContain(asRendered(set.items[0].explain));
  });

  it('marks a word search typed in lower case and with a stray space', async () => {
    const agent = await signIn();
    const page = await agent.get('/games/wordsearch');
    const set = games.dailySetFor('wordsearch', games.serverDate());
    const body = { _csrf: page.text.match(CSRF)[1] };
    set.items.forEach((item) => { body[`answers[${item.id}]`] = ` ${item.word.toLowerCase()}`; });
    const res = await agent.post('/games/wordsearch').type('form').send(body);
    expect(res.text).toContain(`${set.items.length} / ${set.items.length}`);
  });
});

maybe()('a topic challenge', () => {
  it('is graded on the server, pays, names its sources after grading, offers a LinkedIn share and lands on Today\'s Rankings', async () => {
    const agent = await signIn();
    const page = await agent.get('/games/sapphire');
    expect(page.status).toBe(200);
    expect(page.text).toContain('data-mcq-step');
    const set = games.dailySetFor('sapphire', games.serverDate());
    set.items.forEach((item) => expect(page.text).not.toContain(item.source));

    const body = { _csrf: page.text.match(CSRF)[1] };
    set.items.forEach((item) => { body[`answers[${item.id}]`] = String(item.answer); });
    const res = await agent.post('/games/sapphire').type('form').send(body);
    expect(res.status).toBe(200);
    expect(res.text).toContain(`${set.items.length} / ${set.items.length}`);
    expect(res.text).toContain(set.items[0].source);
    expect(res.text).toContain('https://www.linkedin.com/feed/?shareActive=true&amp;text=');
    // The shared text carries the score and a link, never an answer.
    const shared = decodeURIComponent(res.text.match(/shareActive=true&amp;text=([^"]+)"/)[1]);
    expect(shared).toContain(`${set.items.length}/${set.items.length}`);
    expect(shared).toContain('/games/challenges');
    set.items.forEach((item) => expect(shared).not.toContain(item.options[item.answer]));

    const [[paid]] = await promisePool.query("SELECT COALESCE(SUM(points), 0) AS p FROM points_ledger WHERE user_id = ? AND dedupe_key LIKE 'game:sapphire:%'", [playerId]);
    expect(Number(paid.p)).toBe(2);

    const hub = await agent.get('/games/challenges');
    expect(hub.text).toContain('Topic challenges');
    expect(hub.text).toContain('Games Player');
  });
});

maybe()('practice games and the hub', () => {
  it('opens flashcards and typing for anybody, and the hub lists every game', async () => {
    expect((await request(app).get('/games/flashcards')).status).toBe(200);
    expect((await request(app).get('/games/typing')).status).toBe(200);
    const old = await request(app).get('/games');
    expect(old.status).toBe(301);
    expect(old.headers.location).toBe('/games/challenges');
    const hub = await request(app).get('/games/challenges');
    expect(hub.status).toBe(200);
    expect(hub.text).toContain('href="/challenges"');
    expect(hub.text).toContain("Today's Rankings");
    games.GAMES.forEach((g) => expect(hub.text).toContain(`/games/${g.key}`));
  });

  it('answers 404 for a game that does not exist', async () => {
    expect((await request(app).get('/games/nope')).status).toBe(404);
  });
});
