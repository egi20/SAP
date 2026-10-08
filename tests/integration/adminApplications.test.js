'use strict';

/**
 * Applications oversight.
 *
 * Two things are under test and the second one matters more than the screen. The screen
 * answers whether the marketplace is working — an application nobody has moved is the
 * figure it exists for. The guards answer who may read what a candidate wrote to an
 * employer, and who may decide what happens to it.
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');
const User = require('../../models/User');
const Job = require('../../models/Job');
const Application = require('../../models/Application');
const CompanyProfile = require('../../models/CompanyProfile');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const PASSWORD = 'Oversight-Test-Pass-1';
const MARK = 'Oversighttest';
const OWN = [
  'oversight-super@example.test',
  'oversight-admin@example.test',
  'oversight-co@example.test',
  'oversight-con@example.test'
];

let app;
let superId;
let companyId;
let consultantId;
let applicationId;
let superagent;
let plainAdmin;
let employer;

function csrfFrom(html) {
  const m = html.match(/name="_csrf" value="([^"]+)"/);
  return m ? m[1] : '';
}

async function signIn(email) {
  const agent = request.agent(app);
  const page = await agent.get('/auth/login');
  await agent.post('/auth/login').type('form').send({ _csrf: csrfFrom(page.text), email, password: PASSWORD });
  return agent;
}

beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');
  await promisePool.query('DELETE FROM users WHERE email IN (?)', [OWN]);

  const su = await User.create({ email: OWN[0], password: PASSWORD, name: 'Oversight Super', roles: ['admin'] });
  superId = su.id;
  await User.setEmailVerified(superId);
  await User.adminSetRoles(superId, ['admin'], { primary: 'admin' });
  await User.setSuperadmin(superId, true);

  const admin = await User.create({ email: OWN[1], password: PASSWORD, name: 'Oversight Admin', roles: ['admin'] });
  await User.setEmailVerified(admin.id);
  await User.adminSetRoles(admin.id, ['admin'], { primary: 'admin' });

  const co = await User.create({ email: OWN[2], password: PASSWORD, name: 'Oversight Hiring', roles: ['company'] });
  companyId = co.id;
  await User.setEmailVerified(companyId);
  await CompanyProfile.ensureExists(companyId, `${MARK} Hiring Ltd`);

  const job = await Job.create(companyId, {
    title: `${MARK} EWM Consultant`,
    description: 'An advert used by the oversight suite, long enough to pass validation.',
    role: 's4-ewm', seniority: 'senior', engagement_type: 'contract',
    work_mode: 'remote', country: 'DE', currency: 'EUR', status: 'open'
  });

  const con = await User.create({ email: OWN[3], password: PASSWORD, name: `${MARK} Petra Klein`, roles: ['consultant'] });
  consultantId = con.id;
  await User.setEmailVerified(consultantId);
  const applied = await Application.apply(job.id, consultantId, {
    coverLetter: 'A cover letter the oversight screen must not print.',
    dayRate: 900,
    currency: 'EUR'
  });
  applicationId = applied.id || applied.applicationId;

  [superagent, plainAdmin, employer] = await Promise.all([signIn(OWN[0]), signIn(OWN[1]), signIn(OWN[2])]);
});

maybe()('who may open it', () => {
  it('a superadmin can', async () => {
    const res = await superagent.get('/admin/applications');
    expect(res.status).toBe(200);
    expect(res.text).toContain(`${MARK} Petra Klein`);
  });

  it('an ordinary administrator cannot', async () => {
    /*
     * The one screen that can enumerate what candidates wrote to employers, so it carries
     * the guard `/admin/rates` carries. Moderating a forum is not a reason to read it.
     */
    const res = await plainAdmin.get('/admin/applications');
    expect(res.status).toBe(302);
  });

  it('and the tab is not rendered to one', async () => {
    const res = await plainAdmin.get('/admin');
    expect(res.text).not.toContain('href="/admin/applications"');
  });
});

maybe()('what it shows, and what it does not', () => {
  it('shows the state of each application', async () => {
    const res = await superagent.get('/admin/applications');
    expect(res.text).toContain(`${MARK} EWM Consultant`);
    expect(res.text).toContain(`${MARK} Hiring Ltd`);
    expect(res.text).toContain('submitted');
  });

  it('never the cover letter', async () => {
    // The content lives on the application's own page, behind the same guard. A list of
    // every cover letter on the platform is a different object from a health screen.
    const res = await superagent.get('/admin/applications');
    expect(res.text).not.toContain('must not print');
  });

  it('searches the advert and the company, not only the person', async () => {
    const byCompany = await superagent.get('/admin/applications?q=' + encodeURIComponent(`${MARK} Hiring`));
    expect(byCompany.text).toContain(`${MARK} Petra Klein`);

    const byAdvert = await superagent.get('/admin/applications?q=' + encodeURIComponent('EWM Consultant'));
    expect(byAdvert.text).toContain(`${MARK} Petra Klein`);
  });

  it('counts what nobody has moved, from the event log', async () => {
    /*
     * `updated_at` moves on any write, so an untouched application would look attended to.
     * "Never moved" is the absence of a transition event.
     */
    const fresh = await Application.list({ unscoped: true, stalled_days: 1 }, { limit: 50 });
    expect(fresh.rows.map((r) => r.id)).not.toContain(applicationId);

    await promisePool.query('UPDATE applications SET created_at = NOW() - INTERVAL 30 DAY WHERE id = ?', [applicationId]);
    const stalled = await Application.list({ unscoped: true, stalled_days: 14 }, { limit: 50 });
    expect(stalled.rows.map((r) => r.id)).toContain(applicationId);

    // And once the employer moves it, it is no longer stalled however old it is.
    await Application.transition(applicationId, companyId, 'reviewing', { actorIsEmployer: true });
    const after = await Application.list({ unscoped: true, stalled_days: 14 }, { limit: 50 });
    expect(after.rows.map((r) => r.id)).not.toContain(applicationId);
  });
});

maybe()('the filter builder still refuses a forgotten scope', () => {
  it('throws without a scope and without the opt-in', () => {
    // The oversight screen says `unscoped` out loud. A caller that simply forgot a company
    // id must still be told, rather than handed every application on the site.
    expect(() => Application.buildFilter({})).toThrow(/scoped/i);
    expect(() => Application.buildFilter({ unscoped: true })).not.toThrow();
  });
});

maybe()('reading and deciding are different rights', () => {
  it('an ordinary administrator cannot read an application', async () => {
    const res = await plainAdmin.get(`/applications/${applicationId}`);
    expect(res.status).toBe(404);
  });

  it('a superadmin can', async () => {
    const res = await superagent.get(`/applications/${applicationId}`);
    expect(res.status).toBe(200);
  });

  it('but NOBODY outside the two parties can move it', async () => {
    /*
     * This route used to treat any administrator as the employer, so an administrator
     * could reject a candidate on behalf of a company that had decided nothing — and the
     * candidate's notification would have said the employer did it.
     */
    const page = await superagent.get(`/applications/${applicationId}`);
    const res = await superagent.post(`/applications/${applicationId}/transition`).type('form')
      .send({ _csrf: csrfFrom(page.text), to_status: 'rejected' });
    expect(res.status).toBe(404);

    const [[row]] = await promisePool.query('SELECT status FROM applications WHERE id = ?', [applicationId]);
    expect(row.status).toBe('reviewing');
  });

  it('while the employer still can', async () => {
    const page = await employer.get(`/applications/${applicationId}`);
    const res = await employer.post(`/applications/${applicationId}/transition`).type('form')
      .send({ _csrf: csrfFrom(page.text), to_status: 'shortlisted' });
    expect(res.status).toBe(302);

    const [[row]] = await promisePool.query('SELECT status FROM applications WHERE id = ?', [applicationId]);
    expect(row.status).toBe('shortlisted');
  });
});
