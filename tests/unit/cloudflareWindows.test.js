'use strict';

const { windowsFor, mergeCloudflareAccounts, cloudflareGraphqlRanged } = require('../../services/webAnalytics');

describe('a long Cloudflare range is asked week by week', () => {
  it('keeps a week as one window and splits 28 days into four disjoint weeks', () => {
    expect(windowsFor('2026-10-15T00:00:00.000Z', '2026-10-22T00:00:00.000Z')).toHaveLength(1);
    const w = windowsFor('2026-09-24T00:00:00.000Z', '2026-10-22T00:00:00.000Z');
    expect(w).toHaveLength(4);
    for (let i = 1; i < w.length; i += 1) expect(Date.parse(w[i].from)).toBeGreaterThan(Date.parse(w[i - 1].to));
    expect(w[0].from).toBe('2026-09-24T00:00:00.000Z');
    expect(w[w.length - 1].to).toBe('2026-10-22T00:00:00.000Z');
  });

  it('widens the windows instead of multiplying them past thirteen', () => {
    expect(windowsFor('2025-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z').length).toBeLessThanOrEqual(14);
  });

  it('adds counts and visits per dimension, keeps the coarsest sample interval, and orders dates ascending', () => {
    const merged = mergeCloudflareAccounts([
      { totals: [{ count: 180, sum: { visits: 90 } }], pages: [{ count: 5, dimensions: { label: '/jobs' } }], series: [{ count: 3, dimensions: { label: '2026-10-02' } }], sampling: [{ avg: { sampleInterval: 1 } }] },
      { totals: [{ count: 62, sum: { visits: 40 } }], pages: [{ count: 9, dimensions: { label: '/rates' } }, { count: 2, dimensions: { label: '/jobs' } }], series: [{ count: 4, dimensions: { label: '2026-10-01' } }], sampling: [{ avg: { sampleInterval: 10 } }] }
    ]);
    expect(merged.totals[0]).toMatchObject({ count: 242, sum: { visits: 130 } });
    expect(merged.pages.map((p) => [p.dimensions.label, p.count])).toEqual([['/rates', 9], ['/jobs', 7]]);
    expect(merged.series.map((p) => p.dimensions.label)).toEqual(['2026-10-01', '2026-10-02']);
    expect(merged.sampling[0].avg.sampleInterval).toBe(10);
  });

  it('a 28-day total can never come out below the week inside it', async () => {
    // Coarse sampling of the whole period would answer 180; each week answers its own figure.
    const perWeek = [10, 20, 30, 242];
    let call = 0;
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({ data: { viewer: { accounts: [{ totals: [{ count: perWeek[call++], sum: { visits: 1 } }] }] } } })
    });
    const settings = { cloudflare: { apiToken: 't' } };
    const body = await cloudflareGraphqlRanged('q', { from: '2026-09-24T00:00:00.000Z', to: '2026-10-22T00:00:00.000Z' }, { fetchImpl, settings });
    expect(body.data.viewer.accounts[0].totals[0].count).toBe(302);
    expect(body.windows).toBe(4);
  });
});
