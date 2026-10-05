'use strict';

/**
 * The blog, which is a view and not a content store.
 *
 * An editorial post is a community article written from a Hub account and marked, so what
 * is worth asserting is everything it INHERITS without /blog knowing about it — the
 * moderation flag, the one canonical URL, the reply machinery — and the one thing that is
 * genuinely new: that the mark cannot be claimed by somebody who is not an administrator.
 */

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { promisePool } = require('../../config/database');
const User = require('../../models/User');
const Post = require('../../models/Post');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const OWN = ['blog-admin@example.test', 'blog-member@example.test'];
const PASSWORD = 'Blog-Test-Pass-1';
const OFFICIAL = 'Blogtest Why the rate index withholds a bucket';
const MEMBER_ARTICLE = 'Blogtest A member write-up about EWM waves';
const CSRF = /name="_csrf" value="([^"]+)"/;

let app;
let categoryId;
let officialId;
let adminId;
let adminAgent;
let memberAgent;

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
  categoryId = category.id;

  const admin = await User.create({ email: OWN[0], password: PASSWORD, name: 'Blog Admin', roles: ['consultant'] });
  await User.setEmailVerified(admin.id);
  await User.adminSetRoles(admin.id, ['admin'], { primary: 'admin' });
  adminId = admin.id;

  const member = await User.create({ email: OWN[1], password: PASSWORD, name: 'Blog Member', roles: ['consultant'] });
  await User.setEmailVerified(member.id);

  const official = await Post.create(admin.id, {
    categoryId, kind: 'article', title: OFFICIAL, body: 'An official write-up.', isEditorial: true
  });
  officialId = official.id;
  await Post.create(member.id, {
    categoryId, kind: 'article', title: MEMBER_ARTICLE, body: 'A member write-up.'
  });

  adminAgent = await signIn(OWN[0]);
  memberAgent = await signIn(OWN[1]);
});

maybe()('GET /blog', () => {
  it('lists the Hub\'s own articles and nobody else\'s', async () => {
    const res = await request(app).get('/blog');
    expect(res.status).toBe(200);
    expect(res.text).toContain(OFFICIAL);
    expect(res.text).not.toContain(MEMBER_ARTICLE);
  });

  it('links to the article\'s one canonical URL, not a second address for it', async () => {
    // Two addresses for the same text is two pages competing in search, two reply counts
    // to reconcile, and two places to land on a post that has since been hidden.
    const res = await request(app).get('/blog');
    expect(res.text).toMatch(/href="\/community\/blogtest-why-the-rate-index/i);
    expect(res.text).not.toMatch(/href="\/blog\/[a-z]/i);
  });

  it('has no /blog/:slug at all', async () => {
    const res = await request(app).get('/blog/blogtest-why-the-rate-index-withholds-a-bucket');
    expect(res.status).toBe(404);
  });

  it('hides an editorial post the moment it is moderated, without /blog knowing why', async () => {
    // Post.buildFilter excludes hidden posts; the blog passes no rule of its own.
    await promisePool.query('UPDATE posts SET hidden_at = NOW() WHERE id = ?', [officialId]);
    const res = await request(app).get('/blog');
    expect(res.text).not.toContain(OFFICIAL);
    await promisePool.query('UPDATE posts SET hidden_at = NULL WHERE id = ?', [officialId]);
  });

  it('collects no addresses it cannot send to', async () => {
    /*
     * The reference has a subscribe box. One that takes an address with nothing to send it,
     * no record of consent and no unsubscribe link is a promise made to somebody who cannot
     * withdraw it — the same rule the contact form waited on.
     */
    const res = await request(app).get('/blog');
    expect(res.text).not.toMatch(/name="email"/);
    expect(res.text).toContain('working unsubscribe');
  });
});

maybe()('the editorial mark', () => {
  it('is offered to an administrator', async () => {
    const res = await adminAgent.get('/community/new');
    expect(res.text).toContain('name="is_editorial"');
  });

  it('is not offered to a member', async () => {
    const res = await memberAgent.get('/community/new');
    expect(res.text).not.toContain('name="is_editorial"');
  });

  it('cannot be claimed by posting the field anyway', async () => {
    // The route checks the session, not the body — the model cannot tell who sent it.
    const page = await memberAgent.get('/community/new');
    await memberAgent.post('/community').type('form').send({
      _csrf: csrfFrom(page.text),
      category_id: categoryId,
      kind: 'article',
      title: 'Blogtest Member claiming the Hub badge',
      body: 'This should not reach the blog.',
      is_editorial: 'on'
    });

    const [[row]] = await promisePool.query(
      'SELECT is_editorial FROM posts WHERE title = ?', ['Blogtest Member claiming the Hub badge']
    );
    expect(row.is_editorial).toBe(0);

    const res = await request(app).get('/blog');
    expect(res.text).not.toContain('Member claiming the Hub badge');
  });

  it('only marks articles, whatever is asked for', async () => {
    // The Hub congratulating itself, or asking itself a question, is not a thing. Asserted
    // on a real row rather than inside a catch that would pass by never running.
    const created = await Post.create(adminId, {
      categoryId, kind: 'win', title: 'Blogtest Not an article', body: 'A go-live.', isEditorial: true
    });
    const [[row]] = await promisePool.query('SELECT is_editorial FROM posts WHERE id = ?', [created.id]);
    expect(row.is_editorial).toBe(0);

    const res = await request(app).get('/blog');
    expect(res.text).not.toContain('Blogtest Not an article');
  });
});

maybe()('it is a view, not a second content store', () => {
  it('adds no table and no SQL of its own', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'index.js'), 'utf8');
    const section = source.slice(source.indexOf("'/blog'"), source.indexOf("'/about'"));
    expect(section).toContain('Post.browse');
    expect(section).not.toMatch(/SELECT|INSERT|FROM\s+\w+/);
  });
});
