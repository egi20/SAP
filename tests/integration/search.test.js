'use strict';

/**
 * Search, against a real database.
 *
 * The point of these tests is not that search finds things — it is that search finds
 * exactly what the list pages find, and nothing else. Every case below is a row that is
 * invisible somewhere on the site and must therefore be invisible here, without
 * services/search.js containing a single rule about why.
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');
const Post = require('../../models/Post');
const { searchEverything } = require('../../services/search');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

let app;

const OWN_ACCOUNTS = ['search-co@example.test', 'search-con@example.test'];
const CSRF = /name="_csrf" value="([^"]+)"/;
const TERM = 'Zylotronic';

function csrfFrom(html) {
  const match = html.match(CSRF);
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

function group(results, key) {
  return results.groups.find((g) => g.key === key);
}

beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');
  await promisePool.query('DELETE FROM users WHERE email IN (?)', [OWN_ACCOUNTS]);
});

maybe()('one box, four sources', () => {
  let company;
  let draftSlug;
  let openSlug;
  let hiddenPostId;

  beforeAll(async () => {
    company = await signUp({ email: 'search-co@example.test', name: 'Searchable Company', roles: 'company' });
    const consultant = await signUp({
      email: 'search-con@example.test',
      name: 'Searchable Person',
      roles: 'consultant'
    });

    // A published job, and a draft of the same shape.
    const form = await company.get('/jobs/new');
    const token = csrfFrom(form.text);
    const base = {
      _csrf: token,
      description: `A rollout for ${TERM} across three plants, EWM and MM in scope.`,
      role: 's4-ewm',
      seniority: 'senior',
      engagement_type: 'contract',
      work_mode: 'remote',
      country: 'DE',
      rate_min: 800,
      rate_max: 1000,
      activate_phase: 'realize',
      modules: ['ewm']
    };
    await company.post('/jobs').type('form').send({ ...base, title: `${TERM} EWM consultant`, publish: 'on' });
    await company.post('/jobs').type('form').send({ ...base, title: `${TERM} draft role` });

    const [[open]] = await promisePool.query("SELECT slug FROM jobs WHERE title LIKE ? AND status = 'open'", [
      `${TERM}%`
    ]);
    const [[draft]] = await promisePool.query("SELECT slug FROM jobs WHERE title LIKE ? AND status = 'draft'", [
      `${TERM}%`
    ]);
    openSlug = open.slug;
    draftSlug = draft.slug;

    // A company profile carrying the term, and a consultant profile that is NOT public.
    await promisePool.query('UPDATE company_profiles SET tagline = ?, is_public = 1 WHERE user_id = ?', [
      `${TERM} implementation partner`,
      await userId('search-co@example.test')
    ]);
    await promisePool.query('UPDATE consultant_profiles SET headline = ?, is_public = 0 WHERE user_id = ?', [
      `${TERM} specialist`,
      await userId('search-con@example.test')
    ]);

    // A visible community post and a hidden one.
    const [[category]] = await promisePool.query('SELECT id FROM post_categories LIMIT 1');
    await Post.create(await userId('search-con@example.test'), {
      categoryId: category.id,
      kind: 'question',
      title: `How is ${TERM} licensed?`,
      body: 'Asking before the programme starts.'
    });
    const hidden = await Post.create(await userId('search-con@example.test'), {
      categoryId: category.id,
      kind: 'discussion',
      title: `${TERM} rumours`,
      body: 'Removed by a moderator.'
    });
    hiddenPostId = hidden.id;
    await promisePool.query('UPDATE posts SET hidden_at = NOW() WHERE id = ?', [hiddenPostId]);

    expect(consultant).toBeTruthy();
  });

  test('it finds the open job', async () => {
    const results = await searchEverything(TERM);
    expect(results.usable).toBe(true);
    expect(group(results, 'jobs').rows.map((j) => j.slug)).toContain(openSlug);
  });

  test('it does not find the draft, and nothing here knows what a draft is', async () => {
    // `Job.buildFilter` defaults to `status = 'open'`, and search never passes a status.
    const results = await searchEverything(TERM);
    expect(group(results, 'jobs').rows.map((j) => j.slug)).not.toContain(draftSlug);
  });

  test('it finds the company', async () => {
    const results = await searchEverything(TERM);
    expect(group(results, 'companies').total).toBeGreaterThan(0);
  });

  test('it does not find an unpublished consultant profile', async () => {
    // `is_public = 1` is a fixed fragment in ConsultantProfile.buildFilter, not an option.
    const results = await searchEverything(TERM);
    expect(group(results, 'consultants').total).toBe(0);
  });

  test('publishing that profile makes it findable, through the same call', async () => {
    await promisePool.query('UPDATE consultant_profiles SET is_public = 1 WHERE user_id = ?', [
      await userId('search-con@example.test')
    ]);

    const results = await searchEverything(TERM);
    expect(group(results, 'consultants').total).toBe(1);
  });

  test('it finds the visible post and not the hidden one', async () => {
    const results = await searchEverything(TERM);
    const titles = group(results, 'community').rows.map((p) => p.title);
    expect(titles).toContain(`How is ${TERM} licensed?`);
    expect(titles).not.toContain(`${TERM} rumours`);
  });

  test('the count beside "see all" is the count that page will show', async () => {
    const results = await searchEverything(TERM);
    const jobs = group(results, 'jobs');

    // The same filter, expressed in the list page's own query string.
    const listed = await request(app).get(jobs.href);
    expect(listed.status).toBe(200);
    // One open job carrying the term, and the list page says so too.
    expect(jobs.total).toBe(1);
    expect(listed.text).toContain(`${TERM} EWM consultant`);
    expect(listed.text).not.toContain(`${TERM} draft role`);
  });

  test('the total is a sum across types, not a deduplicated figure', async () => {
    const results = await searchEverything(TERM);
    const sum = results.groups.reduce((n, g) => n + g.total, 0);
    // A job and the company that posted it are two results: two different things
    // somebody might have been looking for.
    expect(results.total).toBe(sum);
    expect(results.total).toBeGreaterThan(1);
  });
});

maybe()('the page itself', () => {
  test('it is public, and answers with no query at all', async () => {
    const res = await request(app).get('/search');
    expect(res.status).toBe(200);
    expect(res.text).toContain('One box, five places');
  });

  test('a short query is refused on the page rather than run', async () => {
    const res = await request(app).get('/search?q=a');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Type a little more');
  });

  test('a results page is never offered to a crawler', async () => {
    /*
     * Infinite crawl space: every query string is a distinct URL. The meta tag only stops
     * it being indexed after it has been fetched, so robots.txt disallows the path too.
     */
    const res = await request(app).get(`/search?q=${TERM}`);
    expect(res.text).toMatch(/<meta name="robots" content="noindex/i);

    const robots = await request(app).get('/robots.txt');
    expect(robots.text).toContain('Disallow: /search');
  });

  test('the search box is in the navigation on every page', async () => {
    const home = await request(app).get('/');
    expect(home.text).toContain('action="/search"');
  });

  test('a query is echoed as text, never as markup', async () => {
    const res = await request(app).get('/search?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<script>alert(1)</script>');
    expect(res.text).toContain('&lt;script&gt;');
  });
});
