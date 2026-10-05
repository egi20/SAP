'use strict';

/**
 * The home feed, seen by a stranger.
 *
 * The page used to be two: a landing page for a visitor, the feed for a member. The
 * interesting assertions are therefore all about the logged-out view — both that it shows
 * the activity at all, and that showing it did not open a hole. `services/feed.js` adds no
 * filter of its own, so these are really tests that it does not: a draft advert and a
 * hidden post are invisible here for the same reason they are invisible on /jobs and
 * /community, and nothing in the feed knows why.
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');
const User = require('../../models/User');
const Job = require('../../models/Job');
const Post = require('../../models/Post');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const OWN = ['feed-co@example.test', 'feed-con@example.test'];
const OPEN_TITLE = 'Feedtest Open EWM Rollout';
const DRAFT_TITLE = 'Feedtest Draft Never Published';
const POST_TITLE = 'Feedtest how do you phase an EWM cutover';

let app;
let post;

/*
 * ONE setup and ONE teardown for the file. Creating the fixtures inside the first describe
 * and deleting them in its afterAll leaves the describe after it asserting against rows
 * that no longer exist — which fails as "the feed does not show the advert" and reads
 * exactly like the bug these tests are here to catch.
 */
beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');

    // Scoped to the accounts this suite owns. An unscoped DELETE or a bare LIMIT 1 is green
    // only until another suite writes a row first.
  await promisePool.query('DELETE FROM users WHERE email IN (?)', [OWN]);

  const company = await User.create({
    email: OWN[0], password: 'Feed-Test-Pass-1', name: 'Feed Company', roles: ['company']
  });
  const consultant = await User.create({
    email: OWN[1], password: 'Feed-Test-Pass-1', name: 'Feed Consultant', roles: ['consultant']
  });

  const base = {
    description: 'A test advert.', role: 's4-ewm', seniority: 'senior',
    engagement_type: 'contract', work_mode: 'remote', country: 'DE',
    activate_phase: 'realize'
  };
  await Job.create(company.id, { ...base, title: OPEN_TITLE, status: 'open' });
  await Job.create(company.id, { ...base, title: DRAFT_TITLE, status: 'draft' });

  // The categories are a deploy step, not fixtures — make sure they are there.
  const { syncCategories } = require('../../scripts/sync-catalogues');
  await syncCategories();
  const [[category]] = await promisePool.query("SELECT id FROM post_categories WHERE slug = 'transitions'");
  post = await Post.create(consultant.id, {
    categoryId: category.id, kind: 'question', title: POST_TITLE, body: 'A test question.'
  });
});

/*
 * NO POOL TEARDOWN HERE. `tests/setup.js` registers a global afterAll that closes the pool
 * and the session store, and a hook registered there runs BEFORE a top-level hook in this
 * file — so a top-level afterAll that queries anything gets "Pool is closed", which Jest
 * reports as the whole suite failing while every test in it passed. Fixtures are therefore
 * cleared on the way IN, which also makes a run independent of how the last one ended.
 */
maybe()('GET / as a stranger', () => {
  it('shows the feed, not a page of claims', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain(OPEN_TITLE);
    expect(res.text).toContain(POST_TITLE);
  });

  it('still carries the landing material a stranger needs', async () => {
    const res = await request(app).get('/');
    expect(res.text).toContain('Jobs, talent and real day rates');
    expect(res.text).toContain('Browse by cloud');
    // The slot a member's standing occupies answers the visitor's actual question instead.
    expect(res.text).toContain('New here?');
    expect(res.text).toContain('Why sign in?');
  });

  it('does not show a draft advert, because Job.browse does not', async () => {
    const res = await request(app).get('/');
    expect(res.text).not.toContain(DRAFT_TITLE);
  });

  it('does not show a hidden post, because Post.browse does not', async () => {
    await promisePool.query('UPDATE posts SET hidden_at = NOW() WHERE id = ?', [post.id]);
    const res = await request(app).get('/');
    expect(res.text).not.toContain(POST_TITLE);
    await promisePool.query('UPDATE posts SET hidden_at = NULL WHERE id = ?', [post.id]);
  });

  it('orders strictly by date and invents no cross-type score', async () => {
    const res = await request(app).get('/');
    // The post was created after both adverts, so it must appear above the open one.
    expect(res.text.indexOf(POST_TITLE)).toBeLessThan(res.text.indexOf(OPEN_TITLE));
  });
});

maybe()('the feed filters', () => {
  it('narrows to job adverts on ?kind=job', async () => {
    const res = await request(app).get('/?kind=job');
    expect(res.status).toBe(200);
    expect(res.text).toContain(OPEN_TITLE);
    expect(res.text).not.toContain(POST_TITLE);
  });

  it('narrows to posts on a post kind', async () => {
    const res = await request(app).get('/?kind=question');
    expect(res.text).toContain(POST_TITLE);
    expect(res.text).not.toContain(OPEN_TITLE);
  });

  it('says so when a community filter has excluded the adverts', async () => {
    // A category belongs to the community tree and means nothing for an advert. The feed
    // narrows rather than inventing a mapping between the two vocabularies — and admits it.
    const res = await request(app).get('/?unanswered=1');
    expect(res.text).toContain('Showing community posts only');
  });

  it('ignores a kind it does not have', async () => {
    const res = await request(app).get('/?kind=../../etc/passwd');
    expect(res.status).toBe(200);
    expect(res.text).toContain(OPEN_TITLE);
  });
});
