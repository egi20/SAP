'use strict';

/**
 * Admin › Automated Tests: the screen, the switches and the refusals. The runner itself
 * calls the loopback, which a supertest app does not listen on; its checks are unit-tested
 * and a full run was exercised against a live server when it was written.
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');
const User = require('../../models/User');
const RegressionRun = require('../../models/RegressionRun');
const { CASES } = require('../../config/regressionTests');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const ADMIN = 'admintests-admin@example.test';
const MEMBER = 'admintests-member@example.test';
const PASSWORD = 'Admin-Tests-Pass-1';
const CSRF = /name="_csrf" value="([^"]+)"/;
const CASE = CASES.find((c) => c.category === 'SEO').name;
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
  await promisePool.query('DELETE FROM users WHERE email IN (?)', [[ADMIN, MEMBER]]);
  await promisePool.query('DELETE FROM regression_case_switches WHERE case_name = ?', [CASE]);
  for (const email of [ADMIN, MEMBER]) {
    // eslint-disable-next-line no-await-in-loop
    const u = await User.create({ email, password: PASSWORD, name: 'Admin Tests', roles: ['consultant'] });
    // eslint-disable-next-line no-await-in-loop
    await User.setEmailVerified(u.id);
    // eslint-disable-next-line no-await-in-loop
    if (email === ADMIN) await promisePool.query("UPDATE users SET user_type = 'admin' WHERE id = ?", [u.id]);
  }
});

maybe()('Admin › Automated Tests', () => {
  it('lists every category of the library with a Run button', async () => {
    const agent = await signIn(ADMIN);
    const res = await agent.get('/admin/tests');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Run all tests');
    ['Public pages', 'Sign-in guards', 'Role guards', 'SEO'].forEach((c) => expect(res.text).toContain(c));
  });

  it('switches a case off and on, and never runs a name that is not in the library', async () => {
    const agent = await signIn(ADMIN);
    let page = await agent.get('/admin/tests');
    await agent.post('/admin/tests/switch').type('form').send({ _csrf: page.text.match(CSRF)[1], case: CASE, enabled: '0' });
    expect((await RegressionRun.disabledNames()).has(CASE)).toBe(true);
    page = await agent.get('/admin/tests');
    await agent.post('/admin/tests/switch').type('form').send({ _csrf: page.text.match(CSRF)[1], case: CASE, enabled: '1' });
    expect((await RegressionRun.disabledNames()).has(CASE)).toBe(false);

    page = await agent.get('/admin/tests');
    const [[before]] = await promisePool.query('SELECT COUNT(*) AS n FROM regression_runs WHERE scope = ?', ['Category: No such category']);
    const res = await agent.post('/admin/tests/run').type('form').send({ _csrf: page.text.match(CSRF)[1], category: 'No such category' });
    expect(res.headers.location).toBe('/admin/tests');
    const [[after]] = await promisePool.query('SELECT COUNT(*) AS n FROM regression_runs WHERE scope = ?', ['Category: No such category']);
    expect(after.n).toBe(before.n);
  });

  it('is not open to a member', async () => {
    const agent = await signIn(MEMBER);
    const res = await agent.get('/admin/tests');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });

  it('shows a stored run, failures first', async () => {
    const runId = await RegressionRun.start('Integration fixture', null);
    await RegressionRun.addResult(runId, { name: 'Fixture passes', category: 'X', path: '/', outcome: 'passed', statusCode: 200, durationMs: 3 });
    await RegressionRun.addResult(runId, { name: 'Fixture fails', category: 'X', path: '/x', outcome: 'failed', statusCode: 500, durationMs: 4, message: 'Expected status 200, got 500' });
    await RegressionRun.finish(runId, 10);
    const agent = await signIn(ADMIN);
    const res = await agent.get(`/admin/tests/runs/${runId}`);
    expect(res.status).toBe(200);
    expect(res.text.indexOf('Fixture fails')).toBeLessThan(res.text.indexOf('Fixture passes'));
    expect(res.text).toContain('Expected status 200, got 500');
    const run = await RegressionRun.find(runId);
    expect(run).toMatchObject({ total: 2, passed: 1, failed: 1, state: 'finished' });
  });
});
