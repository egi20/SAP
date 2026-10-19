'use strict';

const crypto = require('crypto');
const webAnalytics = require('../config/webAnalytics');
const config = require('../config/config');

const defaultHost = () => new URL(config.app.baseUrl).hostname;

/**
 * The two providers' reports, in ONE shape, so the trial compares like with like.
 *
 *   { provider, days, totals: [{ label, value }], pages, countries, sources, devices }
 *
 * where each list is `[{ label, value }]`, top ten, already sorted. The two admin screens
 * render the same template from it. The labels on the totals are each provider's OWN
 * terms — GA4 has users and sessions, Cloudflare has visits and no notion of a user — and
 * they are not renamed to look comparable: "page views" is the only figure both define the
 * same way, and the page says so.
 *
 * No SDK for either. GA4's is a large dependency for one POST; a service-account token is a
 * signed JWT, which `crypto` does in ten lines. Cloudflare's is a GraphQL endpoint.
 *
 * Results are cached for ten minutes per provider and range: both APIs are rate limited,
 * and an admin refreshing a page is not new information. A failure is never cached.
 */

const CACHE_MS = 10 * 60 * 1000;
const RANGES = Object.freeze([7, 30]);
const cache = new Map();

async function cached(key, compute) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await compute();
  cache.set(key, { value, expires: Date.now() + CACHE_MS });
  return value;
}

function clearCache() {
  cache.clear();
}

const toList = (rows) =>
  rows
    .map((r) => ({ label: r.label || '(none)', value: Number(r.value) || 0 }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);

/* ------------------------------------------------------------------ GA4 */

const b64url = (input) => Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

async function googleAccessToken(serviceAccount, fetchImpl) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(
    JSON.stringify({
      iss: serviceAccount.clientEmail,
      scope: 'https://www.googleapis.com/auth/analytics.readonly',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600
    })
  );
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(`${header}.${claim}`)
    .sign(serviceAccount.privateKey)
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claim}.${signature}`
    }).toString()
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`Google refused the service account: ${body.error_description || body.error || res.status}`);
  }
  return body.access_token;
}

function ga4Requests(days) {
  const dateRanges = [{ startDate: `${days - 1}daysAgo`, endDate: 'today' }];
  const top = (dimension, metric) => ({
    dateRanges,
    dimensions: [{ name: dimension }],
    metrics: [{ name: metric }],
    orderBys: [{ metric: { metricName: metric }, desc: true }],
    limit: 10
  });
  return [
    { dateRanges, metrics: [{ name: 'screenPageViews' }, { name: 'activeUsers' }, { name: 'sessions' }] },
    top('pagePath', 'screenPageViews'),
    top('country', 'activeUsers'),
    top('sessionSource', 'sessions'),
    top('deviceCategory', 'activeUsers')
  ];
}

/** Pure: a batchRunReports response into the shared shape. */
function normaliseGa4(body, days) {
  const reports = body.reports || [];
  const rowsOf = (i) =>
    (reports[i] && reports[i].rows ? reports[i].rows : []).map((row) => ({
      label: row.dimensionValues ? row.dimensionValues[0].value : '',
      value: row.metricValues[0].value
    }));
  const totalsRow = reports[0] && reports[0].rows && reports[0].rows[0];
  const metric = (i) => (totalsRow ? Number(totalsRow.metricValues[i].value) || 0 : 0);
  return {
    provider: 'ga4',
    days,
    totals: [
      { label: 'Page views', value: metric(0) },
      { label: 'Users', value: metric(1) },
      { label: 'Sessions', value: metric(2) }
    ],
    pages: toList(rowsOf(1)),
    countries: toList(rowsOf(2)),
    sources: toList(rowsOf(3)),
    devices: toList(rowsOf(4))
  };
}

async function ga4Report(days, { fetchImpl = fetch, settings = webAnalytics.settings } = {}) {
  return cached(`ga4:${days}`, async () => {
    const serviceAccount = webAnalytics.readServiceAccount(settings.ga4.serviceAccountRaw);
    const token = await googleAccessToken(serviceAccount, fetchImpl);
    const res = await fetchImpl(
      `https://analyticsdata.googleapis.com/v1beta/properties/${settings.ga4.propertyId}:batchRunReports`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests: ga4Requests(days) })
      }
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`GA4 Data API: ${(body.error && body.error.message) || res.status}`);
    }
    return normaliseGa4(body, days);
  });
}

/* ----------------------------------------------------------- Cloudflare */

/*
 * Which page loads are ours. The GraphQL API keys a site on its SITE TAG, which is not the
 * token in the snippet — the first version assumed it was, and the screen answered a clean
 * zero for a site Cloudflare was counting. So by default the filter is the HOST the site is
 * served from (APP_BASE_URL), which this application knows for certain; an explicitly set
 * CF_WEB_ANALYTICS_SITE_TAG takes over when somebody wants the dashboard's own key.
 *
 * Two fixed literals, never assembled from input: the values travel as variables.
 */
const CLOUDFLARE_FILTERS = Object.freeze({
  siteTag: { declare: '$siteTag: string!', filter: '{ siteTag: $siteTag, datetime_geq: $from, datetime_leq: $to }' },
  host: { declare: '$host: string!', filter: '{ requestHost: $host, datetime_geq: $from, datetime_leq: $to }' }
});

function cloudflareQuery(kind) {
  const { declare, filter } = CLOUDFLARE_FILTERS[kind];
  const group = (alias, extra, fields) =>
    `${alias}: rumPageloadEventsAdaptiveGroups(filter: ${filter}, ${extra}) { ${fields} }`;
  return `
query WebAnalytics($accountTag: string!, ${declare}, $from: Time!, $to: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      ${group('totals', 'limit: 1', 'count sum { visits }')}
      ${group('pages', 'limit: 10, orderBy: [count_DESC]', 'count dimensions { label: requestPath }')}
      ${group('countries', 'limit: 10, orderBy: [count_DESC]', 'count dimensions { label: countryName }')}
      ${group('sources', 'limit: 10, orderBy: [count_DESC]', 'count dimensions { label: refererHost }')}
      ${group('devices', 'limit: 10, orderBy: [count_DESC]', 'count dimensions { label: deviceType }')}
    }
  }
}`;
}

/** Pure: a GraphQL response into the shared shape. */
function normaliseCloudflare(body, days) {
  const account = (body.data && body.data.viewer && body.data.viewer.accounts && body.data.viewer.accounts[0]) || {};
  const rows = (key) => (account[key] || []).map((g) => ({ label: g.dimensions && g.dimensions.label, value: g.count }));
  const total = (account.totals && account.totals[0]) || { count: 0, sum: { visits: 0 } };
  return {
    provider: 'cloudflare',
    days,
    totals: [
      { label: 'Page views', value: Number(total.count) || 0 },
      { label: 'Visits', value: Number(total.sum && total.sum.visits) || 0 }
    ],
    pages: toList(rows('pages')),
    countries: toList(rows('countries')),
    // An empty referrer is a visit typed in, bookmarked or arriving from an app.
    sources: toList(rows('sources').map((r) => ({ ...r, label: r.label || '(direct)' }))),
    devices: toList(rows('devices'))
  };
}

async function cloudflareReport(days, { fetchImpl = fetch, settings = webAnalytics.settings, now = new Date(), host = defaultHost() } = {}) {
  return cached(`cloudflare:${days}`, async () => {
    const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const bySiteTag = Boolean(settings.cloudflare.explicitSiteTag);
    const res = await fetchImpl('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${settings.cloudflare.apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: cloudflareQuery(bySiteTag ? 'siteTag' : 'host'),
        variables: {
          accountTag: settings.cloudflare.accountId,
          ...(bySiteTag ? { siteTag: settings.cloudflare.explicitSiteTag } : { host }),
          from: from.toISOString(),
          to: now.toISOString()
        }
      })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || (body.errors && body.errors.length)) {
      const message = body.errors && body.errors.length ? body.errors.map((e) => e.message).join('; ') : res.status;
      throw new Error(`Cloudflare GraphQL API: ${message}`);
    }
    const report = normaliseCloudflare(body, days);
    report.filteredBy = bySiteTag ? `site tag ${settings.cloudflare.explicitSiteTag}` : `host ${host}`;
    return report;
  });
}

module.exports = {
  RANGES,
  ga4Report,
  cloudflareReport,
  normaliseGa4,
  normaliseCloudflare,
  ga4Requests,
  cloudflareQuery,
  clearCache
};
