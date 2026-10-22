'use strict';

/**
 * The arcade games, played over HTTP the way the browser plays them: every move goes to the
 * server, the server keeps the state, and the score is the server's.
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');
const User = require('../../models/User');
const games = require('../../config/games');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const EMAIL = 'arcade-player@example.test';
const PASSWORD = 'Arcade-Player-1';
const CSRF = /name="_csrf" value="([^"]+)"/;
const META = /<meta name="csrf-token" content="([^"]+)"/;
let app;
let userId;

async function player() {
  const agent = request.agent(app);
  const page = await agent.get('/auth/login');
  await agent.post('/auth/login').type('form').send({ _csrf: page.text.match(CSRF)[1], email: EMAIL, password: PASSWORD });
  const token = (await agent.get('/games/challenges')).text.match(META)[1];
  const post = (path, body = {}) => agent.post(path).set('X-CSRF-Token', token).set('Sec-Fetch-Dest', 'empty')
    .set('Accept', 'application/json').send(body);
  return { agent, post };
}

beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');
  await promisePool.query('DELETE FROM users WHERE email = ?', [EMAIL]);
  const u = await User.create({ email: EMAIL, password: PASSWORD, name: 'Arcade Player', roles: ['consultant'] });
  await User.setEmailVerified(u.id);
  userId = u.id;
});

maybe()('arcade games', () => {
  it('asks a signed-out visitor to sign in, and lists the arcade first on Challenges', async () => {
    const res = await request(app).get('/games/snake');
    expect(res.status).toBe(302);
    const hub = await request(app).get('/games/challenges');
    expect(hub.text.indexOf('Arcade')).toBeLessThan(hub.text.indexOf('Topic challenges'));
  });

  it('Memory: faces come one flip at a time, and the score is the turns the server counted', async () => {
    const { post } = await player();
    const page = await (await player()).agent.get('/games/memory');
    expect(page.text).toContain('data-mem-grid');
    const set = games.dailySetFor('memory', games.serverDate());
    set.items.forEach((p) => expect(page.text).not.toContain(`>${p.meaning}<`));

    const faces = [];
    for (let i = 0; i < 12; i += 2) {
      // eslint-disable-next-line no-await-in-loop
      faces[i] = (await post('/games/memory/flip', { card: i })).body.face;
      // eslint-disable-next-line no-await-in-loop
      const second = (await post('/games/memory/flip', { card: i + 1 })).body;
      faces[i + 1] = second.face;
    }
    const meaningOf = Object.fromEntries(set.items.map((p) => [p.term, p.meaning]));
    const unmatched = new Set(faces.map((_, i) => i));
    // Pairs already turned up together by chance are matched; collect the rest.
    const pairOf = (i) => faces.findIndex((f, j) => j !== i && (meaningOf[faces[i]] === f || meaningOf[f] === faces[i]));
    let last;
    for (let i = 0; i < 12; i += 1) {
      const j = pairOf(i);
      if (!unmatched.has(i) || (i % 2 === 0 && j === i + 1)) { unmatched.delete(i); unmatched.delete(j); continue; }
      // eslint-disable-next-line no-await-in-loop
      await post('/games/memory/flip', { card: i });
      // eslint-disable-next-line no-await-in-loop
      last = (await post('/games/memory/flip', { card: j })).body;
      unmatched.delete(i);
      unmatched.delete(j);
    }
    expect(last.complete).toBe(true);
    const done = (await post('/games/memory/finish')).body;
    expect(done.practice).toBe(false);
    expect(done.score).toBe(games.memoryScore(last.turns, 6));

    const [[row]] = await promisePool.query("SELECT score, total FROM game_attempts WHERE user_id = ? AND game = 'memory'", [userId]);
    expect(row).toEqual({ score: done.score, total: 6 });

    // A second run the same day is practice: graded, never stored.
    await post('/games/memory/flip', { card: 0 });
    await post('/games/memory/flip', { card: 1 });
    const again = (await post('/games/memory/finish')).body;
    expect(again.practice).toBe(true);
    const [[{ n }]] = await promisePool.query("SELECT COUNT(*) AS n FROM game_attempts WHERE user_id = ? AND game = 'memory'", [userId]);
    expect(n).toBe(1);
  });

  it('Lightning: the statements arrive with the start, each answer is locked once, the body is never read', async () => {
    const { post } = await player();
    const start = (await post('/games/lightning/start')).body;
    expect(start.items).toHaveLength(16);
    expect(JSON.stringify(start)).not.toMatch(/"answer"/);
    const set = games.dailySetFor('lightning', games.serverDate());
    for (const item of set.items) {
      // eslint-disable-next-line no-await-in-loop
      const r = (await post('/games/lightning/answer', { id: item.id, value: String(item.answer) })).body;
      expect(r.correct).toBe(true);
    }
    // Changing an answer after it was locked changes nothing.
    const flip = (await post('/games/lightning/answer', { id: set.items[0].id, value: String(!set.items[0].answer) })).body;
    expect(flip.correct).toBe(true);
    const done = (await post('/games/lightning/finish', { answers: {}, score: 0 })).body;
    expect(done.score).toBe(16);
  });

  it('Snake: a bite is locked by the server, and the finish grades the locks', async () => {
    const { post } = await player();
    const start = (await post('/games/snake/start')).body;
    expect(start.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(start)).not.toMatch(/"answer"/);
    const set = games.dailySetFor('snake', games.serverDate());
    const first = set.items[0];
    const wrong = (first.answer + 1) % first.options.length;
    const bite = (await post('/games/snake/eat', { id: first.id, choice: wrong })).body;
    expect(bite.correct).toBe(false);
    expect(bite.answer).toBe(first.options[first.answer]);
    const retry = (await post('/games/snake/eat', { id: first.id, choice: first.answer })).body;
    expect(retry.correct).toBe(false);
    const second = set.items[1];
    expect((await post('/games/snake/eat', { id: second.id, choice: second.answer })).body.correct).toBe(true);
    const done = (await post('/games/snake/finish')).body;
    expect(done.score).toBe(1);
    expect(done.total).toBe(set.items.length);
  });
});
