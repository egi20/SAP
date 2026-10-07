'use strict';

/**
 * /tax/apply as served: what it refuses, what it stores, and who can read it.
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');
const User = require('../../models/User');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const OWN = ['taxapply-admin@example.test', 'taxapply-super@example.test'];
const APPLICANT = 'taxapply-applicant@example.test';
const BOT = 'taxapply-bot@example.test';
const PASSWORD = 'Tax-Apply-Pass-1';
const CSRF = /name="_csrf" value="([^"]+)"/;

let app;

function csrfFrom(html) {
  const match = html.match(CSRF);
  if (!match) throw new Error('No CSRF token on that page');
  return match[1];
}

async function signIn(email) {
  const agent = request.agent(app);
  const page = await agent.get('/auth/login');
  await agent.post('/auth/login').type('form').send({ _csrf: csrfFrom(page.text), email, password: PASSWORD });
  return agent;
}

const VALID = {
  fullName: 'Taxapply Person', email: APPLICANT, phone: '+49 123 456 7890',
  currentCountry: 'Germany', employmentType: 'Freelancer / Self-Employed',
  currentGrossMonthly: '8000', currentNetMonthly: '5200',
  jobTitle: 'SAP EWM Consultant', primarySkills: 'EWM, MM', agreeTerms: 'on'
};

beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');
  await promisePool.query('DELETE FROM tax_applications WHERE email IN (?)', [[APPLICANT, BOT]]);
  await promisePool.query('DELETE FROM users WHERE email IN (?)', [OWN]);
  for (const email of OWN) {
    // eslint-disable-next-line no-await-in-loop
    const u = await User.create({ email, password: PASSWORD, name: 'Taxapply Admin', roles: ['consultant'] });
    // eslint-disable-next-line no-await-in-loop
    await User.setEmailVerified(u.id);
    // eslint-disable-next-line no-await-in-loop
    await promisePool.query("UPDATE users SET user_type = 'admin', is_superadmin = ? WHERE id = ?", [email === OWN[1] ? 1 : 0, u.id]);
  }
});

maybe()('the application form', () => {
  it('names what is missing and stores nothing', async () => {
    const agent = request.agent(app);
    const page = await agent.get('/tax/apply');
    expect(page.status).toBe(200);
    const res = await agent.post('/tax/apply').type('form').send({ _csrf: csrfFrom(page.text), email: APPLICANT });
    expect(res.status).toBe(422);
    expect(res.text).toContain('is-invalid');
    const [[{ n }]] = await promisePool.query('SELECT COUNT(*) AS n FROM tax_applications WHERE email = ?', [APPLICANT]);
    expect(n).toBe(0);
  });

  it('stores a complete application with the estimate the SERVER computed', async () => {
    const agent = request.agent(app);
    const page = await agent.get('/tax/apply');
    const res = await agent.post('/tax/apply').type('form')
      .send({ _csrf: csrfFrom(page.text), ...VALID, estimatedMonthlySavings: '999999', estimatedAnnualSavings: '1' });
    expect(res.status).toBe(302);
    const [rows] = await promisePool.query('SELECT * FROM tax_applications WHERE email = ?', [APPLICANT]);
    expect(rows).toHaveLength(1);
    expect(rows[0].estimated_monthly_savings).toBe(1850);
    expect(rows[0].estimated_annual_savings).toBe(22200);
    expect(rows[0].consented_at).toBeTruthy();
  });

  it('accepts and discards a honeypot hit without saying so', async () => {
    const agent = request.agent(app);
    const page = await agent.get('/tax/apply');
    const res = await agent.post('/tax/apply').type('form')
      .send({ _csrf: csrfFrom(page.text), ...VALID, email: BOT, website: 'http://spam.example' });
    expect(res.status).toBe(302);
    const [[{ n }]] = await promisePool.query('SELECT COUNT(*) AS n FROM tax_applications WHERE email = ?', [BOT]);
    expect(n).toBe(0);
  });
});

maybe()('the queue', () => {
  it('is superadmin-only, because every row is somebody\'s salary', async () => {
    const admin = await signIn(OWN[0]);
    expect([302, 403]).toContain((await admin.get('/admin/tax-applications')).status);

    const sup = await signIn(OWN[1]);
    const list = await sup.get('/admin/tax-applications');
    expect(list.status).toBe(200);
    expect(list.text).toContain('Taxapply Person');
  });
});
