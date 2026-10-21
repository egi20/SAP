'use strict';

/**
 * /report-issue in two modes, with screenshots — and the CSRF fix that made any file upload
 * on the site work at all.
 *
 * Plain Node client: no Sec-Fetch-Dest, so a refused guard answers as a navigation (302).
 * The enquiry limiter allows ten posts per IP per window and each test file loads its own
 * server, so this file keeps to fewer than ten POSTs to the two forms.
 */

const request = require('supertest');
const sharp = require('sharp');
const { promisePool } = require('../../config/database');
const User = require('../../models/User');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const PREFIX = 'Rpttest';
const BODY = 'When I press Save on the profile page nothing happens and the spinner never stops.';
const ADMIN = 'rpt-admin@example.test';
const COMPANY = 'rpt-company@example.test';
const PASSWORD = 'Rpt-Test-Pass-1';
const CSRF = /name="_csrf" value="([^"]+)"/;
let app;

function csrfFrom(html) {
  const match = html.match(CSRF);
  if (!match) throw new Error('No CSRF token on that page');
  return match[1];
}

async function rowsFor(subject) {
  const [rows] = await promisePool.query('SELECT * FROM enquiries WHERE subject = ? ORDER BY id DESC', [subject]);
  return rows;
}

async function signIn(email) {
  const agent = request.agent(app);
  const page = await agent.get('/auth/login');
  await agent.post('/auth/login').type('form').send({ _csrf: csrfFrom(page.text), email, password: PASSWORD });
  return agent;
}

function png(color) {
  return sharp({ create: { width: 40, height: 30, channels: 3, background: color } }).png().toBuffer();
}

beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');
  await promisePool.query('DELETE FROM enquiries WHERE subject LIKE ?', [`${PREFIX}%`]);
  await promisePool.query('DELETE FROM users WHERE email IN (?)', [[ADMIN, COMPANY]]);
  const admin = await User.create({ email: ADMIN, password: PASSWORD, name: 'Rpt Admin', roles: ['admin'] });
  await User.setEmailVerified(admin.id);
  await User.adminSetRoles(admin.id, ['admin'], { primary: 'admin' });
  const company = await User.create({ email: COMPANY, password: PASSWORD, name: 'Rpt Company', roles: ['company'] });
  await User.setEmailVerified(company.id);
});

maybe()('the page', () => {
  it('offers both modes, the reference fields and the privacy line', async () => {
    const problem = await request(app).get('/report-issue');
    expect(problem.status).toBe(200);
    expect(problem.text).toContain('Share an idea');
    expect(problem.text).toContain('value="critical"');
    expect(problem.text).toContain('Tips for reporting');
    expect(problem.text).toContain('Severity guide');
    expect(problem.text).toContain('autocomplete="name"');
    expect(problem.text).toContain('autocomplete="email"');
    expect(problem.text).toContain('aria-describedby="f-message-help"');
    expect(problem.text).toContain('href="/legal/privacy#reports"');
    expect(problem.text).toContain('enctype="multipart/form-data"');

    const idea = await request(app).get('/report-issue?mode=idea');
    expect(idea.text).toContain('Idea type');
    expect(idea.text).toContain('Priority');
    expect(idea.text).toContain('value="idea_feature"');
    expect(idea.text).not.toContain('value="critical"');
    expect(idea.text).toMatch(/value="low"\s+selected/);
  });

  it('drops a page address that is not http(s) instead of prefilling it', async () => {
    const res = await request(app).get('/report-issue?page=javascript:alert(1)');
    expect(res.text).not.toContain('javascript:alert');
  });

  it('documents what is kept in the Privacy policy', async () => {
    const res = await request(app).get('/legal/privacy');
    expect(res.text).toContain('id="reports"');
    expect(res.text).toMatch(/Screenshots are deleted \d+ days after the report is closed/);
  });
});

maybe()('sending one', () => {
  async function post(fields, { files = [], withToken = true, agent = request.agent(app) } = {}) {
    const page = await agent.get('/report-issue');
    const req = agent.post('/report-issue');
    const all = { name: 'Ana Pjetri', email: 'ana@example.test', message: BODY, ...fields };
    if (withToken) req.field('_csrf', csrfFrom(page.text));
    Object.entries(all).forEach(([k, v]) => { req.field(k, v); });
    files.forEach(([buffer, name, type]) => { req.attach('screenshots', buffer, { filename: name, contentType: type }); });
    return req;
  }

  it('stores an idea with its priority', async () => {
    const res = await post({ mode: 'idea', subject: `${PREFIX} idea`, issue_type: 'idea_feature', severity: 'low' });
    expect(res.status).toBe(302);
    const [row] = await rowsFor(`${PREFIX} idea`);
    expect(row.issue_type).toBe('idea_feature');
    expect(row.severity).toBe('low');
  });

  it('refuses "critical" for an idea', async () => {
    const res = await post({ mode: 'idea', subject: `${PREFIX} idea critical`, issue_type: 'idea_feature', severity: 'critical' });
    expect(res.status).toBe(422);
    expect(await rowsFor(`${PREFIX} idea critical`)).toHaveLength(0);
  });

  it('refuses a javascript: page address and writes nothing', async () => {
    const res = await post({ mode: 'problem', subject: `${PREFIX} js url`, issue_type: 'bug', severity: 'critical', page_url: 'javascript:alert(1)' });
    expect(res.status).toBe(422);
    expect(res.text).toContain('must be a web address');
    expect(await rowsFor(`${PREFIX} js url`)).toHaveLength(0);
  });

  it('asks for the link when reporting somebody\'s content, and stores it', async () => {
    const missing = await post({ mode: 'problem', subject: `${PREFIX} abuse`, issue_type: 'abuse', severity: 'high' });
    expect(missing.status).toBe(422);
    const ok = await post({ mode: 'problem', subject: `${PREFIX} abuse`, issue_type: 'abuse', severity: 'high', content_url: 'https://saphub.net/community/post-1' });
    expect(ok.status).toBe(302);
    const [row] = await rowsFor(`${PREFIX} abuse`);
    expect(row.content_url).toBe('https://saphub.net/community/post-1');
  });

  it('stores screenshots re-encoded, and an administrator can open them', async () => {
    const res = await post(
      { mode: 'problem', subject: `${PREFIX} shots`, issue_type: 'bug', severity: 'critical' },
      { files: [[await png('red'), 'one.png', 'image/png'], [await png('blue'), 'two.png', 'image/png']] }
    );
    expect(res.status).toBe(302);
    const [row] = await rowsFor(`${PREFIX} shots`);
    expect(row.severity).toBe('critical');
    const [shots] = await promisePool.query('SELECT id, content_type FROM enquiry_attachments WHERE enquiry_id = ?', [row.id]);
    expect(shots).toHaveLength(2);
    expect(shots[0].content_type).toBe('image/webp');

    const admin = await signIn(ADMIN);
    const page = await admin.get(`/admin/enquiries/${row.id}`);
    expect(page.text).toContain(`/admin/enquiries/${row.id}/attachments/${shots[0].id}`);
    const file = await admin.get(`/admin/enquiries/${row.id}/attachments/${shots[0].id}`)
      .buffer(true).parse((r, cb) => { const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toContain('image/webp');
    // And nobody else can.
    const stranger = await request(app).get(`/admin/enquiries/${row.id}/attachments/${shots[0].id}`);
    expect(stranger.status).toBe(302);
  });

  it('refuses a file that is not an image, keeping what was typed', async () => {
    const res = await post(
      { mode: 'problem', subject: `${PREFIX} not image`, issue_type: 'bug', severity: 'low' },
      { files: [[Buffer.from('not an image'), 'notes.txt', 'text/plain']] }
    );
    expect(res.status).toBe(422);
    expect(res.text).toContain(`${PREFIX} not image`);
    expect(await rowsFor(`${PREFIX} not image`)).toHaveLength(0);
  });

  it('refuses a multipart post without the CSRF token', async () => {
    const res = await post({ mode: 'problem', subject: `${PREFIX} no token`, issue_type: 'bug', severity: 'low' }, { withToken: false });
    expect(res.status).toBe(302);
    expect(await rowsFor(`${PREFIX} no token`)).toHaveLength(0);
  });
});

maybe()('the CSRF fix reaches every upload', () => {
  it('a company logo uploads with the token from the form', async () => {
    const agent = await signIn(COMPANY);
    const page = await agent.get('/profile/company');
    const res = await agent.post('/profile/company/logo').field('_csrf', csrfFrom(page.text)).attach('logo', await png('green'), 'logo.png');
    expect(res.status).toBe(302);
    expect(res.headers.location).not.toBe('/');
    const [[logo]] = await promisePool.query(
      'SELECT COUNT(*) AS n FROM company_logos WHERE user_id = (SELECT id FROM users WHERE email = ?)', [COMPANY]
    );
    expect(Number(logo.n)).toBe(1);
  });

  it('a multipart post to a route that takes no upload is still refused without a check', async () => {
    // Deferral is for listed upload paths only; anything else fails closed as before.
    const agent = await signIn(COMPANY);
    const page = await agent.get('/dashboard');
    const res = await agent.post('/notifications/read-all').field('_csrf', csrfFrom(page.text));
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });
});
