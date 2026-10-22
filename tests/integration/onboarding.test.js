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
  test('opens on the first sign-in only, never on a later one', async () => {
    const first = await signIn(ACCOUNTS.consultant);
    const landing = await first.get('/dashboard');
    expect(landing.status).toBe(200);
    expect(landing.text).toContain('id="onboardingModal"');
    expect(landing.text).toContain('data-auto="1"');
    expect(landing.text).toContain('/js/onboarding.js');
    expect(landing.text).toContain(AUDIENCES.consultant[0].title);

    // Stamped by the sign-in itself, before any script has run.
    const [[row]] = await promisePool.query('SELECT onboarded_at FROM users WHERE email = ?', [ACCOUNTS.consultant]);
    expect(row.onboarded_at).not.toBeNull();

    // Once it has opened, the rest of that visit does not open it again.
    const cleared = await first.post('/dashboard/onboarded')
      .set('X-CSRF-Token', landing.text.match(META)[1]).set('Sec-Fetch-Dest', 'empty').set('Accept', 'application/json');
    expect(cleared.status).toBe(200);
    expect((await first.get('/dashboard')).text).toContain('data-auto="0"');

    // A second sign-in — even one whose first page never ran the script — is not a first.
    const second = await signIn(ACCOUNTS.consultant);
    const again = await second.get('/dashboard');
    // Still rendered, so the assistant can open it — but never by itself.
    expect(again.text).toContain('id="onboardingModal"');
    expect(again.text).toContain('data-auto="0"');
  });

  test('there is no URL that opens it: only the assistant does', () => {
    const fs = require('fs');
    const js = fs.readFileSync(require.resolve('../../public/js/onboarding.js'), 'utf8');
    expect(js).not.toMatch(/location\.search|tour=/);
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
