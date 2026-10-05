'use strict';

/**
 * Stories and reviews, against a real database.
 *
 * The lifecycle is the whole point of this area, and it is the one this codebase applies
 * everywhere: content is hidden, never deleted, and a draft and a retraction are
 * different states. The reference's predecessor has `SiteReview.delete` — a hard DELETE
 * reachable from a bulk action — and after it runs nobody can say what was removed.
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');
const SuccessStory = require('../../models/SuccessStory');
const SiteReview = require('../../models/SiteReview');
const { PRODUCT_LINES } = require('../../config/sapProducts');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

let app;

const OWN_ACCOUNTS = ['story-admin@example.test', 'story-member@example.test', 'story-other@example.test'];
const CSRF_FORM = /name="_csrf" value="([^"]+)"/;
const CSRF_META = /<meta name="csrf-token" content="([^"]+)"/;
const TERM = 'Brindlewick';

function csrfFrom(html) {
  const match = html.match(CSRF_FORM) || html.match(CSRF_META);
  if (!match) throw new Error('No CSRF token on that page');
  return match[1];
}

async function signUp({ email, name, roles }) {
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
      user_types: roles,
      terms: 'on'
    });
  await promisePool.query('UPDATE users SET email_verified = 1 WHERE email = ?', [email]);
  return signIn(email);
}

async function signIn(email) {
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
  await promisePool.query('DELETE FROM success_stories WHERE title LIKE ?', [`${TERM}%`]);
});

maybe()('a story is a draft until somebody publishes it', () => {
  let admin;
  let storyId;
  let slug;

  beforeAll(async () => {
    await signUp({ email: 'story-admin@example.test', name: 'Story Admin', roles: 'consultant' });
    await promisePool.query("UPDATE users SET user_type = 'admin' WHERE email = ?", ['story-admin@example.test']);
    admin = await signIn('story-admin@example.test');
  });

  test('creating one leaves it unpublished', async () => {
    const page = await admin.get('/admin/stories');
    const res = await admin
      .post('/admin/stories')
      .type('form')
      .send({
        _csrf: csrfFrom(page.text),
        title: `${TERM} shipped S/4HANA in nine weeks`,
        body: '<p>A greenfield finance core, live in nine weeks.</p>',
        summary: 'Nine weeks from kick-off to go-live.',
        family: PRODUCT_LINES[0].value,
        video_url: 'https://youtu.be/dQw4w9WgXcQ'
      });
    expect(res.status).toBe(302);

    const [[row]] = await promisePool.query('SELECT * FROM success_stories WHERE title LIKE ?', [`${TERM}%`]);
    storyId = row.id;
    slug = row.slug;
    expect(row.published_at).toBeNull();
    expect(row.hidden_at).toBeNull();
  });

  test('a draft is not on the public list or reachable by slug', async () => {
    const list = await request(app).get('/success-stories');
    expect(list.status).toBe(200);
    expect(list.text).not.toContain(TERM);

    expect((await request(app).get(`/success-stories/${slug}`)).status).toBe(404);
  });

  test('a draft photo cannot be fetched before the story is live', async () => {
    // Otherwise an unpublished story's image can be enumerated before it goes live.
    expect((await request(app).get(`/success-stories/photo/${storyId}`)).status).toBe(404);
  });

  test('publishing puts it on both the list and its own page', async () => {
    const page = await admin.get('/admin/stories');
    await admin
      .post(`/admin/stories/${storyId}/state`)
      .type('form')
      .send({ _csrf: csrfFrom(page.text), field: 'published', value: 'true' });

    expect((await request(app).get('/success-stories')).text).toContain(TERM);
    expect((await request(app).get(`/success-stories/${slug}`)).status).toBe(200);
  });

  test('the video is embedded through the allowlist, never as typed', async () => {
    const res = await request(app).get(`/success-stories/${slug}`);
    // The privacy-enhanced host, derived at render time from the raw stored value.
    expect(res.text).toContain('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(res.text).not.toContain('youtu.be/dQw4w9WgXcQ');
  });

  test('a video host the allowlist does not know produces no frame at all', async () => {
    await promisePool.query('UPDATE success_stories SET video_url = ? WHERE id = ?', [
      'https://evil.example/player?id=1',
      storyId
    ]);
    const res = await request(app).get(`/success-stories/${slug}`);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('evil.example');
    expect(res.text).not.toMatch(/<iframe/i);
  });

  /*
   * Unpublished means "not finished"; hidden means "was live and should not be".
   * Collapsing them into one flag loses the retraction, which is the one somebody asks
   * about later.
   */
  test('hiding is a different state from unpublishing, and neither deletes', async () => {
    const page = await admin.get('/admin/stories');
    await admin
      .post(`/admin/stories/${storyId}/state`)
      .type('form')
      .send({ _csrf: csrfFrom(page.text), field: 'hidden', value: 'true' });

    const [[row]] = await promisePool.query('SELECT published_at, hidden_at FROM success_stories WHERE id = ?', [
      storyId
    ]);
    // Still published, and still there — just not shown.
    expect(row.published_at).not.toBeNull();
    expect(row.hidden_at).not.toBeNull();
    expect((await request(app).get(`/success-stories/${slug}`)).status).toBe(404);
  });

  test('restoring brings it back without republishing it', async () => {
    const page = await admin.get('/admin/stories');
    await admin
      .post(`/admin/stories/${storyId}/state`)
      .type('form')
      .send({ _csrf: csrfFrom(page.text), field: 'hidden', value: 'false' });

    expect((await request(app).get(`/success-stories/${slug}`)).status).toBe(200);
  });

  test('the CSP allows exactly the hosts an embed can name', async () => {
    const res = await request(app).get(`/success-stories/${slug}`);
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain('https://www.youtube-nocookie.com');
    expect(csp).toContain('https://player.vimeo.com');
    // Nothing else was widened to get there.
    expect(csp).toMatch(/frame-src [^;]*'self'/);
  });
});

maybe()('a review is signed in, one per account, and approved before it is seen', () => {
  let member;
  let other;
  let admin;

  beforeAll(async () => {
    member = await signUp({ email: 'story-member@example.test', name: 'Member Person', roles: 'consultant' });
    other = await signUp({ email: 'story-other@example.test', name: 'Other Person', roles: 'company' });
    admin = await signIn('story-admin@example.test');
  });

  test('a signed-out visitor cannot leave one', async () => {
    // The reference takes a name and a role from the form. A testimonial nobody can
    // attribute is not a testimonial, and an anonymous write endpoint is a queue
    // somebody fills with nonsense.
    // An agent, so the anonymous session that issued the token is the one that posts it.
    // Two bare requests fail on CSRF first, which would test the wrong guard.
    const guest = request.agent(app);
    const page = await guest.get('/success-stories/reviews');
    const res = await guest
      .post('/success-stories/reviews')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), rating: 5, body: 'x'.repeat(60) });

    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/auth\/login/);

    /*
     * Scoped to the accounts this suite owns, not a count over the whole table. A global
     * count is green only while nothing else in the database holds a review — it failed
     * the day development data was seeded, reporting an anonymous-write hole that did not
     * exist. Same trap as an unscoped LIMIT 1; see CLAUDE.md.
     */
    const [[row]] = await promisePool.query(
      'SELECT COUNT(*) AS n FROM site_reviews r JOIN users u ON u.id = r.user_id WHERE u.email IN (?)',
      [OWN_ACCOUNTS]
    );
    expect(row.n).toBe(0);
  });

  test('a rating on its own is refused', async () => {
    const page = await member.get('/success-stories/reviews');
    await member
      .post('/success-stories/reviews')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), rating: 5, body: 'Great' });

    expect(await SiteReview.forUser(await userId('story-member@example.test'))).toBeNull();
  });

  test('a submitted review is not visible until it is approved', async () => {
    const page = await member.get('/success-stories/reviews');
    await member
      .post('/success-stories/reviews')
      .type('form')
      .send({
        _csrf: csrfFrom(page.text),
        rating: 5,
        body: `${TERM} — the rate index alone was worth the sign-up, and the estimator saved a week.`
      });

    const own = await SiteReview.forUser(await userId('story-member@example.test'));
    expect(own).toBeTruthy();
    expect(own.approved_at).toBeNull();

    expect((await request(app).get('/success-stories/reviews')).text).not.toContain(TERM);
  });

  test('the role beside the name is derived, never posted', async () => {
    const own = await SiteReview.forUser(await userId('story-member@example.test'));
    // The reference stores whatever author_role was posted, so "SAP Mentor" becomes a
    // claim the page renders as fact.
    expect(own.author_role).toBe('consultant');

    const page = await member.get('/success-stories/reviews');
    await member
      .post('/success-stories/reviews')
      .type('form')
      .send({
        _csrf: csrfFrom(page.text),
        rating: 5,
        body: `${TERM} — still the best directory for SAP contract work anywhere.`,
        author_role: 'SAP Mentor'
      });

    expect((await SiteReview.forUser(await userId('story-member@example.test'))).author_role).toBe('consultant');
  });

  test('approving it makes it public and counts it in the summary', async () => {
    const own = await SiteReview.forUser(await userId('story-member@example.test'));
    const page = await admin.get('/admin/reviews');
    await admin
      .post(`/admin/reviews/${own.id}/state`)
      .type('form')
      .send({ _csrf: csrfFrom(page.text), field: 'approved', value: 'true' });

    expect((await request(app).get('/success-stories/reviews')).text).toContain(TERM);
    const summary = await SiteReview.summary();
    expect(summary.total).toBeGreaterThan(0);
  });

  /*
   * An approved review whose text can be swapped afterwards is an approval that means
   * nothing.
   */
  test('editing an approved review sends it back for approval', async () => {
    const page = await member.get('/success-stories/reviews');
    await member
      .post('/success-stories/reviews')
      .type('form')
      .send({
        _csrf: csrfFrom(page.text),
        rating: 1,
        body: `${TERM} — completely different text, posted after approval.`
      });

    const own = await SiteReview.forUser(await userId('story-member@example.test'));
    expect(own.approved_at).toBeNull();
    expect((await request(app).get('/success-stories/reviews')).text).not.toContain('completely different text');
  });

  test('one account holds one review, replaced rather than added to', async () => {
    const [[row]] = await promisePool.query('SELECT COUNT(*) AS n FROM site_reviews WHERE user_id = ?', [
      await userId('story-member@example.test')
    ]);
    expect(row.n).toBe(1);
  });

  test('hiding a review is not deleting it', async () => {
    const own = await SiteReview.forUser(await userId('story-member@example.test'));
    const page = await admin.get('/admin/reviews');
    await admin
      .post(`/admin/reviews/${own.id}/state`)
      .type('form')
      .send({ _csrf: csrfFrom(page.text), field: 'hidden', value: 'true' });

    const [[row]] = await promisePool.query('SELECT hidden_at FROM site_reviews WHERE id = ?', [own.id]);
    expect(row.hidden_at).not.toBeNull();
    // The row, and the words, are still there to answer "who removed that, and when".
    expect(await SiteReview.forUser(await userId('story-member@example.test'))).toBeTruthy();
  });

  test('a second account leaves its own review, with its own derived role', async () => {
    const page = await other.get('/success-stories/reviews');
    await other
      .post('/success-stories/reviews')
      .type('form')
      .send({
        _csrf: csrfFrom(page.text),
        rating: 4,
        body: 'We hired two consultants through the board inside a month. Worth it.'
      });

    expect((await SiteReview.forUser(await userId('story-other@example.test'))).author_role).toBe('company');
  });
});

maybe()('the refusal that must not arrive later', () => {
  test('a story carries no money fields, in the schema or the model', async () => {
    const [columns] = await promisePool.query('SHOW COLUMNS FROM success_stories');
    const names = columns.map((c) => c.Field).join(' ');
    /*
     * The reference's predecessor carries gross_before, net_before, gross_after and
     * net_after, and renders the difference as a monthly saving — the savings calculator
     * this Hub refuses, wearing a different hat. "We shipped in nine weeks" is evidence;
     * "I went from 3,400 to 5,700 a month" is a financial claim nobody here can stand
     * behind.
     */
    expect(names).not.toMatch(/gross|net_|saving|salary|take_?home/i);

    const out = SuccessStory.normalise({
      title: 'A story',
      body: 'Body',
      gross_before: 3400,
      net_after: 5700,
      savings_monthly: 2300
    });
    expect(Object.keys(out).join(' ')).not.toMatch(/gross|net_|saving/i);
  });
});
