'use strict';

/**
 * The bugs a QA pass over a running install found, pinned so they cannot come back.
 *
 * Every one of these was invisible to the suite that existed: three were in a form
 * attribute or a template, one was a bound nobody had written down, and one was a clock
 * that only disagrees with itself on a machine outside UTC.
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');
const User = require('../../models/User');
const ConsultantProfile = require('../../models/ConsultantProfile');
const { boundsFor } = require('../../config/rateBounds');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const PASSWORD = 'Qa-Regress-Pass-1';
const MARK = 'QaRegress';
const OWN = [`qa-consultant-${MARK}@example.test`, `qa-company-${MARK}@example.test`];

let app;
let consultant;
let company;
let consultantId;

function csrfFrom(html) {
  const m = html.match(/name="_csrf" value="([^"]+)"/);
  return m ? m[1] : '';
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

  // Cleared on the way IN, so a run does not depend on how the last one ended.
  await promisePool.query('DELETE FROM users WHERE email IN (?, ?)', OWN);

  const c = await User.create({ email: OWN[0], password: PASSWORD, name: 'Qa Consultant', roles: ['consultant'] });
  consultantId = c.id;
  await User.setEmailVerified(consultantId);
  await ConsultantProfile.ensureExists(consultantId);

  const co = await User.create({ email: OWN[1], password: PASSWORD, name: 'Qa Company', roles: ['company'] });
  await User.setEmailVerified(co.id);

  consultant = await signIn(OWN[0]);
  company = await signIn(OWN[1]);
});

maybe()('B1/B2 — what a contributed rate is allowed to be', () => {
  async function submitRate(over = {}) {
    const page = await consultant.get('/rates/submit');
    return consultant.post('/rates/submit').type('form').send({
      _csrf: csrfFrom(page.text),
      role: 's4-fi',
      seniority: 'senior',
      engagement_type: 'contract',
      work_mode: 'remote',
      country: 'DE',
      currency: 'EUR',
      amount: '600',
      ...over
    });
  }

  it('refuses the figure that was actually stored', async () => {
    // 5 EUR/day for a senior FI consultant. It went in, and it counted.
    const res = await submitRate({ amount: '5' });
    expect(res.status).toBe(422);
    expect(res.text).toMatch(/between/);
  });

  it('refuses a figure far above any day rate', async () => {
    const res = await submitRate({ amount: '99999999' });
    expect(res.status).toBe(422);
  });

  it('accepts the round figures the form used to reject', async () => {
    /*
     * `min="1" step="10"` made 600 and 1000 invalid in the browser and 611 valid. These
     * are posted directly, so what is being pinned is the SERVER half agreeing with the
     * form half — the two describing one rule.
     */
    for (const amount of ['600', '1000', '605']) {
      // Sequential on purpose: each submission CORRECTS the last within the same month,
      // under a unique key, so posting them in parallel would race that key rather than
      // test anything.
      // eslint-disable-next-line no-await-in-loop
      const res = await submitRate({ amount });
      expect([302, 303]).toContain(res.status);
    }
  });

  it('bounds an annual salary separately from a day rate', async () => {
    // 600 is a normal day rate and an impossible salary. One range cannot bound both.
    const res = await submitRate({ engagement_type: 'permanent', amount: '600' });
    expect(res.status).toBe(422);

    const ok = await submitRate({ engagement_type: 'permanent', amount: '85000' });
    expect([302, 303]).toContain(ok.status);
  });

  it('keeps what was typed when it refuses', async () => {
    const res = await submitRate({ amount: '5', country: 'AT' });
    expect(res.status).toBe(422);
    // The country they chose is still chosen, rather than reset to the stored row.
    expect(res.text).toMatch(/value="AT"[^>]*selected|selected[^>]*value="AT"/);
  });

  it('states the same bound the server will enforce', async () => {
    const page = await consultant.get('/rates/submit');
    const { min, max } = boundsFor('contract', 'EUR');
    expect(page.text).toContain(min.toLocaleString('en-GB'));
    expect(page.text).toContain(max.toLocaleString('en-GB'));
  });
});

maybe()('B3 — a refused profile keeps what was typed, and says which field', () => {
  async function postProfile(over = {}) {
    const page = await consultant.get('/profile/consultant');
    return consultant.post('/profile/consultant').type('form').send({
      _csrf: csrfFrom(page.text),
      headline: 'QaRegress headline that should survive',
      years_experience: '8',
      city: 'QaRegressCity',
      ...over
    });
  }

  it('names the field rather than saying "Invalid value"', async () => {
    const res = await postProfile({ years_experience: '70' });
    expect(res.status).toBe(422);
    expect(res.text).toContain('Years of experience');
    expect(res.text).not.toContain('Invalid value');
  });

  it('refuses a negative year instead of dropping it in silence', async () => {
    const res = await postProfile({ years_experience: '-5' });
    expect(res.status).toBe(422);
    expect(res.text).toContain('Years of experience');
  });

  it('gives back the rest of the form', async () => {
    const res = await postProfile({ years_experience: '70' });
    expect(res.text).toContain('QaRegress headline that should survive');
    expect(res.text).toContain('QaRegressCity');
  });
});

maybe()('B4 — the URL allow-list, from the outside', () => {
  it('refuses javascript: and does not store it', async () => {
    const page = await consultant.get('/profile/consultant');
    const res = await consultant.post('/profile/consultant').type('form').send({
      _csrf: csrfFrom(page.text),
      linkedin_url: 'javascript:alert(1)'
    });
    expect(res.status).toBe(422);

    const [[row]] = await promisePool.query(
      'SELECT linkedin_url FROM consultant_profiles WHERE user_id = ?', [consultantId]
    );
    // Null, because the write never happened — not "stored and then filtered on render".
    expect(row.linkedin_url || '').not.toMatch(/javascript/i);
  });

  it('refuses a company website that is not an address', async () => {
    const page = await company.get('/profile/company');
    const res = await company.post('/profile/company').type('form').send({
      _csrf: csrfFrom(page.text),
      company_name: 'Qa Company',
      website: 'javascript:alert(1)'
    });
    expect(res.status).toBe(422);
    expect(res.text).toContain('Website');
  });
});

maybe()('B5 — one clock', () => {
  it('talks to the database in UTC', async () => {
    /*
     * The driver reads a DATETIME back as UTC (`timezone: 'Z'`). Nothing told the SERVER
     * to write one, so on a host in CEST a message sent at 16:35 displayed as 18:35 — and
     * every window computed in SQL was two hours out with nothing on screen to show it.
     */
    const [[row]] = await promisePool.query('SELECT @@session.time_zone AS tz, NOW() AS db_now');
    expect(row.tz).toBe('+00:00');
    expect(Math.abs(row.db_now.getTime() - Date.now())).toBeLessThan(10000);
  });
});
