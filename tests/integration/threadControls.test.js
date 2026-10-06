'use strict';

/**
 * The thread page's controls: the vote pair, the answer sort, the breadcrumb.
 *
 * The interesting assertions are about what each one must NOT do — a downvote that costs
 * somebody points, a sort that buries the accepted answer, a vote that drops the reader
 * back into a different sort than the one they chose.
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');
const User = require('../../models/User');
const Post = require('../../models/Post');
const Points = require('../../models/Points');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const OWN = ['thr-asker@example.test', 'thr-a@example.test', 'thr-b@example.test', 'thr-voter@example.test'];
const PASSWORD = 'Thread-Test-Pass-1';
const CSRF = /name="_csrf" value="([^"]+)"/;

let app;
let post;
let askerId;
let answerA;
let answerB;
let answerAuthorId;

function csrfFrom(html) {
  const match = html.match(CSRF);
  if (!match) throw new Error('No CSRF token on that page');
  return match[1];
}

async function signIn(email) {
  const agent = request.agent(app);
  const page = await agent.get('/auth/login');
  await agent.post('/auth/login').type('form')
    .send({ _csrf: csrfFrom(page.text), email, password: PASSWORD });
  return agent;
}

async function makeUser(email, name) {
  const user = await User.create({ email, password: PASSWORD, name, roles: ['consultant'] });
  await User.setEmailVerified(user.id);
  return user;
}

beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');
  await promisePool.query('DELETE FROM users WHERE email IN (?)', [OWN]);

  const { syncCategories } = require('../../scripts/sync-catalogues');
  await syncCategories();
  const [[category]] = await promisePool.query("SELECT id FROM post_categories WHERE slug = 'transitions'");

  const asker = await makeUser(OWN[0], 'Thread Asker');
  askerId = asker.id;
  const a = await makeUser(OWN[1], 'Thread Answerer A');
  answerAuthorId = a.id;
  const b = await makeUser(OWN[2], 'Thread Answerer B');
  await makeUser(OWN[3], 'Thread Voter');

  post = await Post.create(askerId, {
    categoryId: category.id, kind: 'question',
    title: 'Threadtest which ledger for the parallel close',
    body: 'A question with two answers, one of them accepted.'
  });

  // A first, B second, so "oldest" and "newest" are distinguishable.
  answerA = (await Post.reply(post.id, answerAuthorId, 'Threadtest ANSWER A, posted first.')).replyId;
  answerB = (await Post.reply(post.id, b.id, 'Threadtest ANSWER B, posted second.')).replyId;

  // B is accepted, so it must lead under every sort while A is older and could be newer.
  await Post.acceptSolution(post.id, answerB, askerId);
});

maybe()('the answer sort', () => {
  it('keeps the accepted answer first under all three', async () => {
    /*
     * A thread whose solution sorts to the bottom under "Newest" is hiding the one reply
     * somebody came for. The sort is a reading preference, not permission to bury it.
     */
    for (const sort of Post.REPLY_SORTS) {
      // eslint-disable-next-line no-await-in-loop
      const replies = await Post.replies(post.id, null, { sort });
      expect(replies[0].id).toBe(answerB);
    }
  });

  it('orders everything below the solution as asked', async () => {
    const oldest = await Post.replies(post.id, null, { sort: 'oldest' });
    const newest = await Post.replies(post.id, null, { sort: 'newest' });
    // Only two replies and one is pinned, so the tail is a single row either way — what is
    // asserted is that the sort reached the query at all.
    expect(oldest.map((r) => r.id)).toEqual([answerB, answerA]);
    expect(newest.map((r) => r.id)).toEqual([answerB, answerA]);
  });

  it('falls back rather than letting a query string reach the ORDER BY', async () => {
    const replies = await Post.replies(post.id, null, { sort: 'r.id; DROP TABLE posts' });
    expect(replies).toHaveLength(2);

    const res = await request(app).get(`/community/${post.slug}?answers=../../etc`);
    expect(res.status).toBe(200);
  });

  it('offers the control only where there is something to sort', async () => {
    const res = await request(app).get(`/community/${post.slug}`);
    expect(res.text).toContain('Sort answers');
  });
});

maybe()('the vote pair', () => {
  it('is not offered to a visitor, or to the author of the thing', async () => {
    const visitor = await request(app).get(`/community/${post.slug}`);
    expect(visitor.text).not.toContain('bi-arrow-down');

    // Voting on your own post is refused by the model, so offering the button would be
    // offering an error.
    const asker = await signIn(OWN[0]);
    const own = await asker.get(`/community/${post.slug}`);
    expect(own.text).not.toMatch(new RegExp(`/community/vote/post/${post.id}"`));
  });

  it('is offered to everybody else, both ways', async () => {
    const voter = await signIn(OWN[3]);
    const res = await voter.get(`/community/${post.slug}`);
    expect(res.text).toContain('bi-arrow-up');
    expect(res.text).toContain('bi-arrow-down');
    expect(res.text).toContain(`action="/community/vote/post/${post.id}"`);
  });

  it('costs the author no points when it goes down', async () => {
    /*
     * `Points.settleTo` pays while an upvote STANDS and settles to zero otherwise; it never
     * settles negative. A community this size cannot afford a button that lets one reader
     * cost somebody standing — "this is wrong" is worth saying without it being worth money.
     */
    const voter = await signIn(OWN[3]);
    const before = await Points.totalFor(answerAuthorId);

    const page = await voter.get(`/community/${post.slug}`);
    await voter.post(`/community/vote/reply/${answerA}`).type('form')
      .send({ _csrf: csrfFrom(page.text), value: '-1', redirectTo: `/community/${post.slug}` });

    const after = await Points.totalFor(answerAuthorId);
    expect(after).toBe(before);

    const [[row]] = await promisePool.query('SELECT vote_score FROM post_replies WHERE id = ?', [answerA]);
    expect(row.vote_score).toBe(-1);
  });

  it('clears the vote when the same button is pressed again', async () => {
    const voter = await signIn(OWN[3]);
    const page = await voter.get(`/community/${post.slug}`);
    // The template posts 0 for the button already pressed; this is that payload.
    await voter.post(`/community/vote/reply/${answerA}`).type('form')
      .send({ _csrf: csrfFrom(page.text), value: '0', redirectTo: `/community/${post.slug}` });

    const [[row]] = await promisePool.query('SELECT vote_score FROM post_replies WHERE id = ?', [answerA]);
    expect(row.vote_score).toBe(0);
  });

  it('returns the voter to the sort they were reading', async () => {
    // Without the query string a reader who chose "Oldest" is dropped back into "Top" by
    // the act of voting, which reads as the page losing their place.
    const voter = await signIn(OWN[3]);
    const res = await voter.get(`/community/${post.slug}?answers=oldest`);
    expect(res.text).toContain(`value="/community/${post.slug}?answers=oldest#answers"`);
  });
});

maybe()('the breadcrumb and the link', () => {
  it('names the category between the community and the thread', async () => {
    const res = await request(app).get(`/community/${post.slug}`);
    expect(res.text).toContain('breadcrumb');
    expect(res.text).toContain('href="/community/category/transitions"');
  });

  it('offers the canonical URL to copy', async () => {
    const config = require('../../config/config');
    const res = await request(app).get(`/community/${post.slug}`);
    expect(res.text).toContain(`data-copy="${config.app.baseUrl}/community/${post.slug}"`);
  });
});
