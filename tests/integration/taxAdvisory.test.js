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

maybe()('GET /tax', () => {
  it('is public, and says what it will not do', async () => {
    // Most people asking how they should be set up have not signed up to anything.
    const res = await request(app).get('/tax');
    expect(res.status).toBe(200);
    taxAdvisory.PROMISE.doesNot.forEach((line) => expect(res.text).toContain(line));
  });

  it('offers no figure to type and no figure to read', async () => {
    const res = await request(app).get('/tax');
    /*
     * No box for a figure, and NO FIGURE ANYWHERE — no currency amount and no percentage.
     *
     * The first version of this forbade the word "take-home", which the page contains: in
     * the sentence saying it does not calculate one. A test that greps for a forbidden
     * string matches the sentence explaining why it is forbidden, and the tempting fix is
     * to delete the sentence.
     */
    expect(res.text).not.toMatch(/name="gross"|name="net"|name="salary"|name="day_rate"/);
    const body = res.text.slice(res.text.indexOf('<main'), res.text.indexOf('</main>'));
    expect(body).not.toMatch(/[€$£]\s?\d/);
    expect(body).not.toMatch(/\d+(\.\d+)?\s?%/);
  });
});

maybe()('POST /tax', () => {
  it('records an enquiry in the one queue, with its routing fields', async () => {
    const agent = request.agent(app);
    const form = await agent.get('/tax');
    const res = await agent.post('/tax').type('form').send({ _csrf: csrfFrom(form.text), ...enquiry() });
    expect(res.status).toBe(302);

    const [[row]] = await promisePool.query('SELECT * FROM enquiries WHERE email = ?', [enquiry().email]);
    expect(row.kind).toBe('tax_advisory');
    expect(row.country).toBe('DE');
    expect(row.arrangement).toBe('own_company');
    expect(row.topic).toBe('cross_border');
    // Stamped for this kind only: it is the one form that states what is kept and for how
    // long, so it is the one with something to record.
    expect(row.privacy_version).not.toBeNull();
    // And the fields the other two kinds own stay NULL, which the CHECK also holds.
    expect(row.issue_type).toBeNull();
    expect(row.severity).toBeNull();
  });

  it('refuses a second OPEN enquiry from the same address, in the schema', async () => {
    /*
     * The unique key on the generated `open_tax_email`, not a SELECT-then-INSERT in the
     * handler: two submissions arriving together is the ordinary case for a double-tapped
     * button, and only the database can decide which one won.
     */
    await expect(
      Enquiry.create({ kind: 'tax_advisory', ...toModel(enquiry()) })
    ).rejects.toMatchObject({ code: 'ALREADY_OPEN' });
  });

  it('refuses a country it cannot route, rather than truncating it', async () => {
    const agent = request.agent(app);
    const form = await agent.get('/tax');
    const res = await agent.post('/tax').type('form')
      .send({ _csrf: csrfFrom(form.text), ...enquiry({ email: `tax-bad-${RUN}@example.test`, country: 'ALB' }) });
    expect(res.status).toBe(422);
    expect(res.text).toMatch(/country you are taxed in/i);
  });

  it('drops a honeypot hit without saying so', async () => {
    const agent = request.agent(app);
    const form = await agent.get('/tax');
    const res = await agent.post('/tax').type('form').send({
      _csrf: csrfFrom(form.text),
      ...enquiry({ email: `tax-bot-${RUN}@example.test` }),
      website: 'http://spam.example'
    });
    // The same answer a real submission gets. Telling a bot it was caught is telling
    // whoever wrote it what to change.
    expect(res.status).toBe(302);
    const [[row]] = await promisePool.query('SELECT COUNT(*) AS n FROM enquiries WHERE email = ?', [
      `tax-bot-${RUN}@example.test`
    ]);
    expect(row.n).toBe(0);
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
