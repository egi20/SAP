'use strict';

/**
 * The analytics trial: GA4 and Cloudflare Web Analytics, side by side.
 *
 * Nothing here reaches the network; both providers are driven through a fake `fetch`
 * that answers in the shape their APIs document.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const wa = require('../../config/webAnalytics');
const service = require('../../services/webAnalytics');

const HEX = 'a'.repeat(32);
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const SERVICE_ACCOUNT = JSON.stringify({
  client_email: 'reader@project.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' })
});

const ANALYTICS_JS = fs.readFileSync(path.join(__dirname, '../../public/js/analytics.js'), 'utf8');
const MAIN_JS = fs.readFileSync(path.join(__dirname, '../../public/js/main.js'), 'utf8');

describe('configuration', () => {
  it('is entirely off with nothing set: no tag, no CSP host, no report', () => {
    const s = wa.load({});
    expect(wa.problems(s)).toEqual([]);
    expect(wa.publicTags(s)).toEqual({ ga4Id: null, cloudflareToken: null });
    expect(wa.cspAdditions(s)).toEqual({ script: [], connect: [] });
    expect(wa.ga4ReportingEnabled(s)).toBe(false);
    expect(wa.cloudflareReportingEnabled(s)).toBe(false);
  });

  it('adds only the configured provider to the CSP', () => {
    const s = wa.load({ CF_WEB_ANALYTICS_TOKEN: HEX });
    expect(wa.cspAdditions(s).script).toEqual(['https://static.cloudflareinsights.com']);
    expect(wa.cspAdditions(s).connect.join(' ')).not.toMatch(/google/);
  });

  it('refuses the property number where the measurement id belongs, and the reverse', () => {
    expect(() => wa.assertWebAnalyticsIntegrity(wa.load({ GA4_MEASUREMENT_ID: '123456789' }))).toThrow(/G-XXXXXXXXXX/);
    expect(() => wa.assertWebAnalyticsIntegrity(wa.load({ GA4_PROPERTY_ID: 'G-ABC123' }))).toThrow(/numeric property id/);
  });

  it('refuses a Cloudflare token pasted with its quotes', () => {
    expect(() => wa.assertWebAnalyticsIntegrity(wa.load({ CF_WEB_ANALYTICS_TOKEN: `"${HEX}"` }))).toThrow(/without quotes/);
  });

  it('accepts the service account as raw JSON or base64', () => {
    const raw = wa.load({ GA4_SERVICE_ACCOUNT_JSON: SERVICE_ACCOUNT });
    const b64 = wa.load({ GA4_SERVICE_ACCOUNT_JSON: Buffer.from(SERVICE_ACCOUNT).toString('base64') });
    expect(wa.problems(raw)).toEqual([]);
    expect(wa.problems(b64)).toEqual([]);
    expect(wa.problems(wa.load({ GA4_SERVICE_ACCOUNT_JSON: 'not json' }))).toHaveLength(1);
  });

  it('never assumes the snippet token is the API site tag', () => {
    // It is not, and assuming it produced a clean zero for a site Cloudflare was counting.
    expect(wa.load({ CF_WEB_ANALYTICS_TOKEN: HEX }).cloudflare.explicitSiteTag).toBe('');
    expect(wa.cloudflareReportingEnabled(wa.load({ CF_ACCOUNT_ID: HEX, CF_API_TOKEN: 't' }))).toBe(true);
  });

  it('never exposes a secret to the views', () => {
    const s = wa.load({
      GA4_MEASUREMENT_ID: 'G-ABC123XYZ',
      GA4_PROPERTY_ID: '123456789',
      GA4_SERVICE_ACCOUNT_JSON: SERVICE_ACCOUNT,
      CF_WEB_ANALYTICS_TOKEN: HEX,
      CF_ACCOUNT_ID: HEX,
      CF_API_TOKEN: 'secret-api-token'
    });
    const shown = JSON.stringify(wa.publicTags(s));
    expect(shown).not.toContain('secret-api-token');
    expect(shown).not.toContain('PRIVATE KEY');
    expect(shown).not.toContain('123456789');
  });
});

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const handler = routes.find(([prefix]) => url.startsWith(prefix));
    const [status, body] = handler[1](init);
    return { ok: status < 400, status, json: async () => body };
  };
  impl.calls = calls;
  return impl;
}

describe('GA4 report', () => {
  const settings = wa.load({ GA4_PROPERTY_ID: '123456789', GA4_SERVICE_ACCOUNT_JSON: SERVICE_ACCOUNT });
  const row = (label, value) => ({ dimensionValues: [{ value: label }], metricValues: [{ value: String(value) }] });

  beforeEach(() => service.clearCache());

  it('signs a token, asks for five reports, and returns the shared shape', async () => {
    const fetchImpl = fakeFetch([
      ['https://oauth2.googleapis.com/token', () => [200, { access_token: 'tok' }]],
      ['https://analyticsdata.googleapis.com/', () => [200, {
        reports: [
          { rows: [{ metricValues: [{ value: '120' }, { value: '40' }, { value: '55' }] }] },
          { rows: [row('/jobs', 30), row('/', 50)] },
          { rows: [row('Albania', 20)] },
          { rows: [row('google', 25)] },
          { rows: [row('mobile', 22), row('desktop', 18)] }
        ]
      }]]
    ]);
    const report = await service.ga4Report(30, { fetchImpl, settings });

    const [tokenCall, dataCall] = fetchImpl.calls;
    const assertion = new URLSearchParams(tokenCall.init.body).get('assertion');
    const claim = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString());
    expect(claim.scope).toBe('https://www.googleapis.com/auth/analytics.readonly');
    expect(dataCall.url).toContain('properties/123456789:batchRunReports');
    expect(dataCall.init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(dataCall.init.body).requests).toHaveLength(5);

    expect(report.totals).toEqual([
      { label: 'Page views', value: 120 },
      { label: 'Users', value: 40 },
      { label: 'Sessions', value: 55 }
    ]);
    expect(report.pages[0]).toEqual({ label: '/', value: 50 });
    expect(report.devices.map((d) => d.label)).toEqual(['mobile', 'desktop']);
  });

  it('reports Google\'s own message when the service account is refused', async () => {
    const fetchImpl = fakeFetch([
      ['https://oauth2.googleapis.com/token', () => [400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }]]
    ]);
    await expect(service.ga4Report(7, { fetchImpl, settings })).rejects.toThrow(/Invalid JWT Signature/);
  });

  it('renders an empty property as zeros, not a crash', () => {
    const report = service.normaliseGa4({ reports: [{}, {}, {}, {}, {}] }, 7);
    expect(report.totals.every((t) => t.value === 0)).toBe(true);
    expect(report.pages).toEqual([]);
  });
});

describe('Cloudflare report', () => {
  const settings = wa.load({ CF_WEB_ANALYTICS_TOKEN: HEX, CF_ACCOUNT_ID: 'b'.repeat(32), CF_API_TOKEN: 'cf-token' });

  beforeEach(() => service.clearCache());

  it('filters on the site\'s own host by default, and returns the shared shape', async () => {
    const group = (label, count) => ({ count, dimensions: { label } });
    const fetchImpl = fakeFetch([
      ['https://api.cloudflare.com/client/v4/graphql', () => [200, {
        data: { viewer: { accounts: [{
          totals: [{ count: 300, sum: { visits: 90 } }],
          pages: [group('/', 200), group('/jobs', 100)],
          countries: [group('Albania', 150)],
          sources: [group('', 70), group('www.google.com', 20)],
          devices: [group('desktop', 180)]
        }] } }
      }]]
    ]);
    const now = new Date('2026-10-19T12:00:00Z');
    const report = await service.cloudflareReport(7, { fetchImpl, settings, now, host: 'saphub.net' });

    const body = JSON.parse(fetchImpl.calls[0].init.body);
    expect(fetchImpl.calls[0].init.headers.Authorization).toBe('Bearer cf-token');
    expect(body.variables).toEqual({
      accountTag: 'b'.repeat(32),
      host: 'saphub.net',
      from: '2026-10-12T12:00:00.000Z',
      to: '2026-10-19T12:00:00.000Z'
    });
    expect(report.totals).toEqual([{ label: 'Page views', value: 300 }, { label: 'Visits', value: 90 }]);
    expect(report.sources[0]).toEqual({ label: '(direct)', value: 70 });
    expect(body.query).toMatch(/requestHost: \$host/);
    expect(body.query).not.toMatch(/siteTag/);
    expect(report.filteredBy).toBe('host saphub.net');
  });

  it('uses the dashboard\'s site tag only when one is set explicitly', async () => {
    const tagged = wa.load({ CF_ACCOUNT_ID: 'b'.repeat(32), CF_API_TOKEN: 'cf-token', CF_WEB_ANALYTICS_SITE_TAG: 'c'.repeat(32) });
    const fetchImpl = fakeFetch([['https://api.cloudflare.com/', () => [200, { data: { viewer: { accounts: [{}] } } }]]]);
    await service.cloudflareReport(30, { fetchImpl, settings: tagged });
    const body = JSON.parse(fetchImpl.calls[0].init.body);
    expect(body.variables.siteTag).toBe('c'.repeat(32));
    expect(body.query).toMatch(/siteTag: \$siteTag/);
  });

  it('when the site reads zero, asks which hosts DO have data, so the fix is obvious', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      const data = body.query.includes('seen:')
        ? { viewer: { accounts: [{ seen: [{ count: 42, dimensions: { requestHost: 'www.saphub.net', siteTag: 'd'.repeat(32) } }] }] } }
        : { viewer: { accounts: [{ totals: [{ count: 0, sum: { visits: 0 } }] }] } };
      return { ok: true, status: 200, json: async () => ({ data }) };
    };
    const report = await service.cloudflareReport(7, { fetchImpl, settings, host: 'saphub.net' });
    expect(calls).toHaveLength(2);
    expect(calls[1].query).not.toMatch(/requestHost: \$host|siteTag: \$siteTag/);
    expect(report.seen).toEqual([{ host: 'www.saphub.net', siteTag: 'd'.repeat(32), value: 42 }]);
  });

  it('says how many visits each sampled page load stands for, and never fails over it', async () => {
    const queries = [];
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      queries.push(body.query);
      const data = body.query.includes('sampling:')
        ? { viewer: { accounts: [{ sampling: [{ avg: { sampleInterval: 10 } }] }] } }
        : { viewer: { accounts: [{ totals: [{ count: 40, sum: { visits: 40 } }] }] } };
      return { ok: true, status: 200, json: async () => ({ data }) };
    };
    const report = await service.cloudflareReport(30, { fetchImpl, settings });
    expect(report.sampleInterval).toBe(10);
    // The "which hosts have data" question is only for an empty report.
    expect(queries.some((q) => q.includes('seen:'))).toBe(false);

    service.clearCache();
    let n = 0;
    const failing = async () => {
      n += 1;
      return n === 1
        ? { ok: true, status: 200, json: async () => ({ data: { viewer: { accounts: [{ totals: [{ count: 5, sum: { visits: 2 } }] }] } } }) }
        : { ok: true, status: 200, json: async () => ({ data: null, errors: [{ message: 'unknown field sampleInterval' }] }) };
    };
    const stillThere = await service.cloudflareReport(7, { fetchImpl: failing, settings });
    expect(stillThere.totals[0].value).toBe(5);
    expect(stillThere.sampleInterval).toBeUndefined();
  });

  it('surfaces GraphQL errors, which arrive with a 200', async () => {
    const fetchImpl = fakeFetch([
      ['https://api.cloudflare.com/', () => [200, { data: null, errors: [{ message: 'not authorized for that account' }] }]]
    ]);
    await expect(service.cloudflareReport(7, { fetchImpl, settings })).rejects.toThrow(/not authorized/);
  });
});

describe('the consent gate in public/js/analytics.js', () => {
  it('requests gtag from exactly one function, reached only from a granted answer', () => {
    expect(ANALYTICS_JS.match(/googletagmanager\.com\/gtag\/js/g)).toHaveLength(1);
    const calls = ANALYTICS_JS.match(/loadGa4\(\)/g);
    // The definition, a stored "granted", and the Allow button: nowhere else.
    expect(calls).toHaveLength(3);
    expect(ANALYTICS_JS).toMatch(/if \(answer === 'granted'\) loadGa4\(\);/);
    expect(ANALYTICS_JS).toMatch(/write\('granted'\);\s*closeBar\(\);\s*loadGa4\(\);/);
  });

  it('offers decline with the same weight as allow', () => {
    const classes = ANALYTICS_JS.match(/(allow|decline)\.className = '([^']+)'/g);
    expect(classes).toHaveLength(2);
    expect(classes[0].split('=')[1]).toBe(classes[1].split('=')[1]);
  });

  it('remembers the answer outside a cookie, and can withdraw it', () => {
    expect(ANALYTICS_JS).toMatch(/localStorage\.setItem/);
    expect(ANALYTICS_JS).toMatch(/data-analytics-choices/);
    expect(ANALYTICS_JS).toMatch(/removeGaCookies/);
  });

  it('replaces the plain notice rather than stacking under it', () => {
    expect(MAIN_JS).toMatch(/meta\[name="ga4-id"\]/);
  });
});
