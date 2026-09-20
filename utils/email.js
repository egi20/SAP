'use strict';

const path = require('path');
const ejs = require('ejs');
const { Resend } = require('resend');
const config = require('../config/config');

/**
 * Transactional email over HTTPS.
 *
 * Resend rather than SMTP because many hosts block outbound port 25/465/587 entirely,
 * which turns "email silently never arrives" into an unfixable production symptom.
 *
 * With no API key configured, `send()` logs the message and resolves. That keeps local
 * development and CI working without credentials, and it is the reason every caller
 * treats email as fire-and-forget: a failed notification must never break the action
 * that triggered it.
 */
const resend = config.email.resendApiKey ? new Resend(config.email.resendApiKey) : null;

const TEMPLATE_DIR = path.join(__dirname, '..', 'views', 'email');

async function renderTemplate(template, locals) {
  const body = await ejs.renderFile(path.join(TEMPLATE_DIR, `${template}.ejs`), {
    ...locals,
    appName: config.app.name,
    baseUrl: config.app.baseUrl
  });
  return ejs.renderFile(path.join(TEMPLATE_DIR, 'base.ejs'), {
    body,
    appName: config.app.name,
    baseUrl: config.app.baseUrl,
    supportEmail: config.app.supportEmail,
    subject: locals.subject || config.app.name
  });
}

async function sendOnce({ to, subject, html }) {
  if (!resend) {
    console.log(`[email:dev] to=${to} subject="${subject}"`);
    return { delivered: false, reason: 'no-api-key' };
  }
  const { error } = await resend.emails.send({ from: config.email.from, to, subject, html });
  if (error) throw new Error(error.message || 'Resend rejected the message');
  return { delivered: true };
}

/**
 * Send with a small retry. Errors are returned, never thrown, because every call site
 * is a side effect of a user action that must succeed regardless.
 */
async function send({ to, subject, template, locals = {} }, retries = 2) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const html = await renderTemplate(template, { ...locals, subject });
      // eslint-disable-next-line no-await-in-loop
      return await sendOnce({ to, subject, html });
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
  }
  console.error(`Email to ${to} failed after ${retries + 1} attempts: ${lastError.message}`);
  return { delivered: false, reason: lastError.message };
}

module.exports = { send, renderTemplate };
