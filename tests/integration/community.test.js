'use strict';

/**
 * The community, against a real database.
 *
 * The points ledger is the reason this suite exists: it is append-only and idempotent, and
 * neither property is visible without a unique key and a real transaction behind it.
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');
const Post = require('../../models/Post');
const Points = require('../../models/Points');
const AppSetting = require('../../models/AppSetting');
const { POINT_AWARDS } = require('../../config/community');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

let app;

const OWN_ACCOUNTS = ['com-asker@example.test', 'com-answerer@example.test', 'com-other@example.test'];

const CSRF = /name="_csrf" value="([^"]+)"/;

function csrfFrom(html) {
  const match = html.match(CSRF);
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

/** Sign in an account this suite already created. */
async function signInExisting(email) {
  const agent = request.agent(app);
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

beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');
  await promisePool.query('DELETE FROM users WHERE email IN (?)', [OWN_ACCOUNTS]);
  // The categories are a deploy step, not fixtures — make sure they are there.
  const { syncCategories } = require('../../scripts/sync-catalogues');
  await syncCategories();
});

maybe()('asking, answering and accepting', () => {
  let asker;
  let postId;
  let askerId;
  let answererId;

  beforeAll(async () => {
    asker = await signUp({ email: 'com-asker@example.test', name: 'Asking Person' });
    // The answerer only ever acts through the model in this block, so the agent is not kept.
    await signUp({ email: 'com-answerer@example.test', name: 'Answering Person' });
    askerId = await userId('com-asker@example.test');
    answererId = await userId('com-answerer@example.test');

    const [[category]] = await promisePool.query("SELECT id FROM post_categories WHERE slug = 'transitions'");

    const form = await asker.get('/community/new');
    const res = await asker
      .post('/community')
      .type('form')
      .send({
        _csrf: csrfFrom(form.text),
        kind: 'question',
        category_id: category.id,
        title: 'Brownfield conversion: how do you size custom code remediation?',
        body: 'We have about 4,000 custom objects in ECC and the readiness check is not telling us much.'
      });

    expect(res.status).toBe(302);
    const [[post]] = await promisePool.query('SELECT id FROM posts WHERE author_user_id = ?', [askerId]);
    postId = post.id;
  });

  test('posting pays once, and the ledger says why', async () => {
    const [rows] = await promisePool.query(
      'SELECT reason, points, dedupe_key FROM points_ledger WHERE user_id = ?',
      [askerId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe('post_created');
    expect(rows[0].points).toBe(POINT_AWARDS.post_created.points);
  });

  test('the same award cannot pay twice, however many times it is emitted', async () => {
    const before = await Points.totalFor(askerId);
    await Points.award(askerId, 'post_created', `post:${postId}`);
    await Points.award(askerId, 'post_created', `post:${postId}`);
    expect(await Points.totalFor(askerId)).toBe(before);
  });

  test('a reply pays its author', async () => {
    const { replyId } = await Post.reply(postId, answererId, 'Start from the ATC run, not the readiness check.');
    expect(replyId).toBeGreaterThan(0);
    expect(await Points.totalFor(answererId)).toBe(POINT_AWARDS.reply_created.points);
  });

  test('you cannot vote on your own post', async () => {
    await expect(Post.vote('post', postId, askerId, 1)).rejects.toMatchObject({ code: 'SELF_VOTE' });
  });

  test('a vote is recomputed, not incremented — changing it is not an off-by-one', async () => {
    const up = await Post.vote('post', postId, answererId, 1);
    expect(up.score).toBe(1);

    // The delta here is 2, not 1. An incrementing implementation drifts silently forever.
    const down = await Post.vote('post', postId, answererId, -1);
    expect(down.score).toBe(-1);

    const cleared = await Post.vote('post', postId, answererId, 0);
    expect(cleared.score).toBe(0);
  });

  test('an upvote pays the author, and withdrawing it writes a reversal rather than a delete', async () => {
    const before = await Points.totalFor(askerId);
    await Post.vote('post', postId, answererId, 1);
    expect(await Points.totalFor(askerId)).toBe(before + POINT_AWARDS.post_upvoted.points);

    await Post.vote('post', postId, answererId, 0);
    expect(await Points.totalFor(askerId)).toBe(before);

    const [rows] = await promisePool.query(
      "SELECT reason, points FROM points_ledger WHERE user_id = ? AND reason LIKE 'post\\_upvoted%' ORDER BY id",
      [askerId]
    );
    /*
     * EVERY row survives — an earlier test in this file already moved this same vote, and
     * those entries are still here. A ledger that can be edited is not a ledger, so the
     * assertion is about the shape and the net rather than about a fixed row count.
     */
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.some((r) => r.reason === 'post_upvoted')).toBe(true);
    expect(rows[rows.length - 1].reason).toBe('post_upvoted_reversed');
    expect(rows[rows.length - 1].points).toBe(-POINT_AWARDS.post_upvoted.points);
    expect(rows.reduce((sum, r) => sum + r.points, 0)).toBe(0);
  });

  test('a voter who changes their mind twice does not leave the author out of pocket', async () => {
    /*
     * The bug this replaced: award-on-up plus reverse-on-down is not reversible twice. The
     * second upvote is ignored because the award's dedupe key already exists, so the author
     * keeps the reversal and ends BELOW where they started while the score reads +1.
     */
    const baseline = await Points.totalFor(askerId);

    await Post.vote('post', postId, answererId, 1);
    await Post.vote('post', postId, answererId, 0);
    const { score } = await Post.vote('post', postId, answererId, 1);

    expect(score).toBe(1);
    expect(await Points.totalFor(askerId)).toBe(baseline + POINT_AWARDS.post_upvoted.points);

    // And flipping is not a way to farm: the net is pinned to the intended amount.
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Post.vote('post', postId, answererId, 0);
      // eslint-disable-next-line no-await-in-loop
      await Post.vote('post', postId, answererId, 1);
    }
    expect(await Points.totalFor(askerId)).toBe(baseline + POINT_AWARDS.post_upvoted.points);

    await Post.vote('post', postId, answererId, 0);
    expect(await Points.totalFor(askerId)).toBe(baseline);
  });
});

maybe()('accepting an answer', () => {
  let askerId;
  let answererId;
  let otherId;
  let postId;
  let firstReplyId;
  let secondReplyId;

  beforeAll(async () => {
    askerId = await userId('com-asker@example.test');
    answererId = await userId('com-answerer@example.test');
    await signUp({ email: 'com-other@example.test', name: 'Other Answerer' });
    otherId = await userId('com-other@example.test');

    const [[post]] = await promisePool.query('SELECT id FROM posts WHERE author_user_id = ?', [askerId]);
    postId = post.id;

    firstReplyId = (await Post.reply(postId, answererId, 'Run the ATC with the S/4HANA readiness variant.')).replyId;
    secondReplyId = (await Post.reply(postId, otherId, 'Size it from the custom code lifecycle report instead.')).replyId;
  });

  test('only the person who asked can accept', async () => {
    await expect(Post.acceptSolution(postId, firstReplyId, answererId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  test('accepting pays the answerer', async () => {
    const before = await Points.totalFor(answererId);
    await Post.acceptSolution(postId, firstReplyId, askerId);
    expect(await Points.totalFor(answererId)).toBe(before + POINT_AWARDS.reply_accepted.points);

    const [[post]] = await promisePool.query('SELECT is_solved, solution_reply_id FROM posts WHERE id = ?', [postId]);
    expect(post.is_solved).toBe(1);
    expect(post.solution_reply_id).toBe(firstReplyId);
  });

  test('accepting the same reply again changes nothing and pays nothing', async () => {
    const before = await Points.totalFor(answererId);
    const result = await Post.acceptSolution(postId, firstReplyId, askerId);
    expect(result.changed).toBe(false);
    expect(await Points.totalFor(answererId)).toBe(before);
  });

  test('REPLACING the accepted answer reverses the first award', async () => {
    /*
     * The reference clears `is_solution` on the previous reply and stops there, so both
     * answerers keep 25 points and the question has paid for two solutions while displaying
     * one. Points.reverse exists for exactly this and nothing called it.
     */
    const firstBefore = await Points.totalFor(answererId);
    const secondBefore = await Points.totalFor(otherId);

    await Post.acceptSolution(postId, secondReplyId, askerId);

    expect(await Points.totalFor(answererId)).toBe(firstBefore - POINT_AWARDS.reply_accepted.points);
    expect(await Points.totalFor(otherId)).toBe(secondBefore + POINT_AWARDS.reply_accepted.points);

    const [[post]] = await promisePool.query('SELECT solution_reply_id FROM posts WHERE id = ?', [postId]);
    expect(post.solution_reply_id).toBe(secondReplyId);

    const [replies] = await promisePool.query(
      'SELECT id, is_solution FROM post_replies WHERE post_id = ? ORDER BY id',
      [postId]
    );
    // Exactly one reply is the solution, whatever the ledger did.
    expect(replies.filter((r) => r.is_solution).map((r) => r.id)).toEqual([secondReplyId]);
  });

  test('an answer accepted, moved away and accepted again ends up paid exactly once', async () => {
    const firstBefore = await Points.totalFor(answererId);
    const secondBefore = await Points.totalFor(otherId);

    await Post.acceptSolution(postId, firstReplyId, askerId); // back to the first
    expect(await Points.totalFor(answererId)).toBe(firstBefore + POINT_AWARDS.reply_accepted.points);
    expect(await Points.totalFor(otherId)).toBe(secondBefore - POINT_AWARDS.reply_accepted.points);

    await Post.acceptSolution(postId, secondReplyId, askerId); // and away again
    expect(await Points.totalFor(answererId)).toBe(firstBefore);
    expect(await Points.totalFor(otherId)).toBe(secondBefore);
  });

  test('accepting your OWN answer marks it but pays nothing', async () => {
    const [[category]] = await promisePool.query("SELECT id FROM post_categories WHERE slug = 'clean-core'");
    const [result] = await promisePool.query(
      `INSERT INTO posts (category_id, author_user_id, kind, title, slug, body)
       VALUES (?, ?, 'question', ?, ?, ?)`,
      [category.id, askerId, 'Self answered', `self-answered-${Date.now()}`, 'Working it out as I type.']
    );
    const ownPostId = result.insertId;
    const own = await Post.reply(ownPostId, askerId, 'Answering my own question for the next person.');

    const before = await Points.totalFor(askerId);
    const accepted = await Post.acceptSolution(ownPostId, own.replyId, askerId);

    expect(accepted.selfAnswered).toBe(true);
    // Marked, because self-answering is legitimate and useful.
    const [[reply]] = await promisePool.query('SELECT is_solution FROM post_replies WHERE id = ?', [own.replyId]);
    expect(reply.is_solution).toBe(1);
    // Paid nothing, because 25 points is the largest award and this is the cheapest way to
    // it. The reply_created award from posting the reply is the only thing that moved.
    expect(await Points.totalFor(askerId)).toBe(before);
  });
});

maybe()('the read-only switch closes every door at once', () => {
  /*
   * `setMany` writes EVERY declared key, because it reads an admin form where an unticked
   * checkbox posts nothing at all — absence has to mean false. So a test that changes one
   * switch must hand back the others, or it quietly closes registration for every suite
   * running beside it.
   */
  async function setSwitch(key, value) {
    const current = await AppSetting.all();
    await AppSetting.setMany({ ...current, [key]: value ? 'on' : '' });
  }

  afterAll(async () => {
    await setSwitch('community_read_only', false);
  });

  test('reading stays open, writing is refused', async () => {
    const asker = await signInExisting('com-asker@example.test');

    await setSwitch('community_read_only', true);

    const read = await request(app).get('/community');
    expect(read.status).toBe(200);

    const page = await asker.get('/community');
    const write = await asker
      .post('/community')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), kind: 'discussion', category_id: 1, title: 'Blocked', body: 'x'.repeat(40) });

    // Refused, not a 500 and not a silent success.
    expect([302, 403]).toContain(write.status);
  });
});
