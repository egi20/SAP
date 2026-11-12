'use strict';

/**
 * An administrator posts a role FOR a company account (2026-11-12, owner, as on
 * dynamicshub.net). The advert belongs to the chosen company, records who wrote it, and the
 * company is told. A company account cannot use the same field to post as somebody else.
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');
const User = require('../../models/User');
const Job = require('../../models/Job');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const ADMIN = 'ajp-admin@example.test';
const COMPANY = 'ajp-company@example.test';
const OTHER = 'ajp-other@example.test';
const CONSULTANT = 'ajp-consultant@example.test';
const PASSWORD = 'Ajp-Test-Pass-1';
const CSRF = /name="_csrf" value="([^"]+)"/;
const run = Date.now();
let app;
const ids = {};

async function signIn(email) {
  const agent = request.agent(app);
  const page = await agent.get('/auth/login');
  await agent.post('/auth/login').type('form').send({ _csrf: page.text.match(CSRF)[1], email, password: PASSWORD });
  return agent;
}

function advert(title, extra = {}) {
  return {
    title,
    description: 'A twelve-month S/4HANA finance rollout across three entities, realize to run.',
    role: 's4-fi', seniority: 'senior', engagement_type: 'contract', work_mode: 'remote', publish: 'on',
    ...extra
  };
}

beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');
  await promisePool.query('DELETE FROM users WHERE email IN (?)', [[ADMIN, COMPANY, OTHER, CONSULTANT]]);
  for (const [email, roles] of [[ADMIN, ['consultant']], [COMPANY, ['company']], [OTHER, ['company']], [CONSULTANT, ['consultant']]]) {
    // eslint-disable-next-line no-await-in-loop
    const u = await User.create({ email, password: PASSWORD, name: email.split('@')[0], roles });
    // eslint-disable-next-line no-await-in-loop
    await User.setEmailVerified(u.id);
    ids[email] = u.id;
  }
  await promisePool.query("UPDATE users SET user_type = 'admin' WHERE id = ?", [ids[ADMIN]]);
});

maybe()('admin posting a job for a company', () => {
  it('shows the company picker to an administrator and not to a company', async () => {
    const admin = await signIn(ADMIN);
    const page = await admin.get(`/jobs/new?for=${ids[COMPANY]}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('name="company_user_id"');
    expect(page.text).toContain(COMPANY);
    expect(page.text).toMatch(new RegExp(`value="${ids[COMPANY]}"\\s+selected`));

    const company = await signIn(COMPANY);
    const own = await company.get('/jobs/new');
    expect(own.status).toBe(200);
    expect(own.text).not.toContain('name="company_user_id"');

    const consultant = await signIn(CONSULTANT);
    expect((await consultant.get('/jobs/new')).status).toBe(302);
  });

  it('refuses an administrator who names no company, and writes nothing', async () => {
    const admin = await signIn(ADMIN);
    const form = await admin.get('/jobs/new');
    const title = `Ajp unnamed company ${run}`;
    const res = await admin.post('/jobs').type('form').send({ _csrf: form.text.match(CSRF)[1], ...advert(title) });
    expect(res.status).toBe(422);
    expect(res.text).toContain('Choose the company this role is posted for.');
    const [rows] = await promisePool.query('SELECT id FROM jobs WHERE title = ?', [title]);
    expect(rows).toHaveLength(0);
  });

  it('files the advert under the chosen company, records the administrator and tells the company', async () => {
    const admin = await signIn(ADMIN);
    const form = await admin.get('/jobs/new');
    const title = `Ajp posted for a company ${run}`;
    const res = await admin.post('/jobs').type('form').send({
      _csrf: form.text.match(CSRF)[1], ...advert(title), company_user_id: ids[COMPANY]
    });
    expect(res.status).toBe(302);
    const [[row]] = await promisePool.query('SELECT * FROM jobs WHERE title = ?', [title]);
    expect(row.company_user_id).toBe(ids[COMPANY]);
    expect(row.posted_by_admin_id).toBe(ids[ADMIN]);
    expect(row.status).toBe('open');
    const job = await Job.findBySlug(row.slug);
    expect(job.company_user_id).toBe(ids[COMPANY]);
    const [notes] = await promisePool.query('SELECT * FROM notifications WHERE user_id = ? AND dedupe_key = ?', [ids[COMPANY], `job-posted-for:${row.id}`]);
    expect(notes).toHaveLength(1);
  });

  it('ignores a company_user_id posted by a company account', async () => {
    const company = await signIn(COMPANY);
    const form = await company.get('/jobs/new');
    const title = `Ajp company posting as another ${run}`;
    await company.post('/jobs').type('form').send({
      _csrf: form.text.match(CSRF)[1], ...advert(title), company_user_id: ids[OTHER]
    });
    const [[row]] = await promisePool.query('SELECT company_user_id, posted_by_admin_id FROM jobs WHERE title = ?', [title]);
    expect(row.company_user_id).toBe(ids[COMPANY]);
    expect(row.posted_by_admin_id).toBeNull();
  });

  it('refuses an account without the company role as the target', async () => {
    const admin = await signIn(ADMIN);
    const form = await admin.get('/jobs/new');
    const res = await admin.post('/jobs').type('form').send({
      _csrf: form.text.match(CSRF)[1], ...advert(`Ajp to a consultant ${run}`), company_user_id: ids[CONSULTANT]
    });
    expect(res.status).toBe(422);
    expect(res.text).toContain('does not hold the company role');
  });
});
