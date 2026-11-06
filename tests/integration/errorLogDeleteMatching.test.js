'use strict';

/**
 * Deleting the error-log entries a filter shows (2026-11-06). It removes exactly the rows the
 * screen listed, refuses without a filter, refuses when the count shown is stale, and is
 * superadmin-only.
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');
const User = require('../../models/User');
const ErrorLog = require('../../models/ErrorLog');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const PASSWORD = 'ErrDelete-Test-Pass-1';
const SUPER = 'errdel-super@example.test';
const ADMIN = 'errdel-admin@example.test';
const run = Date.now();
const MARK = `errdel-${run}`;
let app;

function csrfFrom(html) {
  const m = html.match(/name="_csrf" value="([^"]+)"/);
  return m ? m[1] : '';
}

async function signIn(email) {
  const agent = request.agent(app);
  const page = await agent.get('/auth/login');
  await agent.post('/auth/login').type('form').send({ _csrf: csrfFrom(page.text), email, password: PASSWORD });
  return agent;
}

async function seed(n, message) {
  for (let i = 0; i < n; i += 1) {
    await promisePool.query(
      'INSERT INTO error_logs (message, method, path, status_code) VALUES (?, ?, ?, ?)',
      [message, 'POST', `/graphql?${MARK}`, 403]
    );
  }
}

async function count(message) {
  const [[{ n }]] = await promisePool.query('SELECT COUNT(*) AS n FROM error_logs WHERE message = ?', [message]);
  return Number(n);
}

beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');
  await promisePool.query('DELETE FROM users WHERE email IN (?)', [[SUPER, ADMIN]]);
  for (const email of [SUPER, ADMIN]) {
    const u = await User.create({ email, password: PASSWORD, name: 'Errdel', roles: ['admin'] });
    await User.setEmailVerified(u.id);
    await promisePool.query("UPDATE users SET user_type = 'admin', is_superadmin = ? WHERE id = ?", [email === SUPER ? 1 : 0, u.id]);
  }
});

maybe()('deleting the entries a filter shows', () => {
  it('model: refuses without a filter, and on a stale count deletes nothing', async () => {
    const msg = `${MARK} model`;
    await seed(3, msg);
    await expect(ErrorLog.deleteMatching({}, 3)).rejects.toMatchObject({ code: 'ERROR_LOG_NO_FILTER' });
    await expect(ErrorLog.deleteMatching({ q: msg }, 2)).rejects.toMatchObject({ code: 'ERROR_LOG_COUNT_MISMATCH' });
    expect(await count(msg)).toBe(3);
    expect(await ErrorLog.deleteMatching({ q: msg }, 3)).toBe(3);
    expect(await count(msg)).toBe(0);
  });

  it('a superadmin sees the button on a filtered page and it deletes only those rows', async () => {
    const target = `${MARK} target`;
    const keep = `${MARK} keep`;
    await seed(2, target);
    await seed(1, keep);
    const sup = await signIn(SUPER);
    const page = await sup.get(`/admin/errors?q=${encodeURIComponent(target)}`);
    expect(page.text).toContain('Delete these 2');
    const res = await sup.post('/admin/errors/delete-matching').type('form')
      .send({ _csrf: csrfFrom(page.text), q: target, expected_count: 2 });
    expect(res.status).toBe(302);
    expect(await count(target)).toBe(0);
    expect(await count(keep)).toBe(1);
    expect((await sup.get('/admin/errors')).text).not.toContain('Delete these');
  });

  it('an ordinary admin gets no button and the guard refuses the post', async () => {
    const msg = `${MARK} admin`;
    await seed(1, msg);
    const adm = await signIn(ADMIN);
    const page = await adm.get(`/admin/errors?q=${encodeURIComponent(msg)}`);
    expect(page.text).not.toContain('Delete these');
    const res = await adm.post('/admin/errors/delete-matching').type('form')
      .send({ _csrf: csrfFrom(page.text), q: msg, expected_count: 1 });
    expect(res.headers.location).toBe('/');
    expect(await count(msg)).toBe(1);
  });
});
