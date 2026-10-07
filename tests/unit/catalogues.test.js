'use strict';

const taxonomy = require('../../config/roleTaxonomy');
const products = require('../../config/sapProducts');
const certifications = require('../../config/certifications');
const settings = require('../../config/settings');

/*
 * These catalogues are asserted at boot, and these tests pin the invariants that the boot
 * assertion checks — plus the ones it cannot, because they are about the CONTENT rather
 * than the shape. Every failure mode here produces a wrong number or a missed match rather
 * than an error, which is the argument for testing them at all.
 */

describe('the catalogues assert their own integrity', () => {
  test('role taxonomy', () => expect(taxonomy.assertTaxonomyIntegrity()).toBe(true));
  test('product catalogue', () => expect(products.assertCatalogueIntegrity()).toBe(true));
  test('certification catalogue', () => expect(certifications.assertCertificationIntegrity()).toBe(true));
  test('settings definitions', () => expect(settings.assertSettingsIntegrity()).toBe(true));
});

describe('role taxonomy', () => {
  test('every role in the SAP rate index has a positive integer base day rate', () => {
    for (const slug of taxonomy.RATE_ROLE_SLUGS) {
      expect(Number.isInteger(taxonomy.baseDayRate(slug))).toBe(true);
      expect(taxonomy.baseDayRate(slug)).toBeGreaterThan(0);
    }
  });

  test('roles that are not SAP work are selectable but outside the rate index', () => {
    // An "SAP day rate" for an HR manager is a figure about something else, and printing
    // it beside FI and EWM made the index look less like what it says it is.
    for (const slug of ['business-developer', 'hr-manager', 'recruiter']) {
      expect(taxonomy.isRole(slug)).toBe(true);
      expect(taxonomy.isRateRole(slug)).toBe(false);
      expect(taxonomy.baseDayRate(slug)).toBeNull();
    }
  });

  test('a role category tied to a product line carries that line\'s exact label', () => {
    /*
     * The rate index, the job board and the module picker used to group the same things
     * under different names — "Human Experience" against "SAP SuccessFactors", "Spend &
     * Network" against "SAP Spend Management", two lines glued into one category.
     */
    const tied = taxonomy.ROLE_CATEGORIES.filter((c) => c.line);
    expect(tied.length).toBeGreaterThan(5);
    for (const category of tied) {
      expect(category.category).toBe(products.lineByValue(category.line).label);
    }
  });

  test('every technical role has modules to record a delivery against', () => {
    // A Basis or GRC consultant with a role and no module cannot fill in the delivery
    // history the directory filters on.
    for (const value of ['basis', 'abap-classic', 'pi-po', 'grc-ac', 'security-auth', 'solman-calm', 'migration-tools']) {
      expect(products.isModule(value)).toBe(true);
    }
  });

  test('the module codes this ecosystem actually advertises are all aliases somewhere', () => {
    // A taxonomy for SAP that cannot match "MM" cannot read its own job board.
    const all = new Set(Object.values(taxonomy.ROLE_ALIASES).flat());
    for (const code of ['fi', 'co', 'mm', 'sd', 'pp', 'ewm', 'qm', 'tm', 'ps', 'abap', 'basis', 'cpi']) {
      expect(all.has(code)).toBe(true);
    }
  });

  test('a duplicated alias is either declared intentional or absent', () => {
    const owners = new Map();
    for (const [slug, aliases] of Object.entries(taxonomy.ROLE_ALIASES)) {
      for (const alias of aliases) owners.set(alias, [...(owners.get(alias) || []), slug]);
    }
    for (const [alias, slugs] of owners) {
      if (slugs.length > 1) expect(taxonomy.INTENDED_ALIAS_COLLISIONS.has(alias)).toBe(true);
    }
  });

  test('exactly one seniority band is the baseline', () => {
    const baseline = taxonomy.SENIORITY_LEVELS.filter((l) => l.multiplier === 1);
    expect(baseline).toHaveLength(1);
    expect(baseline[0].value).toBe('senior');
  });
});

describe('product catalogue', () => {
  test('every cross-module dependency names a real module', () => {
    for (const module of products.ALL_MODULES) {
      for (const dep of module.crossModule) {
        expect(products.isModule(dep)).toBe(true);
      }
    }
  });

  test('SAP effort baselines are not CRM-sized', () => {
    /*
     * The single most expensive thing this catalogue could get wrong: carrying the
     * reference's figures across and quoting an ERP programme at a CRM price. Salesforce
     * Hub's largest foundation is 20 consultant-days; nothing here should be near that.
     */
    for (const line of products.PRODUCT_LINES) {
      expect(line.foundationEffortDays).toBeGreaterThanOrEqual(25);
    }
    const financeCore = products.moduleByValue('fi-gl');
    expect(financeCore.baseEffortDays).toBeGreaterThanOrEqual(40);
  });

  test('a module is never its own dependency', () => {
    for (const module of products.ALL_MODULES) {
      expect(module.crossModule).not.toContain(module.value);
    }
  });
});

describe('certification catalogue', () => {
  test('no code carries a year suffix', () => {
    // SAP re-versions codes annually; a stored C_TS4FI_2023 is wrong within twelve months.
    for (const cert of certifications.ALL_CERTIFICATIONS) {
      expect(cert.code).not.toMatch(/_\d{4}$/);
    }
  });

  test('OTHER is reserved and never in the catalogue', () => {
    expect(certifications.isCertificationCode(certifications.OTHER_CODE)).toBe(true);
    expect(certifications.certByCode(certifications.OTHER_CODE)).toBeNull();
    expect(certifications.ALL_CERTIFICATIONS.map((c) => c.code)).not.toContain(certifications.OTHER_CODE);
  });

  test('an unknown code is refused', () => {
    expect(certifications.isCertificationCode('C_MADE_UP')).toBe(false);
  });
});

describe('settings', () => {
  test('a prototype-polluting key cannot reach the write path', () => {
    // `DEFINITIONS['__proto__']` is Object.prototype, which is truthy — so a plain
    // truthiness guard would let this through. Carried over from the reference, and pinned.
    expect(settings.isValidKey('__proto__')).toBe(false);
    expect(settings.coerce('__proto__', 'on')).toBeNull();
  });

  test('the privacy floor is not a setting', () => {
    // RATE_MIN_SAMPLE is an environment variable precisely so lowering it is a deployment
    // decision, not a checkbox that makes a sparse index look fuller.
    expect(settings.KEYS).not.toContain('rate_min_sample');
  });
});
