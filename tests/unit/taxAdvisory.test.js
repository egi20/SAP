'use strict';

/**
 * The tax advisory introduction, and the refusal that defines it.
 *
 * This is the THIRD time the same calculator has tried to arrive: once as `savings_monthly`
 * on a success story, once as a Budget Planner on the company comparison, and now as its
 * own page. So the test that matters here is not that the form works — it is that nothing
 * in the feature computes, stores or renders a saving.
 */

const fs = require('fs');
const path = require('path');
const taxAdvisory = require('../../config/taxAdvisory');
const Enquiry = require('../../models/Enquiry');

const root = path.join(__dirname, '..', '..');

/** Comments stripped: the sentence explaining why a word is forbidden contains the word. */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/<%#[\s\S]*?%>/g, '')
    .replace(/^\s*--.*$/gm, '');
}

describe('nothing here calculates anything', () => {
  const files = [
    'config/taxAdvisory.js',
    'views/legal/tax.ejs',
    'scripts/migrations/027_tax_advisory.sql'
  ];

  it('has no saving, no take-home and no tax rate anywhere in the feature', () => {
    /*
     * DynamicsHub computes `newNet = gross - (gross * percentRate / 100 + fixedFee)` with
     * percentRate defaulting to 5 AND editable by an administrator, then presents the
     * difference as a monthly and annual saving — for anybody, in any country, under any
     * arrangement. Its table stores the figure posted back from the browser.
     */
    const forbidden = [
      'savings', 'monthly_saving', 'annual_saving', 'take_home', 'takehome',
      'net_monthly', 'gross_monthly', 'tax_rate', 'percent_rate', 'deduction'
    ];
    files.forEach((file) => {
      const source = withoutComments(fs.readFileSync(path.join(root, file), 'utf8')).toLowerCase();
      forbidden.forEach((term) => {
        expect(source).not.toContain(term);
      });
    });
  });

  it('has no calculate endpoint, and the route does no arithmetic on money', () => {
    const source = withoutComments(fs.readFileSync(path.join(root, 'routes', 'index.js'), 'utf8'));
    expect(source).not.toMatch(/\/tax\/calculate/);
    expect(source).not.toMatch(/monthlySavings|annualSavings|percentIncrease/);
  });

  it('and the page SAYS so, in words, from the config', () => {
    // A refusal nobody can read on the page is a refusal only the authors know about.
    const view = fs.readFileSync(path.join(root, 'views', 'legal', 'tax.ejs'), 'utf8');
    expect(view).toContain('promise.doesNot');
    expect(taxAdvisory.PROMISE.doesNot.join(' ')).toMatch(/saving/i);
  });
});

describe('config/taxAdvisory.js', () => {
  it('asserts itself, and is asserted at boot', () => {
    expect(() => taxAdvisory.assertTaxAdvisoryIntegrity()).not.toThrow();
    expect(fs.readFileSync(path.join(root, 'server.js'), 'utf8')).toContain('assertTaxAdvisoryIntegrity()');
  });

  it('collects six things and no financial profile', () => {
    /*
     * The reference's form takes forty fields from an anonymous visitor: employer,
     * contract end date, notice period, gross and net pay, current tax rate, VAT
     * registration, desired day rate. A first conversation needs six things.
     */
    const view = fs.readFileSync(path.join(root, 'views', 'legal', 'tax.ejs'), 'utf8');
    const names = [...view.matchAll(/name="([a-z_]+)"/g)].map((m) => m[1]);
    const asked = names.filter((n) => !['_csrf', 'website'].includes(n));
    expect(new Set(asked)).toEqual(new Set(['name', 'email', 'country', 'arrangement', 'topic', 'message']));
  });

  it('bounds a country generously and then checks it, rather than truncating', () => {
    // `text(x, 2)` turns ALB into a valid-looking AL and AUT into Australia.
    expect(taxAdvisory.LIMITS.country).toBeGreaterThan(2);
  });

  it('rejects a topic or an arrangement it does not know', () => {
    expect(taxAdvisory.isTopic('structure')).toBe(true);
    expect(taxAdvisory.isTopic('anything-else')).toBe(false);
    expect(taxAdvisory.isArrangement('umbrella')).toBe(true);
    expect(taxAdvisory.isArrangement('invented')).toBe(false);
  });
});

describe('one table, one queue', () => {
  it('a tax enquiry is a third KIND and not a second table', () => {
    // The rule migration 018 was written about: two queues means a second one nobody
    // opens, and "somebody is watching" is the whole justification for having a form.
    expect(Enquiry.KINDS).toContain('tax_advisory');
    expect(fs.existsSync(path.join(root, 'models', 'TaxEnquiry.js'))).toBe(false);
  });

  it('and the kind list still mirrors the ENUM as the migrations leave it', () => {
    const files = fs.readdirSync(path.join(root, 'scripts', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
    let values = null;
    files.forEach((file) => {
      const sql = fs.readFileSync(path.join(root, 'scripts', 'migrations', file), 'utf8');
      const pattern = /kind\s+ENUM\(([^)]+)\)/gi;
      let match = pattern.exec(sql);
      while (match) {
        values = match[1].split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
        match = pattern.exec(sql);
      }
    });
    expect(Enquiry.KINDS).toEqual(values);
  });

  it('the retention purge is scoped to this kind and to closed rows', () => {
    /*
     * The promise is made on the tax form and nowhere else. A purge that dropped the kind
     * from its WHERE would quietly extend a promise nobody made to messages nobody
     * promised it about.
     */
    const source = fs.readFileSync(path.join(root, 'models', 'Enquiry.js'), 'utf8');
    const block = source.slice(source.indexOf('static async purgeExpiredTaxEnquiries'));
    expect(block).toContain("kind = 'tax_advisory'");
    expect(block).toContain("status = 'closed'");
  });
});

describe('the honeypot is one field in one place', () => {
  it('lives in a partial that both forms include', () => {
    // Two copies of a defence is one that breaks silently the day somebody renames the
    // field in the other.
    expect(fs.existsSync(path.join(root, 'views', 'partials', 'honeypot.ejs'))).toBe(true);
    ['views/legal/tax.ejs', 'views/partials/enquiry-fields.ejs'].forEach((file) => {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      expect(source).toContain("include('");
      expect(source).not.toContain('hp-field');
    });
  });
});
