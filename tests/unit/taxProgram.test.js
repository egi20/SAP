'use strict';

/**
 * The tax calculator, pinned to the figures dynamicshub.net produces for the same inputs,
 * and the browser's copy of the arithmetic pinned to the server's.
 */

const fs = require('fs');
const path = require('path');
const {
  TAX_PROGRAM, estimate, assertTaxProgramIntegrity, TAX_SUCCESS_STORIES
} = require('../../config/taxProgram');
const { compute } = require('../../public/js/tax');
const TaxApplication = require('../../models/TaxApplication');

// gross, net → cost, new net, monthly, percent, annual (as measured on the reference)
const TABLE = [
  [3000, 2000, 450, 2550, 550, 27.5, 6600],
  [5000, 3200, 650, 4350, 1150, 35.9, 13800],
  [8000, 5200, 950, 7050, 1850, 35.6, 22200],
  [10000, 6000, 1150, 8850, 2850, 47.5, 34200],
  [12000, 6800, 1350, 10650, 3850, 56.6, 46200],
  [20000, 11000, 2150, 17850, 6850, 62.3, 82200]
];

describe('config/taxProgram estimate()', () => {
  it.each(TABLE)('%i gross, %i net matches the reference', (g, n, cost, newNet, monthly, percent, annual) => {
    expect(estimate(g, n)).toEqual({ cost, newNet, monthly, percent, annual });
  });

  it('reports a structure that lowers take-home as a negative, not as a saving', () => {
    expect(estimate(8000, 7500).monthly).toBe(-450);
  });

  it('answers nothing for missing figures', () => {
    expect(estimate('', 5000)).toBeNull();
    expect(estimate(5000, 0)).toBeNull();
  });

  it('the browser runs the same arithmetic from the same two constants', () => {
    TABLE.forEach(([g, n]) => {
      const browser = compute(g, n, TAX_PROGRAM.fixedMonthlyFee, TAX_PROGRAM.costRate);
      const server = estimate(g, n);
      expect(Math.round(browser.monthly)).toBe(server.monthly);
      expect(browser.percent).toBe(server.percent);
    });
  });

  it('the browser file carries no copy of the constants', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'tax.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/\b150\b/);
    expect(src).not.toMatch(/0\.1\b/);
  });

  it('every result on the page is labelled indicative', () => {
    const view = fs.readFileSync(path.join(__dirname, '..', '..', 'views', 'legal', 'tax.ejs'), 'utf8');
    expect(view).toContain('Indicative only. Does not include personal income tax');
  });

  it('passes its own boot assertion, and publishes no invented stories', () => {
    expect(() => assertTaxProgramIntegrity()).not.toThrow();
    expect(TAX_SUCCESS_STORIES).toEqual([]);
  });
});

describe('TaxApplication.normalise', () => {
  const valid = {
    fullName: 'Ana Test', email: 'ana@example.com', phone: '+355 69 000 0000',
    currentCountry: 'Germany', employmentType: 'Freelancer / Self-Employed',
    currentGrossMonthly: '8000', currentNetMonthly: '5200',
    jobTitle: 'SAP FICO Consultant', primarySkills: 'FI, CO', agreeTerms: 'on'
  };

  it('accepts a complete application and computes the estimate itself', () => {
    const { values, errors } = TaxApplication.normalise({ ...valid, estimatedMonthlySavings: '999999' });
    expect(errors).toEqual({});
    expect(values.estimatedMonthlySavings).toBe(1850);
    expect(values.estimatedAnnualSavings).toBe(22200);
  });

  it('names every missing required field, consent included', () => {
    const { errors } = TaxApplication.normalise({});
    ['fullName', 'email', 'phone', 'currentCountry', 'employmentType', 'currentGrossMonthly',
      'currentNetMonthly', 'jobTitle', 'primarySkills', 'agreeTerms'].forEach((k) => {
      expect(errors[k]).toBeTruthy();
    });
  });

  it('refuses a value that is not on its list, a number out of range and an overlong answer', () => {
    const { errors } = TaxApplication.normalise({
      ...valid,
      currentCountry: 'Atlantis',
      timezone: '<script>',
      currentGrossMonthly: '12; DROP TABLE',
      currentTaxRatePercent: '140',
      jobTitle: 'x'.repeat(201)
    });
    expect(errors.currentCountry).toBeTruthy();
    expect(errors.timezone).toBeTruthy();
    expect(errors.currentGrossMonthly).toBeTruthy();
    expect(errors.currentTaxRatePercent).toBeTruthy();
    expect(errors.jobTitle).toMatch(/under 200/);
  });

  it('accepts only a linkedin.com address for the LinkedIn field', () => {
    expect(TaxApplication.normalise({ ...valid, linkedinUrl: 'javascript:alert(1)' }).errors.linkedinUrl).toBeTruthy();
    expect(TaxApplication.normalise({ ...valid, linkedinUrl: 'https://www.linkedin.com/in/ana' }).errors.linkedinUrl).toBeUndefined();
  });
});

describe('migration 024', () => {
  it('has no IP address column', () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'migrations', '024_tax_applications.sql'), 'utf8')
      .replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/\bip\b|ip_address/i);
    expect(sql).toMatch(/created_at\s+DATETIME/);
  });
});
