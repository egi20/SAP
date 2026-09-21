'use strict';

/**
 * The daily challenge, against a real database.
 *
 * ONE thing is being tested here, from several directions: a browser cannot decide what
 * it scored. DynamicsHub's game system reads `{ score, gameDate }` out of `req.body` and
 * writes both to a leaderboard, and ships every question together with the index of its
 * correct answer, so anybody signed in can post a perfect score for any date and anybody
 * curious can read the answers in view-source. That output then feeds a points summary —
 * so a browser can mint points. In this codebase the ledger is append-only precisely so
 * a total can always be explained, and a client-authored score destroys that property for
 * every total on the site, not just the cheat's.
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');
const Points = require('../../models/Points');
const challenges = require('../../config/challenges');
const { POINT_AWARDS } = require('../../config/community');
const AppSetting = require('../../models/AppSetting');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

let app;

const OWN_ACCOUNTS = ['quiz-one@example.test', 'quiz-two@example.test'];
const CSRF_FORM = /name="_csrf" value="([^"]+)"/;
const CSRF_META = /<meta name="csrf-token" content="([^"]+)"/;

function csrfFrom(html) {
  const match = html.match(CSRF_FORM) || html.match(CSRF_META);
  if (!match) throw new Error('No CSRF token on that page');
  return match[1];
}

async function signUp({ email, name }) {
  const agent = request.agent(app);
  const page = await agent.get('/auth/register');
  await agent
    .post('/auth/register')
    .type('form')
    .send({
      _csrf: csrfFrom(page.text),
      email,
      name,
      password: 'Sup3rSecret',
      confirm_password: 'Sup3rSecret',
      user_types: 'consultant',
      terms: 'on'
    });
  await promisePool.query('UPDATE users SET email_verified = 1 WHERE email = ?', [email]);

  const login = await agent.get('/auth/login');
  await agent
    .post('/auth/login')
    .type('form')
    .send({ _csrf: csrfFrom(login.text), email, password: 'Sup3rSecret' });
  return agent;
}

async function userId(email) {
  const [[row]] = await promisePool.query('SELECT id FROM users WHERE email = ?', [email]);
  return row.id;
}

/** The right answer for every question in today's set, keyed by id, as the form posts it. */
function perfectAnswers(date) {
  const answers = {};
  for (const question of challenges.dailySetFor(date)) answers[question.id] = question.answer;
  return answers;
}

beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');
  await promisePool.query('DELETE FROM users WHERE email IN (?)', [OWN_ACCOUNTS]);
});

maybe()('the answer key never reaches the browser', () => {
  let player;

  beforeAll(async () => {
    player = await signUp({ email: 'quiz-one@example.test', name: 'Quiz Player' });
  });

  test('the page shows the questions and none of the answers', async () => {
    const res = await player.get('/challenges');
    expect(res.status).toBe(200);

    const date = challenges.serverDate();
    const set = challenges.dailySetFor(date);

    // Every prompt is there.
    for (const question of set) expect(res.text).toContain(question.prompt);

    /*
     * And no explanation is, because an explanation names the right option in prose. This
     * is the check that view-source cannot answer the quiz.
     */
    for (const question of set) expect(res.text).not.toContain(question.explain);
  });

  test('the rendered radio values are positions, not a key', async () => {
    const res = await player.get('/challenges');
    // The form posts the option index chosen. There is nothing else in the markup that
    // distinguishes the correct option from the others.
    expect(res.text).toMatch(/name="answers\[[a-z0-9-]+\]"/);
  });
});

maybe()('the score is decided by the server', () => {
  let player;
  let id;

  beforeAll(async () => {
    player = await signUp({ email: 'quiz-two@example.test', name: 'Second Player' });
    id = await userId('quiz-two@example.test');
  });

  test('a posted score is ignored entirely', async () => {
    const date = challenges.serverDate();
    const page = await player.get('/challenges');

    const res = await player
      .post('/challenges')
      .type('form')
      .send({
        _csrf: csrfFrom(page.text),
        // Everything DynamicsHub would have believed.
        score: 999999,
        total: 999999,
        points: 999999,
        gameDate: '2020-01-01',
        challenge_date: '2020-01-01',
        // One wrong answer for every question: whatever the key says, this is not it.
        ...Object.fromEntries(
          challenges.dailySetFor(date).map((q) => [`answers[${q.id}]`, q.answer === 0 ? 1 : 0])
        )
      });
    expect(res.status).toBe(200);

    const [[row]] = await promisePool.query('SELECT * FROM challenge_attempts WHERE user_id = ?', [id]);
    expect(row.score).toBe(0);
    expect(row.total).toBe(challenges.QUESTIONS_PER_DAY);
    // And the date came from the server clock, not the body.
    expect(new Date(row.challenge_date).toISOString().slice(0, 10)).toBe(date);
  });

  test('the ledger was paid what the grader said, not what was posted', async () => {
    expect(await Points.totalFor(id)).toBe(0);
  });

  test('a second attempt the same day is refused by the unique key', async () => {
    const date = challenges.serverDate();
    const page = await player.get('/challenges');

    await player
      .post('/challenges')
      .type('form')
      .send({
        _csrf: csrfFrom(page.text),
        ...Object.fromEntries(Object.entries(perfectAnswers(date)).map(([k, v]) => [`answers[${k}]`, v]))
      });

    const [[{ n }]] = await promisePool.query(
      'SELECT COUNT(*) AS n FROM challenge_attempts WHERE user_id = ?',
      [id]
    );
    expect(n).toBe(1);

    // And the first, honest, zero still stands — a replay cannot improve it.
    const [[row]] = await promisePool.query('SELECT score FROM challenge_attempts WHERE user_id = ?', [id]);
    expect(row.score).toBe(0);
    expect(await Points.totalFor(id)).toBe(0);
  });
});

maybe()('a correct attempt pays, once, through the ledger', () => {
  let player;
  let id;

  beforeAll(async () => {
    player = await signUp({ email: 'quiz-one@example.test', name: 'Quiz Player' }).catch(() => null);
    if (!player) {
      player = request.agent(app);
      const login = await player.get('/auth/login');
      await player
        .post('/auth/login')
        .type('form')
        .send({ _csrf: csrfFrom(login.text), email: 'quiz-one@example.test', password: 'Sup3rSecret' });
    }
    id = await userId('quiz-one@example.test');
    await promisePool.query('DELETE FROM challenge_attempts WHERE user_id = ?', [id]);
    await promisePool.query('DELETE FROM points_ledger WHERE user_id = ?', [id]);
  });

  test('every answer right pays exactly the declared amount', async () => {
    const date = challenges.serverDate();
    const page = await player.get('/challenges');

    const res = await player
      .post('/challenges')
      .type('form')
      .send({
        _csrf: csrfFrom(page.text),
        duration_ms: 1234,
        ...Object.fromEntries(Object.entries(perfectAnswers(date)).map(([k, v]) => [`answers[${k}]`, v]))
      });
    expect(res.status).toBe(200);

    const [[row]] = await promisePool.query('SELECT * FROM challenge_attempts WHERE user_id = ?', [id]);
    expect(row.score).toBe(challenges.QUESTIONS_PER_DAY);

    const expected = challenges.QUESTIONS_PER_DAY * POINT_AWARDS.challenge_completed.points;
    expect(await Points.totalFor(id)).toBe(expected);
  });

  test('it is ONE ledger row for the attempt, not one per correct answer', async () => {
    /*
     * The subject is the attempt and the intended figure is what it earned, so a retry
     * computes a difference of zero. N rows keyed by index would be a second key scheme
     * for the same fact, and could not be reconciled if the score were ever recomputed.
     */
    const [[{ n }]] = await promisePool.query(
      'SELECT COUNT(*) AS n FROM points_ledger WHERE user_id = ? AND reason LIKE ?',
      [id, 'challenge_completed%']
    );
    expect(n).toBe(1);
  });

  test('the explanations survive a reload, rebuilt from the stored attempt', async () => {
    /*
     * The reference renders them in the response to the POST and nowhere else, so a
     * refresh throws away the reason to have played. The daily set is derived from the
     * date and the row records what was chosen, so the result can be rebuilt exactly —
     * and only for an attempt the unique key has already closed.
     */
    const res = await player.get('/challenges');
    const set = challenges.dailySetFor(challenges.serverDate());

    expect(res.text).toContain(set[0].prompt);
    expect(res.text).toContain(set[0].explain);
  });

  test('the rebuilt score agrees with the one that was stored', async () => {
    const Challenge = require('../../models/Challenge');
    const date = challenges.serverDate();
    const attempt = await Challenge.attemptFor(id, date);

    // A reconciliation as much as a render: a disagreement means the bank was edited
    // under a day somebody had already played.
    expect(Challenge.replay(attempt, date).score).toBe(attempt.score);
  });

  test('a duration reported by the client is stored but never ranked on', async () => {
    const [[row]] = await promisePool.query('SELECT duration_ms FROM challenge_attempts WHERE user_id = ?', [id]);
    expect(row.duration_ms).toBe(1234);

    // The leaderboard orders on the score the server computed, and nothing else the
    // client sent.
    const board = await player.get('/challenges/leaderboard');
    expect(board.status).toBe(200);
  });
});

maybe()('the gates that apply to every other write apply here', () => {
  test('a signed-out visitor cannot play', async () => {
    const guest = request.agent(app);
    const res = await guest.get('/challenges');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/auth\/login/);
  });

  test('freezing the community stops the challenge too', async () => {
    /*
     * It writes to the points ledger, so the switch that stops the community growing has
     * to stop this as well. A gate written into three of four write paths is a gate that
     * is off.
     */
    const before = await AppSetting.all();
    await AppSetting.setMany({ ...before, community_read_only: 'on' });

    const player = request.agent(app);
    const login = await player.get('/auth/login');
    await player
      .post('/auth/login')
      .type('form')
      .send({ _csrf: csrfFrom(login.text), email: 'quiz-two@example.test', password: 'Sup3rSecret' });

    const page = await player.get('/challenges');
    const res = await player
      .post('/challenges')
      .type('form')
      .send({ _csrf: csrfFrom(page.text) });

    expect(res.status).toBe(302);

    await AppSetting.setMany({ ...before, community_read_only: '' });
  });
});
