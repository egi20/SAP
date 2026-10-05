'use strict';

/**
 * The rate benchmark, as served.
 *
 * The model has its own unit tests; these cover the things only the router decides — that
 * the per-role pages do not shadow the two fixed paths beside them, that a benchmark is a
 * shareable URL rather than the result of a POST, and that what the page prints is what the
 * model computed.
 */

const request = require('supertest');
const { benchmark } = require('../../utils/rateBenchmark');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

let app;

/*
 * NO POOL TEARDOWN HERE. `tests/setup.js` registers a global afterAll that closes the pool
 * and the session store, and a hook registered there runs BEFORE a top-level hook in this
 * file — so a top-level afterAll that queries anything gets "Pool is closed", which Jest
 * reports as the whole suite failing while every test in it passed. Fixtures are therefore
 * cleared on the way IN, which also makes a run independent of how the last one ended.
 */
maybe()('GET /rates/calculator', () => {
  beforeAll(() => {
    app = require('../../server');
  });

  it('renders the empty form with no query at all', async () => {
    const res = await request(app).get('/rates/calculator');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Benchmark your day rate');
    // Nothing is claimed before anything is asked.
    expect(res.text).not.toContain('Recommended');
  });

  it('answers a GET, so the result is a link somebody can send', async () => {
    const res = await request(app)
      .get('/rates/calculator?role=s4-ewm&years=12&country=DE&work_mode=onsite&certifications=3&contract_type=fixed-price');
    expect(res.status).toBe(200);

    const expected = benchmark({
      role: 's4-ewm', years: 12, country: 'DE', workMode: 'onsite',
      certifications: 3, contractType: 'fixed-price'
    });
    // The page prints what the model computed — not a figure the view re-derived.
    expect(res.text).toContain(String(expected.recommended));
    expect(res.text).toContain(String(expected.min));
    expect(res.text).toContain(String(expected.max));
  });

  it('prints the working, not only the answer', async () => {
    const res = await request(app).get('/rates/calculator?role=s4-fi&years=8&country=GB');
    expect(res.text).toContain('How that figure was reached');
    expect(res.text).toContain('Base rate for this role');
    // Each factor's chosen value is named, or the multipliers mean nothing.
    expect(res.text).toContain('UK &amp; Ireland');
  });

  it('states the divisors behind the monthly and annual figures', async () => {
    const res = await request(app).get('/rates/calculator?role=s4-fi&years=8');
    expect(res.text).toMatch(/20 billable days a month/);
    expect(res.text).toMatch(/220 a year/);
  });

  it('says so plainly when the role is not one we publish', async () => {
    const res = await request(app).get('/rates/calculator?role=wizard');
    expect(res.status).toBe(200);
    expect(res.text).toContain('not a role we publish');
  });

  it('survives a hand-edited query string', async () => {
    const res = await request(app).get('/rates/calculator?role=s4-fi&years=-9&certifications=abc&work_mode=../etc');
    expect(res.status).toBe(200);
  });

  it('keeps the contributed index separate from the model', async () => {
    /*
     * The claim is that there are TWO answers under two headings, not that the contributed
     * one happens to be suppressed. Asserting "Not published" was really asserting that
     * nobody had contributed anything to this role — true on an empty database, and it
     * failed the day development data was seeded, for a reason that had nothing to do with
     * the separation it was meant to test.
     */
    const res = await request(app).get('/rates/calculator?role=s4-fi&years=8');
    expect(res.text).toContain('How that figure was reached');
    expect(res.text).toContain('What members actually report');
    expect(res.text).toContain('the figure on the left is our model');
  });

  it('withholds a contributed figure for a role nobody has filled in', async () => {
    // A role with no contributions anywhere shows the floor instead of a number — which is
    // the behaviour that makes the index trustworthy, tested where it can be relied on.
    const res = await request(app).get('/rates/calculator?role=concur&years=8');
    expect(res.text).toContain('Not published');
    expect(res.text).toMatch(/At least \d+ are needed/);
  });

  /*
   * The standing refusal, pinned at the page as well as at the model: DynamicsHub's
   * equivalent ends with a block computing a monthly tax saving.
   */
  it('offers no savings, take-home or tax figure', async () => {
    const res = await request(app).get('/rates/calculator?role=s4-fi&years=8&country=DE');
    const body = res.text.toLowerCase();
    expect(body).not.toContain('take-home');
    expect(body).not.toContain('you would save');
    expect(body).not.toContain('monthly saving');
    // Saying it is before tax is the opposite of computing one.
    expect(body).toContain('before tax');
  });
});

maybe()('GET /rates/:role', () => {
  beforeAll(() => {
    app = require('../../server');
  });

  it('renders a known role with its curated table', async () => {
    const res = await request(app).get('/rates/s4-ewm');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Published benchmark');
    expect(res.text).toContain('15+ years');
  });

  it('404s an unknown slug rather than redirecting to the index', async () => {
    // These URLs get linked to from outside. A silent redirect turns a typo nobody notices
    // into a page that quietly answers a different question.
    const res = await request(app).get('/rates/not-a-real-role');
    expect(res.status).toBe(404);
  });

  it.each(['/rates/submit', '/rates/calculator'])('does not shadow %s', async (path) => {
    const res = await request(app).get(path);
    // /submit is gated, so a 302 to the login page; /calculator is public. Neither is the
    // 404 a `:role` match would produce.
    expect([200, 302]).toContain(res.status);
  });

  it('links onward to the calculator for that same role', async () => {
    const res = await request(app).get('/rates/s4-fi');
    expect(res.text).toContain('/rates/calculator?role=s4-fi');
  });
});
