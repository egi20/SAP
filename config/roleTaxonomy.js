'use strict';

/**
 * The SAP consulting role taxonomy.
 *
 * This is the single source of truth. Both reference implementations — DynamicsHub and
 * Salesforce Hub — learned the same lesson here: DynamicsHub duplicated the equivalent
 * list across eight files until it drifted (`pm` vs `project-manager`), and Salesforce Hub
 * fixed that by centralising it. Centralised from the first line here.
 *
 *   value = the slug stored in `jobs.role` and `consultant_profiles.primary_role`
 *   label = the display string
 *
 * Storing the SLUG (never the label) on both tables is deliberate: DynamicsHub stored the
 * label on profiles and the slug on jobs, which made matching and rate bucketing require a
 * fragile label<->slug reverse lookup.
 *
 * SAP-specific shape, and the reason this is not the Salesforce list with words swapped:
 * an SAP practice is organised by MODULE and by LINE OF BUSINESS, and the same person is
 * routinely "FI/CO" or "MM/SD". So the functional roles are split by module the way a
 * statement of work names them, and `ROLE_ALIASES` carries the two-letter module codes —
 * FI, CO, MM, SD, PP, EWM — because that is what job adverts in this ecosystem actually
 * say, far more often than the product's marketing name.
 */
const ROLE_CATEGORIES = [
  {
    category: 'S/4HANA Finance',
    roles: [
      { value: 's4-fi', label: 'Financial Accounting (FI) Consultant' },
      { value: 's4-co', label: 'Management Accounting (CO) Consultant' },
      { value: 's4-rar', label: 'Revenue Accounting (RAR) Consultant' },
      { value: 'group-reporting', label: 'Group Reporting / Consolidation Consultant' },
      { value: 'treasury', label: 'Treasury & Risk Management Consultant' }
    ]
  },
  {
    category: 'S/4HANA Logistics & Manufacturing',
    roles: [
      { value: 's4-mm', label: 'Sourcing & Procurement (MM) Consultant' },
      { value: 's4-sd', label: 'Sales & Distribution (SD) Consultant' },
      { value: 's4-pp', label: 'Production Planning (PP) Consultant' },
      { value: 's4-ewm', label: 'Extended Warehouse Management (EWM) Consultant' },
      { value: 's4-qm', label: 'Quality Management (QM) Consultant' },
      { value: 's4-pm', label: 'Plant Maintenance / EAM Consultant' },
      { value: 's4-tm', label: 'Transportation Management (TM) Consultant' },
      { value: 's4-ps', label: 'Project System (PS) Consultant' }
    ]
  },
  {
    category: 'Human Experience',
    roles: [
      { value: 'sf-employee-central', label: 'SuccessFactors Employee Central Consultant' },
      { value: 'sf-recruiting', label: 'SuccessFactors Recruiting & Onboarding Consultant' },
      { value: 'sf-performance', label: 'SuccessFactors Performance & Goals Consultant' },
      { value: 'sf-compensation', label: 'SuccessFactors Compensation Consultant' },
      { value: 'sf-learning', label: 'SuccessFactors Learning (LMS) Consultant' },
      { value: 'hcm-payroll', label: 'SAP Payroll / HCM Consultant' }
    ]
  },
  {
    category: 'Spend & Network',
    roles: [
      { value: 'ariba', label: 'SAP Ariba Consultant' },
      { value: 'concur', label: 'SAP Concur Consultant' },
      { value: 'fieldglass', label: 'SAP Fieldglass Consultant' }
    ]
  },
  {
    category: 'Supply Chain & Customer Experience',
    roles: [
      { value: 'ibp', label: 'Integrated Business Planning (IBP) Consultant' },
      { value: 'cx-sales-service', label: 'SAP Sales & Service Cloud Consultant' },
      { value: 'cx-commerce', label: 'SAP Commerce Cloud Consultant' },
      { value: 'cx-cdc', label: 'SAP Customer Data Cloud Consultant' }
    ]
  },
  {
    category: 'Technical Roles',
    roles: [
      { value: 'abap-developer', label: 'ABAP Developer' },
      { value: 'abap-cloud-developer', label: 'ABAP Cloud / RAP Developer' },
      { value: 'fiori-developer', label: 'Fiori / UI5 Developer' },
      { value: 'btp-developer', label: 'BTP / CAP Developer' },
      { value: 'integration-consultant', label: 'Integration Consultant (Integration Suite / PI-PO)' },
      { value: 'basis-admin', label: 'Basis Administrator' },
      { value: 'hana-specialist', label: 'HANA Database Specialist' },
      { value: 'security-grc', label: 'SAP Security & GRC Consultant' },
      { value: 'data-migration', label: 'Data Migration Specialist' },
      { value: 'bw-analytics', label: 'BW/4HANA & Datasphere Consultant' },
      { value: 'sac-consultant', label: 'Analytics Cloud (SAC) Consultant' },
      { value: 'qa-engineer', label: 'SAP Test & QA Engineer' }
    ]
  },
  {
    category: 'AI & Automation',
    roles: [
      { value: 'joule-ai', label: 'Joule / SAP AI Consultant' },
      { value: 'process-automation', label: 'Build Process Automation Consultant' },
      { value: 'signavio', label: 'Signavio Process Consultant' }
    ]
  },
  {
    category: 'Architecture & Leadership',
    roles: [
      { value: 'solution-architect', label: 'SAP Solution Architect' },
      { value: 'enterprise-architect', label: 'Enterprise Architect' },
      { value: 'technical-architect', label: 'Technical Architect' },
      { value: 'business-analyst', label: 'Business Process Analyst' }
    ]
  },
  {
    category: 'Program & Business',
    roles: [
      { value: 'project-manager', label: 'Project Manager (SAP Activate)' },
      { value: 'program-manager', label: 'Programme Manager' },
      { value: 'change-manager', label: 'Change Manager' },
      /*
       * Neither reference implementation has a training role. SAP delivery does: a
       * cutover without end-user enablement is the standard way an otherwise sound
       * S/4HANA go-live fails, and "SAP Training Lead" is a line item on real statements
       * of work. Added because the ecosystem has the role, not because the reference had
       * a slot to fill.
       */
      { value: 'training-lead', label: 'Training & Enablement Lead' },
      { value: 'pmo', label: 'PMO' },
      { value: 'business-developer', label: 'Business Developer' }
    ]
  },
  {
    category: 'HR & Recruitment',
    roles: [
      { value: 'hr-manager', label: 'HR Manager' },
      { value: 'recruiter', label: 'Recruiter' }
    ]
  }
];

const ALL_ROLES = ROLE_CATEGORIES.flatMap((c) => c.roles);
const ROLE_SLUGS = ALL_ROLES.map((r) => r.value);
const ROLE_LABELS = new Map(ALL_ROLES.map((r) => [r.value, r.label]));

/**
 * Curated editorial base day rates (EUR) per role slug.
 *
 * Every slug in ROLE_SLUGS must appear here. `assertTaxonomyIntegrity()` enforces that at
 * boot: in DynamicsHub a missing slug fell back silently to a flat default, which quietly
 * flattened whole rate buckets.
 *
 * These are EDITORIAL BASELINES for an empty index, not measurements. They are the figure
 * shown before enough people have contributed a real one, and the rate index replaces them
 * with contributed figures the moment it has three. They sit higher than the Salesforce Hub
 * equivalents across the board because the SAP contract market prices higher, and the gap
 * is widest at the architecture end.
 */
const BASE_DAY_RATES = {
  's4-fi': 850,
  's4-co': 850,
  's4-rar': 950,
  'group-reporting': 950,
  treasury: 1000,
  's4-mm': 800,
  's4-sd': 800,
  's4-pp': 850,
  's4-ewm': 950,
  's4-qm': 800,
  's4-pm': 800,
  's4-tm': 900,
  's4-ps': 800,
  'sf-employee-central': 800,
  'sf-recruiting': 750,
  'sf-performance': 750,
  'sf-compensation': 800,
  'sf-learning': 720,
  'hcm-payroll': 850,
  ariba: 850,
  concur: 700,
  fieldglass: 750,
  ibp: 1000,
  'cx-sales-service': 750,
  'cx-commerce': 850,
  'cx-cdc': 800,
  'abap-developer': 700,
  'abap-cloud-developer': 800,
  'fiori-developer': 750,
  'btp-developer': 850,
  'integration-consultant': 850,
  'basis-admin': 800,
  'hana-specialist': 900,
  'security-grc': 900,
  'data-migration': 750,
  'bw-analytics': 800,
  'sac-consultant': 800,
  'qa-engineer': 600,
  'joule-ai': 950,
  'process-automation': 750,
  signavio: 900,
  'solution-architect': 1150,
  'enterprise-architect': 1250,
  'technical-architect': 1100,
  'business-analyst': 700,
  'project-manager': 850,
  'program-manager': 1050,
  'change-manager': 750,
  'training-lead': 650,
  pmo: 600,
  'business-developer': 650,
  'hr-manager': 550,
  recruiter: 500
};

/**
 * Aliases used by the matcher, so a job asking for "MM" still scores against a consultant
 * whose primary role is `s4-mm`.
 *
 * The module codes carry most of the weight here and that is the SAP-specific part: a role
 * catalogue for this ecosystem that cannot match the string "FI/CO" is a catalogue that
 * cannot read its own job board. Legacy names are aliases too — an advert saying "WM" or
 * "APO" or "Hybris" is describing work somebody with the modern skill can do, and refusing
 * to match it only hides the job.
 *
 * A missing alias does not break anything loudly; it just makes matches score low. Which is
 * why the integrity assertion also checks that every alias target is a real slug.
 */
const ROLE_ALIASES = {
  's4-fi': ['fi', 'fico', 'fi/co', 'financial accounting', 'general ledger', 'accounts payable', 'asset accounting'],
  's4-co': ['co', 'fico', 'controlling', 'management accounting', 'product costing', 'copa'],
  's4-rar': ['rar', 'revenue accounting', 'ifrs 15', 'revenue recognition'],
  'group-reporting': ['consolidation', 'group reporting', 'bpc', 'bcs'],
  treasury: ['trm', 'treasury', 'cash management', 'in-house cash'],
  's4-mm': ['mm', 'materials management', 'procurement', 'purchasing', 'sourcing', 'inventory management'],
  's4-sd': ['sd', 'sales and distribution', 'order to cash', 'otc', 'pricing', 'billing'],
  's4-pp': ['pp', 'production planning', 'ppds', 'manufacturing', 'mrp', 'discrete manufacturing'],
  's4-ewm': ['ewm', 'wm', 'warehouse management', 'extended warehouse', 'logistics execution'],
  's4-qm': ['qm', 'quality management', 'inspection'],
  's4-pm': ['pm', 'eam', 'plant maintenance', 'asset management', 'maintenance'],
  's4-tm': ['tm', 'transportation management', 'le-tra', 'freight'],
  's4-ps': ['ps', 'project system', 'wbs', 'project accounting'],
  'sf-employee-central': ['employee central', 'ec', 'successfactors', 'core hr', 'mdf'],
  'sf-recruiting': ['rcm', 'recruiting management', 'onboarding', 'rmk'],
  'sf-performance': ['pmgm', 'performance and goals', 'calibration', 'succession'],
  'sf-compensation': ['compensation', 'variable pay', 'comp'],
  'sf-learning': ['lms', 'learning management', 'sf learning'],
  'hcm-payroll': ['payroll', 'pa', 'pt', 'py', 'personnel administration', 'time management', 'ecp', 'employee central payroll'],
  ariba: ['ariba', 'sourcing', 'ariba network', 'p2p', 'guided buying', 'slp'],
  concur: ['concur', 'expense', 'travel and expense', 'invoice management'],
  fieldglass: ['fieldglass', 'vms', 'contingent workforce', 'external workforce'],
  ibp: ['ibp', 'apo', 'integrated business planning', 'demand planning', 's&op', 'supply planning'],
  'cx-sales-service': ['c4c', 'cloud for customer', 'sap sales cloud', 'sap service cloud'],
  'cx-commerce': ['hybris', 'commerce cloud', 'sap commerce', 'spartacus', 'composable storefront'],
  'cx-cdc': ['gigya', 'customer data cloud', 'cdc', 'cdp', 'customer data platform'],
  'abap-developer': ['abap', 'abap oo', 'smartforms', 'adobe forms', 'badi', 'user exit', 'idoc'],
  'abap-cloud-developer': ['rap', 'abap cloud', 'restful application programming', 'cds views', 'steampunk'],
  'fiori-developer': ['fiori', 'ui5', 'sapui5', 'fiori elements', 'odata'],
  'btp-developer': ['btp', 'cap', 'cloud application programming', 'kyma', 'cloud foundry', 'node.js on btp'],
  'integration-consultant': ['cpi', 'pi', 'po', 'pi/po', 'integration suite', 'api management', 'event mesh', 'middleware'],
  'basis-admin': ['basis', 'netweaver', 'system administration', 'transport management', 'solution manager', 'cloud alm'],
  'hana-specialist': ['hana', 'hana db', 'hana modelling', 'calculation views'],
  'security-grc': ['grc', 'sap security', 'authorizations', 'roles and authorizations', 'ecs', 'access control', 'ias', 'ips'],
  'data-migration': ['migration cockpit', 'ltmc', 'ltmom', 'lsmw', 'data migration', 'etl', 'bods', 'data services'],
  'bw-analytics': ['bw', 'bw/4hana', 'datasphere', 'data warehouse cloud', 'dwc', 'hana cloud'],
  'sac-consultant': ['sac', 'analytics cloud', 'sac planning', 'stories', 'dashboards'],
  'qa-engineer': ['test automation', 'tricentis', 'tosca', 'cbta', 'qa', 'uat'],
  'joule-ai': ['joule', 'sap ai core', 'ai foundation', 'generative ai hub', 'business ai'],
  'process-automation': ['spa', 'build process automation', 'irpa', 'workflow', 'rpa'],
  signavio: ['signavio', 'process mining', 'process intelligence', 'lean ix'],
  'solution-architect': ['solution architect', 'lead consultant', 'lead architect'],
  'enterprise-architect': ['enterprise architect', 'ea', 'sap eaf', 'north star'],
  'technical-architect': ['technical architect', 'platform architect', 'landscape architect'],
  'business-analyst': ['business analyst', 'process lead', 'functional analyst', 'requirements'],
  'project-manager': ['project manager', 'sap activate', 'pm', 'delivery manager'],
  'program-manager': ['programme manager', 'program manager', 'transformation lead'],
  'change-manager': ['change management', 'ocm', 'organisational change'],
  'training-lead': ['training', 'enablement', 'end user training', 'sap enable now'],
  pmo: ['pmo', 'project office', 'project coordinator'],
  'business-developer': ['business development', 'sales', 'account executive'],
  'hr-manager': ['hr manager', 'people manager', 'talent manager'],
  recruiter: ['recruiter', 'talent acquisition', 'resourcing']
};

/**
 * `pm` is the SAP module code for Plant Maintenance AND the everyday abbreviation for
 * Project Manager. `fico` belongs to two roles by design. An alias string is therefore
 * allowed to appear under more than one slug — the matcher scores every role the string
 * hits rather than resolving to one — and this set is the explicit record of which
 * collisions are intended, so the integrity check can flag any OTHER duplicate as the
 * copy-paste slip it almost certainly is.
 */
/**
 * Seniority bands and the multiplier applied to a base day rate.
 *
 * The bands are wider than the reference's, and the reason is the ecosystem: an SAP
 * practice does not call somebody senior at six years, because a single S/4HANA
 * programme runs two to four. The multipliers are flatter for the same reason — the
 * spread between a competent mid-level FI consultant and a senior one is narrower in a
 * market where the scarce thing is module depth rather than raw years.
 */
const SENIORITY_LEVELS = [
  { value: 'junior', label: 'Junior (0-3 yrs)', multiplier: 0.7 },
  { value: 'mid', label: 'Mid (4-7 yrs)', multiplier: 0.88 },
  { value: 'senior', label: 'Senior (8-14 yrs)', multiplier: 1.0 },
  { value: 'lead', label: 'Lead / Principal (15+ yrs)', multiplier: 1.2 }
];

const SENIORITY_MULTIPLIERS = new Map(SENIORITY_LEVELS.map((s) => [s.value, s.multiplier]));

const INTENDED_ALIAS_COLLISIONS = new Set(['fico', 'pm', 'sourcing', 'billing', 'cdp', 'etl', 'sales']);

/**
 * Asserted at boot by `scripts/validate-boot.js` and by `server.js`. Every failure mode
 * here is one that degrades silently rather than crashing, which is exactly why it is
 * checked loudly at the one moment somebody is watching.
 */
function assertTaxonomyIntegrity() {
  const problems = [];

  const seen = new Set();
  for (const slug of ROLE_SLUGS) {
    if (seen.has(slug)) problems.push(`duplicate role slug: ${slug}`);
    seen.add(slug);
    if (!/^[a-z0-9-]+$/.test(slug)) problems.push(`role slug is not url-safe: ${slug}`);
  }

  for (const slug of ROLE_SLUGS) {
    if (!Object.prototype.hasOwnProperty.call(BASE_DAY_RATES, slug)) {
      problems.push(`role ${slug} has no base day rate`);
    }
  }
  for (const slug of Object.keys(BASE_DAY_RATES)) {
    if (!seen.has(slug)) problems.push(`base day rate for unknown role: ${slug}`);
    const rate = BASE_DAY_RATES[slug];
    if (!Number.isInteger(rate) || rate <= 0) {
      problems.push(`base day rate for ${slug} is not a positive integer: ${rate}`);
    }
  }

  for (const level of SENIORITY_LEVELS) {
    if (!(level.multiplier > 0)) problems.push(`seniority ${level.value} has a bad multiplier`);
  }
  if (!SENIORITY_LEVELS.some((l) => l.multiplier === 1)) {
    problems.push('no seniority band has a multiplier of 1 — the base day rates then describe nobody');
  }

  const aliasOwners = new Map();
  for (const [slug, aliases] of Object.entries(ROLE_ALIASES)) {
    if (!seen.has(slug)) problems.push(`aliases declared for unknown role: ${slug}`);
    for (const alias of aliases) {
      if (alias !== alias.toLowerCase().trim()) {
        problems.push(`alias "${alias}" (${slug}) is not lower-cased and trimmed`);
      }
      const owners = aliasOwners.get(alias) || [];
      owners.push(slug);
      aliasOwners.set(alias, owners);
    }
  }
  for (const [alias, owners] of aliasOwners) {
    if (owners.length > 1 && !INTENDED_ALIAS_COLLISIONS.has(alias)) {
      problems.push(`alias "${alias}" is claimed by ${owners.join(', ')} — add it to INTENDED_ALIAS_COLLISIONS or rename it`);
    }
  }

  if (problems.length) {
    throw new Error(`Role taxonomy is inconsistent:\n  - ${problems.join('\n  - ')}`);
  }
  return true;
}

function roleLabel(slug) {
  return ROLE_LABELS.get(slug) || null;
}

function isRole(slug) {
  return ROLE_LABELS.has(slug);
}

function baseDayRate(slug) {
  return Object.prototype.hasOwnProperty.call(BASE_DAY_RATES, slug) ? BASE_DAY_RATES[slug] : null;
}

module.exports = {
  ROLE_CATEGORIES,
  ALL_ROLES,
  ROLE_SLUGS,
  ROLE_LABELS,
  BASE_DAY_RATES,
  ROLE_ALIASES,
  INTENDED_ALIAS_COLLISIONS,
  SENIORITY_LEVELS,
  SENIORITY_MULTIPLIERS,
  assertTaxonomyIntegrity,
  roleLabel,
  isRole,
  baseDayRate
};
