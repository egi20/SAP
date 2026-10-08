'use strict';

/**
 * The tax advisory introduction, end to end.
 *
 * The page, the enquiry it produces, the one-open-per-address rule the schema holds, and
 * the retention promise — which is the only one on this site with a date in it.
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');
const User = require('../../models/User');
const Enquiry = require('../../models/Enquiry');
const taxAdvisory = require('../../config/taxAdvisory');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const PASSWORD = 'Tax-Test-Pass-1';
const OWN = ['tax-admin@example.test'];
const MARK = 'Taxtest';
const RUN = Date.now();

let app;
let adminId;
let admin;

function csrfFrom(html) {
  const m = html.match(/name="_csrf" value="([^"]+)"/);
  return m ? m[1] : '';
}

const enquiry = (over = {}) => ({
  name: `${MARK} Petra Klein`,
  email: `tax-${RUN}@example.test`,
  country: 'DE',
  arrangement: 'own_company',
  topic: 'cross_border',
  message: 'I invoice clients in two countries and I am not sure where I should be registered.',
  ...over
});

beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');
  await promisePool.query('DELETE FROM enquiries WHERE name LIKE ?', [`${MARK}%`]);
  await promisePool.query('DELETE FROM users WHERE email IN (?)', [OWN]);

  const a = await User.create({ email: OWN[0], password: PASSWORD, name: 'Tax Admin', roles: ['admin'] });
  adminId = a.id;
  await User.setEmailVerified(adminId);
  await User.adminSetRoles(adminId, ['admin'], { primary: 'admin' });
  await User.setSuperadmin(adminId, true);

  admin = request.agent(app);
  const page = await admin.get('/auth/login');
  await admin.post('/auth/login').type('form')
    .send({ _csrf: csrfFrom(page.text), email: OWN[0], password: PASSWORD });
});

/*
 * The public form was retired on 2026-10-07, when the owner put dynamicshub.net's
 * calculator and application form on /tax instead (see CLAUDE.md, "The tax programme").
 * Migration 027 stays, rows of this kind may already exist, and the retention promise made
 * to the people who sent them is still owed — so the rest of this file keeps testing the
 * queue, with its rows written through the model the way the old form wrote them.
 */
maybe()('the retired introduction form', () => {
  it('/tax is the programme page now, not the enquiry form', async () => {
    const res = await request(app).get('/tax');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="taxCalcForm"');
    expect(res.text).not.toContain('name="arrangement"');
  });

  it('takes no POST, so nothing new reaches the queue from it', async () => {
    const agent = request.agent(app);
    // A valid token, so the 404 is the route being gone rather than CSRF refusing it.
    const page = await agent.get('/tax/apply');
    const res = await agent.post('/tax').type('form')
      .send({ _csrf: csrfFrom(page.text), ...enquiry({ email: `tax-retired-${RUN}@example.test` }) });
    expect(res.status).toBe(404);
    const [[row]] = await promisePool.query('SELECT COUNT(*) AS n FROM enquiries WHERE email = ?', [
      `tax-retired-${RUN}@example.test`
    ]);
    expect(row.n).toBe(0);
  });
});

maybe()('a tax enquiry already in the queue', () => {
  it('is stored with its routing fields and its privacy stamp', async () => {
    const { PRIVACY_VERSION } = require('../../config/legal-versions');
    await Enquiry.create({ kind: 'tax_advisory', ...toModel(enquiry()), privacyVersion: PRIVACY_VERSION });

    const [[row]] = await promisePool.query('SELECT * FROM enquiries WHERE email = ?', [enquiry().email]);
    expect(row.kind).toBe('tax_advisory');
    expect(row.country).toBe('DE');
    expect(row.arrangement).toBe('own_company');
    expect(row.topic).toBe('cross_border');
    expect(row.privacy_version).not.toBeNull();
    expect(row.issue_type).toBeNull();
    expect(row.severity).toBeNull();
  });

  it('refuses a second OPEN enquiry from the same address, in the schema', async () => {
    await expect(
      Enquiry.create({ kind: 'tax_advisory', ...toModel(enquiry()) })
    ).rejects.toMatchObject({ code: 'ALREADY_OPEN' });
  });
});

maybe()('the queue and the retention', () => {
  let id;

  beforeAll(async () => {
    if (!reachable) return;
    const [[row]] = await promisePool.query('SELECT id FROM enquiries WHERE email = ?', [enquiry().email]);
    id = row.id;
  });

  it('shows up in the same queue as every other enquiry', async () => {
    const res = await admin.get('/admin/enquiries?kind=tax_advisory');
    expect(res.status).toBe(200);
    expect(res.text).toContain(`${MARK} Petra Klein`);
  });

  it('records the introduction once and never moves it', async () => {
    expect(await Enquiry.markIntroduced(id)).toBe(true);
    const [[first]] = await promisePool.query('SELECT introduced_at FROM enquiries WHERE id = ?', [id]);
    expect(first.introduced_at).not.toBeNull();

    // Set once and never cleared: a date that can be moved is one nobody can rely on.
    expect(await Enquiry.markIntroduced(id)).toBe(false);
    const [[again]] = await promisePool.query('SELECT introduced_at FROM enquiries WHERE id = ?', [id]);
    expect(again.introduced_at.getTime()).toBe(first.introduced_at.getTime());
  });

  it('keeps a closed enquiry until its retention is up, then deletes it', async () => {
    await Enquiry.setStatus(id, 'closed', adminId, null);

    // Not yet due.
    expect(await Enquiry.taxEnquiriesDueForPurge()).toBe(0);
    expect(await Enquiry.purgeExpiredTaxEnquiries()).toBe(0);

    await promisePool.query(
      'UPDATE enquiries SET handled_at = NOW() - INTERVAL ? DAY WHERE id = ?',
      [taxAdvisory.RETENTION_DAYS + 1, id]
    );

    expect(await Enquiry.taxEnquiriesDueForPurge()).toBe(1);
    expect(await Enquiry.purgeExpiredTaxEnquiries()).toBe(1);

    const [[row]] = await promisePool.query('SELECT COUNT(*) AS n FROM enquiries WHERE id = ?', [id]);
    expect(row.n).toBe(0);
  });

  it('and closing it frees the address for a new enquiry', async () => {
    // The unique key reserves one OPEN enquiry, not one ever.
    const created = await Enquiry.create({ kind: 'tax_advisory', ...toModel(enquiry()) });
    expect(created.id).toBeGreaterThan(0);
    await promisePool.query('DELETE FROM enquiries WHERE id = ?', [created.id]);
  });
});

/** The shape `Enquiry.create` wants, from the shape the form posts. */
function toModel(input) {
  return {
    name: input.name,
    email: input.email,
    subject: 'Tax advisory — test',
    body: input.message,
    topic: input.topic,
    arrangement: input.arrangement,
    country: input.country
  };
}
