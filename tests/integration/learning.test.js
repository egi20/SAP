'use strict';

/** /consultants/learning and /consultants/certifications, as on dynamicshub.net. */

const request = require('supertest');
const { promisePool } = require('../../config/database');
const User = require('../../models/User');
const learning = require('../../config/learning');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const EMAIL = 'learning-player@example.test';
const PASSWORD = 'Learning-Pass-123';
const CSRF = /name="_csrf" value="([^"]+)"/;
let app;
let userId;

beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');
  await promisePool.query('DELETE FROM users WHERE email = ?', [EMAIL]);
  const u = await User.create({ email: EMAIL, password: PASSWORD, name: 'Learning Player', roles: ['consultant'] });
  await User.setEmailVerified(u.id);
  userId = u.id;
});

maybe()('learning and certification practice', () => {
  it('lists the learning journeys and the practice for anybody', async () => {
    const paths = await request(app).get('/consultants/learning');
    expect(paths.status).toBe(200);
    learning.LEARNING_PATHS.forEach((p) => expect(paths.text).toContain(p.url));
    const certs = await request(app).get('/consultants/certifications');
    expect(certs.status).toBe(200);
    expect(certs.text).toContain('not real exam questions');
    learning.practiceCerts().forEach((c) => expect(certs.text).toContain(`/consultants/certifications/${c.code}/practice`));
  });

  it('asks for an account to practise, and 404s an exam it has no practice for', async () => {
    const res = await request(app).get('/consultants/certifications/C_TS4FI/practice');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/login/);
    const agent = request.agent(app);
    const page = await agent.get('/auth/login');
    await agent.post('/auth/login').type('form').send({ _csrf: page.text.match(CSRF)[1], email: EMAIL, password: PASSWORD });
    expect((await agent.get('/consultants/certifications/C_NOPE/practice')).status).toBe(404);
  });

  it('serves a session without its key, marks it on the server and shows progress', async () => {
    const agent = request.agent(app);
    const login = await agent.get('/auth/login');
    await agent.post('/auth/login').type('form').send({ _csrf: login.text.match(CSRF)[1], email: EMAIL, password: PASSWORD });

    const page = await agent.get('/consultants/certifications/C_TS4CO/practice');
    expect(page.status).toBe(200);
    const bank = learning.practiceFor('C_TS4CO').questions;
    bank.forEach((item) => expect(page.text).not.toContain(item.explain.replace(/'/g, '&#39;')));

    const served = bank.filter((item) => page.text.includes(`name="answers[${item.id}]"`));
    expect(served).toHaveLength(learning.PRACTICE_SET_SIZE);
    const body = { _csrf: page.text.match(CSRF)[1] };
    served.forEach((item) => { body[`answers[${item.id}]`] = item.options[item.answer]; });
    const res = await agent.post('/consultants/certifications/C_TS4CO/practice').type('form').send(body);
    expect(res.status).toBe(200);
    expect(res.text).toContain(`${served.length} / ${served.length}`);

    const [[row]] = await promisePool.query('SELECT score, total FROM cert_practice_attempts WHERE user_id = ? AND cert_code = ?', [userId, 'C_TS4CO']);
    expect(row).toEqual({ score: served.length, total: served.length });
    const list = await agent.get('/consultants/certifications');
    expect(list.text).toContain('Best <strong>100%</strong>');
  });
});
