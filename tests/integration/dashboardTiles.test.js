'use strict';

/**
 * The dashboard every member lands on after signing in: one tab per role, and every tile
 * a link to a page that exists. Plain Node client, so a refused guard would answer as a
 * navigation (302) — which is why the account holds every role the tabs show.
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');
const User = require('../../models/User');
const { TABS } = require('../../config/dashboard');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const ALL_ROLES = 'dashtiles-all@example.test';
const NO_ROLE = 'dashtiles-none@example.test';
const PASSWORD = 'Dash-Tiles-Pass-1';
const CSRF = /name="_csrf" value="([^"]+)"/;
let app;

async function signIn(email) {
  const agent = request.agent(app);
  const page = await agent.get('/auth/login');
  const res = await agent.post('/auth/login').type('form')
    .send({ _csrf: page.text.match(CSRF)[1], email, password: PASSWORD });
  return { agent, res };
}

beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');
  await promisePool.query('DELETE FROM users WHERE email IN (?)', [[ALL_ROLES, NO_ROLE]]);
  const all = await User.create({ email: ALL_ROLES, password: PASSWORD, name: 'Dash Tiles', roles: ['consultant', 'company', 'recruiter'] });
  await User.setEmailVerified(all.id);
  const none = await User.create({ email: NO_ROLE, password: PASSWORD, name: 'Dash Admin', roles: ['admin'] });
  await User.setEmailVerified(none.id);
});

maybe()('the dashboard', () => {
  it('greets in the banner, not in a second flash', async () => {
    const { agent, res } = await signIn(ALL_ROLES);
    expect(res.headers.location).toBe('/dashboard');
    const page = await agent.get('/dashboard');
    expect(page.text).toContain('Welcome back, Dash Tiles');
    expect(page.text.match(/Welcome back, Dash Tiles/g)).toHaveLength(1);
  });

  it('offers one tab per role held, and opens each', async () => {
    const { agent } = await signIn(ALL_ROLES);
    for (const tab of TABS) {
      // eslint-disable-next-line no-await-in-loop
      const page = await agent.get(`/dashboard?tab=${tab.key}`);
      expect(page.status).toBe(200);
      expect(page.text).toContain(`href="/dashboard?tab=${tab.key}"`);
      tab.tiles.forEach((tile) => expect(page.text).toContain(`href="${tile.href}"`));
    }
  });

  it('links every tile to a page that answers', async () => {
    const { agent } = await signIn(ALL_ROLES);
    const hrefs = [...new Set(TABS.flatMap((t) => t.tiles.map((tile) => tile.href.split('#')[0])))];
    for (const href of hrefs) {
      // eslint-disable-next-line no-await-in-loop
      const res = await agent.get(href);
      expect({ href, status: res.status }).toEqual({ href, status: res.status < 400 ? res.status : 'broken' });
    }
  });

  it('gives an account with no marketplace role more than a heading', async () => {
    const { agent } = await signIn(NO_ROLE);
    const page = await agent.get('/dashboard');
    expect(page.text).toContain('Nothing on your dashboard yet');
    expect(page.text).toContain('href="/referrals"');
    expect(page.text).toContain('Admin Panel');
    // A tab nobody here holds is never offered.
    expect(page.text).not.toContain('href="/dashboard?tab=consultant"');
  });
});
