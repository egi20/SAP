'use strict';

/**
 * The Hub's social links on /admin/settings: saved by a superadmin, rendered in the footer,
 * and refused when the address is not the platform's own.
 *
 * Plain Node client: no Sec-Fetch-Dest, so a refused guard answers as a navigation (302).
 * Other suites call AppSetting.setMany with every current value, so they keep what this
 * one saves; this suite puts the values it found back on the way in, not out.
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');
const User = require('../../models/User');
const AppSetting = require('../../models/AppSetting');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const SUPER = 'social-super@example.test';
const PASSWORD = 'Social-Test-Pass-1';
const CSRF = /name="_csrf" value="([^"]+)"/;
const LINK = 'https://www.linkedin.com/company/sap-hub-social-test/';
let app;
let before;

function csrfFrom(html) {
  const match = html.match(CSRF);
  if (!match) throw new Error('No CSRF token on that page');
  return match[1];
}

beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');
  before = await AppSetting.all();
  await promisePool.query('DELETE FROM users WHERE email = ?', [SUPER]);
  const user = await User.create({ email: SUPER, password: PASSWORD, name: 'Social Super', roles: ['consultant'] });
  await User.setEmailVerified(user.id);
  await promisePool.query("UPDATE users SET user_type = 'admin', is_superadmin = 1 WHERE id = ?", [user.id]);
});

async function signIn() {
  const agent = request.agent(app);
  const page = await agent.get('/auth/login');
  await agent.post('/auth/login').type('form').send({ _csrf: csrfFrom(page.text), email: SUPER, password: PASSWORD });
  return agent;
}

function formOf(values, overrides) {
  const out = {};
  Object.entries(values).forEach(([k, v]) => { out[k] = v === true ? 'on' : (v === false ? '' : v); });
  return { ...out, ...overrides };
}

maybe()('social links on /admin/settings', () => {
  it('offers a field per platform', async () => {
    const agent = await signIn();
    const page = await agent.get('/admin/settings');
    expect(page.status).toBe(200);
    expect(page.text).toContain('Social links');
    ['social_linkedin', 'social_instagram', 'social_tiktok', 'social_x'].forEach((k) => expect(page.text).toContain(`name="${k}"`));
  });

  it('refuses a link to another host, keeps what was typed and saves nothing', async () => {
    const agent = await signIn();
    const page = await agent.get('/admin/settings');
    const res = await agent.post('/admin/settings').type('form')
      .send({ ...formOf(await AppSetting.all(), { social_linkedin: 'https://linkedin.com.evil.example/x' }), _csrf: csrfFrom(page.text) });
    expect(res.status).toBe(422);
    expect(res.text).toContain('not LinkedIn');
    expect(res.text).toContain('value="https://linkedin.com.evil.example/x"');
    const [[row]] = await promisePool.query("SELECT setting_value FROM app_settings WHERE setting_key = 'social_linkedin'");
    expect(row ? row.setting_value : '').not.toContain('evil');
  });

  it('saves a link and the footer shows it', async () => {
    const agent = await signIn();
    const page = await agent.get('/admin/settings');
    const res = await agent.post('/admin/settings').type('form')
      .send({ ...formOf(await AppSetting.all(), { social_linkedin: LINK }), _csrf: csrfFrom(page.text) });
    expect(res.status).toBe(302);
    const contact = await request(app).get('/contact');
    expect(contact.text).toContain(`href="${LINK}"`);
    await AppSetting.setMany(formOf(before, {}));
  });
});
