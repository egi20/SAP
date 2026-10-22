'use strict';

/**
 * The first-login welcome tour (config/onboarding.js): it opens by itself until
 * users.onboarded_at is stamped, never after, and every step's button leads somewhere real.
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');
const User = require('../../models/User');
const { AUDIENCES } = require('../../config/onboarding');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const PASSWORD = 'Onboard-Pass-123';
const CSRF = /name="_csrf" value="([^"]+)"/;
const META = /<meta name="csrf-token" content="([^"]+)"/;
const ACCOUNTS = { consultant: 'onb-consultant@example.test', company: 'onb-company@example.test' };
let app;

async function signIn(email) {
  const agent = request.agent(app);
  const page = await agent.get('/auth/login');
  await agent.post('/auth/login').type('form').send({ _csrf: page.text.match(CSRF)[1], email, password: PASSWORD });
  return agent;
}

beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');
  await promisePool.query('DELETE FROM users WHERE email IN (?)', [Object.values(ACCOUNTS)]);
  for (const [role, email] of Object.entries(ACCOUNTS)) {
    // eslint-disable-next-line no-await-in-loop
    const u = await User.create({ email, password: PASSWORD, name: `Onb ${role}`, roles: [role] });
    // eslint-disable-next-line no-await-in-loop
    await User.setEmailVerified(u.id);
  }
});

maybe()('welcome tour', () => {
  test('opens by itself on first sign-in, and not after it is stamped', async () => {
    const agent = await signIn(ACCOUNTS.consultant);
    const first = await agent.get('/dashboard');
    expect(first.status).toBe(200);
    expect(first.text).toContain('id="onboardingModal"');
    expect(first.text).toContain('data-auto="1"');
    expect(first.text).toContain('/js/onboarding.js');
    expect(first.text).toContain(AUDIENCES.consultant[0].title);

    const stamp = await agent.post('/dashboard/onboarded')
      .set('X-CSRF-Token', first.text.match(META)[1]).set('Sec-Fetch-Dest', 'empty').set('Accept', 'application/json');
    expect(stamp.status).toBe(200);

    const after = await agent.get('/dashboard');
    // Still rendered, so the assistant can replay it — but it no longer opens by itself.
    expect(after.text).toContain('id="onboardingModal"');
    expect(after.text).toContain('data-auto="0"');
  });

  test('a company gets the company tour', async () => {
    const agent = await signIn(ACCOUNTS.company);
    const res = await agent.get('/dashboard');
    expect(res.text).toContain(AUDIENCES.company[0].title);
    expect(res.text).not.toContain(AUDIENCES.consultant[0].title);
  });

  test('a signed-out visitor gets no tour', async () => {
    const res = await request(app).get('/');
    expect(res.text).not.toContain('id="onboardingModal"');
    expect(res.text).not.toContain('/js/onboarding.js');
  });

  test('every step of every tour opens', async () => {
    for (const role of ['consultant', 'company']) {
      // eslint-disable-next-line no-await-in-loop
      const agent = await signIn(ACCOUNTS[role]);
      for (const step of [...AUDIENCES[role], ...AUDIENCES.other]) {
        // eslint-disable-next-line no-await-in-loop
        const res = await agent.get(step.href);
        expect([200, 302]).toContain(res.status);
        if (res.status === 302) expect(res.headers.location).not.toMatch(/\/auth\/login/);
      }
    }
  });
});
