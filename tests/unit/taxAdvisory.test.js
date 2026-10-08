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

/*
 * The public half of this feature — the six-field "talk to a specialist" form at /tax — was
 * retired on 2026-10-07, when the owner decided /tax should carry dynamicshub.net's
 * calculator and application form instead (config/taxProgram.js, CLAUDE.md "The tax
 * programme"). What stays is the queue: migration 027 is applied and immutable, rows of the
 * `tax_advisory` kind may already exist, and the retention promise made to the people who
 * sent them is still owed. So these tests now pin the retirement as well as what survives it.
 */
describe('the retired introduction form', () => {
  it('no longer takes new tax enquiries through the contact queue', () => {
    const source = withoutComments(fs.readFileSync(path.join(root, 'routes', 'index.js'), 'utf8'));
    expect(source).not.toMatch(/router\.post\(\s*'\/tax'/);
    expect(source).not.toContain("kind: 'tax_advisory'");
  });

  it('still keeps its config and migration free of any saving figure', () => {
    const forbidden = ['savings', 'monthly_saving', 'annual_saving', 'take_home', 'takehome', 'percent_rate'];
    ['config/taxAdvisory.js', 'scripts/migrations/027_tax_advisory.sql'].forEach((file) => {
      const source = withoutComments(fs.readFileSync(path.join(root, file), 'utf8')).toLowerCase();
      forbidden.forEach((term) => expect(source).not.toContain(term));
    });
  });
});

describe('config/taxAdvisory.js', () => {
  it('asserts itself, and is asserted at boot', () => {
    expect(() => taxAdvisory.assertTaxAdvisoryIntegrity()).not.toThrow();
    expect(fs.readFileSync(path.join(root, 'server.js'), 'utf8')).toContain('assertTaxAdvisoryIntegrity()');
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
  it('lives in a partial that every form with one includes', () => {
    // Two copies of a defence is one that breaks silently the day somebody renames the
    // field in the other.
    expect(fs.existsSync(path.join(root, 'views', 'partials', 'honeypot.ejs'))).toBe(true);
    ['views/legal/tax-apply.ejs', 'views/partials/enquiry-fields.ejs'].forEach((file) => {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      expect(source).toContain("include('");
      expect(source).not.toContain('hp-field');
    });
  });
});
