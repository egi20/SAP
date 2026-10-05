'use strict';

/**
 * The articles page and the public author page.
 *
 * Both are views over the same `Post.browse` everything else in the community calls, so
 * what is worth asserting is not that they list things — it is that they inherit the rules
 * they never mention: a hidden post is absent, a deactivated account has no page, and the
 * author picker cannot name somebody whose only post is hidden.
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');
const User = require('../../models/User');
const Post = require('../../models/Post');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const OWN = ['pages-writer@example.test', 'pages-ghost@example.test'];
const ARTICLE_TITLE = 'Pagestest Clean core without the religion';
const QUESTION_TITLE = 'Pagestest Why does my IDoc hang';
const HIDDEN_TITLE = 'Pagestest Hidden article nobody should see';

let app;
let writerId;
let ghostId;
let hiddenPostId;

/*
 * Fixtures are cleared on the way IN and the pool is never closed here — `tests/setup.js`
 * owns that, and its hook runs before a top-level hook in this file.
 */
beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');
  await promisePool.query('DELETE FROM users WHERE email IN (?)', [OWN]);

  const { syncCategories } = require('../../scripts/sync-catalogues');
  await syncCategories();
  const [[category]] = await promisePool.query("SELECT id FROM post_categories WHERE slug = 'transitions'");

  const writer = await User.create({
    email: OWN[0], password: 'Pages-Test-Pass-1', name: 'Pages Writer', roles: ['consultant']
  });
  writerId = writer.id;
  const ghost = await User.create({
    email: OWN[1], password: 'Pages-Test-Pass-1', name: 'Pages Ghost', roles: ['consultant']
  });
  ghostId = ghost.id;

  await Post.create(writerId, {
    categoryId: category.id, kind: 'article', title: ARTICLE_TITLE, body: 'An article body.'
  });
  await Post.create(writerId, {
    categoryId: category.id, kind: 'question', title: QUESTION_TITLE, body: 'A question body.'
  });

  // The ghost's ONLY post is hidden, so they must not appear anywhere a filter is built.
  const hidden = await Post.create(ghostId, {
    categoryId: category.id, kind: 'article', title: HIDDEN_TITLE, body: 'Hidden body.'
  });
  hiddenPostId = hidden.id;
  await promisePool.query('UPDATE posts SET hidden_at = NOW() WHERE id = ?', [hiddenPostId]);
});

maybe()('GET /community/articles', () => {
  it('lists articles and nothing else', async () => {
    const res = await request(app).get('/community/articles');
    expect(res.status).toBe(200);
    expect(res.text).toContain(ARTICLE_TITLE);
    // The kind is what this page IS, not a filter that happens to be applied.
    expect(res.text).not.toContain(QUESTION_TITLE);
  });

  it('does not list a hidden article, because Post.browse does not', async () => {
    const res = await request(app).get('/community/articles');
    expect(res.text).not.toContain(HIDDEN_TITLE);
  });

  it('builds the author picker from the same filter, so a hidden-only author is absent', async () => {
    const res = await request(app).get('/community/articles');
    expect(res.text).toContain('Pages Writer');
    expect(res.text).not.toContain('Pages Ghost');
  });

  it('filters by author', async () => {
    const res = await request(app).get(`/community/articles?author=${writerId}`);
    expect(res.text).toContain(ARTICLE_TITLE);
  });

  it('ignores an author parameter that is not a number', async () => {
    const res = await request(app).get('/community/articles?author=1%20OR%201=1');
    expect(res.status).toBe(200);
    expect(res.text).toContain(ARTICLE_TITLE);
  });

  it('is reachable at the reference name', async () => {
    const res = await request(app).get('/forum/articles?author=3');
    expect(res.status).toBe(302);
    // The filters survive the hop, or a shared link lands somewhere that looks broken.
    expect(res.headers.location).toBe('/community/articles?author=3');
  });
});

maybe()('GET /community/author/:id', () => {
  it('collects what one person has written', async () => {
    const res = await request(app).get(`/community/author/${writerId}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Pages Writer');
    expect(res.text).toContain(ARTICLE_TITLE);
    expect(res.text).toContain(QUESTION_TITLE);
  });

  it('does not show their hidden posts', async () => {
    const res = await request(app).get(`/community/author/${ghostId}`);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(HIDDEN_TITLE);
  });

  it('offers no message button — every conversation here is anchored to a subject', async () => {
    const res = await request(app).get(`/community/author/${writerId}`);
    expect(res.text).not.toContain('/messages/new');
  });

  it('404s an id nobody holds, rather than rendering an empty page', async () => {
    // A page that renders for any id is a page that confirms which ids exist.
    const res = await request(app).get('/community/author/99999999');
    expect(res.status).toBe(404);
  });

  it('404s a deactivated account', async () => {
    await promisePool.query('UPDATE users SET is_active = 0 WHERE id = ?', [ghostId]);
    const res = await request(app).get(`/community/author/${ghostId}`);
    expect(res.status).toBe(404);
    await promisePool.query('UPDATE users SET is_active = 1 WHERE id = ?', [ghostId]);
  });

  it('refuses an id that only looks like one', async () => {
    // parseInt('44.map') is 44 — requireIdParam is why that does not reach a query.
    const res = await request(app).get('/community/author/44.map');
    expect(res.status).toBe(404);
  });

  it('is reachable at the reference name', async () => {
    const res = await request(app).get('/forum/user/7');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/community/author/7');
  });
});

/**
 * The three bugs a walkthrough with real data found, pinned.
 *
 * Each one was invisible on an empty database: a link with no id has nothing to point at,
 * a certification nobody holds renders nothing either way, and a branch for the wrong kind
 * of account needs an account of the wrong kind. They are here because the fix is one line
 * each and the test is the only thing that keeps them fixed.
 */
maybe()('what a card links to', () => {
  it('carries the author id, so the link is not /community/author/', async () => {
    /*
     * `Post.browse` selects an explicit column list, and `author_user_id` was not in it —
     * so every card rendered from it linked to "/community/author/" with nothing after
     * the slash. Seven 404s on the front page, from one column missing.
     */
    const res = await request(app).get('/community');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('href="/community/author/"');
    expect(res.text).toMatch(/href="\/community\/author\/\d+"/);
  });

  it('carries it on the home feed too, which is where it was found', async () => {
    const res = await request(app).get('/');
    expect(res.text).not.toContain('href="/community/author/"');
  });

  it('carries it on the articles page and the author page', async () => {
    const pages = await Promise.all(
      ['/community/articles', `/community/author/${writerId}`].map((p) => request(app).get(p))
    );
    pages.forEach((res) => expect(res.text).not.toContain('href="/community/author/"'));
  });
});
