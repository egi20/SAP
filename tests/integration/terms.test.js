'use strict';

/**
 * The Terms of Service as served. Each assertion is one of the gaps a review of the old
 * text named — and the facts are read from config, so the page cannot state an operator,
 * a law or an age the code does not.
 */

const request = require('supertest');
const { LEGAL_ENTITY } = require('../../config/legalEntity');
const { TERMS_VERSION } = require('../../config/legal-versions');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

maybe()('/legal/terms', () => {
  let text;
  beforeAll(async () => {
    const res = await request(require('../../server')).get('/legal/terms');
    expect(res.status).toBe(200);
    text = res.text;
  });

  it('names the operator, the law and the courts', () => {
    expect(text).toContain(LEGAL_ENTITY.name);
    expect(text).toContain('Republic of Albania');
    expect(text).toContain('courts of Tirana');
  });

  it('states the minimum age and the current version', () => {
    expect(text).toContain(`at least ${LEGAL_ENTITY.minimumAge} years old`);
    expect(text).toContain(`Version ${TERMS_VERSION}`);
  });

  it('links the privacy policy, closing an account and reporting content', () => {
    ['/legal/privacy', '/profile/settings/close', '/report-issue', '/contact'].forEach((href) => {
      expect(text).toContain(`href="${href}"`);
    });
  });

  it('covers the licence, scraping, changes, payments and the Digital Services Act', () => {
    expect(text).toContain('non-exclusive, royalty-free');
    expect(text).toMatch(/scrape, crawl or harvest/);
    expect(text).toContain(`${LEGAL_ENTITY.noticeDays} days before the change takes effect`);
    expect(text).toContain('Stripe');
    expect(text).toContain('Digital Services Act');
  });

  it('limits liability only as far as the law allows', () => {
    expect(text).toContain('To the extent permitted by law');
    expect(text).toMatch(/gross negligence/);
  });
});
