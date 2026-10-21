'use strict';

/**
 * The detailed analytics screens: one date range for all of them, and sections that fail
 * one at a time rather than taking the page down.
 */

const { rangeFrom, rangeQuery } = require('../../utils/analyticsRange');
const dash = require('../../services/analyticsDashboard');
const base = require('../../services/webAnalytics');
const wa = require('../../config/webAnalytics');

const NOW = new Date('2026-10-21T15:00:00Z');

describe('rangeFrom', () => {
  it('defaults to 28 days ending today, inclusive', () => {
    expect(rangeFrom({}, NOW)).toMatchObject({ key: '28d', days: 28, from: '2026-09-24', to: '2026-10-21', error: null });
  });

  it('reads every preset dynamicshub offers', () => {
    expect(['7d', '28d', '90d', '180d', '365d'].map((k) => rangeFrom({ range: k }, NOW).days)).toEqual([7, 28, 90, 180, 365]);
  });

  it('accepts a custom range and reproduces it in a link', () => {
    const r = rangeFrom({ range: 'custom', from: '2026-10-01', to: '2026-10-10' }, NOW);
    expect(r).toMatchObject({ key: 'custom', days: 10, from: '2026-10-01', to: '2026-10-10', error: null });
    expect(rangeQuery(r)).toBe('range=custom&from=2026-10-01&to=2026-10-10');
  });

  it('refuses a custom range it cannot answer honestly, and says why', () => {
    expect(rangeFrom({ range: 'custom', from: '2026-10-10', to: '2026-10-01' }, NOW).error).toMatch(/after the end/);
    expect(rangeFrom({ range: 'custom', from: '2026-10-01', to: '2026-12-01' }, NOW).error).toMatch(/future/);
    expect(rangeFrom({ range: 'custom', from: '2024-01-01', to: '2026-10-01' }, NOW).error).toMatch(/at most/);
    expect(rangeFrom({ range: 'custom', from: '2026-02-30', to: '2026-03-01' }, NOW).error).toMatch(/both/);
  });
});

describe('GA4 sections', () => {
  const range = rangeFrom({ range: '7d' }, NOW);

  it('ask for every section the dynamicshub screen shows, over the one range', () => {
    const defs = dash.ga4Sections(range);
    expect(Object.keys(defs)).toEqual(expect.arrayContaining(
      ['kpis', 'series', 'channels', 'age', 'gender', 'devices', 'pages', 'sources', 'landing', 'countries', 'newReturning']
    ));
    Object.values(defs).forEach((d) => expect(d.body.dateRanges).toEqual([{ startDate: '2026-10-15', endDate: '2026-10-21' }]));
    expect(defs.pages.body.limit).toBe(50);
  });

  it('folds channel groups into direct and external', () => {
    const split = dash.directVsExternal([
      { sessionDefaultChannelGroup: 'Direct', activeUsers: 5, sessions: 8 },
      { sessionDefaultChannelGroup: 'Organic Search', activeUsers: 3, sessions: 4 },
      { sessionDefaultChannelGroup: 'Referral', activeUsers: 1, sessions: 1 }
    ]);
    expect(split).toEqual({ direct: { users: 5, sessions: 8 }, external: { users: 4, sessions: 5 } });
  });

  it('keeps every other section when one is refused', async () => {
    base.clearCache();
    const { privateKey } = require('crypto').generateKeyPairSync('rsa', { modulusLength: 2048 });
    const settings = wa.load({
      GA4_PROPERTY_ID: '123456789',
      GA4_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'r@x.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) })
    });
    const fetchImpl = async (url, init) => {
      if (url.includes('oauth2')) return { ok: true, status: 200, json: async () => ({ access_token: 't' }) };
      const body = JSON.parse(init.body);
      const dims = (body.dimensions || []).map((d) => d.name);
      if (dims.includes('userAgeBracket')) return { ok: false, status: 400, json: async () => ({ error: { message: 'Signals off' } }) };
      return { ok: true, status: 200, json: async () => ({ rows: [{ dimensionValues: dims.map(() => ({ value: 'x' })), metricValues: body.metrics.map(() => ({ value: '3' })) }] }) };
    };
    const out = await dash.ga4Dashboard(range, { fetchImpl, settings });
    expect(out.age.error).toBe('Signals off');
    expect(out.pages.rows[0].screenPageViews).toBe(3);
    expect(out.kpis.rows[0].bounceRate).toBe(3);
  });
});

describe('Cloudflare sections', () => {
  it('build one query per section from fixed fields, never from input', () => {
    Object.values(dash.CF_GROUPS).forEach((g) => {
      const q = dash.cloudflareGroupQuery('host', g);
      expect(q).toContain(`label: ${g.field}`);
      expect(q).toContain('requestHost: $host');
    });
  });

  it('keeps every other section when one field is refused', async () => {
    base.clearCache();
    const settings = wa.load({ CF_ACCOUNT_ID: 'b'.repeat(32), CF_API_TOKEN: 't' });
    const fetchImpl = async (url, init) => {
      const { query } = JSON.parse(init.body);
      if (query.includes('userAgentBrowser')) return { ok: true, status: 200, json: async () => ({ errors: [{ message: 'unknown field' }] }) };
      return { ok: true, status: 200, json: async () => ({ data: { viewer: { accounts: [{ rows: [{ count: 4, sum: { visits: 2 }, dimensions: { label: '' } }] }] } } }) };
    };
    const out = await dash.cloudflareDashboard(rangeFrom({ range: '7d' }, NOW), { fetchImpl, settings, host: 'saphub.net' });
    expect(out.browsers.error).toMatch(/unknown field/);
    expect(out.referrers.rows[0]).toEqual({ label: '(direct)', views: 4, visits: 2 });
  });
});
