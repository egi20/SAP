'use strict';

const express = require('express');

const config = require('../config/config');
const Payment = require('../models/Payment');
const Invoice = require('../models/Invoice');
const ErrorLog = require('../models/ErrorLog');
const stripe = require('../utils/stripe');
const { fulfil } = require('../services/paymentFulfilment');
const { isAuthenticated } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/errorHandler');
const { parseId, requireIdParam } = require('../utils/ids');
const { returnTo } = require('../utils/returnTo');
const { paginationFrom, paginationMeta, pageUrl } = require('../utils/pagination');
const {
  productFor,
  formatMinor,
  JOB_FEATURE_DAYS,
  JOB_FEATURE_PRICE_MINOR,
  DEPOSIT_PERCENT,
  DEPOSIT_MIN_MINOR,
  DEPOSIT_MAX_MINOR
} = require('../config/payments');

const router = express.Router();

/* ------------------------------------------------------------------ checkout */

/**
 * POST /payments/checkout/:product
 *
 * Note what is NOT in this handler: an amount. The request names a product and a
 * subject; the catalogue resolver re-checks ownership and eligibility against the
 * database and answers with the price. That is the whole defence against price
 * tampering, and it is why the resolver lives in config/payments.js rather than here —
 * a price computed in a route is a price the next route will compute differently.
 */
router.post(
  '/checkout/:product',
  isAuthenticated,
  writeLimiter,
  asyncHandler(async (req, res) => {
    const fallback = returnTo(req, '/dashboard');
    const product = productFor(req.params.product);

    if (!product) {
      req.flash('error', 'That is not something you can buy here.');
      return res.redirect(fallback);
    }

    if (!stripe.isConfigured()) {
      // Degrade with an explanation rather than a 500. An unconfigured Stripe is the
      // normal state in development and on a fresh deploy.
      req.flash('error', 'Payments are not switched on yet. Please get in touch and we will invoice you directly.');
      return res.redirect(fallback);
    }

    const subjectId = parseId(req.body.subjectId);
    if (subjectId === null) {
      req.flash('error', 'Nothing was selected to pay for.');
      return res.redirect(fallback);
    }

    const priced = await product.resolve(req.session.user.id, subjectId);
    if (!priced.ok) {
      req.flash('error', priced.reason);
      return res.redirect(fallback);
    }

    // Written BEFORE the Stripe call: if the session is created and the response is lost,
    // the webhook still has a row to find by metadata.payment_id.
    const payment = await Payment.create({
      userId: req.session.user.id,
      product: product.key,
      subjectType: product.subjectType,
      subjectId,
      amountMinor: priced.amountMinor,
      currency: priced.currency,
      description: priced.description,
      priceBasis: priced.priceBasis
    });

    await Payment.recordEvent({
      paymentId: payment.id,
      eventType: 'checkout_created',
      detail: `${product.key} subject=${subjectId} amount=${priced.amountMinor}`
    });

    const session = await stripe.createCheckoutSession({
      payment,
      customerEmail: req.session.user.email,
      successUrl: `${config.app.baseUrl}/payments/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${config.app.baseUrl}/payments/cancelled?ref=${encodeURIComponent(payment.reference)}`
    });

    await Payment.attachSession(payment.id, session.id);
    return res.redirect(303, session.url);
  })
);

/* ------------------------------------------------------------------- outcome */

/**
 * GET /payments/success
 *
 * The buyer's redirect back from Stripe. It fulfils, and it races the webhook by
 * definition — Stripe fires both independently. Both are safe because fulfilment is
 * idempotent in the schema; see services/paymentFulfilment.js.
 *
 * The payment status is taken from STRIPE, never from the query string. A caller who
 * knows a session id must not be able to talk an unpaid payment into being fulfilled.
 */
router.get(
  '/success',
  isAuthenticated,
  asyncHandler(async (req, res) => {
    const sessionId = String(req.query.session_id || '');
    if (!sessionId) return res.redirect('/payments/history');

    const payment = await Payment.findBySessionId(sessionId);
    if (!payment) {
      req.flash('info', 'We have not finished recording that payment yet. It will appear here shortly.');
      return res.redirect('/payments/history');
    }
    if (payment.user_id !== req.session.user.id) {
      // 404 rather than 403, matching how quotes and invoices answer elsewhere: someone
      // else's payment does not exist as far as this account is concerned, and a 403
      // would confirm that a given session id is real.
      return res.status(404).render('errors/404', { title: 'Not found' });
    }

    let paid = payment.status === 'paid';
    if (!paid && stripe.isConfigured()) {
      const session = await stripe.retrieveSession(sessionId);
      paid = session && session.payment_status === 'paid';
      if (paid) {
        await fulfil(payment, {
          source: 'success_page',
          stripeSessionId: sessionId,
          stripePaymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : null
        });
      }
    }

    const fresh = await Payment.findById(payment.id);
    return res.render('payments/success', {
      title: paid ? 'Payment received' : 'Payment pending',
      payment: fresh,
      paid,
      formatMinor
    });
  })
);

/** GET /payments/cancelled — the buyer backed out. Nothing to undo; the row stays pending. */
router.get(
  '/cancelled',
  isAuthenticated,
  asyncHandler(async (req, res) => {
    const reference = String(req.query.ref || '');
    if (reference) {
      const payment = await Payment.findByReference(reference);
      if (payment && payment.user_id === req.session.user.id) {
        await Payment.markUnpaid(payment.id, 'cancelled');
        await Payment.recordEvent({ paymentId: payment.id, eventType: 'cancelled', detail: 'buyer returned via cancel_url' });
      }
    }
    return res.render('payments/cancelled', { title: 'Payment cancelled' });
  })
);

/* ------------------------------------------------------------------- webhook */

/**
 * POST /payments/webhook
 *
 * Three things make this route different from every other one in the app, and all three
 * are arranged in server.js rather than here:
 *
 *  1. it is parsed as a RAW BUFFER, because the signature covers the exact bytes Stripe
 *     sent and a re-serialised JSON object will not verify;
 *  2. it is EXEMPT from CSRF, because it has no browser and no session — it authenticates
 *     itself with that signature, which is strictly stronger than a token;
 *  3. it is mounted before the body parsers for reason (1).
 *
 * It answers 200 for anything it has understood, INCLUDING events it deliberately
 * ignores. A non-2xx tells Stripe to retry, so returning an error for "not interesting"
 * turns an ignored event into an infinite redelivery loop.
 */
router.post(
  '/webhook',
  asyncHandler(async (req, res) => {
    let event;
    try {
      event = stripe.verifyWebhookSignature(req.body, req.get('stripe-signature'));
    } catch (err) {
      // An unsigned or badly signed request is expected traffic: probes, health checks,
      // the security test in the suite. Reject it, but do not fill the error log with it.
      if (stripe.isSignatureError(err)) {
        console.warn('[payments] webhook rejected: invalid or missing signature');
      } else {
        await ErrorLog.record(err, req, 400);
      }
      return res.status(400).json({ error: 'Signature verification failed' });
    }

    if (event.type !== 'checkout.session.completed') {
      // Recorded, then acknowledged. Silence here is how an event type nobody expected
      // becomes invisible when it turns out to matter.
      await Payment.recordEvent({ eventType: event.type, stripeEventId: event.id, detail: 'ignored' });
      return res.json({ received: true, handled: false });
    }

    const session = event.data.object;
    if (session.payment_status !== 'paid') {
      await Payment.recordEvent({ eventType: event.type, stripeEventId: event.id, detail: `payment_status=${session.payment_status}` });
      return res.json({ received: true, handled: false });
    }

    // By session id first, because that column is unique; by metadata only as the
    // fallback for a checkout whose session id never made it back onto the row.
    const metadataId = parseId(String((session.metadata && session.metadata.payment_id) || ''));
    const payment =
      (await Payment.findBySessionId(session.id)) || (metadataId ? await Payment.findById(metadataId) : null);

    if (!payment) {
      // Money we cannot attribute. Loud, and kept: this is the shape of a bug in checkout
      // creation, not something to swallow with a 200 and forget.
      await Payment.recordEvent({
        eventType: 'unattributed_payment',
        stripeEventId: event.id,
        detail: `session=${session.id}`
      });
      await ErrorLog.record(new Error(`Stripe session ${session.id} matched no payment row`), req, 200);
      return res.json({ received: true, handled: false });
    }

    await fulfil(payment, {
      source: 'webhook',
      stripeSessionId: session.id,
      stripePaymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : null
    });

    return res.json({ received: true, handled: true });
  })
);

/* -------------------------------------------------------------- buyer's copy */

router.get(
  '/history',
  isAuthenticated,
  asyncHandler(async (req, res) => {
    const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 20 });
    const { rows, total } = await Payment.listFor(req.session.user.id, { limit, offset });
    return res.render('payments/history', {
      title: 'Payments and invoices',
      payments: rows,
      formatMinor,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (n) => pageUrl('/payments/history', req.query, n)
    });
  })
);

/**
 * GET /payments/invoices/:id
 *
 * Fetched as "mine with this id" in a single query. An id-then-ownership-check in two
 * steps is a check somebody eventually forgets to write.
 */
router.get(
  '/invoices/:id',
  isAuthenticated,
  requireIdParam('id'),
  asyncHandler(async (req, res) => {
    const invoice = await Invoice.findForUser(req.params.id, req.session.user.id);
    if (!invoice) return res.status(404).render('errors/404', { title: 'Invoice not found' });
    return res.render('payments/invoice', {
      title: `Invoice ${invoice.number}`,
      invoice,
      formatMinor
    });
  })
);

/**
 * GET /payments — what is for sale, and why.
 *
 * Every figure comes from the catalogue. A price typed into a template is a price that
 * disagrees with the checkout the first time one of them is edited.
 */
router.get('/', (req, res) => {
  res.render('payments/pricing', {
    title: 'Pricing',
    jobFeatureDays: JOB_FEATURE_DAYS,
    jobFeaturePrice: JOB_FEATURE_PRICE_MINOR,
    depositPercent: DEPOSIT_PERCENT,
    depositMin: DEPOSIT_MIN_MINOR,
    depositMax: DEPOSIT_MAX_MINOR,
    stripeReady: stripe.isConfigured(),
    formatMinor
  });
});

module.exports = router;
