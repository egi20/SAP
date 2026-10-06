'use strict';

/**
 * The candidate pipeline: one filter builder, two layouts, and a board that offers only
 * the moves the state machine allows.
 *
 * The thing worth asserting here is not that the page renders. It is that the list and the
 * board answer the same question, that neither of them answers it for somebody else's
 * company, and that the controls on a card are the ones the model will accept — a board
 * whose cards offer a move that then fails is worse than a board with no controls at all.
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');
const User = require('../../models/User');
const Job = require('../../models/Job');
const Application = require('../../models/Application');
const CompanyProfile = require('../../models/CompanyProfile');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const PASSWORD = 'Pipeline-Test-Pass-1';
const OWN = [
  'pipe-co@example.test',
  'pipe-other@example.test',
  'pipe-anna@example.test',
  'pipe-bert@example.test',
  'pipe-clara@example.test'
];

let app;
let companyId;
// Signed in ONCE each, in beforeAll. The login limiter counts every POST from this
// address, and a suite that signs in per case spends a budget the rest of the run needs.
let employer;
let rival;
let candidate;
let jobA;
let jobB;
const applicants = {};

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
  // Cleared on the way IN, so a run is independent of how the last one ended.
  await promisePool.query('DELETE FROM users WHERE email IN (?)', [OWN]);

  const company = await User.create({ email: OWN[0], password: PASSWORD, name: 'Pipeline Logistics', roles: ['company'] });
  companyId = company.id;
  // Sign-in refuses an unconfirmed address, companies included.
  await User.setEmailVerified(companyId);
  await CompanyProfile.ensureExists(companyId, 'Pipeline Logistics');

  const other = await User.create({ email: OWN[1], password: PASSWORD, name: 'Pipeline Rival', roles: ['company'] });
  await User.setEmailVerified(other.id);

  const base = {
    description: 'A test advert.', role: 's4-ewm', seniority: 'senior',
    engagement_type: 'contract', work_mode: 'remote', country: 'DE',
    currency: 'EUR', status: 'open'
  };
  jobA = await Job.create(companyId, { ...base, title: 'Pipeline EWM Consultant' });
  jobB = await Job.create(companyId, { ...base, title: 'Pipeline FI Consultant', role: 's4-fi' });

  /* eslint-disable no-await-in-loop */
  for (const [email, name, job] of [
    [OWN[2], 'Pipeline Anna Mueller', jobA],
    [OWN[3], 'Pipeline Bert Olsen', jobB],
    [OWN[4], 'Pipeline Clara Rossi', jobA]
  ]) {
    const consultant = await User.create({ email, password: PASSWORD, name, roles: ['consultant'] });
    await User.setEmailVerified(consultant.id);
    applicants[email] = consultant.id;
    await Application.apply(job.id, consultant.id, { coverLetter: 'Test.', dayRate: 900, currency: 'EUR' });
  }
  /* eslint-enable no-await-in-loop */

  // Clara withdraws; Bert reaches interview and is then turned down.
  const clara = await Application.list({ company_user_id: companyId, q: 'Clara' });
  await Application.transition(clara.rows[0].id, applicants[OWN[4]], 'withdrawn', { actorIsEmployer: false });

  const bert = await Application.list({ company_user_id: companyId, q: 'Bert' });
  for (const to of ['reviewing', 'shortlisted', 'interviewing', 'rejected']) {
    // eslint-disable-next-line no-await-in-loop
    await Application.transition(bert.rows[0].id, companyId, to, { actorIsEmployer: true });
  }

  [employer, rival, candidate] = await Promise.all([signIn(OWN[0]), signIn(OWN[1]), signIn(OWN[2])]);
});

maybe()('GET /applications', () => {
  it('shows every candidate across every one of this company\'s roles', async () => {
    const res = await employer.get('/applications');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Pipeline Anna Mueller');
    expect(res.text).toContain('Pipeline Bert Olsen');
    // And says which advert each one applied to, or it is a list of people with no subject.
    expect(res.text).toContain('Pipeline EWM Consultant');
    expect(res.text).toContain('Pipeline FI Consultant');
  });

  it('hides the candidate who withdrew, and gives her back on request', async () => {
    const hidden = await employer.get('/applications');
    expect(hidden.text).not.toContain('Pipeline Clara Rossi');

    const shown = await employer.get('/applications?withdrawn=1');
    expect(shown.text).toContain('Pipeline Clara Rossi');
  });

  it('searches by name through likePattern', async () => {
    const res = await employer.get('/applications?q=Mueller');
    expect(res.text).toContain('Pipeline Anna Mueller');
    expect(res.text).not.toContain('Pipeline Bert Olsen');

    // A bare wildcard is a search for that character, not for every row.
    const wild = await employer.get('/applications?q=%25');
    expect(wild.text).not.toContain('Pipeline Anna Mueller');
  });

  it('counts "interviewed" from the event log, so a rejected interviewee still matches', async () => {
    const res = await employer.get('/applications?reached=interviewing');
    // Bert is `rejected` now. He still interviewed, which is the question the box asks.
    expect(res.text).toContain('Pipeline Bert Olsen');
    expect(res.text).not.toContain('Pipeline Anna Mueller');
  });

  it('shows nobody else\'s pipeline', async () => {
    const res = await rival.get('/applications');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('Pipeline Anna Mueller');
    expect(res.text).not.toContain('Pipeline Bert Olsen');
  });

  it('is for hiring accounts', async () => {
    const res = await candidate.get('/applications');
    // A plain supertest client sends no Sec-Fetch-Dest, so the guard treats it as a
    // navigation and redirects rather than answering JSON.
    expect(res.status).toBe(302);
  });
});

maybe()('GET /applications?view=board', () => {
  it('is the same rows in a different shape', async () => {
    const board = await employer.get('/applications?view=board');
    expect(board.status).toBe(200);
    expect(board.text).toContain('Pipeline Anna Mueller');
    // The board carries the live stages only.
    Application.BOARD_COLUMNS.forEach((c) => expect(board.text).toContain(`id="col-${c}"`));
    expect(board.text).not.toContain('id="col-rejected"');
  });

  it('hides what the list hides', async () => {
    const board = await employer.get('/applications?view=board');
    expect(board.text).not.toContain('Pipeline Clara Rossi');
  });

  it('offers no drag-and-drop, and no move the model would refuse', async () => {
    /*
     * A drop target offers every column, including the ones Application.TRANSITIONS
     * refuses — so the gesture promises moves the server then rejects, and the keyboard
     * cannot make it at all. The cards carry the declared transitions as real buttons.
     */
    const board = await employer.get('/applications?view=board');
    expect(board.text).not.toMatch(/draggable="true"/);
    expect(board.text).not.toMatch(/ondrop|dragstart/i);
    expect(board.text).toContain('/transition');
    // Anna is `submitted`: reviewing and rejected are offered, withdrawn never is.
    expect(Application.transitionsFor('submitted', { actorIsEmployer: true })).toEqual(['reviewing', 'rejected']);
  });
});

maybe()('the two sides of the state machine', () => {
  it('refuses to let an employer withdraw somebody else\'s application', async () => {
    const { rows } = await Application.list({ company_user_id: companyId, q: 'Anna' });
    await expect(
      Application.transition(rows[0].id, companyId, 'withdrawn', { actorIsEmployer: true })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('keeps the public count honest, which is why', async () => {
    // countForJob excludes withdrawn rows on the reading that somebody who pulled out is
    // not competition. An employer able to set that status edits what the number means.
    const before = await Application.countForJob(jobA.id);
    expect(before).toBe(1);
  });
});
