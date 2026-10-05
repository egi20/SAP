'use strict';

/**
 * What the auth pages offer, and what "remember me" actually does.
 *
 * Most of this is markup, which is worth asserting for one reason: each of these controls
 * is a promise. A "keep me signed in" box that lengthens nothing, a show/hide button that
 * needs a script that did not load, a dropdown whose values the column rejects — all three
 * look identical to a working one.
 */

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { promisePool } = require('../../config/database');
const User = require('../../models/User');
const config = require('../../config/config');
const { SIGNUP_SOURCE_VALUES } = require('../../config/signupSources');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const OWN = ['authux@example.test'];
const PASSWORD = 'Auth-Ux-Pass-1';
const CSRF = /name="_csrf" value="([^"]+)"/;

let app;

function csrfFrom(html) {
  const match = html.match(CSRF);
  if (!match) throw new Error('No CSRF token on that page');
  return match[1];
}

/**
 * How long the browser was told to keep the session cookie, in milliseconds.
 *
 * Read from `Expires` and not `Max-Age`: express-session serialises an absolute date and
 * emits no Max-Age at all, so a helper looking for one returns null for every response and
 * the assertion fails without telling you that it never measured anything.
 */
function sessionLifetimeMs(res) {
  const cookies = res.headers['set-cookie'] || [];
  const session = cookies.find((c) => c.startsWith('saphub.sid='));
  if (!session) return null;
  const match = session.match(/Expires=([^;]+)/i);
  if (!match) return null;
  return Date.parse(match[1]) - Date.now();
}

beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');
  await promisePool.query('DELETE FROM users WHERE email IN (?)', [OWN]);
  const user = await User.create({ email: OWN[0], password: PASSWORD, name: 'Auth Ux', roles: ['consultant'] });
  await User.setEmailVerified(user.id);
});

maybe()('GET /auth/login', () => {
  it('explains itself only when somebody was sent here', async () => {
    // A permanent "log in to continue" box tells the person who came here deliberately
    // nothing they did not know.
    const direct = await request(app).get('/auth/login');
    expect(direct.text).not.toContain('Sign in to continue');

    const sent = await request(app).get('/auth/login?redirect=%2Fquotes%2Fnew');
    expect(sent.text).toContain('Sign in to continue');
    // And it carries the destination into the sign-up link, or the alternative it offers
    // loses the thing it promised to take them back to.
    expect(sent.text).toContain('/auth/register?redirect=%2Fquotes%2Fnew');
  });

  it('refuses a redirect that leaves the site', async () => {
    const res = await request(app).get('/auth/login?redirect=https%3A%2F%2Fevil.example%2Fx');
    expect(res.text).not.toContain('evil.example');
  });

  it('offers to keep somebody signed in', async () => {
    const res = await request(app).get('/auth/login');
    expect(res.text).toContain('name="remember"');
  });
});

maybe()('remember me', () => {
  async function signIn(remember) {
    const agent = request.agent(app);
    const page = await agent.get('/auth/login');
    const res = await agent.post('/auth/login').type('form').send({
      _csrf: csrfFrom(page.text), email: OWN[0], password: PASSWORD, ...(remember ? { remember: 'on' } : {})
    });
    return res;
  }

  it('lengthens the session cookie, and only that', async () => {
    const ordinary = await signIn(false);
    const remembered = await signIn(true);

    const day = config.session.cookie.maxAge;
    const month = config.session.rememberMeMaxAge;

    // A second of slack each way: the header is an absolute date, so the clock moves
    // between the server writing it and this test reading it.
    expect(sessionLifetimeMs(ordinary)).toBeLessThanOrEqual(day);
    expect(sessionLifetimeMs(ordinary)).toBeGreaterThan(day - 5000);
    expect(sessionLifetimeMs(remembered)).toBeGreaterThan(day);
    expect(sessionLifetimeMs(remembered)).toBeLessThanOrEqual(month);
    expect(sessionLifetimeMs(remembered)).toBeGreaterThan(month - 5000);
  });

  it('creates no second credential to leak, revoke or expire', () => {
    /*
     * The usual shape is a long-lived token in its own table. Here the whole feature is one
     * number on a session that already exists, which is why signing out still ends it.
     */
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'auth.js'), 'utf8');
    expect(source).toMatch(/req\.session\.cookie\.maxAge = config\.session\.rememberMeMaxAge/);
    expect(source).not.toMatch(/remember_token|remember_me_token/);
  });
});

maybe()('GET /auth/register', () => {
  it('offers the closed list of sources, and a way to decline', async () => {
    const res = await request(app).get('/auth/register');
    SIGNUP_SOURCE_VALUES.forEach((value) => {
      expect(res.text).toContain(`value="${value}"`);
    });
    // Optional means skippable, or the answer means nothing.
    expect(res.text).toContain('Rather not say');
  });

  it('stores a recognised source and drops one it does not have', async () => {
    const good = `authux-src-${Date.now()}@example.test`;
    const bad = `authux-bad-${Date.now()}@example.test`;
    try {
      await User.create({ email: good, password: PASSWORD, name: 'Src Good', roles: ['consultant'], heardAbout: 'linkedin' });
      await User.create({ email: bad, password: PASSWORD, name: 'Src Bad', roles: ['consultant'], heardAbout: 'a friend told me' });

      const [[g]] = await promisePool.query('SELECT heard_about FROM users WHERE email = ?', [good]);
      const [[b]] = await promisePool.query('SELECT heard_about FROM users WHERE email = ?', [bad]);
      expect(g.heard_about).toBe('linkedin');
      // Dropped rather than stored: the point of the column is that it can be counted.
      expect(b.heard_about).toBeNull();
    } finally {
      await promisePool.query('DELETE FROM users WHERE email IN (?)', [[good, bad]]);
    }
  });

  it('says what the account is for without a number or a testimonial', async () => {
    const res = await request(app).get('/auth/register');
    expect(res.text).toContain('Why join');
    // A figure nobody owns is a figure nobody updates.
    expect(res.text).not.toMatch(/\b\d{3,}\+?\s*(consultants|members|companies)\b/i);
  });
});

maybe()('password fields', () => {
  it('renders a wrapper the script can attach to, and no dead button without it', async () => {
    /*
     * The toggle is BUILT by public/js/main.js. A server-rendered button that needs a
     * script which failed to load is worse than no button, because the person has already
     * decided to trust what it shows them.
     */
    const res = await request(app).get('/auth/login');
    expect(res.text).toContain('password-field');
    expect(res.text).not.toContain('password-toggle');

    const js = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'main.js'), 'utf8');
    expect(js).toContain('password-toggle');
    // The state has to be announced, or an icon alone never says whether it is showing.
    expect(js).toContain('aria-pressed');
  });

  it('keeps the right autocomplete on each kind of field', async () => {
    // A browser offering the current password on a "new password" field is how somebody
    // sets their old one again.
    const login = await request(app).get('/auth/login');
    expect(login.text).toContain('autocomplete="current-password"');

    const register = await request(app).get('/auth/register');
    expect(register.text).toContain('autocomplete="new-password"');
    expect(register.text).not.toContain('autocomplete="current-password"');
  });
});

maybe()('GET /auth/forgot-password', () => {
  it('says where to look before somebody spends ten minutes refreshing', async () => {
    const res = await request(app).get('/auth/forgot-password');
    expect(res.text).toContain('spam folder');
    // And why this page cannot be more helpful than that: the reply is identical either
    // way, or the form answers "is this person registered here".
    expect(res.text).toContain('same reply either way');
  });
});

maybe()('the source list matches the schema', () => {
  it('mirrors the ENUM in migration 019', () => {
    const migration = fs.readFileSync(
      path.join(__dirname, '..', '..', 'scripts', 'migrations', '019_signup_source.sql'), 'utf8'
    );
    const match = migration.match(/heard_about ENUM\(([^)]*)\)/);
    expect(match).toBeTruthy();
    const inSchema = match[1].split(',').map((v) => v.trim().replace(/'/g, '')).filter(Boolean);
    expect(inSchema).toEqual([...SIGNUP_SOURCE_VALUES]);
  });
});
