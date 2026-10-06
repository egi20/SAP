'use strict';

/**
 * The sales CRM, where it can be checked without a database.
 *
 * This is the one area of the application that holds data about people who never asked to
 * be here, and most of what makes that defensible is a pure function or a declared list.
 * Those are asserted here; the things that need two rows and a transaction are in the
 * integration suite.
 */

const fs = require('fs');
const path = require('path');
const crm = require('../../config/crm');
const CrmLead = require('../../models/CrmLead');
const CrmSuppression = require('../../models/CrmSuppression');
const { parseCsv, readLeads } = require('../../utils/crmImport');

const root = path.join(__dirname, '..', '..');

function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/<%#[\s\S]*?%>/g, '');
}

describe('config/crm.js', () => {
  it('asserts its own integrity, and is asserted at boot', () => {
    expect(() => crm.assertCrmIntegrity()).not.toThrow();
    expect(fs.readFileSync(path.join(root, 'server.js'), 'utf8')).toContain('assertCrmIntegrity()');
  });

  it('lets anybody still in the pipeline be unsubscribed in ONE step', () => {
    /*
     * Somebody asking to be left alone must never depend on the pipeline happening to be
     * in the right place first. The boot assertion checks this too; it is here as well
     * because it is the rule most likely to be broken by adding a stage.
     */
    crm.STATUSES.filter((s) => !crm.isTerminal(s)).forEach((status) => {
      expect(crm.TRANSITIONS[status]).toContain('unsubscribed');
    });
    expect(crm.isTerminal('unsubscribed')).toBe(true);
  });

  it('requires a detail for every source where the category is not an answer', () => {
    expect(crm.sourceNeedsDetail('public_directory')).toBe(true);
    expect(crm.sourceNeedsDetail('existing_customer')).toBe(false);
    crm.LEAD_SOURCES.forEach((s) => expect(s.help).toBeTruthy());
  });

  it('knows which outcomes mean somebody was actually contacted', () => {
    expect(crm.CONTACT_OUTCOMES).toContain('sent');
    expect(crm.CONTACT_OUTCOMES).not.toContain('note');
  });
});

describe('a lead cannot exist without a source', () => {
  const base = { company: 'Nordwind GmbH', source: 'event', source_detail: 'SAP Sapphire, June' };

  it('refuses one with no source at all', () => {
    expect(() => CrmLead.normaliseLead({ company: 'Nordwind GmbH' })).toThrow(/where this contact came from/i);
  });

  it('refuses a category that needs a detail and has none', () => {
    expect(() => CrmLead.normaliseLead({ ...base, source_detail: '' })).toThrow(/specifically/i);
  });

  it('refuses a country rather than truncating it', () => {
    // `text(x, 2)` turns DEU into Germany by luck and AUT into Australia by accident.
    expect(CrmLead.normaliseLead({ ...base, country: 'DEU' }).country).toBeNull();
    expect(CrmLead.normaliseLead({ ...base, country: 'de' }).country).toBe('DE');
  });

  it('refuses a scheme that is not http', () => {
    expect(CrmLead.normaliseLead({ ...base, website: 'javascript:alert(1)' }).website).toBeNull();
    expect(CrmLead.normaliseLead({ ...base, website: 'nordwind.de' }).website).toMatch(/^https:\/\/nordwind\.de/);
  });

  it('keeps only product lines the site already has a name for', () => {
    const fields = CrmLead.normaliseLead({ ...base, product_lines: ['s4hana-finance', 'not-a-line', 's4hana-finance'] });
    expect(fields.product_lines).toEqual(['s4hana-finance']);
  });
});

describe('CrmLead.buildFilter', () => {
  it('puts the search through likePattern', () => {
    const { params } = CrmLead.buildFilter({ q: '100%' });
    expect(params).toContain('%100\\%%');
  });

  it('filters a product line with JSON_CONTAINS and never a LIKE', () => {
    // `LIKE '%s4hana%'` would match s4hana-supply-chain when only s4hana-finance was asked
    // for. Same rule as the agency directory.
    const { clause } = CrmLead.buildFilter({ product_line: 's4hana-finance' });
    expect(clause).toContain('JSON_CONTAINS');
    expect(clause).not.toContain('product_lines LIKE');
  });

  it('ignores a status, source or product line it does not recognise', () => {
    const { clause, params } = CrmLead.buildFilter({ status: 'invented', source: 'invented', product_line: 'invented' });
    expect(clause).toBe('1 = 1');
    expect(params).toHaveLength(0);
  });
});

describe('the suppression list', () => {
  it('stores a hash and never an address', () => {
    const source = fs.readFileSync(path.join(root, 'scripts', 'migrations', '024_crm.sql'), 'utf8');
    const table = source.slice(source.indexOf('CREATE TABLE crm_suppressions'), source.indexOf('CREATE TABLE crm_leads'));
    expect(table).toContain('email_hash');
    // A suppression list full of plaintext addresses IS a mailing list of people who asked
    // not to be mailed.
    expect(table).not.toMatch(/\bemail\s+VARCHAR/);
    // And no foreign key to the leads, or deleting a lead would forget they asked.
    expect(table).not.toContain('REFERENCES crm_leads');
  });

  it('normalises the same way on both sides, or a suppression silently misses', () => {
    expect(CrmSuppression.hashOf(' Person@Example.COM ')).toBe(CrmSuppression.hashOf('person@example.com'));
    // Gmail dots are preserved: two addresses, two hashes, because the check path cannot
    // know which provider collapses them.
    expect(CrmSuppression.hashOf('a.b@gmail.com')).not.toBe(CrmSuppression.hashOf('ab@gmail.com'));
  });

  it('is never deleted from, anywhere in the application', () => {
    const files = ['models/CrmSuppression.js', 'models/CrmLead.js', 'routes/crm.js'];
    files.forEach((file) => {
      const source = withoutComments(fs.readFileSync(path.join(root, file), 'utf8'));
      expect(source).not.toMatch(/DELETE\s+FROM\s+crm_suppressions/i);
    });
  });
});

describe('nothing in the CRM sends anything', () => {
  it('has no transport in the route, the models or the views', () => {
    /*
     * The standing refusal this whole area is built around: a draft is written, a person
     * sends it, a person records that they did. A test is the only thing that keeps that
     * true once somebody reaches for a mail library.
     */
    const files = [
      'routes/crm.js', 'models/CrmLead.js', 'models/CrmDraft.js',
      'views/crm/show.ejs', 'views/crm/index.ejs'
    ];
    files.forEach((file) => {
      const source = withoutComments(fs.readFileSync(path.join(root, file), 'utf8'));
      ['nodemailer', 'sendMail', 'sendgrid', 'smtp', 'mailgun', 'postmark'].forEach((term) => {
        expect(source.toLowerCase()).not.toContain(term.toLowerCase());
      });
    });
  });

  it('names the one column that records a send for what it is', () => {
    const sql = fs.readFileSync(path.join(root, 'scripts', 'migrations', '024_crm.sql'), 'utf8');
    // `marked_sent_at` is a note somebody made. A column called `sent_at` would be read as
    // a delivery receipt by the next person who sees it.
    expect(sql).toContain('marked_sent_at');
    expect(sql).not.toMatch(/\bsent_at\s+DATETIME/);
  });
});

describe('the CSV reader', () => {
  it('handles the part of RFC 4180 that matters', () => {
    expect(parseCsv('a,b\n"x,1","he said ""hi"""\n')).toEqual([['a', 'b'], ['x,1', 'he said "hi"']]);
    // A byte-order mark on the front of an export is the usual first failure.
    expect(parseCsv('﻿a,b\n1,2')[0]).toEqual(['a', 'b']);
  });

  it('reports what it skipped rather than dropping it quietly', () => {
    const result = readLeads('Company,Email\nAcme,a@b.de\nAcme,a@b.de\n,x@y.de\n', {
      source: 'event',
      sourceDetail: 'Sapphire, June'
    });
    expect(result.leads).toHaveLength(1);
    expect(result.skipped.map((s) => s.line)).toEqual([3, 4]);
    expect(result.skipped[0].reason).toMatch(/more than once/);
  });

  it('refuses a file with no source, before reading anybody out of it', () => {
    const result = readLeads('Company\nAcme\n', { source: '' });
    expect(result.problems[0]).toMatch(/where this file came from/i);
  });

  it('needs a header row naming the columns', () => {
    const result = readLeads('Acme,a@b.de\n', { source: 'existing_customer' });
    expect(result.problems[0]).toMatch(/no "company" column/i);
  });
});
