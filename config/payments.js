'use strict';

const { promisePool } = require('./database');

/**
 * The product catalogue, and the ONLY place a price is decided.
 *
 * The rule this file exists to enforce, learned from DynamicsHub's price-tampering
 * finding: a checkout amount is NEVER read from the request. It is derived here, on the
 * server, from a row the payer demonstrably owns. The browser says WHAT to buy; this
 * module says WHAT IT COSTS.
 *
 * Every amount is in MINOR UNITS (cents) and every arithmetic operation is on integers.
 * Stripe speaks minor units, invoices reconcile line by line, and a float euro is how a
 * total ends up a cent away from the sum of its parts.
 */

const CURRENCY = 'EUR';

/**
 * Where the Stripe webhook is served.
 *
 * It lives here rather than in the route file because server.js needs it in TWO places —
 * the raw body parser and the CSRF exemption — and a webhook exempted at one path while
 * being raw-parsed at another fails in a way nobody enjoys diagnosing.
 */
const WEBHOOK_PATH = '/payments/webhook';

/**
 * Featured placement for a job. A flat price, because the value to the buyer does not
 * scale with anything we can measure.
 *
 * Repeat purchases are ADDITIVE by design: buying a second window while one is running
 * extends it rather than replacing it, so there is no "already featured" rejection to
 * argue with and no second guard needed on the subject (see `job_features` in migration
 * 010, which deliberately has no unique key on `job_id`).
 */
const JOB_FEATURE_DAYS = 30;
const JOB_FEATURE_PRICE_MINOR = 14900; // €149.00

/**
 * Deposit against an accepted scope estimate.
 *
 * Derived from the quote's OWN stored total — the figure actually presented to the client
 * — never from today's catalogue and never from the form. A quote is a statement made on a
 * date; the deposit follows the statement.
 *
 * THE CAP BINDS ALMOST ALWAYS HERE, AND THAT CHANGES WHAT THE PAGE MAY SAY.
 *
 * The clamps are not decoration: a card payment for a real programme's true 10% is both
 * above what most cards will authorise and above what anybody sensibly puts through a
 * checkout page. On CRM-sized quotes that is an edge case. On SAP-sized ones it is the
 * normal case — a two-million-euro programme's 10% is €200,000, so the deposit tops out at
 * €25,000, which is 1.25%. A page that then says "10% deposit" is simply wrong, on nearly
 * every quote this application will ever price.
 *
 * So `depositForTotal` returns WHICH RULE APPLIED along with the amount, and the checkout
 * page states it: the percentage actually charged, and that the balance is invoiced. The
 * reference returns a bare number, which is correct arithmetic and a misleading sentence.
 *
 * The floor is kept and will essentially never bind here — the smallest plausible SAP
 * engagement is already above it — because a deposit smaller than its own card fees is
 * still worth refusing if one ever appears.
 */
const DEPOSIT_PERCENT = 10;
const DEPOSIT_MIN_MINOR = 50000; // €500.00
const DEPOSIT_MAX_MINOR = 2500000; // €25,000.00

/** Round a minor-unit amount to a whole currency unit, so invoices read cleanly. */
function toWholeUnits(minor) {
  return Math.round(minor / 100) * 100;
}

/**
 * @returns {{amountMinor:number, basis:'percent'|'floor'|'cap', percentOfTotal:number,
 *   uncappedMinor:number, balanceMinor:number}|null}
 */
function depositForTotal(totalBudget) {
  const total = Number(totalBudget);
  if (!Number.isFinite(total) || total <= 0) return null;

  const totalMinor = Math.round(total * 100);
  const uncappedMinor = toWholeUnits(Math.round((totalMinor * DEPOSIT_PERCENT) / 100));
  const amountMinor = Math.min(Math.max(uncappedMinor, DEPOSIT_MIN_MINOR), DEPOSIT_MAX_MINOR);

  let basis = 'percent';
  if (amountMinor === DEPOSIT_MAX_MINOR && uncappedMinor > DEPOSIT_MAX_MINOR) basis = 'cap';
  else if (amountMinor === DEPOSIT_MIN_MINOR && uncappedMinor < DEPOSIT_MIN_MINOR) basis = 'floor';

  return {
    amountMinor,
    basis,
    // What is ACTUALLY being charged as a share of the total, to one decimal place. This
    // is the number the page shows when the cap binds.
    percentOfTotal: Math.round((amountMinor / totalMinor) * 1000) / 10,
    uncappedMinor,
    balanceMinor: Math.max(0, totalMinor - amountMinor)
  };
}

/**
 * A product is a resolver, not a price tag.
 *
 * `resolve(userId, subjectId)` answers with the full priced subject or a refusal reason,
 * having re-checked ownership and eligibility against the database. The route asks it; the
 * route never decides. That is what keeps "can this person buy this" and "what does it
 * cost" from drifting into two answers.
 */
const PRODUCTS = Object.freeze({
  job_feature: Object.freeze({
    key: 'job_feature',
    label: 'Featured job placement',
    subjectType: 'job',
    /** Buying again while a window is open extends it; nothing is exclusive. */
    exclusive: false,
    description: `Featured placement for ${JOB_FEATURE_DAYS} days`,
    async resolve(userId, subjectId) {
      const [rows] = await promisePool.query(
        'SELECT id, title, slug, status, company_user_id FROM jobs WHERE id = ? LIMIT 1',
        [subjectId]
      );
      const job = rows[0];
      if (!job) return { ok: false, reason: 'That job no longer exists.' };
      if (job.company_user_id !== userId) {
        return { ok: false, reason: 'You can only feature a job you posted.' };
      }
      if (job.status !== 'open') {
        return { ok: false, reason: 'Only an open job can be featured.' };
      }
      return {
        ok: true,
        subject: job,
        amountMinor: JOB_FEATURE_PRICE_MINOR,
        currency: CURRENCY,
        description: `Featured placement — ${job.title} (${JOB_FEATURE_DAYS} days)`,
        // Recorded on the payment so an invoice can be explained years later without
        // re-deriving anything from a catalogue that has since moved.
        priceBasis: { flatMinor: JOB_FEATURE_PRICE_MINOR, days: JOB_FEATURE_DAYS }
      };
    }
  }),

  quote_deposit: Object.freeze({
    key: 'quote_deposit',
    label: 'Project deposit',
    subjectType: 'quote',
    /** One deposit per quote, enforced by the unique key on `quote_deposits.quote_id`. */
    exclusive: true,
    description: `${DEPOSIT_PERCENT}% deposit against an accepted quote, capped`,
    async resolve(userId, subjectId) {
      const [rows] = await promisePool.query(
        `SELECT q.id, q.reference, q.owner_user_id, q.status, q.project_name, q.client_company,
                q.client_name, q.client_email, q.total_budget, q.currency, q.catalogue_version,
                d.id AS deposit_id
           FROM quotes q
           LEFT JOIN quote_deposits d ON d.quote_id = q.id
          WHERE q.id = ? LIMIT 1`,
        [subjectId]
      );
      const quote = rows[0];
      if (!quote) return { ok: false, reason: 'That quote no longer exists.' };
      if (quote.owner_user_id !== userId) {
        return { ok: false, reason: 'You can only take a deposit against your own quote.' };
      }
      if (quote.status !== 'accepted') {
        return { ok: false, reason: 'A deposit can only be taken once the quote is accepted.' };
      }
      if (quote.deposit_id) {
        return { ok: false, reason: 'This quote’s deposit has already been paid.' };
      }
      if (quote.currency !== CURRENCY) {
        // Rather than convert at an unstated rate on the way to a payment page.
        return { ok: false, reason: `Deposits are taken in ${CURRENCY} only.` };
      }

      const deposit = depositForTotal(quote.total_budget);
      if (deposit === null) {
        return { ok: false, reason: 'This quote has no payable total.' };
      }

      return {
        ok: true,
        subject: quote,
        amountMinor: deposit.amountMinor,
        currency: CURRENCY,
        description: `Project deposit — ${quote.project_name} (${quote.reference})`,
        deposit,
        priceBasis: {
          percent: DEPOSIT_PERCENT,
          quoteTotal: Number(quote.total_budget),
          minMinor: DEPOSIT_MIN_MINOR,
          maxMinor: DEPOSIT_MAX_MINOR,
          // Which rule actually set the amount. On SAP-sized quotes this is almost always
          // "cap", and an invoice has to be explicable without re-deriving it.
          basis: deposit.basis,
          percentOfTotal: deposit.percentOfTotal,
          catalogueVersion: quote.catalogue_version
        }
      };
    }
  })
});

function isValidProduct(key) {
  return Object.prototype.hasOwnProperty.call(PRODUCTS, key);
}

function productFor(key) {
  return isValidProduct(key) ? PRODUCTS[key] : null;
}

/** Money as it appears to a person. Minor units in, formatted string out. */
function formatMinor(minor, currency = CURRENCY) {
  const value = Number(minor || 0) / 100;
  return new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2
  }).format(value);
}

/**
 * Boot assertion, in the same spirit as the estimation and taxonomy catalogues: a product
 * with no resolver, a non-integer price or an unsound clamp is a silently wrong charge, so
 * refuse to start instead.
 */
function assertPaymentIntegrity() {
  if (DEPOSIT_MIN_MINOR > DEPOSIT_MAX_MINOR) {
    throw new Error('Payments: deposit floor is above the deposit cap');
  }
  for (const [key, product] of Object.entries(PRODUCTS)) {
    if (product.key !== key) {
      throw new Error(`Payments: product "${key}" disagrees with its own key`);
    }
    if (typeof product.resolve !== 'function') {
      throw new Error(`Payments: product "${key}" has no resolver`);
    }
    if (!product.subjectType) {
      throw new Error(`Payments: product "${key}" has no subject type`);
    }
  }
  for (const amount of [JOB_FEATURE_PRICE_MINOR, DEPOSIT_MIN_MINOR, DEPOSIT_MAX_MINOR]) {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error('Payments: every price must be a positive integer of minor units');
    }
  }
  return true;
}

module.exports = {
  CURRENCY,
  WEBHOOK_PATH,
  PRODUCTS,
  DEPOSIT_PERCENT,
  DEPOSIT_MIN_MINOR,
  DEPOSIT_MAX_MINOR,
  JOB_FEATURE_DAYS,
  JOB_FEATURE_PRICE_MINOR,
  depositForTotal,
  isValidProduct,
  productFor,
  formatMinor,
  assertPaymentIntegrity
};
