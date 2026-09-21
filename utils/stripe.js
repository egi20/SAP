'use strict';

const Stripe = require('stripe');
const config = require('../config/config');

/**
 * The only module that talks to Stripe.
 *
 * Three properties everything else depends on:
 *
 *  1. IT DEGRADES. With no secret key the module loads, `isConfigured()` is false and
 *     every route offers a "payments are not set up" path instead of throwing. That is
 *     what keeps local development, CI and `npm run validate-boot` working without
 *     credentials, exactly as `utils/email.js` does.
 *  2. THE API VERSION IS PINNED. Stripe changes shapes between versions; letting the
 *     account's dashboard default decide which one a webhook arrives in means a payload
 *     can change under a running deploy without a commit.
 *  3. SIGNATURE VERIFICATION IS NOT OPTIONAL. `verifyWebhookSignature` throws when the
 *     signing secret is unset rather than waving the request through, because a webhook
 *     endpoint that trusts its body is an unauthenticated write to the money tables.
 */

// Pinned deliberately. Bumping this is a code change with a payload diff to read, not a
// setting to drift.
const API_VERSION = '2025-08-27.basil';

let client = null;

function isConfigured() {
  return Boolean(config.stripe.secretKey);
}

function publishableKey() {
  return config.stripe.publishableKey || null;
}

function getClient() {
  if (!isConfigured()) {
    throw new Error('Stripe is not configured (STRIPE_SECRET_KEY is unset)');
  }
  if (!client) {
    client = new Stripe(config.stripe.secretKey, { apiVersion: API_VERSION });
  }
  return client;
}

/**
 * Create a Checkout Session for an already-priced payment.
 *
 * Note what this function does NOT take: a price. It takes the payment row that the
 * catalogue already priced. There is no path from an HTTP request to an amount that
 * does not go through `config/payments.js` first.
 */
async function createCheckoutSession({ payment, customerEmail, successUrl, cancelUrl }) {
  const stripe = getClient();

  return stripe.checkout.sessions.create({
    mode: 'payment',
    // Not a security control on its own — metadata is echoed back to us and we re-derive
    // everything from `payment_id` — but it makes a Stripe dashboard row legible.
    client_reference_id: payment.reference,
    customer_email: customerEmail || undefined,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: String(payment.currency).toLowerCase(),
          unit_amount: payment.amount_minor,
          product_data: { name: payment.description }
        }
      }
    ],
    metadata: {
      payment_id: String(payment.id),
      payment_reference: payment.reference,
      product: payment.product,
      subject_type: payment.subject_type,
      subject_id: payment.subject_id === null ? '' : String(payment.subject_id)
    },
    success_url: successUrl,
    cancel_url: cancelUrl
  });
}

async function retrieveSession(sessionId) {
  const stripe = getClient();
  return stripe.checkout.sessions.retrieve(sessionId);
}

/**
 * @param {Buffer} rawBody the UNPARSED request body. A re-serialised JSON object will
 *   not verify: the signature covers the exact bytes Stripe sent.
 */
function verifyWebhookSignature(rawBody, signature) {
  if (!config.stripe.webhookSecret) {
    throw new Error('Stripe webhook secret is not configured');
  }
  if (!signature) {
    throw new Error('Missing stripe-signature header');
  }
  return getClient().webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
}

/** Distinguish "you sent us rubbish" from "we broke". Only the second is worth logging. */
function isSignatureError(err) {
  const message = String((err && err.message) || '');
  return (
    (err && err.type === 'StripeSignatureVerificationError')
    || /signature|stripe-signature|webhook secret/i.test(message)
  );
}

module.exports = {
  API_VERSION,
  isConfigured,
  publishableKey,
  getClient,
  createCheckoutSession,
  retrieveSession,
  verifyWebhookSignature,
  isSignatureError
};
