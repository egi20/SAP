'use strict';

const { advertRates } = require('../../utils/advertRates');

const toEur = (amount, currency) => (currency === 'EUR' ? Number(amount) : currency === 'GBP' ? Number(amount) * 1.2 : null);
const FROM = new Date('2026-10-22T00:00:00Z');

describe('what open adverts offer', () => {
  test('leaves out an advert that hides its rate, and one outside the plausible range', () => {
    const r = advertRates([
      { role: 's4-fi', seniority: 'senior', rate_min: 700, rate_max: 900, currency: 'EUR', rate_visible: 1, published_at: '2026-10-05' },
      { role: 's4-fi', seniority: 'senior', rate_min: 650, rate_max: 850, currency: 'EUR', rate_visible: 0, published_at: '2026-10-06' },
      { role: 's4-fi', seniority: 'mid', rate_min: 90000, rate_max: 95000, currency: 'EUR', rate_visible: 1, published_at: '2026-10-06' }
    ], 'contract', toEur, { from: FROM });
    expect(r.summary.adverts).toBe(1);
    expect(r.summary.median).toBe(800);
    expect(r.outOfBounds).toBe(1);
  });

  test('converts to euros and reads a one-sided range as a point', () => {
    const r = advertRates([
      { role: 's4-mm', seniority: 'lead', rate_min: 500, rate_max: null, currency: 'GBP', rate_visible: 1, published_at: '2026-09-01' }
    ], 'contract', toEur, { from: FROM });
    expect(r.summary.median).toBe(600);
    expect(r.byRole[0]).toMatchObject({ key: 's4-mm', adverts: 1 });
  });

  test('a month with no advert is null, never zero', () => {
    const r = advertRates([
      { role: 's4-fi', seniority: 'senior', rate_min: 800, rate_max: 800, currency: 'EUR', rate_visible: 1, published_at: '2026-10-01' }
    ], 'contract', toEur, { from: FROM });
    expect(r.byMonth).toHaveLength(12);
    expect(r.byMonth[11]).toMatchObject({ period: '2026-10', value: 800 });
    expect(r.byMonth[0].value).toBeNull();
  });
});
