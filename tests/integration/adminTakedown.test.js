'use strict';

/**
 * An administrator taking a consultant profile or a job advert out of public view.
 *
 * Before this there was no way to do either short of deactivating the whole account, which
 * also ends their applications, their messages and their community standing. What is worth
 * asserting is that the takedown reaches EVERY surface — the directory, the search, the
 * profile page, the photograph, the board, the feed — and that the member cannot undo it
 * from their own settings.
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');
const User = require('../../models/User');
const Job = require('../../models/Job');
const Moderation = require('../../models/Moderation');
const ConsultantProfile = require('../../models/ConsultantProfile');
const CompanyProfile = require('../../models/CompanyProfile');
const Skill = require('../../models/Skill');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const PASSWORD = 'Takedown-Test-Pass-1';
const MARK = 'Takedowntest';
const OWN = [
  'takedown-admin@example.test',
  'takedown-con@example.test',
  'takedown-co@example.test',
  'takedown-reader@example.test'
];

let app;
let adminId;
let consultantId;
let companyId;
let job;
let admin;
let reader;

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

  const a = await User.create({ email: OWN[0], password: PASSWORD, name: 'Takedown Admin', roles: ['admin'] });
  adminId = a.id;
  await User.setEmailVerified(adminId);
  await User.adminSetRoles(adminId, ['admin'], { primary: 'admin' });

  const c = await User.create({ email: OWN[1], password: PASSWORD, name: `${MARK} Petra Klein`, roles: ['consultant'] });
  consultantId = c.id;
  await User.setEmailVerified(consultantId);
  await ConsultantProfile.ensureExists(consultantId);
  await ConsultantProfile.update(consultantId, {
    headline: `${MARK} EWM consultant`,
    primary_role: 's4-ewm',
    seniority: 'senior',
    years_experience: 9,
    full_lifecycles: 3,
    country: 'DE',
    day_rate: 900,
    availability: 'immediate',
    bio: 'A profile written by the account-takedown suite, long enough to clear the floor.'
  });
  const skills = await Skill.findOrCreateMany(['EWM', 'MFS']);
  await Skill.setForConsultant(consultantId, skills.map((s) => s.id));
  await ConsultantProfile.addProject(consultantId, {
    client: 'A distributor', role: 'EWM lead', activate_phase: 'realize',
    started_on: '2024-01-01', ended_on: '2024-12-31', description: 'Three sites.',
    modules: ['ewm']
  }).catch(() => null);
  await ConsultantProfile.setPublic(consultantId, true);

  const co = await User.create({ email: OWN[2], password: PASSWORD, name: 'Takedown Hiring', roles: ['company'] });
  companyId = co.id;
  await User.setEmailVerified(companyId);
  await CompanyProfile.ensureExists(companyId, `${MARK} Hiring Ltd`);
  job = await Job.create(companyId, {
    title: `${MARK} EWM Consultant`,
    description: 'An advert used by the takedown suite, long enough to pass validation.',
    role: 's4-ewm', seniority: 'senior', engagement_type: 'contract',
    work_mode: 'remote', country: 'DE', currency: 'EUR', status: 'open'
  });

  await User.create({ email: OWN[3], password: PASSWORD, name: 'Takedown Reader', roles: ['consultant'] });
  await User.setEmailVerified((await User.findByEmail(OWN[3])).id);

  [admin, reader] = await Promise.all([signIn(OWN[0]), signIn(OWN[3])]);
});

maybe()('taking a consultant profile out of the directory', () => {
  it('is in the directory first', async () => {
    const res = await reader.get('/consultants?q=' + encodeURIComponent(MARK));
    expect(res.text).toContain(`${MARK} EWM consultant`);
  });

  it('leaves every surface at once', async () => {
    const result = await Moderation.setProfileHidden(consultantId, true, {
      actorUserId: adminId,
      reason: 'Suite takedown.'
    });
    expect(result.changed).toBe(true);

    // The directory and the search both go through ConsultantProfile.buildFilter, so
    // neither of them has to know this rule exists.
    const directory = await reader.get('/consultants?q=' + encodeURIComponent(MARK));
    expect(directory.text).not.toContain(`${MARK} EWM consultant`);

    const search = await reader.get('/search?q=' + encodeURIComponent(MARK));
    expect(search.text).not.toContain(`${MARK} EWM consultant`);

    // The page itself, and the photograph route, which only ever checked that the reader
    // was signed in.
    const page = await reader.get(`/consultants/${consultantId}`);
    expect(page.status).toBe(404);

    const photo = await reader.get(`/consultants/photo/${consultantId}`);
    expect(photo.status).toBe(302);
    expect(photo.headers.location).toBe('/images/avatar-placeholder.svg');
  });

  it('but the owner and an administrator can still see it', async () => {
    const owner = await signIn(OWN[1]);
    expect((await owner.get(`/consultants/${consultantId}`)).status).toBe(200);
    expect((await admin.get(`/consultants/${consultantId}`)).status).toBe(200);
  });

  it('and the member cannot put it back from their own settings', async () => {
    /*
     * The whole reason it is a different column from `is_public`. If this returned
     * published:true the decision would be a suggestion, and nothing on their screen
     * would even have said one was made.
     */
    const result = await ConsultantProfile.setPublic(consultantId, true);
    expect(result.published).toBe(false);
    expect(result.adminHidden).toBe(true);

    const directory = await reader.get('/consultants?q=' + encodeURIComponent(MARK));
    expect(directory.text).not.toContain(`${MARK} EWM consultant`);
  });

  it('is on the moderation screen, with what was decided', async () => {
    const res = await admin.get('/admin/moderation');
    expect(res.text).toContain('Profiles out of the directory');
    expect(res.text).toContain('Suite takedown.');
  });

  it('restoring clears our decision and leaves their switch exactly as it was', async () => {
    await Moderation.setProfileHidden(consultantId, false, { actorUserId: adminId });

    const [[row]] = await promisePool.query(
      'SELECT is_public, admin_hidden_at FROM consultant_profiles WHERE user_id = ?',
      [consultantId]
    );
    expect(row.admin_hidden_at).toBeNull();
    // They had it published before we took it down, and the refused publish above did not
    // change that. So it comes back.
    expect(row.is_public).toBe(1);

    const directory = await reader.get('/consultants?q=' + encodeURIComponent(MARK));
    expect(directory.text).toContain(`${MARK} EWM consultant`);
  });

  it('and restoring never publishes a profile its owner had unpublished', async () => {
    /*
     * The other half of "nothing else". An administrator undoing a removal is not an
     * administrator deciding somebody's profile should be public — the same rule as
     * restoring a reply giving back the writing points but not the accepted-answer mark.
     */
    await ConsultantProfile.setPublic(consultantId, false);
    await Moderation.setProfileHidden(consultantId, true, { actorUserId: adminId, reason: 'Second pass.' });
    await Moderation.setProfileHidden(consultantId, false, { actorUserId: adminId });

    const [[row]] = await promisePool.query(
      'SELECT is_public, admin_hidden_at FROM consultant_profiles WHERE user_id = ?',
      [consultantId]
    );
    expect(row.admin_hidden_at).toBeNull();
    expect(row.is_public).toBe(0);
    expect((await reader.get('/consultants?q=' + encodeURIComponent(MARK))).text)
      .not.toContain(`${MARK} EWM consultant`);
  });
});

maybe()('taking an advert off the board', () => {
  it('is on the board first', async () => {
    const res = await reader.get('/jobs?q=' + encodeURIComponent(MARK));
    expect(res.text).toContain(`${MARK} EWM Consultant`);
  });

  it('leaves the board, the search and its own page', async () => {
    await Moderation.setJobHidden(job.id, true, { actorUserId: adminId, reason: 'Suite takedown.' });

    expect((await reader.get('/jobs?q=' + encodeURIComponent(MARK))).text).not.toContain(`${MARK} EWM Consultant`);
    expect((await reader.get('/search?q=' + encodeURIComponent(MARK))).text).not.toContain(`${MARK} EWM Consultant`);
    expect((await reader.get(`/jobs/${job.slug}`)).status).toBe(404);
  });

  it('whatever its own status says', async () => {
    // `status` is the advertiser's column and `admin_hidden_at` is ours; the board needs
    // both clear.
    const { rows } = await Job.browse({ status: 'open' }, { limit: 200 });
    expect(rows.map((r) => r.id)).not.toContain(job.id);
  });

  it('and the advertiser cannot reopen it into the board', async () => {
    await Job.setStatus(job.id, companyId, 'paused');
    await Job.setStatus(job.id, companyId, 'open');
    const { rows } = await Job.browse({ status: 'open' }, { limit: 200 });
    expect(rows.map((r) => r.id)).not.toContain(job.id);
  });

  it('is on the moderation screen too, and comes back from there', async () => {
    const screen = await admin.get('/admin/moderation');
    expect(screen.text).toContain('Adverts taken off the board');

    await Moderation.setJobHidden(job.id, false, { actorUserId: adminId });
    const after = await reader.get(`/jobs/${job.slug}`);
    expect(after.status).toBe(200);
  });
});

maybe()('the admin screens themselves', () => {
  it('the user list filters by state and shows when somebody was last seen', async () => {
    const res = await admin.get('/admin/users?q=' + encodeURIComponent(MARK) + '&status=active');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Last seen');
    expect(res.text).toContain('Country');
  });

  it('the job list has the control for the filter its route always honoured', async () => {
    const res = await admin.get('/admin/jobs');
    expect(res.text).toContain('name="q"');
    expect(res.text).toContain('/admin/moderation');
  });

  it('the error log filters, summarises and exports the same rows', async () => {
    const page = await admin.get('/admin/errors?status_code=500');
    expect(page.status).toBe(200);
    expect(page.text).toContain('Where they are');

    const csv = await admin.get('/admin/errors/export.csv?status_code=500');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split('\r\n')[0]).toBe(
      '"created_at","status_code","method","path","message","user_id"'.replace(/"/g, '')
    );
  });
});
