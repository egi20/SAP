'use strict';

/**
 * Asking for the confirmation email again without being signed in.
 *
 * The only resend path sat behind isAuthenticated, and an unconfirmed account cannot sign
 * in — so somebody whose first email never arrived could never get a second. Plain Node
 * client throughout: no Sec-Fetch-Dest, so guards answer as for a navigation (302).
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const EMAIL = 'verify-again@example.test';
const CSRF = /name="_csrf" value="([^"]+)"/;
let app;

function csrfFrom(html) {
  const match = html.match(CSRF);
  if (!match) throw new Error('No CSRF token on that page');
  return match[1];
}

async function outstandingTokens() {
  const [[row]] = await promisePool.query(
    `SELECT COUNT(*) AS n FROM email_verifications v JOIN users u ON u.id = v.user_id
      WHERE u.email = ? AND v.consumed_at IS NULL`,
    [EMAIL]
  );
  return Number(row.n);
}

beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');
  await promisePool.query('DELETE FROM users WHERE email = ?', [EMAIL]);
});

maybe()('a confirmation link can be asked for again while signed out', () => {
  beforeAll(async () => {
    const agent = request.agent(app);
    const page = await agent.get('/auth/register');
    await agent.post('/auth/register').type('form').send({
      _csrf: csrfFrom(page.text),
      email: EMAIL,
      name: 'Verify Again',
      password: 'Sup3rSecret',
      confirm_password: 'Sup3rSecret',
      user_types: 'consultant',
      terms: 'on'
    });
  });

  test('the sign-in page offers it', async () => {
    const res = await request(app).get('/auth/login');
    expect(res.text).toContain('href="/auth/verify-again"');
  });

  test('an unconfirmed account gets a fresh token', async () => {
    const agent = request.agent(app);
    const page = await agent.get('/auth/verify-again');
    expect(page.status).toBe(200);
    const res = await agent.post('/auth/verify-again').type('form').send({ _csrf: csrfFrom(page.text), email: EMAIL });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/auth/login');
    expect(await outstandingTokens()).toBe(1);
  });

  test('an unknown address gets the same answer, so the form says nothing about who is registered', async () => {
    const known = request.agent(app);
    const p1 = await known.get('/auth/verify-again');
    await known.post('/auth/verify-again').type('form').send({ _csrf: csrfFrom(p1.text), email: EMAIL });
    const knownFlash = (await known.get('/auth/login')).text.match(/If that address[^<]+/)[0];

    const unknown = request.agent(app);
    const p2 = await unknown.get('/auth/verify-again');
    await unknown.post('/auth/verify-again').type('form').send({ _csrf: csrfFrom(p2.text), email: 'nobody-here@example.test' });
    const unknownFlash = (await unknown.get('/auth/login')).text.match(/If that address[^<]+/)[0];

    expect(unknownFlash).toBe(knownFlash);
  });
});
