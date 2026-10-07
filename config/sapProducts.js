'use strict';

/**
 * SAP product lines and their modules.
 *
 * The SAP equivalent of DynamicsHub's product/module tree and Salesforce Hub's cloud
 * families. Used by the job posting form (required skills context), the consultant profile
 * builder, the scope estimator and the community category tree.
 *
 * `baseEffortDays` is the editorial baseline the estimator starts from: the number of
 * consultant-days a greenfield implementation of that module typically takes before
 * complexity, integration and data-migration multipliers are applied. `foundationEffortDays`
 * is what the product line costs before any module — the configuration nobody itemises but
 * everybody pays for.
 *
 * Two things here are deliberately unlike the reference implementations, and both come from
 * SAP projects being shaped differently from CRM projects:
 *
 * 1. **The numbers are much larger.** A Salesforce Sales Cloud rollout baselines at 12 days
 *    of foundation; an S/4HANA finance core baselines at 60. Porting the reference's figures
 *    and relabelling them would have produced an estimator that quotes an ERP programme at a
 *    CRM price — the single most expensive thing this catalogue could get wrong.
 *
 * 2. **`crossModule` exists.** SAP modules are not independent: configuring SD without MM is
 *    not a smaller project, it is an integration problem. A module listing another in
 *    `crossModule` tells the estimator that selecting only one of the pair leaves integration
 *    work that has to be done anyway, and the estimator adds it rather than pretending the
 *    boundary is free. Neither reference has this, because neither ecosystem needs it.
 */
const PRODUCT_LINES = [
  {
    value: 's4hana-finance',
    label: 'SAP S/4HANA Finance',
    foundationEffortDays: 60,
    modules: [
      { value: 'fi-gl', label: 'General Ledger (FI-GL)', baseEffortDays: 45, crossModule: [] },
      { value: 'fi-ap', label: 'Accounts Payable (FI-AP)', baseEffortDays: 25, crossModule: ['mm-purchasing'] },
      { value: 'fi-ar', label: 'Accounts Receivable (FI-AR)', baseEffortDays: 25, crossModule: ['sd-billing'] },
      { value: 'fi-aa', label: 'Asset Accounting (FI-AA)', baseEffortDays: 30, crossModule: [] },
      { value: 'co-cca', label: 'Cost Centre Accounting (CO-CCA)', baseEffortDays: 25, crossModule: ['fi-gl'] },
      { value: 'co-pc', label: 'Product Cost Controlling (CO-PC)', baseEffortDays: 45, crossModule: ['pp-discrete'] },
      { value: 'co-pa', label: 'Profitability Analysis (CO-PA)', baseEffortDays: 40, crossModule: ['sd-billing'] },
      { value: 'fi-rar', label: 'Revenue Accounting (RAR / IFRS 15)', baseEffortDays: 55, crossModule: ['sd-billing'] },
      { value: 'group-reporting', label: 'Group Reporting & Consolidation', baseEffortDays: 60, crossModule: ['fi-gl'] },
      { value: 'treasury', label: 'Treasury & Risk Management (TRM)', baseEffortDays: 55, crossModule: ['fi-gl'] },
      { value: 'mdg', label: 'Master Data Governance (MDG)', baseEffortDays: 50, crossModule: [] },
      { value: 'central-finance', label: 'Central Finance (CFIN)', baseEffortDays: 70, crossModule: ['fi-gl'] },
      { value: 'fi-ca', label: 'Contract Accounting (FI-CA)', baseEffortDays: 55, crossModule: ['fi-ar'] },
      { value: 'brim', label: 'BRIM — Subscription Billing & Convergent Invoicing', baseEffortDays: 80, crossModule: ['fi-ca'] },
      { value: 'drc', label: 'Document & Reporting Compliance (DRC / e-invoicing)', baseEffortDays: 30, crossModule: ['fi-ar'] },
      { value: 'bpc', label: 'Business Planning & Consolidation (BPC)', baseEffortDays: 50, crossModule: ['fi-gl'] }
    ]
  },
  {
    value: 's4hana-supply-chain',
    label: 'SAP S/4HANA Supply Chain & Manufacturing',
    foundationEffortDays: 55,
    modules: [
      { value: 'mm-purchasing', label: 'Sourcing & Procurement (MM)', baseEffortDays: 45, crossModule: ['fi-ap'] },
      { value: 'mm-inventory', label: 'Inventory Management (MM-IM)', baseEffortDays: 30, crossModule: ['mm-purchasing'] },
      { value: 'sd-sales', label: 'Sales (SD)', baseEffortDays: 45, crossModule: ['mm-inventory'] },
      { value: 'sd-billing', label: 'Billing & Pricing (SD-BIL)', baseEffortDays: 35, crossModule: ['fi-ar'] },
      { value: 'pp-discrete', label: 'Production Planning — Discrete (PP)', baseEffortDays: 55, crossModule: ['mm-inventory'] },
      { value: 'pp-process', label: 'Production Planning — Process (PP-PI)', baseEffortDays: 60, crossModule: ['mm-inventory'] },
      { value: 'ewm', label: 'Extended Warehouse Management (EWM)', baseEffortDays: 80, crossModule: ['mm-inventory'] },
      { value: 'qm', label: 'Quality Management (QM)', baseEffortDays: 35, crossModule: ['mm-purchasing'] },
      { value: 'pm-eam', label: 'Plant Maintenance / EAM', baseEffortDays: 45, crossModule: ['mm-inventory'] },
      { value: 'tm', label: 'Transportation Management (TM)', baseEffortDays: 65, crossModule: ['sd-sales'] },
      { value: 'ps', label: 'Project System (PS)', baseEffortDays: 40, crossModule: ['co-cca'] },
      { value: 'wm-classic', label: 'Warehouse Management — classic (WM)', baseEffortDays: 40, crossModule: ['mm-inventory'] },
      { value: 'aatp', label: 'Advanced Available-to-Promise (aATP)', baseEffortDays: 30, crossModule: ['sd-sales'] },
      { value: 'gts', label: 'Global Trade Services (GTS)', baseEffortDays: 45, crossModule: ['sd-sales'] },
      { value: 'ehs', label: 'Environment, Health & Safety (EHS)', baseEffortDays: 45, crossModule: [] },
      { value: 'plm-vc', label: 'PLM & Variant Configuration (VC / AVC)', baseEffortDays: 55, crossModule: ['sd-sales'] },
      { value: 'cs-service', label: 'Service Management (CS / S/4HANA Service)', baseEffortDays: 45, crossModule: ['sd-billing'] }
    ]
  },
  {
    value: 'successfactors',
    /*
     * "& HCM" because on-premise HCM — PA/OM, time, payroll — is still where a great deal
     * of SAP HR work is, and a line that only names the cloud product left a payroll
     * consultant with a role in the taxonomy and no module to record against it.
     */
    label: 'SAP SuccessFactors & HCM',
    foundationEffortDays: 30,
    modules: [
      { value: 'sf-ec', label: 'Employee Central', baseEffortDays: 55, crossModule: [] },
      { value: 'sf-rcm', label: 'Recruiting (RCM & RMK)', baseEffortDays: 35, crossModule: ['sf-ec'] },
      { value: 'sf-onb', label: 'Onboarding', baseEffortDays: 25, crossModule: ['sf-rcm'] },
      { value: 'sf-pmgm', label: 'Performance & Goals', baseEffortDays: 30, crossModule: ['sf-ec'] },
      { value: 'sf-comp', label: 'Compensation & Variable Pay', baseEffortDays: 35, crossModule: ['sf-ec'] },
      { value: 'sf-lms', label: 'Learning (LMS)', baseEffortDays: 35, crossModule: [] },
      { value: 'sf-ecp', label: 'Employee Central Payroll', baseEffortDays: 70, crossModule: ['sf-ec'] },
      { value: 'sf-tm', label: 'Time Tracking & Time Off', baseEffortDays: 30, crossModule: ['sf-ec'] },
      { value: 'sf-sd', label: 'Succession & Development', baseEffortDays: 30, crossModule: ['sf-pmgm'] },
      { value: 'sf-analytics', label: 'People Analytics & Workforce Planning', baseEffortDays: 25, crossModule: ['sf-ec'] },
      { value: 'hcm-pa-om', label: 'HCM Personnel Administration & Org Management (PA/OM)', baseEffortDays: 45, crossModule: [] },
      { value: 'hcm-pt', label: 'HCM Time Management (PT)', baseEffortDays: 35, crossModule: ['hcm-pa-om'] },
      { value: 'hcm-py', label: 'HCM Payroll (PY)', baseEffortDays: 70, crossModule: ['hcm-pa-om'] }
    ]
  },
  {
    value: 'spend-management',
    label: 'SAP Spend Management',
    foundationEffortDays: 25,
    modules: [
      { value: 'ariba-sourcing', label: 'Ariba Sourcing & Contracts', baseEffortDays: 40, crossModule: [] },
      { value: 'ariba-buying', label: 'Ariba Buying & Invoicing', baseEffortDays: 50, crossModule: ['mm-purchasing'] },
      { value: 'ariba-slp', label: 'Supplier Lifecycle & Performance', baseEffortDays: 30, crossModule: ['ariba-sourcing'] },
      { value: 'ariba-network', label: 'Ariba Network Enablement', baseEffortDays: 25, crossModule: ['ariba-buying'] },
      { value: 'concur-expense', label: 'Concur Expense', baseEffortDays: 30, crossModule: ['fi-ap'] },
      { value: 'concur-travel', label: 'Concur Travel', baseEffortDays: 25, crossModule: ['concur-expense'] },
      { value: 'concur-invoice', label: 'Concur Invoice', baseEffortDays: 25, crossModule: ['fi-ap'] },
      { value: 'fieldglass', label: 'Fieldglass External Workforce', baseEffortDays: 40, crossModule: [] }
    ]
  },
  {
    value: 'supply-chain-planning',
    label: 'SAP Supply Chain Planning',
    foundationEffortDays: 30,
    modules: [
      { value: 'ibp-demand', label: 'IBP for Demand', baseEffortDays: 45, crossModule: [] },
      { value: 'ibp-sop', label: 'IBP for Sales & Operations', baseEffortDays: 50, crossModule: ['ibp-demand'] },
      { value: 'ibp-response', label: 'IBP for Response & Supply', baseEffortDays: 60, crossModule: ['ibp-sop'] },
      { value: 'ibp-inventory', label: 'IBP for Inventory', baseEffortDays: 35, crossModule: ['ibp-demand'] }
    ]
  },
  {
    value: 'customer-experience',
    label: 'SAP Customer Experience',
    foundationEffortDays: 25,
    modules: [
      { value: 'cx-sales', label: 'SAP Sales Cloud', baseEffortDays: 35, crossModule: ['sd-sales'] },
      { value: 'cx-service', label: 'SAP Service Cloud', baseEffortDays: 40, crossModule: [] },
      { value: 'cx-commerce', label: 'SAP Commerce Cloud', baseEffortDays: 90, crossModule: ['sd-sales'] },
      { value: 'cx-cdc', label: 'SAP Customer Data Cloud', baseEffortDays: 30, crossModule: [] },
      { value: 'cx-emarsys', label: 'SAP Emarsys Marketing', baseEffortDays: 35, crossModule: ['cx-cdc'] }
    ]
  },
  {
    value: 'btp',
    label: 'SAP Business Technology Platform',
    foundationEffortDays: 25,
    modules: [
      { value: 'btp-integration', label: 'Integration Suite (CPI & API Management)', baseEffortDays: 45, crossModule: [] },
      { value: 'btp-cap', label: 'Extensions on CAP / ABAP Cloud', baseEffortDays: 50, crossModule: ['btp-integration'] },
      { value: 'btp-fiori', label: 'Fiori / UI5 Custom Applications', baseEffortDays: 35, crossModule: ['btp-cap'] },
      { value: 'btp-automation', label: 'Build Process Automation', baseEffortDays: 30, crossModule: [] },
      { value: 'btp-ai', label: 'AI Foundation & Joule Extensions', baseEffortDays: 40, crossModule: ['btp-integration'] },
      { value: 'btp-identity', label: 'Identity Authentication & Provisioning (IAS/IPS)', baseEffortDays: 20, crossModule: [] },
      { value: 'btp-build-workzone', label: 'SAP Build Apps & Work Zone', baseEffortDays: 25, crossModule: [] }
    ]
  },
  {
    value: 'analytics',
    label: 'SAP Data & Analytics',
    foundationEffortDays: 25,
    modules: [
      { value: 'sac-reporting', label: 'Analytics Cloud — Reporting', baseEffortDays: 35, crossModule: [] },
      { value: 'sac-planning', label: 'Analytics Cloud — Planning', baseEffortDays: 55, crossModule: ['sac-reporting'] },
      { value: 'datasphere', label: 'SAP Datasphere', baseEffortDays: 50, crossModule: ['sac-reporting'] },
      { value: 'bw4hana', label: 'BW/4HANA', baseEffortDays: 60, crossModule: [] },
      { value: 'signavio', label: 'Signavio Process Insights', baseEffortDays: 30, crossModule: [] },
      { value: 'signavio-suite', label: 'Signavio Process Manager & Process Intelligence', baseEffortDays: 35, crossModule: [] },
      { value: 'leanix', label: 'LeanIX Enterprise Architecture', baseEffortDays: 30, crossModule: [] },
      { value: 'business-data-cloud', label: 'SAP Business Data Cloud', baseEffortDays: 40, crossModule: ['datasphere'] }
    ]
  },
  {
    /*
     * The technical half of SAP work. Without it a Basis, ABAP or GRC consultant had a
     * role in the taxonomy and not a single module to record a delivery against — and the
     * delivery history is what the directory filters and the match score read.
     */
    value: 'technology',
    label: 'SAP Technology & Operations',
    foundationEffortDays: 25,
    modules: [
      { value: 'basis', label: 'Basis & NetWeaver Administration', baseEffortDays: 40, crossModule: [] },
      { value: 'abap-classic', label: 'ABAP Development (classic, RICEFW)', baseEffortDays: 50, crossModule: [] },
      { value: 'pi-po', label: 'Process Integration / Orchestration (PI/PO)', baseEffortDays: 45, crossModule: [] },
      { value: 'security-auth', label: 'Security & Authorisations', baseEffortDays: 35, crossModule: ['basis'] },
      { value: 'grc-ac', label: 'GRC Access Control', baseEffortDays: 40, crossModule: ['security-auth'] },
      { value: 'grc-pc', label: 'GRC Process Control', baseEffortDays: 40, crossModule: [] },
      { value: 'solman-calm', label: 'Solution Manager / Cloud ALM', baseEffortDays: 30, crossModule: ['basis'] },
      { value: 'migration-tools', label: 'Data Migration (Migration Cockpit / BODS)', baseEffortDays: 45, crossModule: [] },
      { value: 's4-conversion', label: 'S/4HANA System Conversion (SUM / DMO)', baseEffortDays: 90, crossModule: ['basis'] },
      { value: 'walkme', label: 'WalkMe Digital Adoption', baseEffortDays: 20, crossModule: [] }
    ]
  },
  {
    /*
     * Industry solutions are separate products with separate consultants: IS-U and IS-Oil
     * are not one "Oil & Gas / Utilities" skill, and an advert for either is unreadable to
     * somebody who has only done the other.
     */
    value: 'industry-solutions',
    label: 'SAP Industry Solutions',
    foundationEffortDays: 40,
    modules: [
      { value: 'is-u', label: 'IS-U / Utilities', baseEffortDays: 90, crossModule: ['fi-ca'] },
      { value: 'is-oil', label: 'IS-Oil (Oil & Gas)', baseEffortDays: 80, crossModule: ['sd-sales'] },
      { value: 'is-retail', label: 'IS-Retail / S/4HANA Retail', baseEffortDays: 70, crossModule: ['sd-sales'] },
      { value: 'is-auto', label: 'Automotive (VMS / JIT)', baseEffortDays: 60, crossModule: ['sd-sales'] },
      { value: 'psm-fm', label: 'Public Sector — Funds Management (PSM-FM)', baseEffortDays: 55, crossModule: ['fi-gl'] },
      { value: 'fs-banking', label: 'Banking (FS-CML / Transactional Banking)', baseEffortDays: 90, crossModule: [] },
      { value: 'fs-insurance', label: 'Insurance (FS-CD / FS-PM)', baseEffortDays: 90, crossModule: ['fi-ca'] }
    ]
  }
];

/**
 * OUT OF SCOPE, stated rather than left to be guessed: SAP Business One and SAP Business
 * ByDesign. They are SAP products, but they are sold and implemented by a different
 * partner channel to a different market, and their consultants rarely overlap with the
 * S/4HANA programmes this catalogue sizes. A line for them would be a line nothing else
 * on the site — estimator baselines, rate index, role taxonomy — could back up.
 */

const ALL_MODULES = PRODUCT_LINES.flatMap((line) =>
  line.modules.map((m) => ({ ...m, line: line.value, lineLabel: line.label }))
);
const MODULE_BY_VALUE = new Map(ALL_MODULES.map((m) => [m.value, m]));
const LINE_BY_VALUE = new Map(PRODUCT_LINES.map((l) => [l.value, l]));

/** The share of a cross-module dependency's effort that lands on you when you skip it. */
const CROSS_MODULE_INTEGRATION_SHARE = 0.2;

/**
 * Checked at boot. Every one of these mistakes moves an estimate silently rather than
 * failing, which is the whole argument for asserting them where somebody is watching.
 */
function assertCatalogueIntegrity() {
  const problems = [];
  const seen = new Set();

  for (const line of PRODUCT_LINES) {
    if (seen.has(line.value)) problems.push(`duplicate product line: ${line.value}`);
    seen.add(line.value);
    if (!Number.isInteger(line.foundationEffortDays) || line.foundationEffortDays <= 0) {
      problems.push(`product line ${line.value} has a bad foundationEffortDays`);
    }
    if (!line.modules.length) problems.push(`product line ${line.value} has no modules`);
  }

  for (const module of ALL_MODULES) {
    if (seen.has(module.value)) problems.push(`duplicate module value: ${module.value}`);
    seen.add(module.value);
    if (!/^[a-z0-9-]+$/.test(module.value)) problems.push(`module value is not url-safe: ${module.value}`);
    if (!Number.isInteger(module.baseEffortDays) || module.baseEffortDays <= 0) {
      problems.push(`module ${module.value} has a bad baseEffortDays`);
    }
    if (!Array.isArray(module.crossModule)) {
      problems.push(`module ${module.value} has no crossModule array`);
      continue;
    }
    for (const dep of module.crossModule) {
      if (dep === module.value) problems.push(`module ${module.value} depends on itself`);
    }
  }

  // Deferred to a second pass: a dependency is allowed to point at a module declared later.
  for (const module of ALL_MODULES) {
    for (const dep of module.crossModule || []) {
      if (!MODULE_BY_VALUE.has(dep)) {
        problems.push(`module ${module.value} depends on unknown module: ${dep}`);
      }
    }
  }

  if (problems.length) {
    throw new Error(`Product catalogue is inconsistent:\n  - ${problems.join('\n  - ')}`);
  }
  return true;
}

function moduleByValue(value) {
  return MODULE_BY_VALUE.get(value) || null;
}

function lineByValue(value) {
  return LINE_BY_VALUE.get(value) || null;
}

/** Display label for a module slug, or the slug itself if the catalogue has dropped it. */
function moduleLabel(value) {
  const found = MODULE_BY_VALUE.get(value);
  return found ? found.label : value;
}

/** Display label for a product line. */
function lineLabel(value) {
  const found = LINE_BY_VALUE.get(value);
  return found ? found.label : value;
}

function isModule(value) {
  return MODULE_BY_VALUE.has(value);
}

/** The lines touched by a selection of modules, in catalogue order. */
function linesForModules(moduleValues) {
  const wanted = new Set(moduleValues);
  return PRODUCT_LINES.filter((line) => line.modules.some((m) => wanted.has(m.value)));
}

module.exports = {
  PRODUCT_LINES,
  ALL_MODULES,
  MODULE_BY_VALUE,
  CROSS_MODULE_INTEGRATION_SHARE,
  assertCatalogueIntegrity,
  moduleByValue,
  lineByValue,
  moduleLabel,
  lineLabel,
  isModule,
  linesForModules
};
