'use strict';

/**
 * The CV builder, as served.
 *
 * The route-level questions are who may open it, whose rows it reads, and whether the
 * .docx that comes out is a file Word will open — the last one being the failure that
 * reaches a recipient rather than a log.
 */

const request = require('supertest');
const PizZip = require('pizzip');
const { promisePool } = require('../../config/database');
const User = require('../../models/User');
const Job = require('../../models/Job');
const Skill = require('../../models/Skill');
const ConsultantProfile = require('../../models/ConsultantProfile');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const OWN = ['cv-con@example.test', 'cv-co@example.test'];
const PASSWORD = 'Cv-Test-Pass-1';
const CSRF = /name="_csrf" value="([^"]+)"/;
const RATE = 1234;

let app;
let consultantId;
let openJob;
let draftJob;

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

  const consultant = await User.create({ email: OWN[0], password: PASSWORD, name: 'Cvtest Person', roles: ['consultant'] });
  await User.setEmailVerified(consultant.id);
  consultantId = consultant.id;

  await ConsultantProfile.ensureExists(consultantId);
  await ConsultantProfile.update(consultantId, {
    headline: 'Cvtest EWM consultant',
    bio: 'Cvtest summary paragraph.',
    primary_role: 's4-ewm', seniority: 'senior', country: 'DE', city: 'Hamburg',
    years_experience: 9, full_lifecycles: 0, day_rate: RATE, currency: 'EUR',
    availability: 'immediate', work_mode: 'remote'
  });
  const skills = await Skill.findOrCreateMany(['Cvtest Wave planning']);
  await Skill.setForConsultant(consultantId, skills.map((s) => s.id));
  await ConsultantProfile.addProject(consultantId, {
    name: 'Cvtest FI engagement', client: 'Cvtest Client', role: 'FI consultant',
    activatePhase: 'realize', isFullLifecycle: true, modules: ['fi-gl'],
    startedOn: '2024-01-01', endedOn: '2024-12-31', description: 'Cvtest finance work.'
  });
  await ConsultantProfile.addProject(consultantId, {
    name: 'Cvtest EWM engagement', client: 'Cvtest Client', role: 'EWM consultant',
    activatePhase: 'deploy', isFullLifecycle: false, modules: ['ewm'],
    startedOn: '2022-01-01', endedOn: '2022-12-31', description: 'Cvtest warehouse work.'
  });
  await ConsultantProfile.addExperience(consultantId, {
    company: 'Independent', title: 'Freelance', startedOn: '2018-01-01', isCurrent: true
  });

  const company = await User.create({ email: OWN[1], password: PASSWORD, name: 'Cvtest Co', roles: ['company'] });
  const base = {
    description: 'A test advert.', role: 's4-ewm', seniority: 'senior',
    engagement_type: 'contract', work_mode: 'remote', country: 'DE', activate_phase: 'realize'
  };
  openJob = await Job.create(company.id, { ...base, title: 'Cvtest open EWM advert', status: 'open' });
  await Job.setModules(openJob.id, ['ewm']);
  draftJob = await Job.create(company.id, { ...base, title: 'Cvtest draft advert', status: 'draft' });
  await Job.setModules(draftJob.id, ['ewm']);
});

maybe()('who may open it', () => {
  it('is closed to a visitor', async () => {
    // A plain Node client sends no Sec-Fetch-Dest, so the guard reads this as a navigation
    // and answers 302 to the login page. See CLAUDE.md.
    const res = await request(app).get('/profile/cv');
    expect(res.status).toBe(302);
  });

  it('is closed to a company account', async () => {
    const company = await signIn(OWN[1]);
    const res = await company.get('/profile/cv');
    expect([302, 403]).toContain(res.status);
  });

  it('takes no id, so there is nothing to enumerate', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'profile.js'), 'utf8');
    expect(source).not.toMatch(/'\/cv\/:/);
    expect(source).toContain("'/cv'");
  });
});

maybe()('what it builds', () => {
  it('renders the profile, including the delivery history', async () => {
    const me = await signIn(OWN[0]);
    const res = await me.get('/profile/cv');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Cvtest EWM consultant');
    expect(res.text).toContain('Cvtest FI engagement');
    expect(res.text).toContain('Cvtest summary paragraph.');
  });

  it('leaves the rate out unless it is asked for', async () => {
    const me = await signIn(OWN[0]);
    const without = await me.get('/profile/cv');
    expect(without.text).not.toContain(String(RATE));

    const with_ = await me.get('/profile/cv?rate=1');
    expect(with_.text).toContain(String(RATE));
  });

  it('orders the engagements against an advert', async () => {
    const me = await signIn(OWN[0]);
    const res = await me.get(`/profile/cv?job=${openJob.slug}`);
    expect(res.text).toContain('Relevant here');
    expect(res.text.indexOf('Cvtest EWM engagement')).toBeLessThan(res.text.indexOf('Cvtest FI engagement'));
  });

  it('ignores a draft advert, so the builder cannot be used to probe for one', async () => {
    /*
     * The job is loaded only to order the engagements, and only when it is one anybody
     * could read — otherwise somebody guessing slugs learns which drafts exist from
     * whether the ordering changed.
     */
    const me = await signIn(OWN[0]);
    const res = await me.get(`/profile/cv?job=${draftJob.slug}`);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('Cvtest draft advert');
    expect(res.text).not.toContain('Relevant here');
  });
});

maybe()('the .docx', () => {
  it('is a file that opens, and its filename is slugified', async () => {
    const me = await signIn(OWN[0]);
    // supertest hands back {} for a type it does not recognise, so the body is read as a
    // Buffer deliberately rather than by weakening the assertion.
    const res = await me.get('/profile/cv.docx').buffer().parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="cvtest-person-cv.docx"');
    // Generated from a profile that can change in the next minute.
    expect(res.headers['cache-control']).toContain('no-store');

    // It passed assertDocumentOpens on the way out; this opens it again from the response.
    const zip = new PizZip(res.body);
    const xml = zip.file('word/document.xml').asText();
    expect(xml).toContain('Cvtest EWM consultant');
    expect(xml).toContain('Cvtest FI engagement');
  });

  it('keeps the rate out of the file too', async () => {
    const me = await signIn(OWN[0]);
    const res = await me.get('/profile/cv.docx').buffer().parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    const xml = new PizZip(res.body).file('word/document.xml').asText();
    expect(xml).not.toContain(String(RATE));
  });

  it('carries no table, because an ATS reads the document in linear order', async () => {
    /*
     * The reference advertises "ATS-friendly" and then lays its CV out in a two-column
     * table. Columns interleave when they are parsed, text boxes are skipped, and a page
     * header repeats as though it were content.
     */
    const me = await signIn(OWN[0]);
    const res = await me.get('/profile/cv.docx').buffer().parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    const xml = new PizZip(res.body).file('word/document.xml').asText();
    expect(xml).not.toContain('<w:tbl>');
    expect(xml).not.toContain('<w:txbxContent>');
  });
});
