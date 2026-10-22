'use strict';

/**
 * Sales agents (migration 035): promoted from /admin/referrals?tab=agents, a personal
 * /s/<code> link that lands on sign-up, first-touch credit at registration, and no money.
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');
const User = require('../../models/User');
const SalesAgent = require('../../models/SalesAgent');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const SUPER = 'agents-super@example.test';
const AGENT = 'agents-agent@example.test';
const OTHER = 'agents-other@example.test';
const ADMIN = 'agents-admin@example.test';
const PASSWORD = 'Agents-Pass-123';
const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const CSRF = /name="_csrf" value="([^"]+)"/;
const run = Date.now();
let app;

async function signIn(email) {
  const agent = request.agent(app);
  const page = await agent.get('/auth/login');
  await agent.post('/auth/login').type('form').send({ _csrf: page.text.match(CSRF)[1], email, password: PASSWORD });
  return agent;
}

async function promote(email) {
  const sup = await signIn(SUPER);
  const page = await sup.get('/admin/referrals?tab=agents');
  return sup.post('/admin/referrals/agents/add').type('form').send({ _csrf: page.text.match(CSRF)[1], email });
}

async function register(visitor, email) {
  const page = await visitor.get('/auth/register').set('User-Agent', BROWSER);
  return visitor.post('/auth/register').set('User-Agent', BROWSER).type('form').send({
    _csrf: page.text.match(CSRF)[1], email, name: 'Agent Visitor', password: 'Sup3rSecret', confirm_password: 'Sup3rSecret',
    user_types: 'consultant', terms: 'on'
  });
}

beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');
  await promisePool.query('DELETE FROM users WHERE email IN (?) OR email LIKE ?', [[SUPER, AGENT, OTHER, ADMIN], 'agents-visitor-%@example.test']);
  for (const email of [SUPER, AGENT, OTHER, ADMIN]) {
    // eslint-disable-next-line no-await-in-loop
    const u = await User.create({ email, password: PASSWORD, name: email.split('@')[0], roles: ['consultant'] });
    // eslint-disable-next-line no-await-in-loop
    await User.setEmailVerified(u.id);
    if (email === SUPER || email === ADMIN) {
      // eslint-disable-next-line no-await-in-loop
      await promisePool.query("UPDATE users SET user_type = 'admin', is_superadmin = ? WHERE id = ?", [email === SUPER ? 1 : 0, u.id]);
    }
  }
});

maybe()('sales agents', () => {
  it('a superadmin promotes an existing account without touching its roles', async () => {
    await promote(AGENT);
    const user = await User.findByEmail(AGENT);
    const agent = await SalesAgent.findByUserId(user.id);
    expect(agent.code).toMatch(/^[A-Z0-9]{8}$/);
    expect(user.user_type).toBe('consultant');
    expect(user.is_consultant).toBe(1);
  });

  it('refuses an address with no account, and creates none', async () => {
    await promote('agents-nobody@example.test');
    expect(await User.findByEmail('agents-nobody@example.test')).toBeNull();
  });

  it('the link lands on sign-up with the code, counts a person once, and credits the sign-up', async () => {
    const agentUser = await User.findByEmail(AGENT);
    const { code } = await SalesAgent.findByUserId(agentUser.id);
    const visitor = request.agent(app);
    const first = await visitor.get(`/s/${code.toLowerCase()}`).set('User-Agent', BROWSER);
    expect(first.status).toBe(302);
    expect(first.headers.location).toBe(`/auth/register?a=${code}`);
    await visitor.get(`/s/${code}`).set('User-Agent', BROWSER);
    await request(app).get(`/s/${code}`).set('User-Agent', 'WhatsApp/2.23.20.0');
    expect((await SalesAgent.findByUserId(agentUser.id)).link_opens).toBe(1);

    // Another agent's link opened later in the same session does not take the sign-up.
    await promote(OTHER);
    const other = await SalesAgent.findByUserId((await User.findByEmail(OTHER)).id);
    await visitor.get(`/s/${other.code}`).set('User-Agent', BROWSER);

    const email = `agents-visitor-${run}@example.test`;
    await register(visitor, email);
    expect((await User.findByEmail(email)).sales_agent_id).toBe(agentUser.id);

    const sup = await signIn(SUPER);
    const page = await sup.get('/admin/referrals?tab=agents');
    expect(page.status).toBe(200);
    expect(page.text).toContain(`/s/${code}`);
    expect(page.text).toContain(email);
    expect(page.text).toContain('No agent link');
  });

  it("the agent sees their link and who came through it on the dashboard, without email addresses", async () => {
    const agentUser = await User.findByEmail(AGENT);
    const { code } = await SalesAgent.findByUserId(agentUser.id);
    const me = await signIn(AGENT);
    const res = await me.get('/dashboard?tab=agent');
    expect(res.status).toBe(200);
    expect(res.text).toContain(`/s/${code}`);
    expect(res.text).toContain('Came from your link');
    expect(res.text).toContain('Agent Visitor');
    expect(res.text).not.toContain(`agents-visitor-${run}@example.test`);
    // Somebody who is not an agent gets the tab without the section.
    const other = await signIn(SUPER);
    expect((await other.get('/dashboard?tab=agent')).text).not.toContain('Your sign-up link');
  });

  it('a paused agent credits nothing and an unknown code still reaches sign-up', async () => {
    const otherUser = await User.findByEmail(OTHER);
    const { code } = await SalesAgent.findByUserId(otherUser.id);
    await SalesAgent.setActive(otherUser.id, false);
    const visitor = request.agent(app);
    const res = await visitor.get(`/s/${code}`).set('User-Agent', BROWSER);
    expect(res.headers.location).toBe('/auth/register');
    const email = `agents-visitor-paused-${run}@example.test`;
    await register(visitor, email);
    expect((await User.findByEmail(email)).sales_agent_id).toBeNull();
    expect((await request(app).get('/s/NOTACODE')).headers.location).toBe('/auth/register');
  });

  it('is superadmin-only', async () => {
    const admin = await signIn(ADMIN);
    expect((await admin.get('/admin/referrals?tab=agents')).headers.location).toBe('/');
  });
});
