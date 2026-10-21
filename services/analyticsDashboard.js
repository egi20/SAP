'use strict';

const webAnalytics = require('../config/webAnalytics');
const base = require('./webAnalytics');

/**
 * The detailed analytics screens — the sections dynamicshub.net/admin/analytics shows,
 * read from GA4's Data API and from Cloudflare's GraphQL API over one date range.
 *
 * EACH SECTION IS ITS OWN REQUEST AND MAY FAIL ON ITS OWN. GA4 refuses a whole batch for
 * one dimension it will not serve (demographics without Google Signals, for one), and
 * Cloudflare refuses a whole query for one field or one range its plan does not cover. A
 * dashboard that went blank because the age chart was unavailable would be worse than one
 * that shows every other section and says, in that one card, why it is empty — the same
 * rule `services/search.js` follows per source.
 *
 * A section is `{ key, rows }` or `{ key, error }`. Rows are `{ label, ...metrics }` in the
 * order the provider returned them. Nothing here renders; the views decide how.
 *
 * Results are cached for ten minutes per provider and range (realtime: thirty seconds).
 * A failed section is not cached.
 */

const AI_ASSISTANT = /chatgpt|openai|perplexity|claude|anthropic|gemini|bard|copilot|you\.com|phind|deepseek|mistral/i;

async function settle(key, run) {
  try {
    return { key, rows: await run() };
  } catch (err) {
    return { key, error: err.message };
  }
}

/* ------------------------------------------------------------------ GA4 */

async function ga4Call(method, body, { fetchImpl, settings, token }) {
  const res = await fetchImpl(
    `https://analyticsdata.googleapis.com/v1beta/properties/${settings.ga4.propertyId}:${method}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json.error && json.error.message) || `GA4 Data API answered ${res.status}`);
  return json;
}

/** Pure: a runReport response into rows keyed by the names asked for. */
function ga4Rows(json, dimensions, metrics) {
  return (json.rows || []).map((row) => {
    const out = {};
    dimensions.forEach((d, i) => { out[d] = row.dimensionValues[i].value; });
    metrics.forEach((m, i) => { out[m] = Number(row.metricValues[i].value) || 0; });
    out.label = dimensions.length ? row.dimensionValues.map((v) => v.value).join(' · ') : 'total';
    return out;
  });
}

/** The GA4 sections, each one request. Declared as data so a test can read them. */
function ga4Sections(range) {
  const dateRanges = [{ startDate: range.from, endDate: range.to }];
  const report = (dimensions, metrics, { limit = 50, orderBy, order = 'metric' } = {}) => ({
    dimensions,
    metrics,
    body: {
      dateRanges,
      dimensions: dimensions.map((name) => ({ name })),
      metrics: metrics.map((name) => ({ name })),
      ...(limit ? { limit } : {}),
      ...(orderBy
        ? { orderBys: [order === 'dimension' ? { dimension: { dimensionName: orderBy } } : { metric: { metricName: orderBy }, desc: true }] }
        : {})
    }
  });
  return {
    kpis: report([], ['screenPageViews', 'activeUsers', 'sessions', 'engagementRate', 'newUsers', 'averageSessionDuration', 'bounceRate'], { limit: 0 }),
    series: report(['date'], ['screenPageViews', 'activeUsers', 'sessions'], { limit: 400, orderBy: 'date', order: 'dimension' }),
    channels: report(['sessionDefaultChannelGroup'], ['activeUsers', 'sessions'], { limit: 20, orderBy: 'sessions' }),
    age: report(['userAgeBracket'], ['activeUsers'], { limit: 20, orderBy: 'userAgeBracket', order: 'dimension' }),
    gender: report(['userGender'], ['activeUsers'], { limit: 10, orderBy: 'activeUsers' }),
    devices: report(['deviceCategory'], ['activeUsers', 'sessions'], { limit: 10, orderBy: 'activeUsers' }),
    pages: report(['pagePath'], ['screenPageViews', 'activeUsers'], { limit: 50, orderBy: 'screenPageViews' }),
    sources: report(['sessionSourceMedium'], ['sessions', 'activeUsers'], { limit: 50, orderBy: 'sessions' }),
    landing: report(['sessionSourceMedium', 'landingPage'], ['sessions', 'activeUsers'], { limit: 100, orderBy: 'sessions' }),
    countries: report(['country'], ['activeUsers', 'sessions'], { limit: 50, orderBy: 'activeUsers' }),
    newReturning: report(['newVsReturning'], ['activeUsers', 'sessions', 'engagementRate'], { limit: 10, orderBy: 'activeUsers' })
  };
}

/** Pure: GA4's channel groups folded into the two numbers dynamicshub shows. */
function directVsExternal(channelRows) {
  const out = { direct: { users: 0, sessions: 0 }, external: { users: 0, sessions: 0 } };
  channelRows.forEach((r) => {
    const side = /^direct$/i.test(r.sessionDefaultChannelGroup) ? out.direct : out.external;
    side.users += r.activeUsers;
    side.sessions += r.sessions;
  });
  return out;
}

async function ga4Dashboard(range, { fetchImpl = fetch, settings = webAnalytics.settings } = {}) {
  return base.cached(`ga4-dash:${range.from}:${range.to}`, async () => {
    const serviceAccount = webAnalytics.readServiceAccount(settings.ga4.serviceAccountRaw);
    const token = await base.googleAccessToken(serviceAccount, fetchImpl);
    const ctx = { fetchImpl, settings, token };
    const defs = ga4Sections(range);

    const sections = await Promise.all(
      Object.entries(defs).map(([key, def]) =>
        settle(key, async () => ga4Rows(await ga4Call('runReport', def.body, ctx), def.dimensions, def.metrics))
      )
    );
    const byKey = Object.fromEntries(sections.map((s) => [s.key, s]));

    if (byKey.channels.rows) byKey.direct = { key: 'direct', split: directVsExternal(byKey.channels.rows) };
    if (byKey.sources.rows) {
      byKey.ai = { key: 'ai', rows: byKey.sources.rows.filter((r) => AI_ASSISTANT.test(r.sessionSourceMedium)) };
    }
    return byKey;
  });
}

/** Who is on the site now: GA4's realtime report, last thirty minutes. Cached 30 s. */
async function ga4Realtime({ fetchImpl = fetch, settings = webAnalytics.settings } = {}) {
  const key = `ga4-rt:${Math.floor(Date.now() / 30000)}`;
  return base.cached(key, async () => {
    const serviceAccount = webAnalytics.readServiceAccount(settings.ga4.serviceAccountRaw);
    const token = await base.googleAccessToken(serviceAccount, fetchImpl);
    const ctx = { fetchImpl, settings, token };
    const run = (dimensions) =>
      settle(dimensions[0] || 'total', async () => ga4Rows(
        await ga4Call('runRealtimeReport', {
          dimensions: dimensions.map((name) => ({ name })),
          metrics: [{ name: 'activeUsers' }],
          limit: 10
        }, ctx),
        dimensions,
        ['activeUsers']
      ));
    const [total, countries, pages] = await Promise.all([run([]), run(['country']), run(['unifiedScreenName'])]);
    return {
      activeUsers: total.rows && total.rows[0] ? total.rows[0].activeUsers : 0,
      countries,
      pages,
      error: total.error || null
    };
  });
}

/* ----------------------------------------------------------- Cloudflare */

const CF_GROUPS = Object.freeze({
  series: { field: 'date', limit: 400, orderBy: 'date_ASC' },
  pages: { field: 'requestPath', limit: 50 },
  countries: { field: 'countryName', limit: 50 },
  referrers: { field: 'refererHost', limit: 50 },
  devices: { field: 'deviceType', limit: 10 },
  browsers: { field: 'userAgentBrowser', limit: 15 },
  os: { field: 'userAgentOS', limit: 15 }
});

function cloudflareGroupQuery(kind, group) {
  const { declare, filter } = base.CLOUDFLARE_FILTERS[kind];
  const order = group.orderBy || 'count_DESC';
  return `
query Section($accountTag: string!, ${declare}, $from: Time!, $to: Time!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    rows: rumPageloadEventsAdaptiveGroups(filter: ${filter}, limit: ${group.limit}, orderBy: [${order}]) {
      count sum { visits } dimensions { label: ${group.field} }
    }
  } }
}`;
}

async function cloudflareDashboard(range, { fetchImpl = fetch, settings = webAnalytics.settings, host = base.defaultHost() } = {}) {
  return base.cached(`cf-dash:${range.from}:${range.to}`, async () => {
    const bySiteTag = Boolean(settings.cloudflare.explicitSiteTag);
    const variables = {
      accountTag: settings.cloudflare.accountId,
      ...(bySiteTag ? { siteTag: settings.cloudflare.explicitSiteTag } : { host }),
      from: `${range.from}T00:00:00Z`,
      to: `${range.to}T23:59:59Z`
    };
    const sections = await Promise.all(
      Object.entries(CF_GROUPS).map(([key, group]) =>
        settle(key, async () => {
          const body = await base.cloudflareGraphql(cloudflareGroupQuery(bySiteTag ? 'siteTag' : 'host', group), variables, { fetchImpl, settings });
          const account = (body.data && body.data.viewer && body.data.viewer.accounts && body.data.viewer.accounts[0]) || {};
          return (account.rows || []).map((g) => ({
            label: (g.dimensions && g.dimensions.label) || (key === 'referrers' ? '(direct)' : '(none)'),
            views: Number(g.count) || 0,
            visits: Number(g.sum && g.sum.visits) || 0
          }));
        })
      )
    );
    return Object.fromEntries(sections.map((s) => [s.key, s]));
  });
}

module.exports = {
  AI_ASSISTANT,
  CF_GROUPS,
  ga4Sections,
  ga4Rows,
  directVsExternal,
  cloudflareGroupQuery,
  ga4Dashboard,
  ga4Realtime,
  cloudflareDashboard
};
