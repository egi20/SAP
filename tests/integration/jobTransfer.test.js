'use strict';

/**
 * Handing an advert over.
 *
 * The rule worth testing is the refusal, not the move: an advert that has collected
 * applications carries data written by people who chose ONE employer, and this schema has
 * no notion of an organisation that could establish the recipient is the same one. The
 * race — somebody applying between the offer and the acceptance — is the case the
 * eligibility check inside the transaction exists for.
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');
const User = require('../../models/User');
const Job = require('../../models/Job');
const JobTransfer = require('../../models/JobTransfer');
const Application = require('../../models/Application');
const CompanyProfile = require('../../models/CompanyProfile');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const PASSWORD = 'Transfer-Test-Pass-1';
const OWN = [
  'xfer-from@example.test',
  'xfer-to@example.test',
  'xfer-stranger@example.test',
  'xfer-applicant@example.test'
];

let app;
let fromId;
let toId;
let strangerId;
let applicantId;
let sender;
let recipient;

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

const jobBase = {
  description: 'A twelve-month engagement, described at sufficient length to pass validation.',
  role: 's4-ewm', seniority: 'senior', engagement_type: 'contract',
  work_mode: 'remote', country: 'DE', currency: 'EUR'
};

async function freshJob(title, status = 'open') {
  return Job.create(fromId, { ...jobBase, title, status });
}

beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');
  await promisePool.query('DELETE FROM users WHERE email IN (?)', [OWN]);

  const from = await User.create({ email: OWN[0], password: PASSWORD, name: 'Transfer Sender', roles: ['company'] });
  fromId = from.id;
  await User.setEmailVerified(fromId);
  await CompanyProfile.ensureExists(fromId, 'Transfer Sender Ltd');

  const to = await User.create({ email: OWN[1], password: PASSWORD, name: 'Transfer Receiver', roles: ['company'] });
  toId = to.id;
  await User.setEmailVerified(toId);
  await CompanyProfile.ensureExists(toId, 'Transfer Receiver Ltd');

  const stranger = await User.create({ email: OWN[2], password: PASSWORD, name: 'Transfer Stranger', roles: ['company'] });
  strangerId = stranger.id;
  await User.setEmailVerified(strangerId);

  const applicant = await User.create({ email: OWN[3], password: PASSWORD, name: 'Transfer Applicant', roles: ['consultant'] });
  applicantId = applicant.id;
  await User.setEmailVerified(applicantId);

  [sender, recipient] = await Promise.all([signIn(OWN[0]), signIn(OWN[1])]);
});

maybe()('offering an advert', () => {
  it('moves it to the account that accepts, and pauses a live advert', async () => {
    const job = await freshJob('Transfer Alpha EWM Consultant');
    const offer = await JobTransfer.offer(job.id, fromId, { toEmail: OWN[1], message: 'Taking over from me.' });

    const waiting = await JobTransfer.pendingForUser({ email: OWN[1], id: toId });
    expect(waiting.map((t) => t.id)).toContain(offer.id);

    const result = await JobTransfer.accept(offer.id, { id: toId, email: OWN[1], isCompany: true });
    expect(result.wasPaused).toBe(true);

    const moved = await Job.findById(job.id);
    expect(moved.company_user_id).toBe(toId);
    /*
     * The public page names the company that posted the role. That sentence changing
     * under its readers with nobody having looked at the advert is the one thing a
     * handover must not do silently.
     */
    expect(moved.status).toBe('paused');
  });

  it('leaves a draft a draft — there is nothing live to take down', async () => {
    const job = await freshJob('Transfer Beta EWM Consultant', 'draft');
    const offer = await JobTransfer.offer(job.id, fromId, { toEmail: OWN[1] });
    await JobTransfer.accept(offer.id, { id: toId, email: OWN[1], isCompany: true });
    expect((await Job.findById(job.id)).status).toBe('draft');
  });

  it('refuses a second live offer on the same advert', async () => {
    const job = await freshJob('Transfer Gamma EWM Consultant');
    await JobTransfer.offer(job.id, fromId, { toEmail: OWN[1] });
    // The unique key on the generated `pending_job_id` is what holds this, not an `if`.
    await expect(JobTransfer.offer(job.id, fromId, { toEmail: OWN[2] }))
      .rejects.toMatchObject({ code: 'ALREADY_OFFERED' });
  });

  it('refuses your own address', async () => {
    const job = await freshJob('Transfer Delta EWM Consultant');
    await expect(JobTransfer.offer(job.id, fromId, { toEmail: OWN[0] }))
      .rejects.toMatchObject({ code: 'SELF_TRANSFER' });
  });

  it('is claimed by the address it was sent to and nobody else', async () => {
    const job = await freshJob('Transfer Epsilon EWM Consultant');
    const offer = await JobTransfer.offer(job.id, fromId, { toEmail: OWN[1] });

    await expect(JobTransfer.accept(offer.id, { id: strangerId, email: OWN[2], isCompany: true }))
      .rejects.toMatchObject({ code: 'TRANSFER_NOT_FOUND' });
    expect((await Job.findById(job.id)).company_user_id).toBe(fromId);
  });
});

maybe()('an advert with applications is not yours alone to give away', () => {
  it('refuses the offer, and names what is in the way', async () => {
    const job = await freshJob('Transfer Zeta EWM Consultant');
    await Application.apply(job.id, applicantId, { coverLetter: 'Test.', dayRate: 900, currency: 'EUR' });

    const eligibility = await JobTransfer.eligibility(job.id);
    expect(eligibility.ok).toBe(false);
    // "Cannot be transferred" with no reason is the message people bounce off, and here
    // the reason is about the candidates rather than about the advert.
    expect(eligibility.reasons[0]).toMatch(/applied/);

    await expect(JobTransfer.offer(job.id, fromId, { toEmail: OWN[1] }))
      .rejects.toMatchObject({ code: 'NOT_TRANSFERABLE' });
  });

  it('refuses the ACCEPTANCE when somebody applies after the offer was made', async () => {
    /*
     * The race the eligibility re-check inside the transaction exists for. The offer was
     * legitimate when it was made; by the time it is accepted the advert has acquired
     * somebody else's cover letter, and that is a different advert.
     */
    const job = await freshJob('Transfer Eta EWM Consultant');
    const offer = await JobTransfer.offer(job.id, fromId, { toEmail: OWN[1] });

    await Application.apply(job.id, applicantId, { coverLetter: 'Test.', dayRate: 900, currency: 'EUR' });

    await expect(JobTransfer.accept(offer.id, { id: toId, email: OWN[1], isCompany: true }))
      .rejects.toMatchObject({ code: 'NOT_TRANSFERABLE' });
    expect((await Job.findById(job.id)).company_user_id).toBe(fromId);
  });
});

maybe()('an expired offer', () => {
  it('cannot be accepted, and is settled rather than left pending', async () => {
    const job = await freshJob('Transfer Theta EWM Consultant');
    const offer = await JobTransfer.offer(job.id, fromId, { toEmail: OWN[1] });
    await promisePool.query('UPDATE job_transfers SET expires_at = NOW() - INTERVAL 1 DAY WHERE id = ?', [offer.id]);

    await expect(JobTransfer.accept(offer.id, { id: toId, email: OWN[1], isCompany: true }))
      .rejects.toMatchObject({ code: 'EXPIRED' });

    const [[row]] = await promisePool.query('SELECT status FROM job_transfers WHERE id = ?', [offer.id]);
    expect(row.status).toBe('expired');
  });

  it('does not block a new one — the next offer settles the lapsed row', async () => {
    const job = await freshJob('Transfer Iota EWM Consultant');
    const first = await JobTransfer.offer(job.id, fromId, { toEmail: OWN[1] });
    await promisePool.query('UPDATE job_transfers SET expires_at = NOW() - INTERVAL 1 DAY WHERE id = ?', [first.id]);

    // No scheduled job runs here; the next person to act settles it.
    const second = await JobTransfer.offer(job.id, fromId, { toEmail: OWN[2] });
    expect(second.id).not.toBe(first.id);

    const [[lapsed]] = await promisePool.query('SELECT status FROM job_transfers WHERE id = ?', [first.id]);
    expect(lapsed.status).toBe('expired');
  });
});

maybe()('POST /jobs/:slug/transfer', () => {
  it('answers identically whether or not that address has an account', async () => {
    /*
     * Otherwise this form is an account-existence oracle any company account can query one
     * offer at a time. The sender is told the MECHANISM — it waits, it expires — and never
     * the answer for the address they typed.
     */
    const jobA = await freshJob('Transfer Kappa EWM Consultant');
    const jobB = await freshJob('Transfer Lambda EWM Consultant');

    // One at a time: a flash queue holds both messages otherwise, and the comparison
    // would be reading the first one twice.
    const sentence = async (slug, email) => {
      const page = await sender.get(`/jobs/${slug}`);
      await sender.post(`/jobs/${slug}/transfer`).type('form')
        .send({ _csrf: csrfFrom(page.text), to_email: email });
      const after = await sender.get(`/jobs/${slug}`);
      return {
        text: after.text,
        flash: (after.text.match(/Offered to [^<]+/) || [''])[0].replace(email, '<address>')
      };
    };

    const known = await sentence(jobA.slug, OWN[1]);
    const unknown = await sentence(jobB.slug, 'nobody-at-all@example.test');

    // The same sentence, with only the address differing.
    expect(known.flash).toBe(unknown.flash);
    expect(known.flash).toMatch(/expires after/);
    expect(unknown.text).not.toMatch(/no account|not registered|unknown address/i);
  });

  it('shows the recipient the offer, and the sender their own list', async () => {
    const inbox = await recipient.get('/dashboard/transfers');
    expect(inbox.status).toBe(200);
    expect(inbox.text).toContain('Transfer Kappa EWM Consultant');

    const outbox = await sender.get('/dashboard/transfers');
    expect(outbox.text).toContain('nobody-at-all@example.test');
  });

  it('hands over nothing to a consultant account', async () => {
    const consultant = await signIn(OWN[3]);
    const res = await consultant.get('/dashboard/transfers');
    // A plain supertest client sends no Sec-Fetch-Dest, so a failed role guard redirects.
    expect(res.status).toBe(302);
  });
});
