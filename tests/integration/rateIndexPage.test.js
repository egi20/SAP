'use strict';

/**
 * /rates laid out like dynamicshub.net's Rate & Salary Index: the page renders every
 * section, and the advert figures read only open adverts that show their rate.
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');
const User = require('../../models/User');
const Job = require('../../models/Job');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const COMPANY = 'rateindex-co@example.test';
let app;
const ids = {};

beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');
  await promisePool.query('DELETE FROM users WHERE email = ?', [COMPANY]);
  const company = await User.create({ email: COMPANY, password: 'Rate-Index-Pass-1', name: 'Rateindex Co', roles: ['company'] });
  const base = { description: 'A test advert.', role: 's4-ewm', seniority: 'senior', engagement_type: 'contract', work_mode: 'remote', country: 'DE', currency: 'EUR' };
  ids.shown = (await Job.create(company.id, { ...base, title: 'Rateindex shown', status: 'open', rate_min: 800, rate_max: 900, rate_visible: 1 })).id;
  ids.hidden = (await Job.create(company.id, { ...base, title: 'Rateindex hidden', status: 'open', rate_min: 700, rate_max: 750, rate_visible: 0 })).id;
  ids.draft = (await Job.create(company.id, { ...base, title: 'Rateindex draft', status: 'draft', rate_min: 600, rate_max: 650, rate_visible: 1 })).id;
});

maybe()('the Rate & Salary Index', () => {
  it('reads open adverts that show their rate, and nothing else', async () => {
    const rows = await Job.advertisedRateRows('contract');
    const seen = rows.map((r) => r.id);
    expect(seen).toContain(ids.shown);
    expect(seen).not.toContain(ids.hidden);
    expect(seen).not.toContain(ids.draft);
  });

  it('renders every section, for anybody', async () => {
    const res = await request(app).get('/rates');
    expect(res.status).toBe(200);
    for (const heading of ['Benchmark my rate', 'Market rate trends', 'Rates by role', 'Community rate index',
      'Daily rate budgets (contract adverts)', 'Annual salaries (permanent adverts)', 'Rate benchmarks by role', 'Methodology']) {
      expect(res.text).toContain(heading.replace(/&/g, '&amp;'));
    }
  });

  it('switches the breakdown tab by link, and ignores a tab it does not know', async () => {
    expect((await request(app).get('/rates?tab=country')).text).toMatch(/nav-link active[^>]*>[\s\S]{0,80}By country/);
    expect((await request(app).get('/rates?tab=nope')).text).toMatch(/nav-link active[^>]*>[\s\S]{0,80}By role/);
  });

  it('still offers no savings, take-home or tax figure', async () => {
    const body = (await request(app).get('/rates')).text.toLowerCase();
    expect(body).not.toContain('take-home');
    expect(body).not.toContain('monthly saving');
  });
});
