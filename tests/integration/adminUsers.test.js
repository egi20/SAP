'use strict';

/**
 * /admin/users at parity with the reference: search by id, the three filters, paging,
 * the Dedupe switch, and "Delete" — which is AccountClosure run by an administrator.
 *
 * Plain Node client: no Sec-Fetch-Dest, so a refused guard answers as a navigation (302).
 * Every assertion is scoped to accounts this suite created (the `adm-users-` prefix);
 * nothing here counts rows it does not own.
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');
const User = require('../../models/User');
const ConsultantProfile = require('../../models/ConsultantProfile');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const PREFIX = 'adm-users-';
const DOMAIN = '@example.test';
const PASSWORD = 'Sup3rSecret';
const CSRF = /name="_csrf" value="([^"]+)"/;
let app;

const email = (tag) => `${PREFIX}${tag}${DOMAIN}`;

function csrfFrom(html) {
  const match = html.match(CSRF);
  if (!match) throw new Error('No CSRF token on that page');
  return match[1];
}

async function make(tag, roles = ['consultant'], name = 'Ana Kola') {
  const user = await User.create({ email: email(tag), password: PASSWORD, name, roles });
  await User.setEmailVerified(user.id);
  return user.id;
}

async function signIn(tag) {
  const agent = request.agent(app);
  const page = await agent.get('/auth/login');
  await agent.post('/auth/login').type('form').send({ _csrf: csrfFrom(page.text), email: email(tag), password: PASSWORD });
  return agent;
}

async function row(id) {
  const [[r]] = await promisePool.query(
    'SELECT email, is_active, closed_at, dedupe_access, is_superadmin FROM users WHERE id = ?',
    [id]
  );
  return r;
}

// The ids a page lists among this suite's accounts, read from the row checkboxes' labels
// and the ID cells — whichever the viewer has.
function listedEmails(html) {
  return [...html.matchAll(/<td>\s*(adm-users-[^\s<]+)/g)].map((m) => m[1]);
}

beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');
  // Fixtures are cleared on the way IN; closed ones carry a tombstone address, so they are
  // found by the name this suite gives them instead.
  await promisePool.query("DELETE FROM users WHERE email LIKE 'adm-users-%' OR name LIKE 'AdmUsers %'");
});

maybe()('the admin user list', () => {
  let superAgent;
  let adminAgent;
  const ids = {};

  beforeAll(async () => {
    ids.owner = await make('owner', ['admin'], 'AdmUsers Owner');
    await User.setSuperadmin(ids.owner, true);
    ids.plainAdmin = await make('plainadmin', ['admin'], 'AdmUsers Plain');
    ids.company = await make('company', ['company'], 'AdmUsers Company');
    ids.listed = await make('listed', ['consultant'], 'AdmUsers Listed');
    ids.unlisted = await make('unlisted', ['consultant'], 'AdmUsers Unlisted');
    ids.inactive = await make('inactive', ['consultant'], 'AdmUsers Inactive');
    await User.setActive(ids.inactive, false);

    // Listed by the directory's own conditions — a published profile on an active account.
    await ConsultantProfile.ensureExists(ids.listed);
    await promisePool.query('UPDATE consultant_profiles SET is_public = 1 WHERE user_id = ?', [ids.listed]);
    await ConsultantProfile.ensureExists(ids.unlisted);

    superAgent = await signIn('owner');
    adminAgent = await signIn('plainadmin');
  });

  test('the dashboard: headline figures, grouped quick actions, system info', async () => {
    const page = await superAgent.get('/admin');
    ['Total Users', 'Consultants', 'Total Jobs', 'Active Jobs', 'Quick Actions', 'Users &amp; Talent',
      'Coming soon', 'System Info', process.version].forEach((text) => expect(page.text).toContain(text));
    expect(page.text).toContain('href="/admin/rates"');
    // An ordinary admin is not offered a screen that would answer 403.
    const plain = await adminAgent.get('/admin');
    expect(plain.text).toContain('Quick Actions');
    expect(plain.text).not.toContain('href="/admin/rates"');
    expect(plain.text).not.toContain('href="/crm"');
  });

  test('has the reference columns, the back link and the search placeholder', async () => {
    const page = await superAgent.get(`/admin/users?q=${PREFIX}`);
    expect(page.status).toBe(200);
    ['First Name', 'Last Name', 'Talent', 'Dedupe', 'Last Login', 'Registered', 'Back to Dashboard', 'Manage platform users']
      .forEach((text) => expect(page.text).toContain(text));
    expect(page.text).toContain('placeholder="Search by email or ID..."');
    expect(page.text).toContain(`aria-label="Select user ${email('listed')}"`);
  });

  test('an all-digit search finds that account by id', async () => {
    const page = await superAgent.get(`/admin/users?q=${ids.company}`);
    expect(listedEmails(page.text)).toContain(email('company'));
  });

  test('the user type filter', async () => {
    const page = await superAgent.get(`/admin/users?q=${PREFIX}&role=company`);
    expect(listedEmails(page.text)).toEqual([email('company')]);
  });

  test('the status filter', async () => {
    const inactive = await superAgent.get(`/admin/users?q=${PREFIX}&status=inactive`);
    expect(listedEmails(inactive.text)).toEqual([email('inactive')]);
    const active = await superAgent.get(`/admin/users?q=${PREFIX}&status=active`);
    expect(listedEmails(active.text)).not.toContain(email('inactive'));
  });

  test('the talent filter uses the directory rule', async () => {
    const listed = await superAgent.get(`/admin/users?q=${PREFIX}&talent=listed`);
    expect(listedEmails(listed.text)).toEqual([email('listed')]);
    const hidden = listedEmails((await superAgent.get(`/admin/users?q=${PREFIX}&talent=hidden`)).text);
    expect(hidden).toEqual(expect.arrayContaining([email('unlisted'), email('inactive')]));
    expect(hidden).not.toContain(email('listed'));
    expect(hidden).not.toContain(email('company'));
  });

  test('pages in twenties, keeping the filter in the links', async () => {
    for (let i = 0; i < 21; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await make(`page${String(i).padStart(2, '0')}`, ['partner'], 'AdmUsers Pager');
    }
    const first = await superAgent.get(`/admin/users?q=${PREFIX}page&role=partner`);
    expect(listedEmails(first.text)).toHaveLength(20);
    expect(first.text).toContain('Showing 20 of 21 user(s)');
    expect(first.text).toContain(`href="/admin/users?q=${PREFIX}page&amp;role=partner&amp;page=2"`);
    const second = await superAgent.get(`/admin/users?q=${PREFIX}page&role=partner&page=2`);
    expect(listedEmails(second.text)).toHaveLength(1);
  });

  test('an admin flips Dedupe access, and comes back to the same filter', async () => {
    const page = await adminAgent.get('/admin/users');
    const res = await adminAgent.post(`/admin/users/${ids.listed}/dedupe-access`).type('form')
      .send({ _csrf: csrfFrom(page.text), allow: '1', redirectTo: `/admin/users?q=${PREFIX}` });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/admin/users?q=${PREFIX}`);
    expect((await row(ids.listed)).dedupe_access).toBe(1);
    await adminAgent.post(`/admin/users/${ids.listed}/dedupe-access`).type('form')
      .send({ _csrf: csrfFrom(page.text), allow: '0' });
    expect((await row(ids.listed)).dedupe_access).toBe(0);
  });

  test('an ordinary admin cannot delete anybody', async () => {
    const page = await adminAgent.get('/admin/users');
    expect(page.text).not.toContain('Confirm Delete User');
    await adminAgent.post(`/admin/users/${ids.unlisted}/delete`).type('form').send({ _csrf: csrfFrom(page.text) });
    expect((await row(ids.unlisted)).closed_at).toBeNull();
  });

  test('nobody deletes their own account', async () => {
    const page = await superAgent.get('/admin/users');
    await superAgent.post(`/admin/users/${ids.owner}/delete`).type('form').send({ _csrf: csrfFrom(page.text) });
    const me = await row(ids.owner);
    expect(me.closed_at).toBeNull();
    expect(me.is_active).toBe(1);
  });

  test('delete closes the account: identity erased, row kept', async () => {
    const page = await superAgent.get('/admin/users');
    const res = await superAgent.post(`/admin/users/${ids.company}/delete`).type('form')
      .send({ _csrf: csrfFrom(page.text), redirectTo: `/admin/users?q=${PREFIX}` });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/admin/users?q=${PREFIX}`);
    const closed = await row(ids.company);
    expect(closed).toBeDefined();
    expect(closed.closed_at).not.toBeNull();
    expect(closed.is_active).toBe(0);
    expect(closed.email).toBe(`closed-${ids.company}@accounts.invalid`);
    // Out of the default list, and in the closed one.
    const list = await superAgent.get(`/admin/users?q=${ids.company}`);
    expect(list.text).not.toContain(`/admin/users/${ids.company}/delete`);
    const tomb = await superAgent.get(`/admin/users?q=${ids.company}&status=closed`);
    expect(tomb.text).toContain(`closed-${ids.company}@accounts.invalid`);
  });

  test('bulk delete closes every selected account, and refuses a changed selection', async () => {
    const a = await make('bulk-a', ['consultant'], 'AdmUsers BulkA');
    const b = await make('bulk-b', ['consultant'], 'AdmUsers BulkB');
    const page = await superAgent.get('/admin/users');
    const token = csrfFrom(page.text);

    await superAgent.post('/admin/users/bulk-delete').type('form')
      .send({ _csrf: token, ids: [String(a), String(b)], expected: '1' });
    expect((await row(a)).closed_at).toBeNull();
    expect((await row(b)).closed_at).toBeNull();

    await superAgent.post('/admin/users/bulk-delete').type('form')
      .send({ _csrf: token, ids: [String(a), String(b)], expected: '2' });
    expect((await row(a)).closed_at).not.toBeNull();
    expect((await row(b)).closed_at).not.toBeNull();
  });

  test('bulk delete skips the account doing it, and closes the rest', async () => {
    const c = await make('bulk-c', ['consultant'], 'AdmUsers BulkC');
    const page = await superAgent.get('/admin/users');
    await superAgent.post('/admin/users/bulk-delete').type('form')
      .send({ _csrf: csrfFrom(page.text), ids: [String(ids.owner), String(c)], expected: '2' });
    expect((await row(ids.owner)).closed_at).toBeNull();
    expect((await row(c)).closed_at).not.toBeNull();
  });

  test('a superadmin may delete another administrator', async () => {
    const page = await superAgent.get('/admin/users');
    await superAgent.post(`/admin/users/${ids.plainAdmin}/delete`).type('form').send({ _csrf: csrfFrom(page.text) });
    expect((await row(ids.plainAdmin)).closed_at).not.toBeNull();
  });
});
