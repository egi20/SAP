'use strict';

/**
 * An immediate alert for a CRITICAL report — the site is down for somebody, or data is
 * being lost or exposed — on top of the support email every report already produces.
 *
 * Slack, through an incoming-webhook URL in SLACK_ALERT_WEBHOOK_URL. Off unless set, and
 * pinned to hooks.slack.com: the URL is a credential that posts into a channel, and one
 * pointing anywhere else is a misconfiguration sending report titles to a stranger. Fire and
 * forget, like every notification here — a failed alert must never fail the report.
 *
 * Only the reference, the subject and the queue link go out; never the message, the
 * reporter's name or their address.
 */
const config = require('../config/config');

function webhookUrl() {
  const raw = (process.env.SLACK_ALERT_WEBHOOK_URL || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.hostname === 'hooks.slack.com' ? url.toString() : null;
  } catch (e) {
    return null;
  }
}

function assertAlertsConfig() {
  if ((process.env.SLACK_ALERT_WEBHOOK_URL || '').trim() && !webhookUrl()) {
    throw new Error('SLACK_ALERT_WEBHOOK_URL must be an https://hooks.slack.com/ incoming-webhook URL');
  }
}

async function criticalReport({ reference, subject, id }) {
  const url = webhookUrl();
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `:rotating_light: Critical report ${reference}: ${String(subject).slice(0, 150)}\n${config.app.baseUrl}/admin/enquiries/${id}`
      })
    });
    return res.ok;
  } catch (err) {
    console.error(`Critical alert for ${reference} failed: ${err.message}`);
    return false;
  }
}

module.exports = { criticalReport, assertAlertsConfig, webhookUrl };
