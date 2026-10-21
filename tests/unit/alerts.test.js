'use strict';

/** The Slack alert for a critical report: off unless set, and only ever to hooks.slack.com. */
const { webhookUrl, assertAlertsConfig } = require('../../utils/alerts');

describe('the critical-report alert', () => {
  const saved = process.env.SLACK_ALERT_WEBHOOK_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.SLACK_ALERT_WEBHOOK_URL;
    else process.env.SLACK_ALERT_WEBHOOK_URL = saved;
  });

  it('is off when nothing is configured', () => {
    delete process.env.SLACK_ALERT_WEBHOOK_URL;
    expect(webhookUrl()).toBeNull();
    expect(() => assertAlertsConfig()).not.toThrow();
  });

  it('accepts a Slack incoming webhook', () => {
    process.env.SLACK_ALERT_WEBHOOK_URL = 'https://hooks.slack.com/services/T000/B000/xyz';
    expect(webhookUrl()).toContain('hooks.slack.com');
  });

  it('refuses at boot a URL that points anywhere else', () => {
    process.env.SLACK_ALERT_WEBHOOK_URL = 'https://hooks.slack.com.evil.example/x';
    expect(webhookUrl()).toBeNull();
    expect(() => assertAlertsConfig()).toThrow(/hooks\.slack\.com/);
  });
});
