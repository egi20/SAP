'use strict';

/**
 * Payments, against a real database.
 *
 * Everything interesting here is a UNIQUE KEY doing its job, so none of it is visible
 * without one. Fulfilment is deliberately not gated on the payment's own status — the
 * webhook and the success page race, always — so what makes it safe is that every write is
 * an INSERT IGNORE against a unique key and the database decides the winner.
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');
const Payment = require('../../models/Payment');
const Job = require('../../models/Job');
const { fulfil, billingDetailsFor } = require('../../services/paymentFulfilment');
const { PRODUCTS, JOB_FEATURE_PRICE_MINOR, JOB_FEATURE_DAYS, depositForTotal } = require('../../config/payments');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

let app;

const OWN_ACCOUNTS = ['pay-company@example.test', 'pay-other@example.test'];

const CSRF = /name="_csrf" value="([^"]+)"/;

function csrfFrom(html) {
  const match = html.match(CSRF);
  if (!match) throw new Error('No CSRF token on that page');
  return match[1];
}

async function signUp({ email, name, roles }) {
  const agent = request.agent(app);
  const page = await agent.get('/auth/register');
  await agent
    .post('/auth/register')
    .type('form')
    .send({
      _csrf: csrfFrom(page.text),
      email,
      name,
      password: 'Sup3rSecret',
      confirm_password: 'Sup3rSecret',
      user_types: roles,
      terms: 'on'
    });
  await promisePool.query('UPDATE users SET email_verified = 1 WHERE email = ?', [email]);

  const login = await agent.get('/auth/login');
  await agent
    .post('/auth/login')
    .type('form')
    .send({ _csrf: csrfFrom(login.text), email, password: 'Sup3rSecret' });
  return agent;
}

async function userId(email) {
  const [[row]] = await promisePool.query('SELECT id FROM users WHERE email = ?', [email]);
  return row.id;
}

beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');
  await promisePool.query('DELETE FROM users WHERE email IN (?)', [OWN_ACCOUNTS]);
});

maybe()('a price is derived, never accepted', () => {
  let company;
  let companyId;
  let otherId;
  let jobId;

  beforeAll(async () => {
    company = await signUp({ email: 'pay-company@example.test', name: 'Paying Co', roles: 'company' });
    await signUp({ email: 'pay-other@example.test', name: 'Other Co', roles: 'company' });
    companyId = await userId('pay-company@example.test');
    otherId = await userId('pay-other@example.test');

    const form = await company.get('/jobs/new');
    await company
      .post('/jobs')
      .type('form')
      .send({
        _csrf: csrfFrom(form.text),
        title: 'S/4HANA EWM lead',
        description: 'Warehouse rollout across four sites, realize through deploy, hands on.',
        role: 's4-ewm',
        seniority: 'lead',
        engagement_type: 'contract',
        work_mode: 'remote',
        country: 'DE',
        modules: ['ewm'],
        publish: 'on'
      });

    const [[job]] = await promisePool.query("SELECT id FROM jobs WHERE title = 'S/4HANA EWM lead'");
    jobId = job.id;
  });

  test('the resolver prices a job its owner posted', async () => {
    const priced = await PRODUCTS.job_feature.resolve(companyId, jobId);
    expect(priced.ok).toBe(true);
    expect(priced.amountMinor).toBe(JOB_FEATURE_PRICE_MINOR);
  });

  test('and refuses one they did not', async () => {
    const refused = await PRODUCTS.job_feature.resolve(otherId, jobId);
    expect(refused.ok).toBe(false);
    expect(refused.reason).toMatch(/only feature a job you posted/i);
  });

  test('a closed job cannot be featured', async () => {
    await promisePool.query("UPDATE jobs SET status = 'closed' WHERE id = ?", [jobId]);
    const refused = await PRODUCTS.job_feature.resolve(companyId, jobId);
    expect(refused.ok).toBe(false);
    await promisePool.query("UPDATE jobs SET status = 'open' WHERE id = ?", [jobId]);
  });

  test('an amount posted in the request cannot reach the payment', async () => {
    /*
     * The whole point of the resolver. The browser says WHAT to buy; the catalogue says
     * what it costs. DynamicsHub's price-tampering finding was a submitted amount reaching
     * the checkout.
     */
    const page = await company.get('/jobs/new');
    const res = await company
      .post('/payments/checkout/job_feature')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), subjectId: jobId, amountMinor: 1, amount: 1, price: 1 });

    // Stripe is not configured in tests, so checkout is refused — but nothing was created
    // at a price the request named.
    const [rows] = await promisePool.query('SELECT amount_minor FROM payments WHERE user_id = ?', [companyId]);
    for (const row of rows) expect(row.amount_minor).toBe(JOB_FEATURE_PRICE_MINOR);
    expect([302, 303, 503]).toContain(res.status);
  });
});

maybe()('fulfilment is safe to run twice, in any order', () => {
  let companyId;
  let jobId;

  beforeAll(async () => {
    companyId = await userId('pay-company@example.test');
    const [[job]] = await promisePool.query("SELECT id FROM jobs WHERE title = 'S/4HANA EWM lead'");
    jobId = job.id;
  });

  test('one payment produces one featured window, however many times it is fulfilled', async () => {
    const payment = await Payment.create({
      userId: companyId,
      product: 'job_feature',
      subjectType: 'job',
      subjectId: jobId,
      amountMinor: JOB_FEATURE_PRICE_MINOR,
      currency: 'EUR',
      description: 'Featured placement — test',
      priceBasis: { flatMinor: JOB_FEATURE_PRICE_MINOR, days: JOB_FEATURE_DAYS }
    });

    const first = await fulfil(payment, { source: 'webhook' });
    const second = await fulfil(payment, { source: 'success-page' });

    // Only one caller CLAIMS the payment — that is who sends the receipt — but both are
    // safe, and the second creates nothing.
    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(false);

    const [windows] = await promisePool.query('SELECT id FROM job_features WHERE payment_id = ?', [payment.id]);
    expect(windows).toHaveLength(1);

    const [invoices] = await promisePool.query('SELECT id FROM invoices WHERE payment_id = ?', [payment.id]);
    expect(invoices).toHaveLength(1);
  });

  test('a second purchase EXTENDS the window rather than colliding with it', async () => {
    const before = await Job.featuredUntil(jobId);
    expect(before).not.toBeNull();

    const renewal = await Payment.create({
      userId: companyId,
      product: 'job_feature',
      subjectType: 'job',
      subjectId: jobId,
      amountMinor: JOB_FEATURE_PRICE_MINOR,
      currency: 'EUR',
      description: 'Featured placement — renewal',
      priceBasis: { flatMinor: JOB_FEATURE_PRICE_MINOR, days: JOB_FEATURE_DAYS }
    });
    await fulfil(renewal, { source: 'webhook' });

    const after = await Job.featuredUntil(jobId);
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());

    const [windows] = await promisePool.query('SELECT id FROM job_features WHERE job_id = ?', [jobId]);
    expect(windows.length).toBe(2); // overlapping rows are the design, not a bug
  });

  test('a featured job sorts above an unfeatured one, whatever the chosen sort', async () => {
    const { rows } = await Job.browse({}, { limit: 20, sort: 'newest' });
    const featured = rows.filter((r) => r.is_featured);
    expect(featured.length).toBeGreaterThan(0);
    // Every featured row comes before every unfeatured one.
    const firstUnfeatured = rows.findIndex((r) => !r.is_featured);
    const lastFeatured = rows.map((r) => Boolean(r.is_featured)).lastIndexOf(true);
    if (firstUnfeatured !== -1) expect(lastFeatured).toBeLessThan(firstUnfeatured);
  });
});

maybe()('two payments for one exclusive subject', () => {
  let companyId;
  let quoteId;

  beforeAll(async () => {
    companyId = await userId('pay-company@example.test');

    const { calculateEstimation } = require('../../utils/sapEstimation');
    const { catalogueVersion } = require('../../config/estimation');
    const Quote = require('../../models/Quote');

    const estimate = calculateEstimation({ selectedModules: ['fi-gl', 'sd-sales'], numberOfIntegrations: 2 });
    const quote = await Quote.create(companyId, {
      client: { name: 'A Buyer', company: 'Acme GmbH' },
      project: { name: 'Deposit test' },
      inputs: { selectedModules: ['fi-gl', 'sd-sales'], transitionApproach: 'greenfield' },
      estimate,
      catalogueVersion: catalogueVersion()
    });
    quoteId = quote.id;
    await promisePool.query("UPDATE quotes SET status = 'accepted' WHERE id = ?", [quoteId]);
  });

  test('only one settles it; the loser is flagged for a human and never auto-refunded', async () => {
    const [[quote]] = await promisePool.query('SELECT total_budget FROM quotes WHERE id = ?', [quoteId]);
    const deposit = depositForTotal(quote.total_budget);

    const makePayment = () =>
      Payment.create({
        userId: companyId,
        product: 'quote_deposit',
        subjectType: 'quote',
        subjectId: quoteId,
        amountMinor: deposit.amountMinor,
        currency: 'EUR',
        description: 'Project deposit — test',
        priceBasis: { percent: 10, quoteTotal: Number(quote.total_budget), basis: deposit.basis }
      });

    // Two checkout tabs, one quote. These are two DIFFERENT payments, so the per-payment
    // unique key cannot see the collision — the key on quote_deposits.quote_id can.
    const winner = await makePayment();
    const loser = await makePayment();

    const first = await fulfil(winner, { source: 'webhook' });
    const second = await fulfil(loser, { source: 'webhook' });

    expect(first.fulfilled).toBe(true);
    expect(first.collided).toBe(false);
    expect(second.collided).toBe(true);

    const [deposits] = await promisePool.query('SELECT payment_id FROM quote_deposits WHERE quote_id = ?', [quoteId]);
    expect(deposits).toHaveLength(1);
    expect(deposits[0].payment_id).toBe(winner.id);

    // The loser is flagged, not reversed. A refund is a decision with a person on the
    // other end of it, never something a webhook handler does on a partial view.
    const [[loserRow]] = await promisePool.query('SELECT needs_refund, status FROM payments WHERE id = ?', [loser.id]);
    expect(loserRow.needs_refund).toBe(1);
    expect(loserRow.status).not.toBe('refunded');

    // And above all: no invoice for money that is about to be given back.
    const [invoices] = await promisePool.query('SELECT id FROM invoices WHERE payment_id = ?', [loser.id]);
    expect(invoices).toHaveLength(0);
  });

  test('the deposit resolver refuses a second attempt once one is paid', async () => {
    const refused = await PRODUCTS.quote_deposit.resolve(companyId, quoteId);
    expect(refused.ok).toBe(false);
    expect(refused.reason).toMatch(/already been paid/i);
  });

  test('a deposit cannot be taken against a quote that is not accepted', async () => {
    await promisePool.query("UPDATE quotes SET status = 'draft' WHERE id = ?", [quoteId]);
    const refused = await PRODUCTS.quote_deposit.resolve(companyId, quoteId);
    expect(refused.ok).toBe(false);
    expect(refused.reason).toMatch(/once the quote is accepted/i);
  });
});

maybe()('the invoice', () => {
  test('is billed to a name somebody chose, never an email local part', async () => {
    const companyId = await userId('pay-company@example.test');
    const billTo = await billingDetailsFor(companyId);

    expect(billTo.name).toBe('Paying Co');
    expect(billTo.name).not.toContain('@');
    expect(billTo.email).toBe('pay-company@example.test');
  });

  test('snapshots the buyer rather than joining the profile', async () => {
    const companyId = await userId('pay-company@example.test');
    const [[invoice]] = await promisePool.query(
      'SELECT id, bill_to_name FROM invoices WHERE user_id = ? ORDER BY id LIMIT 1',
      [companyId]
    );
    expect(invoice.bill_to_name).toBe('Paying Co');

    // Renaming the account must not rewrite an invoice already issued.
    await promisePool.query("UPDATE users SET name = 'Renamed Co' WHERE id = ?", [companyId]);
    const [[after]] = await promisePool.query('SELECT bill_to_name FROM invoices WHERE id = ?', [invoice.id]);
    expect(after.bill_to_name).toBe('Paying Co');

    await promisePool.query("UPDATE users SET name = 'Paying Co' WHERE id = ?", [companyId]);
  });
});
