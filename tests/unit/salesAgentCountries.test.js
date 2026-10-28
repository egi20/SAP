'use strict';

/**
 * The Sales agents tab's country breakdown (as dynamicshub.net's): the ring, the grouping
 * behind it, and the modal that lists the people. Rendered without a database.
 */

const path = require('path');
const ejs = require('ejs');
const { donutSlices, OTHER_COLOR } = require('../../utils/donutSlices');
const SalesAgent = require('../../models/SalesAgent');

describe('donutSlices', () => {
  it('sums to 100% and folds the tail into one Other slice', () => {
    const rows = Array.from({ length: 9 }, (_, i) => ({ label: `C${i}`, count: 9 - i }));
    const { slices, total, distinct } = donutSlices(rows, { top: 6 });
    expect(total).toBe(45);
    expect(distinct).toBe(9);
    expect(slices).toHaveLength(7);
    expect(slices[6]).toMatchObject({ isOther: true, count: 3 + 2 + 1, color: OTHER_COLOR });
    expect(slices.reduce((n, s) => n + s.pct, 0)).toBeCloseTo(100, 9);
    // Each slice starts where the previous one ended.
    expect(slices[1].offset).toBeCloseTo(-slices[0].pct, 9);
  });

  it('never draws an empty bucket and reports no data for nothing', () => {
    expect(donutSlices([{ label: 'A', count: 0 }])).toMatchObject({ hasData: false, total: 0 });
    expect(donutSlices(null).hasData).toBe(false);
  });
});

describe('SalesAgent.groupCountries', () => {
  const rows = [
    { agent_id: 7, code: 'al', n: 3, from_ip: 2 },
    { agent_id: 7, code: null, n: 1, from_ip: 0 },
    { agent_id: 8, code: 'DE', n: 2, from_ip: 0 },
    { agent_id: 8, code: 'AL', n: 1, from_ip: 1 },
    { agent_id: null, code: 'US', n: 40, from_ip: 40 }
  ];

  it('keys each agent, upper-cases codes and keeps Unknown as its own bucket', () => {
    const { byAgent } = SalesAgent.groupCountries(rows);
    expect(byAgent[7]).toEqual([{ code: 'AL', count: 3, fromIp: 2 }, { code: null, count: 1, fromIp: 0 }]);
    expect(byAgent[8][0]).toEqual({ code: 'DE', count: 2, fromIp: 0 });
  });

  it('sums only the agents into overall; the no-link rows stay apart', () => {
    const { overall, direct } = SalesAgent.groupCountries(rows);
    expect(overall).toEqual([
      { code: 'AL', count: 4, fromIp: 3 },
      { code: 'DE', count: 2, fromIp: 0 },
      { code: null, count: 1, fromIp: 0 }
    ]);
    expect(direct).toEqual([{ code: 'US', count: 40, fromIp: 40 }]);
  });
});

describe('the Sales agents tab', () => {
  const views = path.join(__dirname, '..', '..', 'views', 'admin');
  const geo = (rows) => ({ rows, chart: donutSlices(rows.map((r) => ({ label: r.code || 'Unknown', count: r.count }))) });
  const locals = {
    csrfToken: 't',
    agents: [{ user_id: 7, code: 'ABCDEFGH', is_active: 1, account_active: 1, link_opens: 12, opens_24h: 3, name: 'Ana <b>', email: 'ana@x.test',
      signups: 2, signups_24h: 1, consultants: 2, companies: 0, verified: 1, last_signup: new Date() }],
    direct: { all_accounts: 50, signups: 48, signups_24h: 4, consultants: 30, companies: 10, verified: 40, via_referrer: 2 },
    agentPeople: { 7: [{ id: 1, name: 'Bea', email: 'bea@x.test', is_active: 1, is_consultant: 1, is_company: 0, email_verified: 1,
      created_at: new Date(), country: 'AL', country_source: 'ip' }] },
    agentCountries: { 7: geo([{ code: 'AL', count: 2, fromIp: 2 }]) },
    directCountries: geo([{ code: 'US', count: 48, fromIp: 10 }]),
    overallCountries: geo([{ code: 'AL', count: 2, fromIp: 2 }]),
    countryLabel: (c) => (c === 'AL' ? 'Albania' : c || 'Unknown'),
    geoNote: 'note',
    linkFor: (code) => `https://x.test/s/${code}`
  };

  it('shows both 24-hour columns and a top-country button that opens the modal', async () => {
    const html = await ejs.renderFile(path.join(views, '_sales-agents.ejs'), locals);
    expect(html).toContain('Opened (24h)');
    expect(html).toContain('Signed up (24h)');
    expect(html).toContain('data-bs-target="#agent-countries-7"');
    expect(html).toContain('data-bs-target="#agent-countries-direct"');
    expect(html).toContain('Where agent-link sign-ups come from');
    expect(html).not.toContain('Ana <b>');
  });

  it('modals list each person with their country and say when it came from the sign-up IP', async () => {
    const html = await ejs.renderFile(path.join(views, '_sales-agent-modals.ejs'), locals);
    expect(html).toContain('id="agent-countries-7"');
    expect(html).toContain('id="agent-countries-direct"');
    expect(html).toContain('bea@x.test');
    expect(html).toMatch(/Albania\s*<span[^>]*>· sign-up IP/);
    expect(html).toContain('(10 from sign-up IP)');
  });
});
