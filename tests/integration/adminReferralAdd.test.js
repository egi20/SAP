'use strict';

/**
 * POST /admin/referrals/add — a superadmin puts an existing account into the scheme at an
 * agreed rate; it never creates an account and never changes an existing referrer.
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');
const User = require('../../models/User');
const Referral = require('../../models/Referral');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const SUPER = 'refadd-super@example.test';
const ADMIN = 'refadd-admin@example.test';
const MEMBER = 'refadd-member@example.test';
const PASSWORD = 'Ref-Add-Pass-1';
const CSRF = /name="_csrf" value="([^"]+)"/;
let app;
let memberId;

async function signIn(email) {
  const agent = request.agent(app);
  const page = await agent.get('/auth/login');
  await agent.post('/auth/login').type('form').send({ _csrf: page.text.match(CSRF)[1], email, password: PASSWORD });
  return agent;
}

async function add(agent, body) {
  const page = await agent.get('/admin/referrals');
  return agent.post('/admin/referrals/add').type('form').send({ _csrf: page.text.match(CSRF)[1], ...body });
}

beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');
  await promisePool.query('DELETE FROM users WHERE email IN (?)', [[SUPER, ADMIN, MEMBER]]);
  for (const email of [SUPER, ADMIN, MEMBER]) {
    // eslint-disable-next-line no-await-in-loop
    const u = await User.create({ email, password: PASSWORD, name: email === MEMBER ? 'Refadd Member' : 'Refadd Admin', roles: ['consultant'] });
    // eslint-disable-next-line no-await-in-loop
    await User.setEmailVerified(u.id);
    if (email === MEMBER) memberId = u.id;
    // eslint-disable-next-line no-await-in-loop
    else await promisePool.query("UPDATE users SET user_type = 'admin', is_superadmin = ? WHERE id = ?", [email === SUPER ? 1 : 0, u.id]);
  }
});

maybe()('adding a referrer from the admin screen', () => {
  it('enrols an existing account at the rate given, and lists it', async () => {
    const agent = await signIn(SUPER);
    const res = await add(agent, { email: MEMBER, rate_percent: '12.5' });
    expect(res.status).toBe(302);
    const referrer = await Referral.findByUserId(memberId);
    expect(referrer.rate_bps).toBe(1250);
    const page = await agent.get('/admin/referrals');
    expect(page.text).toContain('Refadd Member');
    expect(page.text).toContain('People they brought in');
  });

  it('leaves an existing referrer exactly as it was', async () => {
    const agent = await signIn(SUPER);
    const before = await Referral.findByUserId(memberId);
    await add(agent, { email: MEMBER, rate_percent: '20' });
    const after = await Referral.findByUserId(memberId);
    expect(after).toMatchObject({ code: before.code, rate_bps: before.rate_bps });
  });

  it('creates nothing for an address with no account, and refuses a rate out of range', async () => {
    const agent = await signIn(SUPER);
    await add(agent, { email: 'refadd-nobody@example.test' });
    const [[{ n }]] = await promisePool.query("SELECT COUNT(*) AS n FROM users WHERE email = 'refadd-nobody@example.test'", []);
    expect(n).toBe(0);
    const res = await add(agent, { email: ADMIN, rate_percent: '45' });
    expect(res.status).toBe(302);
    const [admin] = await promisePool.query('SELECT id FROM users WHERE email = ?', [ADMIN]);
    expect(await Referral.findByUserId(admin[0].id)).toBeNull();
  });

  it('is superadmin-only', async () => {
    const agent = await signIn(ADMIN);
    const res = await agent.post('/admin/referrals/add').type('form').send({ email: MEMBER });
    expect([302, 403]).toContain(res.status);
  });
});
