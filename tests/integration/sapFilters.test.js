'use strict';

/**
 * The SAP-specific filters, end to end, against a real database.
 *
 * Which SAP an advert is for (migration 028): the form stores it, the board filters on it,
 * and the advert says it — run here because the column is an ENUM, and a value the form
 * offers that the ENUM refuses only fails there. And the directory's filter on one named
 * certification, whose EXISTS clause only proves itself against real SQL.
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const EMAIL = 'deploy-co@example.test';
const TERM = 'Quernwick';
const CSRF = /name="_csrf" value="([^"]+)"/;

let app;

function csrfFrom(html) {
  const match = html.match(CSRF);
  if (!match) throw new Error('No CSRF token on that page');
  return match[1];
}

beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');
  // Cleared on the way in, so a run does not depend on how the last one ended.
  await promisePool.query('DELETE FROM users WHERE email = ?', [EMAIL]);
});

maybe()('an advert names its deployment and transition', () => {
  let company;
  let slug;

  beforeAll(async () => {
    company = request.agent(app);
    const page = await company.get('/auth/register');
    await company.post('/auth/register').type('form').send({
      _csrf: csrfFrom(page.text),
      email: EMAIL,
      name: 'Deployment Company',
      password: 'Sup3rSecret',
      confirm_password: 'Sup3rSecret',
      user_types: 'company',
      terms: 'on'
    });
    await promisePool.query('UPDATE users SET email_verified = 1 WHERE email = ?', [EMAIL]);
    const login = await company.get('/auth/login');
    await company.post('/auth/login').type('form').send({
      _csrf: csrfFrom(login.text), email: EMAIL, password: 'Sup3rSecret'
    });

    const form = await company.get('/jobs/new');
    expect(form.text).toContain('name="deployment"');
    const created = await company.post('/jobs').type('form').send({
      _csrf: csrfFrom(form.text),
      title: `${TERM} RISE finance lead`,
      description: `A ${TERM} programme moving a group's finance from ECC onto S/4HANA Private Edition.`,
      role: 's4-fi',
      seniority: 'senior',
      engagement_type: 'contract',
      work_mode: 'hybrid',
      country: 'DE',
      deployment: 'private-cloud',
      transition_approach: 'brownfield',
      publish: 'on'
    });
    expect(created.status).toBe(302);
    const [[row]] = await promisePool.query('SELECT slug, deployment, transition_approach FROM jobs WHERE title LIKE ?', [
      `${TERM}%`
    ]);
    expect(row.deployment).toBe('private-cloud');
    expect(row.transition_approach).toBe('brownfield');
    slug = row.slug;
  });

  test('the board filters on it', async () => {
    const hit = await request(app).get(`/jobs?q=${TERM}&deployment=private-cloud`);
    expect(hit.text).toContain(`/jobs/${slug}`);

    const miss = await request(app).get(`/jobs?q=${TERM}&deployment=public-cloud`);
    expect(miss.text).not.toContain(`/jobs/${slug}`);

    const byApproach = await request(app).get(`/jobs?q=${TERM}&transition_approach=greenfield`);
    expect(byApproach.text).not.toContain(`/jobs/${slug}`);
  });

  test('the advert says which SAP, in words', async () => {
    const page = await request(app).get(`/jobs/${slug}`);
    expect(page.text).toContain('S/4HANA Cloud Private Edition (RISE)');
    expect(page.text).toContain('Brownfield (system conversion)');
  });

  test('a value the ENUM does not hold is refused, not stored', async () => {
    const form = await company.get('/jobs/new');
    const res = await company.post('/jobs').type('form').send({
      _csrf: csrfFrom(form.text),
      title: `${TERM} bogus deployment`,
      description: 'Should not be stored, because the deployment is not one the column holds.',
      role: 's4-fi',
      seniority: 'senior',
      engagement_type: 'contract',
      work_mode: 'remote',
      deployment: 'mainframe'
    });
    expect(res.status).toBe(422);
    const [rows] = await promisePool.query('SELECT id FROM jobs WHERE title = ?', [`${TERM} bogus deployment`]);
    expect(rows).toHaveLength(0);
  });
});

maybe()('the directory filters on one named certification', () => {
  test('the filter runs against the database and keeps its selection', async () => {
    const res = await request(app).get('/consultants?cert_code=C_TS4FI');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/<option value="C_TS4FI" selected>/);
  });

  test('an unknown code is ignored rather than refused', async () => {
    const res = await request(app).get('/consultants?cert_code=C_MADEUP');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('value="C_MADEUP"');
  });
});
