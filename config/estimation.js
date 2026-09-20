'use strict';

const { ACTIVATE_PHASES } = require('./activatePhases');

/**
 * Estimation catalogues and multipliers.
 *
 * The MODULE catalogue is NOT here — it lives in `config/sapProducts.js`, which is the
 * single source for product lines, modules and their cross-module dependencies. This file
 * holds only the things that multiply or distribute that effort.
 *
 * Every number below is editorial: a published starting point, not a measurement. They are
 * gathered in one place precisely so they can be argued with and adjusted, rather than
 * being scattered as magic constants through the calculation.
 *
 * THREE THINGS HERE HAVE NO COUNTERPART IN EITHER REFERENCE, and they are the reason this
 * is a port rather than a relabelling:
 *
 *   1. `TRANSITION_APPROACHES` — greenfield, brownfield or selective. It is the first
 *      question asked on any real S/4HANA programme and it moves the number more than
 *      anything else in this file. A CRM estimator has no equivalent because a CRM
 *      implementation has no existing ECC landscape to convert.
 *   2. `CLEAN_CORE_LEVELS` replaces the reference's "customisation level". SAP's own
 *      governing concept, and the axis is not "how much custom code" but "how much of it
 *      sits INSIDE the core" — which is what decides whether the next upgrade is a
 *      weekend or a project.
 *   3. The phases are SAP Activate's, shared with the job board and the delivery history
 *      from `config/activatePhases.js`, so a quote, an advert and a CV all mean the same
 *      thing by "realize".
 *
 * And one structural change that follows from the third: TRAINING IS A WORKSTREAM, NOT A
 * PHASE. The reference has a training phase it can switch off. SAP Activate has no such
 * phase — enablement runs across explore, realize and deploy — so training lives in the
 * resource allocation, and excluding it removes a role from the team rather than a block
 * from the timeline.
 */

/**
 * Add-on products that carry integration effort of their own.
 * The SAP equivalent of the reference's AppExchange list.
 */
const ADDON_SOLUTIONS = {
  'addon-vertex': { name: 'Vertex Tax Engine', days: 25, category: 'Tax' },
  'addon-avalara': { name: 'Avalara Tax Automation', days: 20, category: 'Tax' },
  'addon-opentext-vim': { name: 'OpenText VIM (Vendor Invoice Management)', days: 45, category: 'Documents' },
  'addon-opentext-archive': { name: 'OpenText Archiving', days: 25, category: 'Documents' },
  'addon-vistex': { name: 'Vistex (pricing, rebates, incentives)', days: 60, category: 'Pricing' },
  'addon-blackline': { name: 'BlackLine Financial Close', days: 35, category: 'Finance' },
  'addon-esker': { name: 'Esker / Serrala AR-AP Automation', days: 30, category: 'Finance' },
  'addon-nakisa': { name: 'Nakisa Lease Administration', days: 30, category: 'Finance' },
  'addon-syniti': { name: 'Syniti / SNP Data Migration Suite', days: 40, category: 'Data' },
  'addon-winshuttle': { name: 'Winshuttle / Precisely Automate', days: 20, category: 'Data' },
  'addon-tricentis': { name: 'Tricentis Tosca Test Automation', days: 35, category: 'Testing' },
  'addon-celonis': { name: 'Celonis Process Mining', days: 30, category: 'Analytics' },
  'addon-redwood': { name: 'Redwood / Automic Job Scheduling', days: 20, category: 'Operations' },
  'addon-edi': { name: 'EDI / B2B Integration Suite', days: 45, category: 'Integration' },
  'addon-other': { name: 'Other third-party add-on', days: 20, category: 'Other' }
};

/**
 * How the customer gets to S/4HANA. The single biggest lever on an SAP estimate, and the
 * question every real programme answers before any other.
 *
 * Greenfield is the baseline at 1.0 because it is the cleanest: a new implementation, no
 * legacy configuration to untangle. Brownfield looks cheaper — "we are just converting the
 * system" — and is not: the work moves from designing processes to reconciling twenty
 * years of accumulated configuration, custom code and data against what S/4HANA will
 * accept. Selective transition carries both kinds of work at once, which is why it is the
 * most expensive of the three rather than a compromise between them.
 */
const TRANSITION_APPROACHES = {
  greenfield: {
    name: 'Greenfield (new implementation)',
    multiplier: 1.0,
    description: 'A new build on standard processes. No legacy configuration to reconcile.'
  },
  brownfield: {
    name: 'Brownfield (system conversion)',
    multiplier: 1.15,
    description:
      'Converting an existing ECC system in place. Less process design, far more remediation: '
      + 'custom code, simplification items and data readiness.'
  },
  selective: {
    name: 'Selective data transition',
    multiplier: 1.45,
    description:
      'A new system carrying chosen history and configuration across. Both the design work of '
      + 'a greenfield and the reconciliation of a conversion.'
  }
};

/**
 * How much of the customisation sits inside the core.
 *
 * Replaces the reference's "customisation level", and the axis is different on purpose.
 * The reference asks how much custom code there is; this asks WHERE it lives. Key-user
 * extensions and side-by-side BTP apps survive an upgrade. Classic modifications to SAP's
 * own objects do not — they are re-tested and often re-written every time, which is a cost
 * that lands after go-live rather than during the build, and it is the single thing an
 * estimate is most often silently optimistic about.
 */
const CLEAN_CORE_LEVELS = {
  clean: {
    name: 'Clean core',
    multiplier: 0.9,
    description: 'Standard processes with key-user extensibility only. Nothing modifies SAP objects.'
  },
  moderate: {
    name: 'Mostly clean',
    multiplier: 1.0,
    description: 'Standard where possible, with side-by-side extensions on BTP and released APIs.'
  },
  heavy: {
    name: 'In-core development',
    multiplier: 1.35,
    description:
      'Classic ABAP development against SAP objects. Faster to write and re-tested at every '
      + 'upgrade — the cost is real and arrives later.'
  }
};

const COMPLEXITY_MULTIPLIERS = {
  simple: { multiplier: 0.8, description: 'One country, one company code, close to standard' },
  moderate: { multiplier: 1.0, description: 'Several company codes, some interfaces and local requirements' },
  complex: { multiplier: 1.4, description: 'Multi-country rollout, significant interfacing, statutory variety' },
  enterprise: { multiplier: 1.8, description: 'Global template plus local rollouts, multi-system landscape' }
};

/**
 * Industry weighting. These reflect regulatory, statutory and approval burden, not how
 * hard the technology is.
 */
const INDUSTRY_MULTIPLIERS = {
  Technology: { multiplier: 0.95, description: 'Tech-literate users, fewer statutory variations' },
  'Professional Services': { multiplier: 0.95, description: 'Service-focused, simpler logistics' },
  Manufacturing: { multiplier: 1.05, description: 'Production, costing and shop-floor integration' },
  Retail: { multiplier: 1.05, description: 'High volumes, many outlets, promotions' },
  Distribution: { multiplier: 1.1, description: 'Complex logistics, warehousing and fulfilment' },
  'Oil & Gas / Utilities': { multiplier: 1.2, description: 'Industry solutions and regulated reporting' },
  Education: { multiplier: 1.1, description: 'Many stakeholder groups, unusual workflows' },
  Healthcare: { multiplier: 1.2, description: 'Patient data handling and clinical sign-off' },
  'Financial Services': { multiplier: 1.25, description: 'Heavy compliance, audit and approval burden' },
  'Public Sector': { multiplier: 1.3, description: 'Procurement, accreditation and audit requirements' },
  Other: { multiplier: 1.0, description: 'Standard implementation' }
};

const COMPANY_SIZE_MULTIPLIERS = {
  'Small (1-50)': { multiplier: 0.85, userEstimate: 25, description: 'Single entity, fast decisions' },
  'Medium (51-500)': { multiplier: 1.0, userEstimate: 150, description: 'Standard deployment' },
  'Large (501-5000)': { multiplier: 1.2, userEstimate: 1500, description: 'Several entities, real governance' },
  'Enterprise (5000+)': { multiplier: 1.45, userEstimate: 5000, description: 'Global rollout, heavy change management' }
};

/**
 * Phase percentages, over SAP Activate's phases.
 *
 * They must sum to 100; `assertEstimationIntegrity()` checks it at boot, because a table
 * that quietly sums to 98 shifts every estimate.
 *
 * The shape is not the reference's, and the difference is where the weight sits. A CRM
 * estimator spends 35% in build; an SAP programme spends its weight in EXPLORE — the fit
 * to standard, the gap list and the design decisions that come out of it — and then in
 * realize. Deploy is heavier too, because an ERP cutover is a rehearsed event with a
 * business downtime window, not a package promotion.
 */
const PHASE_DISTRIBUTION = {
  discover: {
    name: 'Discover',
    percentage: 5,
    description: 'Current landscape, readiness check, transition approach, business case'
  },
  prepare: {
    name: 'Prepare',
    percentage: 10,
    description: 'Project setup, governance, system provisioning, team onboarding'
  },
  explore: {
    name: 'Explore',
    percentage: 25,
    description: 'Fit-to-standard workshops, delta design, gap list, data and integration scoping'
  },
  realize: {
    name: 'Realize',
    percentage: 35,
    description: 'Configuration, extensions, integrations, data migration cycles, testing'
  },
  deploy: {
    name: 'Deploy',
    percentage: 15,
    description: 'Cutover rehearsals, business downtime, go-live, production support handover'
  },
  run: {
    name: 'Run (hypercare)',
    percentage: 10,
    description: 'Post-go-live support, defect triage, period-end close, optimisation'
  }
};

/**
 * Default team shape and day rates.
 *
 * Percentages must sum to 100 for the same reason the phases must — the apportionment
 * distributes the project's consultant-days across these roles, and the result has to
 * reconcile with the phase total and the headline number.
 *
 * `training-lead` is here rather than in the phases. Excluding training removes this role
 * and its days are redistributed across the rest; the timeline does not change, because
 * enablement was never a block of calendar of its own.
 *
 * `rate` is editorial and matches `BASE_DAY_RATES` in `config/roleTaxonomy.js` for the
 * same role where one exists — two tables of day rates that disagree is a quote that
 * contradicts the rate index on the same site.
 */
const DEFAULT_RESOURCE_ALLOCATION = {
  'solution-architect': { name: 'Solution Architect', percentage: 10, rate: 1150, role: 'solution-architect' },
  'functional-consultant': { name: 'Functional Consultant', percentage: 30, rate: 850, role: 's4-fi' },
  'technical-consultant': { name: 'ABAP / Extension Developer', percentage: 18, rate: 800, role: 'abap-cloud-developer' },
  'integration-consultant': { name: 'Integration Consultant', percentage: 10, rate: 850, role: 'integration-consultant' },
  'data-migration': { name: 'Data Migration Specialist', percentage: 8, rate: 750, role: 'data-migration' },
  'basis-admin': { name: 'Basis / Platform', percentage: 6, rate: 800, role: 'basis-admin' },
  'qa-engineer': { name: 'Test Lead', percentage: 6, rate: 600, role: 'qa-engineer' },
  'project-manager': { name: 'Project Manager', percentage: 8, rate: 850, role: 'project-manager' },
  'training-lead': { name: 'Training & Enablement Lead', percentage: 4, rate: 650, role: 'training-lead' }
};

/** The resource whose days are removed when training is excluded. */
const TRAINING_RESOURCE_ID = 'training-lead';

/** Days added per integration, by how involved the integration is. */
const INTEGRATION_DAYS = { simple: 20, medium: 30, complex: 45 };

/** Effort assumed for each free-text item the client lists but we cannot map. */
const UNMAPPED_ITEM_DAYS = { module: 25, addon: 20 };

/** Phase-completion milestones surfaced on the timeline. SAP Activate's own quality gates. */
const PHASE_MILESTONES = {
  discover: 'Readiness assessed, approach chosen',
  prepare: 'Project start quality gate',
  explore: 'Fit-to-standard complete, backlog signed off',
  realize: 'Integration test and UAT sign-off',
  deploy: 'Go-live',
  run: 'Transition to support'
};

/**
 * Fail the boot rather than ship a silently wrong estimate.
 * Returns a list of problems; empty means consistent.
 */
function estimationProblems() {
  const problems = [];

  const phaseTotal = Object.values(PHASE_DISTRIBUTION).reduce((sum, p) => sum + p.percentage, 0);
  if (phaseTotal !== 100) problems.push(`PHASE_DISTRIBUTION sums to ${phaseTotal}, not 100`);

  const resourceTotal = Object.values(DEFAULT_RESOURCE_ALLOCATION).reduce((sum, r) => sum + r.percentage, 0);
  if (resourceTotal !== 100) problems.push(`DEFAULT_RESOURCE_ALLOCATION sums to ${resourceTotal}, not 100`);

  /*
   * The phases ARE SAP Activate's, in order. Not "similar to": the job board stores one of
   * these on every advert and the delivery history stores one on every engagement, so a
   * phase that exists in the estimator and nowhere else would mean a quote and a CV using
   * the same word for different things.
   */
  const declared = Object.keys(PHASE_DISTRIBUTION);
  if (declared.join(',') !== ACTIVATE_PHASES.join(',')) {
    problems.push(
      `PHASE_DISTRIBUTION is [${declared.join(', ')}] but the SAP Activate phases are `
        + `[${ACTIVATE_PHASES.join(', ')}] — they must match, in order`
    );
  }

  for (const [id, phase] of Object.entries(PHASE_DISTRIBUTION)) {
    if (!PHASE_MILESTONES[id]) problems.push(`phase "${id}" has no milestone`);
    if (!phase.name || !phase.description) problems.push(`phase "${id}" is missing a name or description`);
  }

  for (const [id, resource] of Object.entries(DEFAULT_RESOURCE_ALLOCATION)) {
    if (!(resource.rate > 0)) problems.push(`resource "${id}" has no positive day rate`);
    if (!resource.role) problems.push(`resource "${id}" names no taxonomy role`);
  }

  if (!DEFAULT_RESOURCE_ALLOCATION[TRAINING_RESOURCE_ID]) {
    problems.push(`TRAINING_RESOURCE_ID "${TRAINING_RESOURCE_ID}" is not a declared resource`);
  }

  for (const [id, approach] of Object.entries(TRANSITION_APPROACHES)) {
    if (!(approach.multiplier > 0)) problems.push(`transition approach "${id}" has a bad multiplier`);
  }
  if (TRANSITION_APPROACHES.greenfield.multiplier !== 1.0) {
    problems.push('greenfield is the baseline and must have a multiplier of exactly 1.0');
  }

  return problems;
}

function assertEstimationIntegrity() {
  const problems = estimationProblems();
  if (problems.length) {
    throw new Error(`Estimation configuration is inconsistent:\n  - ${problems.join('\n  - ')}`);
  }
  return true;
}

/**
 * A fingerprint of every number that can move an estimate.
 *
 * Stored alongside each saved quote so a quote produced under an older catalogue can be
 * identified as stale rather than silently compared against today's figures. It is derived
 * rather than hand-maintained, because a version anyone has to remember to bump is a
 * version that is wrong.
 */
function catalogueVersion() {
  const crypto = require('crypto');
  const { ALL_MODULES, PRODUCT_LINES, CROSS_MODULE_INTEGRATION_SHARE } = require('./sapProducts');

  const material = JSON.stringify({
    modules: ALL_MODULES.map((m) => [m.value, m.baseEffortDays, m.crossModule]),
    foundations: PRODUCT_LINES.map((l) => [l.value, l.foundationEffortDays]),
    CROSS_MODULE_INTEGRATION_SHARE,
    ADDON_SOLUTIONS,
    TRANSITION_APPROACHES,
    CLEAN_CORE_LEVELS,
    COMPLEXITY_MULTIPLIERS,
    INDUSTRY_MULTIPLIERS,
    COMPANY_SIZE_MULTIPLIERS,
    PHASE_DISTRIBUTION,
    DEFAULT_RESOURCE_ALLOCATION,
    INTEGRATION_DAYS,
    UNMAPPED_ITEM_DAYS
  });

  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 12);
}

module.exports = {
  ADDON_SOLUTIONS,
  TRANSITION_APPROACHES,
  CLEAN_CORE_LEVELS,
  COMPLEXITY_MULTIPLIERS,
  INDUSTRY_MULTIPLIERS,
  COMPANY_SIZE_MULTIPLIERS,
  PHASE_DISTRIBUTION,
  DEFAULT_RESOURCE_ALLOCATION,
  TRAINING_RESOURCE_ID,
  INTEGRATION_DAYS,
  UNMAPPED_ITEM_DAYS,
  PHASE_MILESTONES,
  estimationProblems,
  assertEstimationIntegrity,
  catalogueVersion
};
