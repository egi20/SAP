'use strict';

/**
 * The marketplace, end to end, against a real MySQL-compatible database.
 *
 * Deliberately NOT mocked. Salesforce Hub's own port plan ends with three bugs that were
 * green under mocks and only a real database found — an alias colliding with a real column
 * under `only_full_group_by`, a test whose source was unmocked and unreachable, and a DATE
 * compared as a string. This suite exists so this application's equivalents surface here
 * rather than in production.
 *
 * Skipped when no database is reachable, so `npm test` still runs on a laptop without one.
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');

/*
 * Decided in tests/globalSetup.js, not here. Jest registers every `describe` while the file
 * is being evaluated, so a flag set in `beforeAll` is still false when the suite decides
 * whether to skip — which is how the first version of this file reported seven skipped
 * tests against a database that was running.
 */
const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);
let app;

const CSRF = /name="_csrf" value="([^"]+)"/;

function csrfFrom(html) {
  const match = html.match(CSRF);
  if (!match) throw new Error('No CSRF token on that page');
  return match[1];
}

/** Sign up, and come back with an agent that is signed in and email-verified. */
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
      // The field is `user_types`, and only `User.PUBLIC_ROLES` can be created here —
      // the filter in routes/auth.js is a security boundary, not a convenience.
      user_types: roles,
      terms: 'on'
    });

  // Verification is a mailed link; the flow it guards is not what this suite is testing.
  await promisePool.query('UPDATE users SET email_verified = 1 WHERE email = ?', [email]);

  const login = await agent.get('/auth/login');
  await agent
    .post('/auth/login')
    .type('form')
    .send({ _csrf: csrfFrom(login.text), email, password: 'Sup3rSecret' });

  return agent;
}

const OWN_ACCOUNTS = ['hiring@example.test', 'ewm@example.test'];

/**
 * Each suite owns its own accounts and removes only those.
 *
 * `DELETE FROM users` was the first version, and it is a trap: Jest runs test FILES in
 * parallel workers by default, so two suites truncating the same table race each other and
 * fail in whichever order the scheduler picked that day. Everything in this schema cascades
 * from `users`, so deleting this suite's own e-mail addresses is both sufficient and
 * parallel-safe.
 */
async function removeOwnAccounts() {
  await promisePool.query('DELETE FROM users WHERE email IN (?)', [OWN_ACCOUNTS]);
}

beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');
  await removeOwnAccounts();
});

// No afterAll cleanup here: tests/setup.js closes the pool, and it runs first, so a query
// in this file's afterAll fails with "Pool is closed". The beforeAll above starts from a
// clean slate instead, which is the version that cannot race.

maybe()('a role posted with modules reaches the consultant who delivered them', () => {
  let company;
  let consultant;
  let jobSlug;

  beforeAll(async () => {
    company = await signUp({ email: 'hiring@example.test', name: 'Hiring Co', roles: 'company' });
    consultant = await signUp({ email: 'ewm@example.test', name: 'Delivery Person', roles: 'consultant' });

    const form = await company.get('/jobs/new');
    const posted = await company
      .post('/jobs')
      .type('form')
      .send({
        _csrf: csrfFrom(form.text),
        title: 'S/4HANA EWM consultant, realize phase',
        description:
          'Greenfield warehouse rollout on S/4HANA. Working alongside the MM team through '
          + 'realize and into deploy. Committed, specific, hands-on configuration work.',
        role: 's4-ewm',
        seniority: 'senior',
        engagement_type: 'contract',
        work_mode: 'remote',
        country: 'DE',
        rate_min: 800,
        rate_max: 1000,
        activate_phase: 'realize',
        modules: ['ewm', 'mm-purchasing'],
        publish: 'on'
      });
    expect(posted.status).toBe(302);

    /*
     * Scoped to the account this suite owns. The first version was
     * `SELECT slug, status FROM jobs LIMIT 1`, which was green only for as long as this
     * was the one suite that had ever written a job — the payments suite posts one too,
     * and then this picked up whichever row the server happened to hand back first and
     * asserted this suite's phase against somebody else's advert.
     */
    const [[job]] = await promisePool.query(
      `SELECT j.slug, j.status
         FROM jobs j
         JOIN users u ON u.id = j.company_user_id
        WHERE u.email = ?
        ORDER BY j.id DESC
        LIMIT 1`,
      ['hiring@example.test']
    );
    expect(job.status).toBe('open');
    jobSlug = job.slug;
  });

  test('the job stored its modules and its phase', async () => {
    const [[row]] = await promisePool.query('SELECT activate_phase FROM jobs WHERE slug = ?', [jobSlug]);
    expect(row.activate_phase).toBe('realize');

    const [modules] = await promisePool.query(
      'SELECT module_slug FROM job_modules jm JOIN jobs j ON j.id = jm.job_id WHERE j.slug = ?',
      [jobSlug]
    );
    expect(modules.map((m) => m.module_slug).sort()).toEqual(['ewm', 'mm-purchasing']);
  });

  test('the module filter is any-of, not all-of', async () => {
    // The SAP-shaped decision in `Job.buildFilter`. An advert naming four modules must come
    // back for somebody who ticked one of them.
    const one = await request(app).get('/jobs?modules=ewm');
    expect(one.text).toContain('S/4HANA EWM consultant');

    const either = await request(app).get('/jobs?modules=ewm&modules=fi-gl');
    expect(either.text).toContain('S/4HANA EWM consultant');

    const neither = await request(app).get('/jobs?modules=fi-gl');
    expect(neither.text).not.toContain('S/4HANA EWM consultant');
  });

  test('the phase filter narrows to the phase the role is scoped to', async () => {
    const realize = await request(app).get('/jobs?activate_phase=realize');
    expect(realize.text).toContain('S/4HANA EWM consultant');

    const run = await request(app).get('/jobs?activate_phase=run');
    expect(run.text).not.toContain('S/4HANA EWM consultant');
  });

  test('a search for a literal per-cent sign is not a full table scan', async () => {
    // utils/likePattern.js. The value was always bound, so nothing was injectable — but an
    // unescaped `%` asked for every row in the table.
    const res = await request(app).get('/jobs?q=%25');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('S/4HANA EWM consultant');
  });

  test('delivered modules move the match score, claimed skills do not', async () => {
    const consultantUserId = (
      await promisePool.query('SELECT id FROM users WHERE email = ?', ['ewm@example.test'])
    )[0][0].id;

    const profileForm = await consultant.get('/profile/consultant');
    await consultant
      .post('/profile/consultant')
      .type('form')
      .send({
        _csrf: csrfFrom(profileForm.text),
        headline: 'EWM and MM, ten years',
        bio: 'Warehouse and procurement work across discrete manufacturing.',
        primary_role: 's4-ewm',
        seniority: 'senior',
        years_experience: 10,
        full_lifecycles: 0, // falsy, and it must still save — see routes/profile.js
        country: 'DE',
        work_mode: 'remote',
        day_rate: 900,
        currency: 'EUR',
        availability: 'immediate',
        skills: 'EWM, MM, Fiori'
      });

    const [[saved]] = await promisePool.query(
      'SELECT full_lifecycles FROM consultant_profiles WHERE user_id = ?',
      [consultantUserId]
    );
    expect(saved.full_lifecycles).toBe(0);

    const before = await consultant.get(`/jobs/${jobSlug}`);

    const withProject = await consultant.get('/profile/consultant');
    await consultant
      .post('/profile/consultant/projects')
      .type('form')
      .send({
        _csrf: csrfFrom(withProject.text),
        name: 'Greenfield warehouse rollout',
        client: 'A manufacturer',
        product_line: 's4hana-supply-chain',
        role: 's4-ewm',
        activate_phase: 'realize',
        is_full_lifecycle: 'on',
        modules: ['ewm', 'mm-purchasing'],
        started_on: '2024-01-01',
        ended_on: '2025-01-01',
        description: 'Configured EWM end to end.'
      });

    const [projectModules] = await promisePool.query(
      `SELECT pm.module_slug FROM consultant_project_modules pm
         JOIN consultant_projects pr ON pr.id = pm.project_id WHERE pr.user_id = ?`,
      [consultantUserId]
    );
    expect(projectModules.map((m) => m.module_slug).sort()).toEqual(['ewm', 'mm-purchasing']);

    const after = await consultant.get(`/jobs/${jobSlug}`);
    const moduleTerm = (html) => Number(html.match(/>modules<\/span>\s*<strong>(\d+)<\/strong>/i)?.[1]);
    expect(moduleTerm(before.text)).toBe(0); // the job names two modules; none delivered
    expect(moduleTerm(after.text)).toBeGreaterThan(moduleTerm(before.text));
  });

  test('the talent directory finds a consultant by what they delivered', async () => {
    const page = await consultant.get('/profile/consultant');
    await consultant
      .post('/profile/consultant/visibility')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), is_public: 'on' });

    const [[profile]] = await promisePool.query(
      'SELECT is_public, completeness FROM consultant_profiles cp JOIN users u ON u.id = cp.user_id WHERE u.email = ?',
      ['ewm@example.test']
    );
    expect(profile.completeness).toBeGreaterThanOrEqual(60);
    expect(profile.is_public).toBe(1);

    /*
     * Asserted through a SIGNED-IN agent. The directory is anonymised to a reader without
     * an account — names and photographs are behind one, because most of the people in it
     * are currently working — so a logged-out request finds the row and shows "Sign in to
     * view name", which would fail this assertion for a reason that has nothing to do with
     * module matching. See tests/integration/talentAnonymity.test.js.
     *
     * And through the COMPANY's agent, not the consultant's own: the navigation prints the
     * signed-in user's name on every page, so browsing as the consultant would satisfy the
     * negative assertion below from the navbar rather than from the results.
     */
    const byModule = await company.get('/consultants?modules=ewm');
    expect(byModule.text).toContain('Delivery Person');

    const byOther = await company.get('/consultants?modules=fi-gl');
    expect(byOther.text).not.toContain('Delivery Person');
  });
});

maybe()('the rate index keeps its privacy floor', () => {
  test('an aggregate below the floor publishes a count and no figures', async () => {
    const [[user]] = await promisePool.query('SELECT id FROM users WHERE email = ?', ['ewm@example.test']);
    await promisePool.query(
      `INSERT INTO rate_submissions (user_id, role, seniority, engagement_type, country, amount, currency, amount_eur, period)
       VALUES (?, 's4-ewm', 'senior', 'contract', 'DE', 900, 'EUR', 900, DATE_FORMAT(NOW(), '%Y-%m'))`,
      [user.id]
    );

    const RateSubmission = require('../../models/RateSubmission');
    const summary = await RateSubmission.summary({ role: 's4-ewm', seniority: 'senior', country: 'DE' });

    // One person is below the n>=3 floor: the count survives, every figure is suppressed.
    expect(summary.contributors).toBe(1);
    expect(summary.suppressed).toBe(true);
    expect(summary.median).toBeNull();
    expect(summary.p25).toBeNull();
  });
});
