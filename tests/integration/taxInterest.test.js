'use strict';

/**
 * Who opens /tax: the three steps are recorded, a signed-in visit carries the account, a
 * crawler is not counted, the calculator beacon carries no figures, and the names reach a
 * superadmin only.
 *
 * Plain Node clients send no browser user-agent, and the recorder ignores anything that does
 * not look like a browser — so every request here sends one, deliberately.
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');
const User = require('../../models/User');
const TaxInterest = require('../../models/TaxInterest');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const ADMIN = 'taxinterest-admin@example.test';
const SUPER = 'taxinterest-super@example.test';
const MEMBER = 'taxinterest-member@example.test';
const PASSWORD = 'Tax-Interest-Pass-1';
const BROWSER = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const CSRF = /name="_csrf" value="([^"]+)"/;
const META = /name="csrf-token" content="([^"]+)"/;

let app;
let memberId;

async function signIn(email) {
  const agent = request.agent(app);
  const page = await agent.get('/auth/login').set('User-Agent', BROWSER);
  await agent.post('/auth/login').set('User-Agent', BROWSER).type('form')
    .send({ _csrf: page.text.match(CSRF)[1], email, password: PASSWORD });
  return agent;
}

async function rowsFor(userId) {
  const [rows] = await promisePool.query(
    'SELECT step, views FROM tax_interest_views WHERE user_id = ? ORDER BY step', [userId]
  );
  return Object.fromEntries(rows.map((r) => [r.step, r.views]));
}


beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');
  await promisePool.query('DELETE FROM users WHERE email IN (?)', [[ADMIN, SUPER, MEMBER]]);
  for (const email of [ADMIN, SUPER, MEMBER]) {
    // eslint-disable-next-line no-await-in-loop
    const u = await User.create({ email, password: PASSWORD, name: email === MEMBER ? 'Taxinterest Member' : 'Taxinterest Admin', roles: ['consultant'] });
    // eslint-disable-next-line no-await-in-loop
    await User.setEmailVerified(u.id);
    if (email === MEMBER) memberId = u.id;
    // eslint-disable-next-line no-await-in-loop
    else await promisePool.query("UPDATE users SET user_type = 'admin', is_superadmin = ? WHERE id = ?", [email === SUPER ? 1 : 0, u.id]);
  }
});

maybe()('recording the tax funnel', () => {
  it('names a signed-in member at each step, and counts repeats as views', async () => {
    const agent = await signIn(MEMBER);
    const page = await agent.get('/tax').set('User-Agent', BROWSER);
    expect(page.status).toBe(200);
    await agent.get('/tax').set('User-Agent', BROWSER);
    const res = await agent.post('/tax/calculated').set('User-Agent', BROWSER).set('X-CSRF-Token', page.text.match(META)[1]);
    expect(res.status).toBe(204);
    await agent.get('/tax/apply').set('User-Agent', BROWSER);
    await new Promise((r) => setTimeout(r, 150));
    expect(await rowsFor(memberId)).toEqual({ landing: 2, calculator: 1, apply: 1 });
  });

  it('does not count a crawler', async () => {
    const before = await rowsFor(memberId);
    const agent = await signIn(MEMBER);
    await agent.get('/tax').set('User-Agent', 'Googlebot/2.1 (+http://www.google.com/bot.html)');
    await new Promise((r) => setTimeout(r, 150));
    expect(await rowsFor(memberId)).toEqual(before);
  });

  it('refuses the calculator beacon without a CSRF token', async () => {
    const res = await request(app).post('/tax/calculated').set('User-Agent', BROWSER);
    // A plain client reads as a navigation, so the CSRF refusal is a redirect, not a 403.
    expect(res.status).not.toBe(204);
    expect([302, 403]).toContain(res.status);
  });

  it('never sends what was typed into the calculator', () => {
    const fs = require('fs');
    const source = fs.readFileSync(require.resolve('../../public/js/tax.js'), 'utf8');
    const start = source.indexOf("'/tax/calculated'");
    const beacon = source.slice(start, source.indexOf('.catch', start));
    expect(beacon).not.toMatch(/\bbody\s*:/);
  });

  it('ignores a step that is not one of the three', async () => {
    expect(await TaxInterest.record('checkout', memberId)).toBe(false);
  });
});

maybe()('the panel on /admin/analytics', () => {
  it('shows a superadmin who opened it, with how far they got', async () => {
    const agent = await signIn(SUPER);
    const res = await agent.get('/admin/analytics').set('User-Agent', BROWSER);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Tax optimisation — who opens it');
    expect(res.text).toContain('Taxinterest Member');
    expect(res.text).toContain('Opened the application form');
  });

  it('shows an ordinary administrator the counts and not the names', async () => {
    const agent = await signIn(ADMIN);
    const res = await agent.get('/admin/analytics').set('User-Agent', BROWSER);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Tax optimisation — who opens it');
    expect(res.text).not.toContain(MEMBER);
    expect(res.text).toContain('visible to superadmins only');
  });
});
