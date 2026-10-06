'use strict';

/**
 * Closing an account.
 *
 * The thing worth asserting is not that the row changed. It is that the page's two lists
 * are TRUE: everything named under "removed" is gone, and everything named under "kept" is
 * still there. A closure screen that promises deletion and leaves an invoice standing is
 * the one version of this that is actually dishonest, so both halves are tested.
 */

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { promisePool } = require('../../config/database');
const User = require('../../models/User');
const Job = require('../../models/Job');
const Post = require('../../models/Post');
const Points = require('../../models/Points');
const Application = require('../../models/Application');
const CompanyProfile = require('../../models/CompanyProfile');
const ConsultantProfile = require('../../models/ConsultantProfile');
const Notification = require('../../models/Notification');
const Referral = require('../../models/Referral');
const AccountClosure = require('../../models/AccountClosure');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const PASSWORD = 'Closure-Test-Pass-1';
const OWN = [
  'close-con@example.test',
  'close-co@example.test',
  'close-owing@example.test',
  'close-reader@example.test'
];

let app;
let consultantId;
let companyId;
let owingId;
let job;
let post;
let applicationId;

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
  await promisePool.query('DELETE FROM users WHERE email IN (?)', [OWN]);

  const company = await User.create({ email: OWN[1], password: PASSWORD, name: 'Closure Hiring Ltd', roles: ['company'] });
  companyId = company.id;
  await User.setEmailVerified(companyId);
  await CompanyProfile.ensureExists(companyId, 'Closure Hiring Ltd');

  job = await Job.create(companyId, {
    title: 'Closure EWM Consultant',
    description: 'An advert used by the account-closure suite, long enough to be valid.',
    role: 's4-ewm', seniority: 'senior', engagement_type: 'contract',
    work_mode: 'remote', country: 'DE', currency: 'EUR', status: 'open'
  });

  const consultant = await User.create({ email: OWN[0], password: PASSWORD, name: 'Closure Departing Person', roles: ['consultant'] });
  consultantId = consultant.id;
  await User.setEmailVerified(consultantId);
  await ConsultantProfile.ensureExists(consultantId);
  await ConsultantProfile.update(consultantId, { headline: 'Closure test headline', years_experience: 9 });

  await Job.saveForUser(consultantId, job.id);
  await Notification.emit({
    userId: consultantId, type: 'test', title: 'Closure test notification',
    link: '/', dedupeKey: `closure-test:${consultantId}`
  });

  const applied = await Application.apply(job.id, consultantId, { coverLetter: 'Test.', dayRate: 900, currency: 'EUR' });
  applicationId = applied.id || applied.applicationId;

  const [categories] = await promisePool.query('SELECT id FROM post_categories WHERE is_active = 1 LIMIT 1');
  post = await Post.create(consultantId, {
    categoryId: categories[0].id,
    kind: 'question',
    title: 'Closure test — does a post outlive its author',
    body: 'A question written by somebody who then closed their account.'
  });

  const owing = await User.create({ email: OWN[2], password: PASSWORD, name: 'Closure Owed Person', roles: ['consultant'] });
  owingId = owing.id;
  await User.setEmailVerified(owingId);

  await User.create({ email: OWN[3], password: PASSWORD, name: 'Closure Reader', roles: ['consultant'] });
});

maybe()('GET /profile/settings/close', () => {
  it('says what is kept before anything can be pressed', async () => {
    const agent = await signIn(OWN[0]);
    const res = await agent.get('/profile/settings/close');
    expect(res.status).toBe(200);
    // Every kept thing is named on the page, from the model's own list.
    AccountClosure.KEPT.forEach((item) => expect(res.text).toContain(item.what));
    expect(res.text).toContain('cannot be undone');
  });

  it('builds both lists from the model rather than retyping them', () => {
    /*
     * A list of promises maintained separately from the code that keeps them is worse than
     * no list: the page goes on saying the old thing after the operation changes.
     */
    const view = fs.readFileSync(path.join(__dirname, '..', '..', 'views', 'profile', 'close.ejs'), 'utf8');
    expect(view).toContain('removed.forEach');
    expect(view).toContain('kept.forEach');
  });

  it('refuses the wrong password', async () => {
    const agent = await signIn(OWN[3]);
    const page = await agent.get('/profile/settings/close');
    const res = await agent.post('/profile/settings/close').type('form')
      .send({ _csrf: csrfFrom(page.text), current_password: 'not-the-password', understood: 'on' });
    expect(res.status).toBe(302);

    const after = await User.findByEmail(OWN[3]);
    expect(after.is_active).toBe(1);
  });
});

maybe()('closing a consultant account', () => {
  let pointsBefore;

  beforeAll(async () => {
    if (!reachable) return;
    pointsBefore = await Points.totalFor(consultantId);
    await AccountClosure.close(consultantId, { reason: 'Leaving contracting.' });
  });

  it('erases the identity and frees the address', async () => {
    const [[row]] = await promisePool.query('SELECT * FROM users WHERE id = ?', [consultantId]);
    expect(row.name).toBe(AccountClosure.CLOSED_NAME);
    expect(row.email).toBe(AccountClosure.tombstoneEmail(consultantId));
    expect(row.is_active).toBe(0);
    expect(row.closed_at).not.toBeNull();
    // The real address is free again: somebody can register with it.
    expect(await User.findByEmail(OWN[0])).toBeNull();
  });

  it('leaves no password that can sign in', async () => {
    const [[row]] = await promisePool.query('SELECT * FROM users WHERE id = ?', [consultantId]);
    expect(await User.verifyPassword(row, PASSWORD)).toBe(false);
  });

  it('removes everything the page said it would', async () => {
    const [[profile]] = await promisePool.query('SELECT COUNT(*) AS n FROM consultant_profiles WHERE user_id = ?', [consultantId]);
    const [[saved]] = await promisePool.query('SELECT COUNT(*) AS n FROM saved_jobs WHERE user_id = ?', [consultantId]);
    const [[notes]] = await promisePool.query('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?', [consultantId]);
    expect(profile.n).toBe(0);
    expect(saved.n).toBe(0);
    expect(notes.n).toBe(0);
  });

  it('withdraws the live application, through the model, with its audit event', async () => {
    const [[row]] = await promisePool.query('SELECT status FROM applications WHERE id = ?', [applicationId]);
    expect(row.status).toBe('withdrawn');

    // The employer watching that pipeline is entitled to see what happened to it.
    const events = await Application.events(applicationId);
    const withdrawal = events.find((e) => e.to_status === 'withdrawn');
    expect(withdrawal).toBeTruthy();
    expect(withdrawal.note).toMatch(/closed their account/);
  });

  it('keeps the post, under the neutral name', async () => {
    const { rows } = await Post.browse({ q: 'Closure test' }, { limit: 10 });
    const theirs = rows.find((p) => p.id === post.id);
    expect(theirs).toBeTruthy();
    expect(theirs.author_name).toBe(AccountClosure.CLOSED_NAME);
  });

  it('but takes the author page down, which was already the rule', async () => {
    // "An inactive or missing account is a 404, never an empty page."
    const reader = await signIn(OWN[3]);
    const res = await reader.get(`/community/author/${consultantId}`);
    expect(res.status).toBe(404);
  });

  it('keeps the points ledger exactly as it was', async () => {
    // Append-only so every total on the site can be checked. Removing rows would make
    // somebody else's figures unverifiable, not just theirs.
    expect(await Points.totalFor(consultantId)).toBe(pointsBefore);
  });

  it('refuses to close it twice', async () => {
    await expect(AccountClosure.close(consultantId)).rejects.toMatchObject({ code: 'ALREADY_CLOSED' });
  });
});

maybe()('closing a company account', () => {
  it('closes the adverts, so nobody applies to a role nobody is hiring for', async () => {
    expect((await Job.findById(job.id)).status).toBe('open');
    const result = await AccountClosure.close(companyId);
    expect(result.closedJobs).toBeGreaterThan(0);
    expect((await Job.findById(job.id)).status).toBe('closed');
  });
});

maybe()('what blocks a closure', () => {
  it('money still owed, with the figure named', async () => {
    const referrer = await Referral.enrol(owingId);
    await Referral.adjust(referrer.id, {
      amountMinor: 2500,
      note: 'Closure suite fixture.',
      actorUserId: owingId,
      dedupeKey: `closure-suite:${owingId}`
    });

    const { ok, problems } = await AccountClosure.blockers(await User.findById(owingId));
    expect(ok).toBe(false);
    // "You cannot close your account" with no number is the message people assume is a bug.
    expect(problems[0]).toContain('25.00');

    await expect(AccountClosure.close(owingId)).rejects.toMatchObject({ code: 'BLOCKED' });
  });

  it('an administrator closes their own account through another administrator', async () => {
    const { problems } = await AccountClosure.blockers({
      id: 999999, is_superadmin: 1, user_type: 'admin'
    });
    expect(problems[0]).toMatch(/another administrator/i);
  });
});
