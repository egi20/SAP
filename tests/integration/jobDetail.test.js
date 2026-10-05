'use strict';

/**
 * The job advert's own page.
 *
 * Most of what is asserted here is markup, and it is worth asserting because each piece is
 * a promise: a share link that carries localhost into somebody's timeline, an application
 * count that includes the people who withdrew, a "Back" button that goes somewhere the
 * reader has never been. All three look correct on the page.
 */

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { promisePool } = require('../../config/database');
const User = require('../../models/User');
const Job = require('../../models/Job');
const Application = require('../../models/Application');
const CompanyProfile = require('../../models/CompanyProfile');
const config = require('../../config/config');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const OWN = ['jd-co@example.test', 'jd-con1@example.test', 'jd-con2@example.test'];
const TITLE = 'Jobdetail EWM Consultant for a wave rollout';

let app;
let job;
let companyId;
const applicantIds = [];

beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');
  await promisePool.query('DELETE FROM users WHERE email IN (?)', [OWN]);

  const company = await User.create({
    email: OWN[0], password: 'Jd-Test-Pass-1', name: 'Jobdetail Logistics', roles: ['company']
  });
  companyId = company.id;
  await CompanyProfile.ensureExists(companyId, 'Jobdetail Logistics');
  await CompanyProfile.update(companyId, {
    company_type: 'end_customer', country: 'DE', city: 'Hamburg',
    website: 'https://example.test',
    // `about` and `company_size`, which are what the columns are called — CompanyProfile
    // .update filters against an allowed list and drops a wrong name in silence.
    about: 'A distribution business running three warehouses on EWM.',
    company_size: '201-1000'
  });

  job = await Job.create(companyId, {
    title: TITLE,
    description: 'A twelve-month EWM engagement.',
    role: 's4-ewm', seniority: 'senior', engagement_type: 'contract', work_mode: 'hybrid',
    country: 'DE', city: 'Hamburg', rate_min: 900, rate_max: 1100, rate_visible: 1,
    currency: 'EUR', duration_months: 12, activate_phase: 'realize', status: 'open'
  });

  // Sequential: each application needs its applicant to exist first, and the order the
  // two land in is what the withdrawal case below indexes into.
  /* eslint-disable no-await-in-loop */
  for (const email of [OWN[1], OWN[2]]) {
    const consultant = await User.create({
      email, password: 'Jd-Test-Pass-1', name: `Jobdetail Applicant ${email[7]}`, roles: ['consultant']
    });
    await User.setEmailVerified(consultant.id);
    applicantIds.push(consultant.id);
    await Application.apply(job.id, consultant.id, {
      coverLetter: 'A test application.', dayRate: 950, currency: 'EUR'
    });
  }
  /* eslint-enable no-await-in-loop */
});

maybe()('GET /jobs/:slug', () => {
  it('says where the breadcrumb goes rather than promising "Back"', async () => {
    /*
     * The app sends Referrer-Policy: no-referrer, so the server cannot know where somebody
     * came from. A button labelled "Back" that always goes to the same place is lying
     * about half the time.
     */
    const res = await request(app).get(`/jobs/${job.slug}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('All jobs');
    expect(res.text).toMatch(/breadcrumb/);
  });

  it('shows an overview of the terms', async () => {
    const res = await request(app).get(`/jobs/${job.slug}`);
    expect(res.text).toContain('Job overview');
    ['contract', 'hybrid', 'Hamburg', 'senior', 'realize', '12 months'].forEach((value) => {
      expect(res.text).toContain(value);
    });
  });

  it('counts applications, and does not count the people who withdrew', async () => {
    // The number answers "how much competition is there", and somebody who pulled out is
    // not competition — counting them inflates it in the one direction that discourages
    // the next reader for no reason.
    expect(await Application.countForJob(job.id)).toBe(2);

    await promisePool.query(
      "UPDATE applications SET status = 'withdrawn' WHERE job_id = ? AND consultant_user_id = ?",
      [job.id, applicantIds[0]]
    );
    expect(await Application.countForJob(job.id)).toBe(1);

    await promisePool.query(
      "UPDATE applications SET status = 'submitted' WHERE job_id = ? AND consultant_user_id = ?",
      [job.id, applicantIds[0]]
    );
  });

  it('builds share links from the canonical URL, not from the request', async () => {
    /*
     * A link assembled from whatever host the browser happened to use carries localhost —
     * or a staging hostname — into somebody's timeline, where it is wrong forever and
     * nobody can tell why.
     */
    const res = await request(app).get(`/jobs/${job.slug}`);
    const canonical = `${config.app.baseUrl}/jobs/${job.slug}`;
    expect(res.text).toContain(encodeURIComponent(canonical));
    expect(res.text).toContain('linkedin.com/sharing');
    expect(res.text).toContain('mailto:');
    // The copy button is built by main.js; the page ships the slot and the URL only.
    expect(res.text).toContain(`data-copy="${canonical}"`);
  });

  it('loads no third-party script to do it', async () => {
    // This page currently loads nothing from anybody else's domain, and a share widget is
    // the usual way that stops being true.
    const res = await request(app).get(`/jobs/${job.slug}`);
    expect(res.text).not.toMatch(/<script[^>]+src="https?:\/\/(?!localhost)/);
  });

  it('describes the company advertising it', async () => {
    const res = await request(app).get(`/jobs/${job.slug}`);
    expect(res.text).toContain('About Jobdetail Logistics');
    expect(res.text).toContain('End customer');
    expect(res.text).toContain('201-1000');
    expect(res.text).toContain('three warehouses on EWM');
    expect(res.text).toContain('Their other roles');
  });

  it('leaves the card out entirely when there is nothing to say', async () => {
    // An "About the company" heading over an empty box is worse than no card: it reads as
    // a company that could not be bothered.
    const bare = await User.create({
      email: `jd-bare-${Date.now()}@example.test`, password: 'Jd-Test-Pass-1',
      name: 'Jobdetail Bare', roles: ['company']
    });
    try {
      await CompanyProfile.ensureExists(bare.id, 'Jobdetail Bare');
      const bareJob = await Job.create(bare.id, {
        title: `Jobdetail bare advert ${Date.now()}`,
        description: 'No company profile behind this one.',
        role: 's4-fi', seniority: 'mid', engagement_type: 'contract', work_mode: 'remote',
        country: 'DE', activate_phase: 'explore', status: 'open'
      });
      const res = await request(app).get(`/jobs/${bareJob.slug}`);
      expect(res.status).toBe(200);
      /*
       * company_type has a DEFAULT of 'end_customer', so every row has one — a condition
       * that included it was always true and rendered the heading over an empty box.
       */
      expect(res.text).not.toContain('About Jobdetail Bare');
    } finally {
      await promisePool.query('DELETE FROM users WHERE id = ?', [bare.id]);
    }
  });
});

maybe()('the copy button', () => {
  it('is built by the script and not rendered dead by the server', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'main.js'), 'utf8');
    expect(js).toContain('copy-link');
    // It reads data-copy rather than location.href, which would carry whatever query
    // string the reader arrived with into the link they then send somebody.
    expect(js).toContain("getAttribute('data-copy')");
    expect(js).not.toMatch(/writeText\(\s*location\.href/);
    // navigator.clipboard needs a secure context; a plain-http deployment is not one.
    expect(js).toContain('isSecureContext');
    expect(js).toContain('aria-live');
  });
});
