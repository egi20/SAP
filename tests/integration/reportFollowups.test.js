'use strict';

/**
 * What happens after a report is sent, and the public ideas page: the reference, My
 * reports, the per-address limit, refusals shown beside their field, screenshots with their
 * metadata stripped, the optional browser line, published ideas with votes, and
 * security.txt.
 *
 * Plain Node client: no Sec-Fetch-Dest, so a refused guard answers as a navigation (302).
 * Each test file loads its own server and the enquiry limiter allows ten POSTs per IP, so
 * this file keeps well under that.
 */

const request = require('supertest');
const sharp = require('sharp');
const { promisePool } = require('../../config/database');
const User = require('../../models/User');
const Enquiry = require('../../models/Enquiry');
const { FAQ_QUESTIONS } = require('../../config/faq');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const PREFIX = 'Rptfu';
const BODY = 'The export button on the quote page does nothing at all when I press it.';
const MEMBER = 'rptfu-member@example.test';
const ADMIN = 'rptfu-admin@example.test';
const PASSWORD = 'Rptfu-Test-Pass-1';
const CSRF = /name="_csrf" value="([^"]+)"/;
let app;
let memberId;

function csrfFrom(html) {
  const match = html.match(CSRF);
  if (!match) throw new Error('No CSRF token on that page');
  return match[1];
}

async function signIn(email) {
  const agent = request.agent(app);
  const page = await agent.get('/auth/login');
  await agent.post('/auth/login').type('form').send({ _csrf: csrfFrom(page.text), email, password: PASSWORD });
  return agent;
}

async function post(agent, fields, files = []) {
  const page = await agent.get('/report-issue');
  const req = agent.post('/report-issue').field('_csrf', csrfFrom(page.text));
  Object.entries({ name: 'Ana Pjetri', email: 'rptfu@example.test', message: BODY, ...fields })
    .forEach(([k, v]) => { req.field(k, v); });
  files.forEach(([buffer, name, type]) => { req.attach('screenshots', buffer, { filename: name, contentType: type }); });
  return req;
}

async function row(subject) {
  const [[r]] = await promisePool.query('SELECT * FROM enquiries WHERE subject = ? ORDER BY id DESC LIMIT 1', [subject]);
  return r;
}

beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');
  await promisePool.query('DELETE FROM enquiries WHERE subject LIKE ?', [`${PREFIX}%`]);
  await promisePool.query('DELETE FROM users WHERE email IN (?)', [[MEMBER, ADMIN]]);
  const member = await User.create({ email: MEMBER, password: PASSWORD, name: 'Rptfu Member', roles: ['consultant'] });
  await User.setEmailVerified(member.id);
  memberId = member.id;
  const admin = await User.create({ email: ADMIN, password: PASSWORD, name: 'Rptfu Admin', roles: ['admin'] });
  await User.setEmailVerified(admin.id);
  await User.adminSetRoles(admin.id, ['admin'], { primary: 'admin' });
});

maybe()('after sending', () => {
  let ideaId;

  it('gives a reference, links it to the account and stores the optional details', async () => {
    const agent = await signIn(MEMBER);
    const res = await post(agent, {
      mode: 'idea', subject: `${PREFIX} idea`, issue_type: 'idea_improvement', severity: 'normal',
      include_env: 'on', env_info: 'TestAgent/1.0 | screen 390x844 | window 390x700', publish_consent: 'on'
    });
    expect(res.status).toBe(302);
    const r = await row(`${PREFIX} idea`);
    ideaId = r.id;
    expect(res.headers.location).toContain(`sent=${r.id}`);
    expect(r.user_id).toBe(memberId);
    expect(r.env_info).toContain('TestAgent/1.0');
    expect(r.publish_consent).toBe(1);

    const page = await agent.get(res.headers.location);
    expect(page.text).toContain(`R-${r.id}`);
    expect(page.text).toContain('data-report-sent');

    const mine = await agent.get('/report-issue/mine');
    expect(mine.status).toBe(200);
    expect(mine.text).toContain(`R-${r.id}`);
    expect(mine.text).toContain('Open');
  });

  it('keeps My reports behind a sign-in', async () => {
    const res = await request(app).get('/report-issue/mine');
    expect(res.status).toBe(302);
  });

  it('shows a refusal under the field it is about', async () => {
    const res = await post(request.agent(app), { mode: 'problem', subject: `${PREFIX} bad`, issue_type: 'bug', severity: 'low', page_url: 'not a url' });
    expect(res.status).toBe(422);
    expect(res.text).toMatch(/id="f-page"[^>]*is-invalid|is-invalid[^"]*" id="f-page"/);
    expect(res.text).toContain('id="f-page-error"');
    expect(res.text).toContain(`${PREFIX} bad`);
  });

  it('limits how many reports one address can send in an hour', async () => {
    const address = `rptfu-limit-${Date.now()}@example.test`;
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Enquiry.create({ kind: 'issue', name: 'x', email: address, subject: `${PREFIX} limit ${i}`, body: BODY, issueType: 'bug', severity: 'low' });
    }
    const res = await post(request.agent(app), { email: address, mode: 'problem', subject: `${PREFIX} limit 6`, issue_type: 'bug', severity: 'low' });
    expect(res.status).toBe(429);
    expect(await row(`${PREFIX} limit 6`)).toBeUndefined();
  });

  it('strips metadata, location included, from a screenshot', async () => {
    const jpeg = await sharp({ create: { width: 30, height: 20, channels: 3, background: 'red' } })
      .withMetadata({ exif: { IFD0: { Copyright: 'rptfu-secret' }, GPS: { GPSLatitudeRef: 'N' } } })
      .jpeg().toBuffer();
    expect((await sharp(jpeg).metadata()).exif).toBeDefined();
    const res = await post(request.agent(app), { mode: 'problem', subject: `${PREFIX} exif`, issue_type: 'bug', severity: 'low' }, [[jpeg, 'photo.jpg', 'image/jpeg']]);
    expect(res.status).toBe(302);
    const r = await row(`${PREFIX} exif`);
    const [[shot]] = await promisePool.query('SELECT bytes FROM enquiry_attachments WHERE enquiry_id = ?', [r.id]);
    const meta = await sharp(shot.bytes).metadata();
    expect(meta.exif).toBeUndefined();
    expect(shot.bytes.toString('latin1')).not.toContain('rptfu-secret');
  });

  it('publishes an idea only with consent and an administrator, without the name, and counts votes', async () => {
    const before = await request(app).get('/ideas');
    expect(before.text).not.toContain(`${PREFIX} idea`);

    const admin = await signIn(ADMIN);
    const page = await admin.get(`/admin/enquiries/${ideaId}`);
    expect(page.text).toContain('Publish it');
    await admin.post(`/admin/enquiries/${ideaId}/publish`).type('form').send({ _csrf: csrfFrom(page.text), published: 'on' });

    const after = await request(app).get('/ideas');
    expect(after.text).toContain(`${PREFIX} idea`);
    expect(after.text).not.toContain('Rptfu Member');
    expect(after.text).not.toContain('rptfu@example.test');

    const voter = await signIn(MEMBER);
    const ideas = await voter.get('/ideas');
    await voter.post(`/ideas/${ideaId}/vote`).type('form').send({ _csrf: csrfFrom(ideas.text) });
    const [[{ n }]] = await promisePool.query('SELECT COUNT(*) AS n FROM idea_votes WHERE enquiry_id = ?', [ideaId]);
    expect(Number(n)).toBe(1);
    await voter.post(`/ideas/${ideaId}/vote`).type('form').send({ _csrf: csrfFrom(ideas.text) });
    const [[{ m }]] = await promisePool.query('SELECT COUNT(*) AS m FROM idea_votes WHERE enquiry_id = ?', [ideaId]);
    expect(Number(m)).toBe(0);
  });

  it('cannot publish or vote on an idea sent without consent', async () => {
    const created = await Enquiry.create({ kind: 'issue', name: 'x', email: 'rptfu-nc@example.test', subject: `${PREFIX} no consent`, body: BODY, issueType: 'idea_feature', severity: 'low' });
    expect(await Enquiry.setIdeaPublished(created.id, true, null)).toBe(false);
    expect((await Enquiry.toggleIdeaVote(created.id, memberId)).ok).toBe(false);
  });
});

maybe()('around the form', () => {
  it('serves security.txt with a contact and an expiry in the future', async () => {
    const res = await request(app).get('/.well-known/security.txt');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/^Contact: mailto:/m);
    const expires = new Date(res.text.match(/^Expires: (.+)$/m)[1]);
    expect(expires.getTime()).toBeGreaterThan(Date.now());
  });

  it('suggests FAQ questions from the one list the FAQ page renders', async () => {
    const report = await request(app).get('/report-issue');
    expect(report.text).toContain('id="faq-questions"');
    const faq = await request(app).get('/faq');
    FAQ_QUESTIONS.forEach((f) => {
      expect(report.text).toContain(f.id);
      expect(faq.text).toContain(`id="${f.id}"`);
    });
  });

  it('offers the browser-details box unticked, and the severity guide beside the field on a phone', async () => {
    const res = await request(app).get('/report-issue');
    expect(res.text).toMatch(/id="f-env" name="include_env" data-env-toggle\s*>/);
    expect(res.text).toContain('class="d-lg-none mt-2 small"');
  });
});
