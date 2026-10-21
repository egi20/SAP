'use strict';

const path = require('path');
const ejs = require('ejs');

const FILE = path.join(__dirname, '../../views/admin/analytics-partials/line-chart.ejs');
const render = (locals) => ejs.renderFile(FILE, locals);

describe('the traffic-over-time chart', () => {
  test('draws every day of the range, at zero where the provider returned nothing', async () => {
    const html = await render({
      range: { from: '2026-10-15', to: '2026-10-21' },
      series: [{ label: 'Page views', color: '#0064d9', byDay: { '2026-10-21': 12 } }]
    });
    expect((html.match(/<circle /g) || []).length).toBe(7);
    expect(html).toContain('<polyline');
    expect(html).toContain('2026-10-21 — Page views: 12');
    expect(html).toContain('2026-10-15 — Page views: 0');
  });

  test('carries its colours on the elements, never relying on a stylesheet', async () => {
    const html = await render({
      range: { from: '2026-10-20', to: '2026-10-21' },
      series: [{ label: 'Users', color: '#0f9d8a', byDay: { '2026-10-20': 3, '2026-10-21': 5 } }]
    });
    expect(html).toMatch(/<polyline[^>]*stroke="#0f9d8a"/);
    expect(html).not.toMatch(/class="col"/);
  });

  test('says so when the whole range is zero', async () => {
    const html = await render({ range: { from: '2026-10-20', to: '2026-10-21' }, series: [{ label: 'Page views', color: '#0064d9', byDay: {} }] });
    expect(html).toContain('Every day in this range is zero');
  });
});
