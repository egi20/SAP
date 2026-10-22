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
  // An advert stored under a role slug the taxonomy no longer knows.
  ids.legacy = (await Job.create(company.id, { ...base, title: 'Rateindex legacy', status: 'open', rate_min: 1200, rate_max: 1300, rate_visible: 1 })).id;
  await promisePool.query("UPDATE jobs SET role = 'retired-role-slug' WHERE id = ?", [ids.legacy]);
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

  it('labels an advert whose role the taxonomy no longer knows, and does not link it', async () => {
    const res = await request(app).get('/rates');
    expect(res.text).toContain('Other role');
    expect(res.text).not.toContain('/rates/retired-role-slug');
  });

  it('describes itself as a Dataset to search engines, with the badge style hero', async () => {
    const res = await request(app).get('/rates');
    const ld = JSON.parse(res.text.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
    expect(ld['@type']).toBe('Dataset');
    expect(res.text).toContain('section-badge');
  });

  it('carries industry and skills through the calculator and into the shared link', async () => {
    const res = await request(app).get('/rates/calculator?role=s4-ewm&industry=finance&skills=btp&skills=ai');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Client industry');
    expect(res.text).toMatch(/data-copy="[^"]*industry=finance[^"]*skills=btp&amp;skills=ai/);
    expect(res.text).toContain('data-print');
  });

  it('asks for contributions where the index needs them, and shows what each skill adds', async () => {
    const res = await request(app).get('/rates');
    expect(res.text).toContain('Help build the index');
    expect(res.text).toMatch(/href="\/rates\/submit"[^>]*>[\s\S]{0,120}Add your figure/);
    expect(res.text).toMatch(/SAP BTP \+5%/);
    expect((res.text.match(/class="role-rate-link/g) || []).length).toBeGreaterThan(40);
  });
});
