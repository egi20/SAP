'use strict';

/**
 * What the rebuilt navbar menus rely on, as served: the user menu renders for a signed-in
 * account, the Notifications section's endpoints answer the way main.js expects, and the
 * three pages the menus added are real pages.
 *
 * Requests that main.js makes with fetch() send `Sec-Fetch-Dest: empty`, and are sent that
 * way here; a plain Node request is treated as a navigation (see CLAUDE.md).
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');
const User = require('../../models/User');
const Notification = require('../../models/Notification');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const OWN = ['navmenu-con@example.test'];
const PASSWORD = 'Nav-Menu-Pass-1';
const CSRF = /name="_csrf" value="([^"]+)"/;

let app;
let userId;

function csrfFrom(html) {
  const match = html.match(CSRF);
  if (!match) throw new Error('No CSRF token on that page');
  return match[1];
}

async function signIn(email) {
  const agent = request.agent(app);
  const page = await agent.get('/auth/login');
  await agent.post('/auth/login').type('form')
    .send({ _csrf: csrfFrom(page.text), email, password: PASSWORD });
  return agent;
}

beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');
  await promisePool.query('DELETE FROM users WHERE email IN (?)', [OWN]);
  const user = await User.create({ email: OWN[0], password: PASSWORD, name: 'Navmenu Person', roles: ['consultant'] });
  userId = user.id;
  await User.setEmailVerified(userId);
  await Notification.emit({ userId, type: 'test', title: 'Navmenu first', link: '/jobs', dedupeKey: 'navmenu:1' });
  await Notification.emit({ userId, type: 'test', title: 'Navmenu offsite', link: 'https://evil.example/x', dedupeKey: 'navmenu:2' });
  await Notification.emit({ userId, type: 'test', title: 'Navmenu protocol-relative', link: '//evil.example', dedupeKey: 'navmenu:3' });
});

maybe()('the user menu', () => {
  it('renders the profile header, the tiles and the role sections for a signed-in account', async () => {
    const agent = await signIn(OWN[0]);
    const res = await agent.get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('user-menu-dropdown');
    expect(res.text).toContain(OWN[0]);
    expect(res.text).toContain('>Consultant</span>');
    expect(res.text).toContain('dropdown-quick-links');
    expect(res.text).toContain('Sales Agent');
    expect(res.text).toContain('Sign Out');
    // Not an administrator, so no Admin Panel.
    expect(res.text).not.toContain('Admin Panel');
  });
});

maybe()('the Notifications section', () => {
  it('lists the latest with the unread count, and drops any link that leaves the site', async () => {
    const agent = await signIn(OWN[0]);
    const res = await agent.get('/notifications/recent').set('Sec-Fetch-Dest', 'empty');
    expect(res.status).toBe(200);
    expect(res.body.unread).toBe(3);
    const byTitle = Object.fromEntries(res.body.notifications.map((n) => [n.title, n]));
    expect(byTitle['Navmenu first'].link).toBe('/jobs');
    expect(byTitle['Navmenu offsite'].link).toBeNull();
    expect(byTitle['Navmenu protocol-relative'].link).toBeNull();
  });

  it('marks everything read from a fetch and answers in JSON rather than redirecting', async () => {
    const agent = await signIn(OWN[0]);
    const page = await agent.get('/notifications');
    const res = await agent.post('/notifications/read-all')
      .set('Sec-Fetch-Dest', 'empty')
      .set('X-CSRF-Token', csrfFrom(page.text));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, count: 3 });
    expect(await Notification.unreadCount(userId)).toBe(0);
  });

  it('is closed to a visitor', async () => {
    const res = await request(app).get('/notifications/recent').set('Sec-Fetch-Dest', 'empty');
    expect(res.status).toBe(401);
  });
});

maybe()('pages the menus added', () => {
  it('/tax carries the calculator, labelled indicative, and links to the application', async () => {
    const res = await request(app).get('/tax');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="taxCalcForm"');
    expect(res.text).toContain('Indicative only');
    expect(res.text).toContain('href="/tax/apply"');
  });

  it('/dedupe groups duplicates and does not let the response be cached', async () => {
    const agent = request.agent(app);
    const page = await agent.get('/dedupe');
    expect(page.status).toBe(200);
    const res = await agent.post('/dedupe').type('form').send({
      _csrf: csrfFrom(page.text),
      list: 'Anna Navtest, anna.navtest@example.com\nNAVTEST, ANNA <Anna.Navtest@example.com>\nSomebody Else'
    });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.text).toContain('anna.navtest@example.com');
    expect(res.text).toMatch(/<strong>2<\/strong> distinct/);
  });

  it('/profile/documents opens for a member and not for a visitor', async () => {
    expect((await request(app).get('/profile/documents')).status).toBe(302);
    const agent = await signIn(OWN[0]);
    const res = await agent.get('/profile/documents');
    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/profile/cv"');
  });
});
