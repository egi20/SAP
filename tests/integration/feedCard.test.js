'use strict';

/**
 * The feed card's controls.
 *
 * Each of these is a button that writes to the points ledger, or a link somebody will
 * paste somewhere. What is worth asserting is that they go through the paths that already
 * exist — one vote endpoint, one canonical base URL, one composer — rather than growing
 * their own.
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');
const User = require('../../models/User');
const Post = require('../../models/Post');
const config = require('../../config/config');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const OWN = ['card-author@example.test', 'card-reader@example.test'];
const PASSWORD = 'Card-Test-Pass-1';
const TITLE = 'Cardtest a question with a long body';
// Comfortably past the long extract's 760-character bound, so "the end is not on the page"
// is a statement about the bound and not about this fixture's length.
const LONG_BODY = `${'An unusually long opening sentence about warehouse waves. '.repeat(30)}END OF BODY.`;
const CSRF = /name="_csrf" value="([^"]+)"/;

let app;
let post;
let authorId;

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

beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');
  await promisePool.query('DELETE FROM users WHERE email IN (?)', [OWN]);

  const { syncCategories } = require('../../scripts/sync-catalogues');
  await syncCategories();
  const [[category]] = await promisePool.query("SELECT id FROM post_categories WHERE slug = 'transitions'");

  const author = await User.create({ email: OWN[0], password: PASSWORD, name: 'Card Author', roles: ['consultant'] });
  await User.setEmailVerified(author.id);
  authorId = author.id;

  const reader = await User.create({ email: OWN[1], password: PASSWORD, name: 'Card Reader', roles: ['consultant'] });
  await User.setEmailVerified(reader.id);

  post = await Post.create(authorId, {
    categoryId: category.id, kind: 'question', title: TITLE, body: LONG_BODY
  });
});

maybe()('the extract', () => {
  it('holds a longer extract behind a details, not the whole body', async () => {
    /*
     * The reference expands the full post inline, so every card on a fifteen-card feed
     * ships its entire article whether or not anybody opens it. A feed page must not grow
     * with the length of what people wrote.
     */
    const res = await request(app).get('/community');
    expect(res.text).toContain('Show more');
    expect(res.text).toContain('<details');
    // The body is longer than both extracts, so the end of it must not be on the page.
    expect(res.text).not.toContain('END OF BODY.');
  });

  it('needs no script to expand', async () => {
    // A <details> is the one expander on the site that works with scripting off and that
    // the keyboard reaches without help.
    const res = await request(app).get('/community');
    expect(res.text).toMatch(/<details[^>]*>\s*<summary/);
  });
});

maybe()('the vote button', () => {
  it('is a sign-in link for a visitor, not a button that does nothing', async () => {
    const res = await request(app).get('/community');
    expect(res.text).toContain('Sign in to upvote');
    expect(res.text).not.toContain('action="/community/vote/post/');
  });

  it('posts to the endpoint the thread page already uses', async () => {
    // One writer for the points ledger. A second vote path would be a second key scheme.
    const reader = await signIn(OWN[1]);
    const res = await reader.get('/community');
    expect(res.text).toContain(`action="/community/vote/post/${post.id}"`);
  });

  it('returns the voter to the page they voted from', async () => {
    /*
     * The route used to accept only paths under /community, so a vote cast on the home
     * feed threw the reader onto the community index — a page they had not asked for,
     * having lost their place in the one they had. It goes through returnTo now.
     */
    const reader = await signIn(OWN[1]);
    const feed = await reader.get('/');
    const res = await reader.post(`/community/vote/post/${post.id}`).type('form').send({
      _csrf: csrfFrom(feed.text), value: '1', redirectTo: '/'
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });

  it('shows the button already pressed to somebody who has voted', async () => {
    /*
     * `services/feed.js` was passing viewerUserId into a `browse` that did not take it, so
     * the argument went nowhere and every card rendered unvoted however many times its
     * reader had voted.
     */
    const reader = await signIn(OWN[1]);
    const res = await reader.get('/community');
    expect(res.text).toContain('aria-pressed="true"');
  });

  it('refuses to send somebody off-site through redirectTo', async () => {
    const reader = await signIn(OWN[1]);
    const feed = await reader.get('/');
    const res = await reader.post(`/community/vote/post/${post.id}`).type('form').send({
      _csrf: csrfFrom(feed.text), value: '1', redirectTo: 'https://evil.example/x'
    });
    expect(res.headers.location).not.toContain('evil.example');
  });
});

maybe()('share and reply', () => {
  it('copies the canonical URL, not the one the browser happened to use', async () => {
    const res = await request(app).get('/community');
    expect(res.text).toContain(`data-copy="${config.app.baseUrl}/community/${post.slug}"`);
  });

  it('sends a reply to the thread rather than offering a box on the card', async () => {
    /*
     * A reply written against 280 characters of a question is a reply written without
     * reading it, and duplicate answers are the one thing a question thread cannot
     * recover from. The composer is where the question is.
     */
    const res = await request(app).get('/community');
    expect(res.text).toContain(`/community/${post.slug}#reply`);
    expect(res.text).not.toMatch(/action="\/community\/[^"]+\/reply"[^>]*>\s*<div class="card-body">\s*<input[^>]*_csrf[\s\S]{0,200}rows="6"[\s\S]{0,400}<\/form>\s*<\/article>/);
  });

  it('has something for that anchor to land on', async () => {
    // An anchor pointing at nothing scrolls to the top of the thread, which is the one
    // place the reader did not ask for.
    const signedOut = await request(app).get(`/community/${post.slug}`);
    expect(signedOut.text).toContain('id="reply"');

    const reader = await signIn(OWN[1]);
    const signedIn = await reader.get(`/community/${post.slug}`);
    expect(signedIn.text).toContain('id="reply"');
  });
});
