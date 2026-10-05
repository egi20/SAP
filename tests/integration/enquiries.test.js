'use strict';

/**
 * The contact form, the issue reporter and the queue behind them.
 *
 * /contact shipped as an address alone with a note saying why: a form needs somewhere to
 * put what it collects, a spam defence and somebody watching a queue, and until all three
 * exist a form is the version that can silently drop a message while both sides believe it
 * was sent. These tests are that note, turned into assertions — most of them are about the
 * message ARRIVING, because that is the whole claim.
 */

const request = require('supertest');
const fs = require('fs');
const path = require('path');
const { promisePool } = require('../../config/database');
const User = require('../../models/User');
const Enquiry = require('../../models/Enquiry');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const OWN = ['enq-admin@example.test'];
const CSRF = /name="_csrf" value="([^"]+)"/;
const SUBJECT = 'Enqtest the EWM filter returns nothing';
const BODY = 'When I tick EWM on the jobs page the list empties, and I expected it to widen.';

let app;
let adminAgent;

function csrfFrom(html) {
  const match = html.match(CSRF);
  if (!match) throw new Error('No CSRF token on that page');
  return match[1];
}

/** Everything this suite wrote, scoped by the subject it owns. */
async function ownEnquiries() {
  const [rows] = await promisePool.query(
    'SELECT * FROM enquiries WHERE subject LIKE ? ORDER BY id DESC',
    ['Enqtest%']
  );
  return rows;
}

beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');
  await promisePool.query('DELETE FROM enquiries WHERE subject LIKE ?', ['Enqtest%']);
  await promisePool.query('DELETE FROM users WHERE email IN (?)', [OWN]);

  const admin = await User.create({
    email: OWN[0], password: 'Enq-Test-Pass-1', name: 'Enq Admin', roles: ['admin']
  });
  await User.setEmailVerified(admin.id);
  await User.adminSetRoles(admin.id, ['admin'], { primary: 'admin' });

  adminAgent = request.agent(app);
  const login = await adminAgent.get('/auth/login');
  await adminAgent.post('/auth/login').type('form').send({
    _csrf: csrfFrom(login.text), email: OWN[0], password: 'Enq-Test-Pass-1'
  });
});

maybe()('POST /contact', () => {
  it('stores what a person wrote, signed out', async () => {
    const agent = request.agent(app);
    const page = await agent.get('/contact');
    const res = await agent.post('/contact').type('form').send({
      _csrf: csrfFrom(page.text),
      name: 'Ana Pjetri', email: 'ana@example.test', subject: SUBJECT, message: BODY, website: ''
    });
    expect(res.status).toBe(302);

    const [row] = await ownEnquiries();
    expect(row.kind).toBe('contact');
    expect(row.body).toBe(BODY);
    // Not asked for, so NULL rather than defaulted — "not asked" and "answered with the
    // first option" are different facts about the same column, and the CHECK agrees.
    expect(row.issue_type).toBeNull();
    expect(row.severity).toBeNull();
  });

  it('refuses a message too short to answer, and says what it needs', async () => {
    const agent = request.agent(app);
    const page = await agent.get('/contact');
    const res = await agent.post('/contact').type('form').send({
      _csrf: csrfFrom(page.text),
      name: 'Ana Pjetri', email: 'ana@example.test', subject: 'Enqtest short', message: 'hi'
    });
    // 422 and the form back with the reason — not a redirect that looks like success.
    expect(res.status).toBe(422);
    expect(res.text).toContain('twenty characters at least');
  });

  it('applies its validators rather than merely declaring them', async () => {
    // The reference puts rules on a route and never calls validationResult, which makes
    // every rule decorative and lets a 10,000-character value reach the column.
    const agent = request.agent(app);
    const page = await agent.get('/contact');
    const res = await agent.post('/contact').type('form').send({
      _csrf: csrfFrom(page.text),
      name: 'A', email: 'not-an-email', subject: '', message: 'x'
    });
    expect(res.status).toBe(422);
  });

  it('needs a CSRF token like every other form, and answers in the shape of the request', async () => {
    /*
     * Both halves, deliberately, because the status depends on the caller and not on the
     * failure: middleware/errorHandler.js sends a navigation to a flash and a redirect, and
     * a background fetch a 403 JSON body. A plain Node client sends no Sec-Fetch-Dest, so
     * it is read as a navigation — which is why asserting 403 here failed the first time
     * for a reason that had nothing to do with CSRF. See CLAUDE.md.
     */
    const asNavigation = await request(app).post('/contact').type('form').send({
      name: 'Ana', email: 'ana@example.test', subject: 'Enqtest csrf', message: BODY
    });
    expect(asNavigation.status).toBe(302);

    const asFetch = await request(app).post('/contact')
      .set('Sec-Fetch-Dest', 'empty')
      .type('form')
      .send({ name: 'Ana', email: 'ana@example.test', subject: 'Enqtest csrf', message: BODY });
    expect(asFetch.status).toBe(403);

    // Neither reached the table, which is the part that matters.
    const stored = await ownEnquiries();
    expect(stored.some((r) => r.subject === 'Enqtest csrf')).toBe(false);
  });

  it('accepts and discards a honeypot hit without saying so', async () => {
    /*
     * The one case where this form drops a message on purpose. Telling a bot it was caught
     * is telling whoever wrote it what to change — so the response is the same as a
     * success, and nothing is stored.
     */
    const before = (await ownEnquiries()).length;
    const agent = request.agent(app);
    const page = await agent.get('/contact');
    const res = await agent.post('/contact').type('form').send({
      _csrf: csrfFrom(page.text),
      name: 'Spam Bot', email: 'bot@example.test', subject: 'Enqtest honeypot', message: BODY,
      website: 'http://buy-things.example'
    });
    expect(res.status).toBe(302);
    expect((await ownEnquiries()).length).toBe(before);
  });

  it('is rate limited, per IP and across both forms', () => {
    /*
     * Asserted against the SOURCE rather than by sending eleven messages. Exercising the
     * limit would spend the budget this suite's other cases need, and then the first test
     * to be reordered would fail as a CSRF or validation error for a reason that has
     * nothing to do with either — which is exactly how this suite failed the first time.
     *
     * Keyed on the IP and never on the session: with saveUninitialized: false a cookie-less
     * flood gets a fresh session id every request, so a session-keyed counter never
     * accumulates. That is what `ipLimiter` is.
     */
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'index.js'), 'utf8');
    expect(source).toMatch(/const enquiryLimiter = ipLimiter\(/);
    expect(source).toMatch(/ENQUIRY_MAX_PER_WINDOW = 10/);
    // Both forms, or the cheaper one is an open door to the same table.
    expect(source).toMatch(/'\/contact',\s*\n\s*enquiryLimiter/);
    expect(source).toMatch(/'\/report-issue',\s*\n\s*enquiryLimiter/);
  });

  it('hides the honeypot from people and from assistive technology', async () => {
    const res = await request(app).get('/contact');
    expect(res.text).toMatch(/aria-hidden="true"[\s\S]{0,200}name="website"/);
    expect(res.text).toContain('tabindex="-1"');
  });
});

maybe()('POST /report-issue', () => {
  it('stores the three fields that make a report answerable', async () => {
    const agent = request.agent(app);
    const page = await agent.get('/report-issue');
    const res = await agent.post('/report-issue').type('form').send({
      _csrf: csrfFrom(page.text),
      name: 'Ana Pjetri', email: 'ana@example.test',
      subject: 'Enqtest issue report', message: BODY,
      issue_type: 'bug', severity: 'high', page_url: 'https://example.test/jobs?modules=ewm'
    });
    expect(res.status).toBe(302);

    const [row] = await ownEnquiries();
    expect(row.kind).toBe('issue');
    expect(row.issue_type).toBe('bug');
    expect(row.severity).toBe('high');
    expect(row.page_url).toContain('/jobs');
  });

  it('refuses an issue type it does not have', async () => {
    const agent = request.agent(app);
    const page = await agent.get('/report-issue');
    const res = await agent.post('/report-issue').type('form').send({
      _csrf: csrfFrom(page.text),
      name: 'Ana Pjetri', email: 'ana@example.test',
      subject: 'Enqtest bad type', message: BODY,
      issue_type: 'urgent-please-read', severity: 'high'
    });
    expect(res.status).toBe(422);
  });

  it('cannot be made to write an issue with no type, even past the model', async () => {
    // The CHECK in migration 018 is the third holder of this rule, after the form and the
    // model. A rule enforced only by the handler that happens to be correct today is the
    // shape this codebase keeps warning about.
    await expect(promisePool.query(
      "INSERT INTO enquiries (kind, name, email, subject, body) VALUES ('issue', 'x', 'x@y.test', 'Enqtest check', 'body')"
    )).rejects.toThrow();
  });
});

maybe()('the queue', () => {
  it('lists what arrived', async () => {
    const res = await adminAgent.get('/admin/enquiries?q=Enqtest');
    expect(res.status).toBe(200);
    expect(res.text).toContain(SUBJECT);
  });

  it('moves one and records who touched it', async () => {
    const [row] = await ownEnquiries();
    const page = await adminAgent.get(`/admin/enquiries/${row.id}`);
    await adminAgent.post(`/admin/enquiries/${row.id}/status`).type('form').send({
      _csrf: csrfFrom(page.text), status: 'closed', admin_note: 'Answered by email.'
    });

    const after = await Enquiry.find(row.id);
    expect(after.status).toBe('closed');
    expect(after.handled_by).toBeTruthy();
    expect(after.admin_note).toBe('Answered by email.');
  });

  it('keeps an existing note when the box is left empty', async () => {
    // An empty textarea on a status form must not erase what somebody wrote earlier —
    // the same reason AppSetting.setMany writes every declared key.
    const [row] = await ownEnquiries();
    const page = await adminAgent.get(`/admin/enquiries/${row.id}`);
    await adminAgent.post(`/admin/enquiries/${row.id}/status`).type('form').send({
      _csrf: csrfFrom(page.text), status: 'open', admin_note: ''
    });

    const after = await Enquiry.find(row.id);
    expect(after.status).toBe('open');
    expect(after.admin_note).toBe('Answered by email.');
  });

  it('sends nothing from the admin screen', async () => {
    /*
     * The reply is composed in a mail client. A reply form here would make the Hub a second
     * place the conversation partly lives, and the half that is missing is always the half
     * somebody needs later.
     */
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'views', 'admin', 'enquiry.ejs'), 'utf8');
    expect(source).not.toMatch(/name="reply/);
    const routes = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'admin.js'), 'utf8');
    const section = routes.slice(routes.indexOf("'/enquiries'"));
    expect(section).not.toMatch(/email\.send/);
  });

  it('is closed to an account that is not an administrator', async () => {
    const res = await request(app).get('/admin/enquiries');
    // A plain Node client sends no Sec-Fetch-Dest, so the guard reads this as a navigation
    // and answers 302 to the login page. See CLAUDE.md.
    expect(res.status).toBe(302);
  });
});

maybe()('the vocabularies match the schema', () => {
  const migration = fs.readFileSync(
    path.join(__dirname, '..', '..', 'scripts', 'migrations', '018_enquiries.sql'), 'utf8'
  );

  it.each([
    ['kind', Enquiry.KINDS],
    ['issue_type', Enquiry.ISSUE_TYPES],
    ['severity', Enquiry.SEVERITIES],
    ['status', Enquiry.STATUSES]
  ])('%s mirrors its ENUM', (column, values) => {
    // Written out by hand in the form, the validator and the admin filter is how an option
    // gets added to a dropdown and silently rejected behind it.
    const match = migration.match(new RegExp(`${column}\\s+ENUM\\(([^)]*)\\)`));
    expect(match).toBeTruthy();
    const inSchema = match[1].split(',').map((v) => v.trim().replace(/'/g, ''));
    expect(inSchema).toEqual([...values]);
  });
});
