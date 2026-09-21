'use strict';

/**
 * Referrals end to end, against a real database.
 *
 * What is being tested is a liability: who is owed what, and whether the number survives
 * the things that happen to it — a redelivered webhook, a referrer paid twice, a
 * refund, a rate changed after the fact. Every balance here is a SUM over the ledger,
 * because there is no balance column anywhere and that is the point.
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');
const Referral = require('../../models/Referral');
const Payment = require('../../models/Payment');
const { fulfil } = require('../../services/paymentFulfilment');
const {
  DEFAULT_RATE_BPS,
  MAX_COMMISSION_MINOR,
  MIN_PAYOUT_MINOR,
  commissionMinor
} = require('../../config/referrals');
const { PRODUCTS } = require('../../config/payments');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

let app;

const OWN_ACCOUNTS = [
  'ref-referrer@example.test',
  'ref-buyer@example.test',
  'ref-stranger@example.test',
  'ref-admin@example.test'
];

const CSRF_META = /<meta name="csrf-token" content="([^"]+)"/;
const CSRF_FORM = /name="_csrf" value="([^"]+)"/;

function csrfFrom(html) {
  const match = html.match(CSRF_FORM) || html.match(CSRF_META);
  if (!match) throw new Error('No CSRF token on that page');
  return match[1];
}

async function signUp({ email, name, roles, agent = null }) {
  const client = agent || request.agent(app);
  const page = await client.get('/auth/register');
  await client
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

  const login = await client.get('/auth/login');
  await client
    .post('/auth/login')
    .type('form')
    .send({ _csrf: csrfFrom(login.text), email, password: 'Sup3rSecret' });
  return client;
}

async function userId(email) {
  const [[row]] = await promisePool.query('SELECT id FROM users WHERE email = ?', [email]);
  return row.id;
}

/** A settled payment, written the way the fulfilment path would find one. */
async function paidPayment({ buyerId, product = 'quote_deposit', amountMinor = 2500000, subjectId = null }) {
  const payment = await Payment.create({
    userId: buyerId,
    product,
    subjectType: PRODUCTS[product].subjectType,
    subjectId,
    amountMinor,
    currency: 'EUR',
    description: 'test payment'
  });
  await Payment.markPaid(payment.id);
  return Payment.findById(payment.id);
}

beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');
  await promisePool.query('DELETE FROM users WHERE email IN (?)', [OWN_ACCOUNTS]);
});

maybe()('attribution happens once, at registration, from the link that was followed', () => {
  let referrerRow;

  beforeAll(async () => {
    await signUp({ email: 'ref-referrer@example.test', name: 'Introducing Person', roles: 'consultant' });
    referrerRow = await Referral.enrol(await userId('ref-referrer@example.test'));
  });

  test('a code on any page is remembered, and the registration reads it', async () => {
    const agent = request.agent(app);
    // The link can point anywhere — that is the point of capturing it site-wide.
    await agent.get(`/jobs?ref=${referrerRow.code}`);
    await signUp({ email: 'ref-buyer@example.test', name: 'Buying Person', roles: 'company', agent });

    const attribution = await Referral.attributionFor(await userId('ref-buyer@example.test'));
    expect(attribution).toBeTruthy();
    expect(attribution.referrer_id).toBe(referrerRow.id);
    expect(attribution.rate_bps).toBe(DEFAULT_RATE_BPS);
  });

  test('the rate is snapshotted, so a later change cannot reprice an old introduction', async () => {
    const before = await Referral.attributionFor(await userId('ref-buyer@example.test'));
    await Referral.setRate(referrerRow.id, 2000);

    const after = await Referral.attributionFor(await userId('ref-buyer@example.test'));
    expect(after.rate_bps).toBe(before.rate_bps);

    await Referral.setRate(referrerRow.id, DEFAULT_RATE_BPS);
  });

  test('a posted code cannot override the link the visitor actually followed', async () => {
    /*
     * The session is read before the form field, and this is the security of the whole
     * scheme: a form-first read would let one referrer claim another's introduction by
     * posting their code into somebody else's registration.
     */
    const thief = await Referral.enrol(await userId('ref-referrer@example.test'));
    expect(thief.id).toBe(referrerRow.id); // enrol is idempotent

    const agent = request.agent(app);
    await agent.get(`/?ref=${referrerRow.code}`);

    const page = await agent.get('/auth/register');
    await agent
      .post('/auth/register')
      .type('form')
      .send({
        _csrf: csrfFrom(page.text),
        email: 'ref-stranger@example.test',
        name: 'Stranger Person',
        password: 'Sup3rSecret',
        confirm_password: 'Sup3rSecret',
        user_types: 'consultant',
        terms: 'on',
        ref: 'ZZZZZZZZ' // a code that is not the one followed
      });

    const attribution = await Referral.attributionFor(await userId('ref-stranger@example.test'));
    expect(attribution.referrer_id).toBe(referrerRow.id);

    // Registered by hand rather than through signUp(), so the verification step that
    // helper performs has to happen here too — login refuses an unverified account.
    await promisePool.query('UPDATE users SET email_verified = 1 WHERE email = ?', [
      'ref-stranger@example.test'
    ]);
  });

  test('a referrer cannot introduce themselves', async () => {
    const selfId = await userId('ref-referrer@example.test');
    expect(await Referral.attribute(referrerRow.code, selfId)).toBe(false);
    expect(await Referral.attributionFor(selfId)).toBeNull();
  });

  test('an account is attributed once and never re-attributed', async () => {
    const buyerId = await userId('ref-buyer@example.test');
    // Even called directly, a second attribution is refused by the unique key.
    expect(await Referral.attribute(referrerRow.code, buyerId)).toBe(false);

    const [[{ count }]] = await promisePool.query(
      'SELECT COUNT(*) AS count FROM referral_attributions WHERE referred_user_id = ?',
      [buyerId]
    );
    expect(count).toBe(1);
  });
});

maybe()('commission is earned when money arrives, and only then', () => {
  let referrerRow;
  let buyerId;

  beforeAll(async () => {
    referrerRow = await Referral.findByUserId(await userId('ref-referrer@example.test'));
    buyerId = await userId('ref-buyer@example.test');
    await promisePool.query('DELETE FROM commission_ledger WHERE referrer_id = ?', [referrerRow.id]);
  });

  test('a settled deposit credits its referrer, capped', async () => {
    const payment = await paidPayment({ buyerId, amountMinor: 2500000 });
    const result = await Referral.credit(payment);

    expect(result.credited).toBe(MAX_COMMISSION_MINOR);
    const balance = await Referral.balanceFor(referrerRow.id);
    expect(balance.unpaidMinor).toBe(MAX_COMMISSION_MINOR);
  });

  test('crediting the same payment twice pays once', async () => {
    const payment = await paidPayment({ buyerId, amountMinor: 100000 });
    const first = await Referral.credit(payment);
    const second = await Referral.credit(payment);

    expect(first.credited).toBe(commissionMinor(100000, DEFAULT_RATE_BPS));
    expect(second.credited).toBe(0);
    expect(second.reason).toBe('already credited');
  });

  test('a product that pays nothing is still recorded, with the reason', async () => {
    /*
     * "Your introduction bought something and it earned nothing" is information the
     * referrer is owed. A gap is what produces the email asking where their money went.
     */
    const payment = await paidPayment({ buyerId, amountMinor: 5000 });
    await promisePool.query("UPDATE payments SET product = 'not_commissionable' WHERE id = ?", [payment.id]);
    const reread = await Payment.findById(payment.id);

    const result = await Referral.credit(reread);
    expect(result.credited).toBe(0);

    const { rows } = await Referral.ledgerFor(referrerRow.id, { limit: 5 });
    expect(rows[0].note).toMatch(/not a commissionable product/i);
  });

  test('a payment from somebody nobody introduced earns nothing', async () => {
    const strangerId = await userId('ref-stranger@example.test');
    await promisePool.query('DELETE FROM referral_attributions WHERE referred_user_id = ?', [strangerId]);

    const payment = await paidPayment({ buyerId: strangerId, amountMinor: 100000 });
    const result = await Referral.credit(payment);
    expect(result).toEqual({ credited: 0, reason: 'not referred' });
  });

  test('an introduction past its window earns nothing, and the window is the stamped one', async () => {
    await promisePool.query(
      'UPDATE referral_attributions SET earns_until = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE referred_user_id = ?',
      [buyerId]
    );

    const payment = await paidPayment({ buyerId, amountMinor: 100000 });
    const result = await Referral.credit(payment);
    expect(result.reason).toBe('outside the earning window');

    await promisePool.query(
      'UPDATE referral_attributions SET earns_until = DATE_ADD(NOW(), INTERVAL 365 DAY) WHERE referred_user_id = ?',
      [buyerId]
    );
  });

  test('the fulfilment path credits without being asked twice', async () => {
    /*
     * Not gated on which racer claimed the payment: the dedupe key makes a second call a
     * no-op, and a commission that depends on who won the race is one that goes missing
     * the time the webhook lost.
     */
    const before = await Referral.balanceFor(referrerRow.id);
    const payment = await paidPayment({ buyerId, product: 'job_feature', amountMinor: 14900 });

    await fulfil(payment);
    await fulfil(payment);

    const after = await Referral.balanceFor(referrerRow.id);
    expect(after.unpaidMinor - before.unpaidMinor).toBe(commissionMinor(14900, DEFAULT_RATE_BPS));
  });
});

maybe()('paying it out, and taking it back', () => {
  let referrerRow;
  let buyerId;

  beforeAll(async () => {
    referrerRow = await Referral.findByUserId(await userId('ref-referrer@example.test'));
    buyerId = await userId('ref-buyer@example.test');
    await promisePool.query('DELETE FROM commission_ledger WHERE referrer_id = ?', [referrerRow.id]);
    await promisePool.query('DELETE FROM commission_payouts WHERE referrer_id = ?', [referrerRow.id]);
  });

  test('a balance below the floor is refused rather than transferred', async () => {
    const payment = await paidPayment({ buyerId, product: 'job_feature', amountMinor: 14900 });
    await Referral.credit(payment);

    const balance = await Referral.balanceFor(referrerRow.id);
    expect(balance.unpaidMinor).toBeLessThan(MIN_PAYOUT_MINOR);

    await expect(
      Referral.payOut(referrerRow.id, { method: 'bank_transfer' })
    ).rejects.toMatchObject({ code: 'BELOW_MINIMUM' });
  });

  test('a payout settles everything unpaid and leaves nothing to explain', async () => {
    const big = await paidPayment({ buyerId, amountMinor: 2500000 });
    await Referral.credit(big);

    const before = await Referral.balanceFor(referrerRow.id);
    const result = await Referral.payOut(referrerRow.id, {
      method: 'bank_transfer',
      reference: 'TRF-1',
      actorUserId: null
    });

    expect(result.amountMinor).toBe(before.unpaidMinor);
    const after = await Referral.balanceFor(referrerRow.id);
    expect(after.unpaidMinor).toBe(0);
    // The lifetime figure is not reduced by being paid: it is what was ever earned.
    expect(after.lifetimeEarnedMinor).toBe(before.lifetimeEarnedMinor);
  });

  test('a second payout straight after has nothing to settle', async () => {
    await expect(
      Referral.payOut(referrerRow.id, { method: 'bank_transfer' })
    ).rejects.toMatchObject({ code: 'NOTHING_TO_PAY' });
  });

  test('anything credited after a payout belongs to the next one', async () => {
    const payment = await paidPayment({ buyerId, product: 'job_feature', amountMinor: 14900 });
    await Referral.credit(payment);

    const balance = await Referral.balanceFor(referrerRow.id);
    expect(balance.unpaidMinor).toBe(commissionMinor(14900, DEFAULT_RATE_BPS));
  });

  /*
   * The gap the reference leaves: it credits on money received and has no path that
   * un-credits it, so a refunded payment owes a commission forever.
   */
  test('recording a refund reverses that payment’s commission, exactly', async () => {
    const payment = await paidPayment({ buyerId, amountMinor: 1000000 });
    const { credited } = await Referral.credit(payment);
    expect(credited).toBeGreaterThan(0);

    const before = await Referral.balanceFor(referrerRow.id);
    const { reversed } = await Referral.reverseForPayment(payment.id, { note: 're_test' });

    expect(reversed).toBe(-credited);
    const after = await Referral.balanceFor(referrerRow.id);
    expect(after.unpaidMinor).toBe(before.unpaidMinor - credited);
  });

  test('reversing the same refund twice reverses once', async () => {
    const payment = await paidPayment({ buyerId, amountMinor: 1000000 });
    await Referral.credit(payment);
    await Referral.reverseForPayment(payment.id);

    const before = await Referral.balanceFor(referrerRow.id);
    const again = await Referral.reverseForPayment(payment.id);

    expect(again).toEqual({ reversed: 0, reason: 'already reversed' });
    expect((await Referral.balanceFor(referrerRow.id)).unpaidMinor).toBe(before.unpaidMinor);
  });

  test('a commission already paid out still reverses, and the balance goes negative', async () => {
    /*
     * The correct answer, and a visible one: the next payout settles less. Writing it off
     * because the money already left would mean the Hub refunded a customer and kept
     * paying a commission on it.
     */
    const payment = await paidPayment({ buyerId, amountMinor: 2500000 });
    const { credited } = await Referral.credit(payment);
    await Referral.payOut(referrerRow.id, { method: 'bank_transfer', reference: 'TRF-2' });

    expect((await Referral.balanceFor(referrerRow.id)).unpaidMinor).toBe(0);

    await Referral.reverseForPayment(payment.id);
    expect((await Referral.balanceFor(referrerRow.id)).unpaidMinor).toBe(-credited);
  });

  test('a reversal is a compensating entry, never an edit', async () => {
    const [[earned]] = await promisePool.query(
      "SELECT COUNT(*) AS n FROM commission_ledger WHERE referrer_id = ? AND entry_type = 'earned'",
      [referrerRow.id]
    );
    // Every earning ever credited is still there to read.
    expect(Number(earned.n)).toBeGreaterThan(0);
  });
});

maybe()('what the referrer and the admin can see', () => {
  let referrer;
  let admin;

  beforeAll(async () => {
    referrer = request.agent(app);
    const login = await referrer.get('/auth/login');
    await referrer
      .post('/auth/login')
      .type('form')
      .send({ _csrf: csrfFrom(login.text), email: 'ref-referrer@example.test', password: 'Sup3rSecret' });

    await signUp({ email: 'ref-admin@example.test', name: 'Ref Admin', roles: 'consultant' });
    await promisePool.query(
      "UPDATE users SET user_type = 'admin', is_superadmin = 1 WHERE email = ?",
      ['ref-admin@example.test']
    );
    admin = request.agent(app);
    const adminLogin = await admin.get('/auth/login');
    await admin
      .post('/auth/login')
      .type('form')
      .send({ _csrf: csrfFrom(adminLogin.text), email: 'ref-admin@example.test', password: 'Sup3rSecret' });
  });

  test('the referrer sees their own code, balance and ledger', async () => {
    const res = await referrer.get('/referrals');
    expect(res.status).toBe(200);
    const row = await Referral.findByUserId(await userId('ref-referrer@example.test'));
    expect(res.text).toContain(row.code);
  });

  test('an account that has not asked is offered the scheme, not enrolled in it', async () => {
    const stranger = request.agent(app);
    const login = await stranger.get('/auth/login');
    await stranger
      .post('/auth/login')
      .type('form')
      .send({ _csrf: csrfFrom(login.text), email: 'ref-stranger@example.test', password: 'Sup3rSecret' });

    const res = await stranger.get('/referrals');
    expect(res.status).toBe(200);
    expect(await Referral.findByUserId(await userId('ref-stranger@example.test'))).toBeNull();
  });

  test('a retired code attributes nothing, and does not tell a stranger why', async () => {
    const row = await Referral.findByUserId(await userId('ref-referrer@example.test'));
    await Referral.setActive(row.id, false);

    const res = await request(app).get(`/referrals/go/${row.code}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');

    await Referral.setActive(row.id, true);
  });

  test('the admin overview is superadmin-only', async () => {
    expect((await admin.get('/admin/referrals')).status).toBe(200);

    const plain = request.agent(app);
    const login = await plain.get('/auth/login');
    await plain
      .post('/auth/login')
      .type('form')
      .send({ _csrf: csrfFrom(login.text), email: 'ref-referrer@example.test', password: 'Sup3rSecret' });
    expect((await plain.get('/admin/referrals')).status).toBe(302);
  });
});
