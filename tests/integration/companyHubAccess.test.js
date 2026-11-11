'use strict';

/*
 * Company Hub offers only what the reader can open (owner, 2026-11-11). "Post a role" goes
 * to /jobs/new, guarded by the company role; offering it to anybody else sent them to a
 * refusal on the settings page.
 */
const request = require('supertest');
const { promisePool } = require('../../config/database');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);
const run = Date.now().toString(36);
let app;

function csrfFrom(html) {
  const m = html.match(/name="_csrf" value="([^"]+)"/);
  return m ? m[1] : '';
}

async function signUp(email, roles) {
  const agent = request.agent(app);
  const page = await agent.get('/auth/register');
  await agent.post('/auth/register').type('form').send({
    _csrf: csrfFrom(page.text), email, name: 'Hub Reader', password: 'Sup3rSecret',
    confirm_password: 'Sup3rSecret', user_types: roles, terms: 'on'
  });
  await promisePool.query('UPDATE users SET email_verified = 1 WHERE email = ?', [email]);
  const login = await agent.get('/auth/login');
  await agent.post('/auth/login').type('form').send({ _csrf: csrfFrom(login.text), email, password: 'Sup3rSecret' });
  return agent;
}

const POST_CARD = /href="\/jobs\/new">\s*<div class="card-body">/;
const card = (href) => new RegExp(`href="${href}">\\s*<div class="card-body">`);

maybe()('Company Hub', () => {
  beforeAll(() => {
    app = require('../../server');
  });

  test('a visitor is not offered "Post a role", and is told what would add it', async () => {
    const res = await request(app).get('/company-hub');
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(POST_CARD);
    expect(res.text).toContain('Posting a role needs a company account');
  });

  test('a consultant is pointed at the roles form instead', async () => {
    const agent = await signUp(`hub-consultant-${run}@example.test`, 'consultant');
    const res = await agent.get('/company-hub');
    expect(res.text).not.toMatch(POST_CARD);
    expect(res.text).toContain('href="/profile/settings#roles"');
  });

  test('a company account is offered it, and it opens', async () => {
    const agent = await signUp(`hub-company-${run}@example.test`, 'company');
    const res = await agent.get('/company-hub');
    expect(res.text).toMatch(POST_CARD);
    expect(res.text).not.toContain('Posting a role needs');
    expect((await agent.get('/jobs/new')).status).toBe(200);
  });
});

maybe()('Consultant Hub', () => {
  beforeAll(() => {
    app = require('../../server');
  });

  test('a visitor is sent to sign-up to build a profile', async () => {
    const res = await request(app).get('/consultant-hub');
    expect(res.text).toMatch(card('/auth/register'));
    expect(res.text).not.toContain('Building a profile needs');
  });

  test('a consultant is sent to their own profile, which opens', async () => {
    const agent = await signUp(`hub2-consultant-${run}@example.test`, 'consultant');
    const res = await agent.get('/consultant-hub');
    expect(res.text).toMatch(card('/profile/consultant'));
    expect(res.text).not.toMatch(card('/auth/register'));
    expect((await agent.get('/profile/consultant')).status).toBe(200);
  });

  test('a company account is pointed at the roles form instead', async () => {
    const agent = await signUp(`hub2-company-${run}@example.test`, 'company');
    const res = await agent.get('/consultant-hub');
    expect(res.text).not.toMatch(card('/auth/register'));
    expect(res.text).not.toMatch(card('/profile/consultant'));
    expect(res.text).toContain('Building a profile needs the consultant role');
  });
});
