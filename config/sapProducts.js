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
      { value: 'treasury', label: 'Treasury & Risk Management (TRM)', baseEffortDays: 55, crossModule: ['fi-gl'] }
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
      { value: 'ps', label: 'Project System (PS)', baseEffortDays: 40, crossModule: ['co-cca'] }
    ]
  },
  {
    value: 'successfactors',
    label: 'SAP SuccessFactors',
    foundationEffortDays: 30,
    modules: [
      { value: 'sf-ec', label: 'Employee Central', baseEffortDays: 55, crossModule: [] },
      { value: 'sf-rcm', label: 'Recruiting (RCM & RMK)', baseEffortDays: 35, crossModule: ['sf-ec'] },
      { value: 'sf-onb', label: 'Onboarding', baseEffortDays: 25, crossModule: ['sf-rcm'] },
      { value: 'sf-pmgm', label: 'Performance & Goals', baseEffortDays: 30, crossModule: ['sf-ec'] },
      { value: 'sf-comp', label: 'Compensation & Variable Pay', baseEffortDays: 35, crossModule: ['sf-ec'] },
      { value: 'sf-lms', label: 'Learning (LMS)', baseEffortDays: 35, crossModule: [] },
      { value: 'sf-ecp', label: 'Employee Central Payroll', baseEffortDays: 70, crossModule: ['sf-ec'] },
      { value: 'sf-tm', label: 'Time Tracking & Time Off', baseEffortDays: 30, crossModule: ['sf-ec'] }
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
      { value: 'btp-identity', label: 'Identity Authentication & Provisioning (IAS/IPS)', baseEffortDays: 20, crossModule: [] }
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
      { value: 'signavio', label: 'Signavio Process Insights', baseEffortDays: 30, crossModule: [] }
    ]
  }
];

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
  isModule,
  linesForModules
};
