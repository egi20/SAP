'use strict';

/**
 * Taking superadmin back from the site, without a shell.
 *
 * Plain Node client: no Sec-Fetch-Dest, so a refused guard answers as a navigation (302).
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');
const User = require('../../models/User');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const OWNER = 'revoke-owner@example.test';
const COLLEAGUE = 'revoke-colleague@example.test';
const PASSWORD = 'Sup3rSecret';
const CSRF = /name="_csrf" value="([^"]+)"/;
let app;

function csrfFrom(html) {
  const match = html.match(CSRF);
  if (!match) throw new Error('No CSRF token on that page');
  return match[1];
}

async function makeSuperadmin(email) {
  const user = await User.create({ email, password: PASSWORD, name: email.split('@')[0], roles: ['admin'] });
  await User.setEmailVerified(user.id);
  await User.setSuperadmin(user.id, true);
  return user.id;
}

async function signIn(email) {
  const agent = request.agent(app);
  const page = await agent.get('/auth/login');
  await agent.post('/auth/login').type('form').send({ _csrf: csrfFrom(page.text), email, password: PASSWORD });
  return agent;
}

async function flags(id) {
  const [[row]] = await promisePool.query('SELECT is_superadmin, user_type FROM users WHERE id = ?', [id]);
  return row;
}

beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');
  await promisePool.query('DELETE FROM users WHERE email IN (?)', [[OWNER, COLLEAGUE]]);
});

maybe()('a superadmin can make another superadmin an ordinary admin', () => {
  let ownerId;
  let colleagueId;
  let owner;

  beforeAll(async () => {
    ownerId = await makeSuperadmin(OWNER);
    colleagueId = await makeSuperadmin(COLLEAGUE);
    owner = await signIn(OWNER);
  });

  test('the button is offered for a superadmin', async () => {
    const page = await owner.get(`/admin/users?q=${encodeURIComponent(COLLEAGUE)}`);
    expect(page.text).toContain(`/admin/users/${colleagueId}/revoke-superadmin`);
  });

  test('pressing it removes superadmin and keeps admin', async () => {
    const page = await owner.get('/admin/users');
    const res = await owner.post(`/admin/users/${colleagueId}/revoke-superadmin`).type('form').send({ _csrf: csrfFrom(page.text) });
    expect(res.status).toBe(302);
    const row = await flags(colleagueId);
    expect(row.is_superadmin).toBe(0);
    expect(row.user_type).toBe('admin');
  });

  test('nobody can remove their own', async () => {
    const page = await owner.get('/admin/users');
    await owner.post(`/admin/users/${ownerId}/revoke-superadmin`).type('form').send({ _csrf: csrfFrom(page.text) });
    expect((await flags(ownerId)).is_superadmin).toBe(1);
  });

  test('an ordinary admin cannot use it', async () => {
    await User.setSuperadmin(colleagueId, false);
    const colleague = await signIn(COLLEAGUE);
    const page = await colleague.get('/admin');
    await colleague.post(`/admin/users/${ownerId}/revoke-superadmin`).type('form').send({ _csrf: csrfFrom(page.text) });
    expect((await flags(ownerId)).is_superadmin).toBe(1);
  });
});
