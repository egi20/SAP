'use strict';

const {
  ALL_MODULES,
  MODULE_BY_VALUE,
  PRODUCT_LINES,
  CROSS_MODULE_INTEGRATION_SHARE,
  moduleByValue,
  lineByValue
} = require('../config/sapProducts');
const {
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
  PHASE_MILESTONES
} = require('../config/estimation');

/**
 * SAP project estimation engine.
 *
 * Entirely pure: it reads catalogues and returns a breakdown, touching no database and no
 * clock beyond a single timestamp. That is what makes the invariants below testable, and
 * they are the whole point of the module — an estimate whose parts do not add up to its
 * own total is worse than no estimate, because a client will find the discrepancy.
 *
 * The invariants, each enforced by construction rather than by hoping:
 *
 *   1. Phase days sum EXACTLY to the total.
 *   2. Resource days sum EXACTLY to the same total.
 *   3. Every cost is `days × rate` on integers, so the budget reconciles line by line.
 *   4. The calendar duration is the sum of sequential phase durations, not the whole
 *      project divided by one fully-parallel team.
 *   5. Nothing is counted twice. See `totalBudget` below.
 */

const AVERAGE_TEAM_SIZE = 6;
const WORKING_DAYS_PER_WEEK = 5;
const MINIMUM_BASE_EFFORT_DAYS = 40;
const UNKNOWN_MODULE_DAYS = 30;

/**
 * Distribute an integer `total` across items by `weights` so the parts sum EXACTLY to
 * `total`.
 *
 * Largest-remainder (Hamilton): floor every share, then hand the leftover units to the
 * items with the largest fractional parts. Independent `Math.round(total * pct / 100)`
 * calls do NOT do this — each rounds in isolation, so the parts drift a unit or two away
 * from the headline figure and the document contradicts itself.
 *
 * Ported unchanged from the reference. It is the load-bearing piece of arithmetic in the
 * whole engine and it was already right.
 *
 * @param {number} total integer total to distribute
 * @param {number[]} weights per-item weights, negatives treated as zero
 * @returns {number[]} integer parts summing to `total`
 */
function apportionDays(total, weights) {
  const target = Math.round(total);
  const positive = weights.map((w) => (w > 0 ? w : 0));
  const weightSum = positive.reduce((a, b) => a + b, 0);

  if (weightSum <= 0 || target <= 0) return weights.map(() => 0);

  const exact = positive.map((w) => (target * w) / weightSum);
  const parts = exact.map(Math.floor);

  let remainder = target - parts.reduce((a, b) => a + b, 0);
  const byFraction = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  for (let k = 0; remainder > 0; k += 1, remainder -= 1) {
    parts[byFraction[k % byFraction.length].index] += 1;
  }

  return parts;
}

/**
 * Merge an override map over a defaults map, per key.
 *
 * A key present in the override wins and is shallow-merged over the default, so a partial
 * override like `{ rate: 900 }` keeps the default's name and percentage. A non-object
 * override is ignored entirely rather than replacing the whole table with rubbish.
 */
function overrideConfigMap(defaults, overrides) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return defaults;

  const merged = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      merged[key] = { ...(defaults[key] || {}), ...value };
    }
  }
  return merged;
}

/**
 * Realistic calendar duration in whole weeks.
 *
 * The naive model — `ceil(totalDays / teamSize / daysPerWeek)` — treats the whole project
 * as one bucket of effort worked fully in parallel, which collapses a 900-day programme
 * into thirty weeks. SAP Activate phases run largely sequentially: you cannot configure
 * before fit-to-standard has produced a backlog, or rehearse a cutover before the build
 * lands. So the span is the SUM of per-phase durations, with the team parallel WITHIN each
 * phase.
 *
 * Excluded phases contribute nothing; every active phase takes at least one week.
 */
function computeProjectDurationWeeks(phaseDays, teamSize = AVERAGE_TEAM_SIZE, daysPerWeek = WORKING_DAYS_PER_WEEK) {
  const team = Math.max(1, teamSize);
  const perWeek = Math.max(1, daysPerWeek);

  const weeks = (phaseDays || []).reduce((sum, days) => {
    const value = Number(days) || 0;
    return value > 0 ? sum + Math.max(1, Math.ceil(value / team / perWeek)) : sum;
  }, 0);

  return Math.max(1, weeks);
}

/** Count comma-, semicolon- or newline-separated items in a free-text field. */
function countFreeTextItems(text) {
  if (!text || !String(text).trim()) return 0;
  return String(text)
    .split(/[,;\n]+/)
    .filter((item) => item.trim().length > 0).length;
}

/**
 * Effort for the module boundaries the client did NOT buy.
 *
 * This is the SAP-specific part of the calculation and the thing `config/sapProducts.js`
 * promised when it declared `crossModule`. Neither reference has it, because neither
 * ecosystem needs it: Sales Cloud without Service Cloud is simply a smaller project.
 *
 * SD without MM is NOT a smaller project. Somebody still has to make sales orders reserve
 * stock that a procurement process this programme is not implementing will deliver, and
 * that work is an integration to a system boundary rather than configuration of a module.
 * Charged at `CROSS_MODULE_INTEGRATION_SHARE` of the missing module's own baseline, once
 * per unordered pair — the boundary between MM and SD is one boundary, not two, and
 * counting it from both sides is the kind of doubling nobody notices in a total.
 *
 * A dependency that IS in scope costs nothing here: its integration is already inside the
 * two modules' own baselines.
 *
 * @returns {{days:number, boundaries:Array<{from:string,to:string,days:number}>}}
 */
function crossModuleEffort(selectedModules, share = CROSS_MODULE_INTEGRATION_SHARE) {
  const selected = new Set(selectedModules);
  const seen = new Set();
  const boundaries = [];
  let days = 0;

  for (const slug of selectedModules) {
    const module = MODULE_BY_VALUE.get(slug);
    if (!module) continue;

    for (const dep of module.crossModule || []) {
      if (selected.has(dep)) continue;

      // One boundary per unordered pair, whichever side declared it.
      const key = [slug, dep].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);

      const target = MODULE_BY_VALUE.get(dep);
      if (!target) continue;

      const boundaryDays = Math.round(target.baseEffortDays * share);
      days += boundaryDays;
      boundaries.push({ from: slug, to: dep, days: boundaryDays });
    }
  }

  return { days, boundaries };
}

/** Look up which product line a module slug belongs to. */
const MODULE_PARENT = new Map();
for (const line of PRODUCT_LINES) {
  for (const module of line.modules) MODULE_PARENT.set(module.value, line.value);
}

/**
 * Calculate a full project estimate.
 *
 * @param {Object} input scope chosen by the client
 * @param {Object} config rates, contingency, currency and optional catalogue overrides
 * @returns {Object} the complete breakdown
 */
function calculateEstimation(input = {}, config = {}) {
  const {
    selectedLines = [],
    selectedModules = [],
    selectedAddons = [],
    transitionApproach = 'greenfield',
    cleanCoreLevel = 'moderate',
    complexity = 'moderate',
    numberOfUsers = 50,
    numberOfCompanyCodes = 1,
    numberOfCountries = 1,
    numberOfIntegrations = 0,
    integrationComplexity = 'medium',
    clientIndustry = '',
    companySize = '',
    includeTraining = true,
    includeRun = true,
    otherModules = '',
    otherAddons = '',
    otherIntegrations = ''
  } = input;

  const { contingencyPercentage = 15, currency = 'EUR' } = config;

  // Config-supplied values override the defaults per key, so a partial override can never
  // break the apportionment below.
  const complexityMultipliers = overrideConfigMap(COMPLEXITY_MULTIPLIERS, config.complexityMultipliers);
  const cleanCoreLevels = overrideConfigMap(CLEAN_CORE_LEVELS, config.cleanCoreLevels);
  const transitionApproaches = overrideConfigMap(TRANSITION_APPROACHES, config.transitionApproaches);
  const phaseDistribution = overrideConfigMap(PHASE_DISTRIBUTION, config.phaseDistribution);
  const resourceAllocationConfig = overrideConfigMap(DEFAULT_RESOURCE_ALLOCATION, config.resourceRates);

  // --- Step 1: base effort from the chosen scope -------------------------------------
  // Per line: max(foundation, sum of its selected modules). A line selected with no
  // modules still costs its platform setup; a line with modules costs at least their sum.
  const moduleBreakdown = [];
  const moduleDaysByLine = {};

  for (const moduleSlug of selectedModules) {
    const lineSlug = MODULE_PARENT.get(moduleSlug);
    const module = moduleByValue(moduleSlug);
    const days = module ? module.baseEffortDays : UNKNOWN_MODULE_DAYS;
    const key = lineSlug || moduleSlug;
    moduleDaysByLine[key] = (moduleDaysByLine[key] || 0) + days;
    moduleBreakdown.push({
      id: moduleSlug,
      name: module ? module.label : moduleSlug,
      line: lineSlug || null,
      days
    });
  }

  // A module whose line was not ticked still counts: the client chose the work.
  const lines = new Set([...selectedLines, ...Object.keys(moduleDaysByLine)]);

  let baseEffort = 0;
  const lineBreakdown = [];

  for (const lineSlug of lines) {
    const line = lineByValue(lineSlug);
    const foundation = line ? line.foundationEffortDays : 0;
    const moduleDays = moduleDaysByLine[lineSlug] || 0;
    const effectiveDays = Math.max(foundation, moduleDays);
    baseEffort += effectiveDays;
    lineBreakdown.push({
      id: lineSlug,
      name: line ? line.label : lineSlug,
      foundationDays: foundation,
      moduleDays,
      effectiveDays
    });
  }

  // The boundaries with everything NOT in scope. See crossModuleEffort.
  const crossModule = crossModuleEffort(selectedModules);
  baseEffort += crossModule.days;

  const addonBreakdown = [];
  for (const addonId of selectedAddons) {
    const addon = ADDON_SOLUTIONS[addonId];
    const days = addon ? addon.days : ADDON_SOLUTIONS['addon-other'].days;
    baseEffort += days;
    addonBreakdown.push({
      id: addonId,
      name: addon ? addon.name : addonId,
      category: addon ? addon.category : 'Other',
      days
    });
  }

  if (baseEffort === 0) baseEffort = MINIMUM_BASE_EFFORT_DAYS;

  // --- Step 2: multipliers -----------------------------------------------------------
  // The transition approach first, because it is the one a reader looks for.
  const transitionEntry = transitionApproaches[transitionApproach] || transitionApproaches.greenfield;
  baseEffort *= transitionEntry.multiplier;

  const complexityEntry = complexityMultipliers[complexity] || { multiplier: 1.0, description: '' };
  baseEffort *= complexityEntry.multiplier;

  // User scaling is logarithmic and floored: doubling the seat count does not double the
  // work, and a small pilot never falls below 80% of the baseline.
  const users = Math.max(1, parseInt(numberOfUsers, 10) || 50);
  const userMultiplier = Math.max(0.8, 1 + Math.log10(users / 50) * 0.2);
  baseEffort *= userMultiplier;

  /*
   * Company codes, not "orgs".
   *
   * The reference counts Salesforce orgs, each of which is a separate deployment path. The
   * SAP analogue is the legal entity: each additional company code is its own chart of
   * accounts assignment, its own statutory reporting and its own set of approval limits —
   * inside ONE system, which is why it costs less per unit than a second org does there.
   */
  const companyCodes = Math.max(1, parseInt(numberOfCompanyCodes, 10) || 1);
  const companyCodeMultiplier = 1 + (companyCodes - 1) * 0.12;
  baseEffort *= companyCodeMultiplier;

  // Countries are localisation: tax, statutory reporting, language, payroll and banking.
  // A second country costs more than a second company code inside the same country.
  const countries = Math.max(1, parseInt(numberOfCountries, 10) || 1);
  const countryMultiplier = 1 + (countries - 1) * 0.25;
  baseEffort *= countryMultiplier;

  const cleanCoreEntry = cleanCoreLevels[cleanCoreLevel] || { multiplier: 1.0, description: '' };
  baseEffort *= cleanCoreEntry.multiplier;

  const industryEntry = INDUSTRY_MULTIPLIERS[clientIndustry] || { multiplier: 1.0, description: '' };
  baseEffort *= industryEntry.multiplier;

  const companySizeEntry = COMPANY_SIZE_MULTIPLIERS[companySize] || { multiplier: 1.0, description: '' };
  baseEffort *= companySizeEntry.multiplier;

  // --- Step 3: additive effort -------------------------------------------------------
  const integrations = Math.max(0, parseInt(numberOfIntegrations, 10) || 0);
  const daysPerIntegration = INTEGRATION_DAYS[integrationComplexity] || INTEGRATION_DAYS.medium;
  baseEffort += integrations * daysPerIntegration;

  // Anything the client typed that we could not map to the catalogue is still scope, and
  // costing it at zero is how a quote becomes an argument later.
  const unmappedModules = countFreeTextItems(otherModules);
  const unmappedAddons = countFreeTextItems(otherAddons);
  const unmappedIntegrations = countFreeTextItems(otherIntegrations);
  const unmappedEffort =
    unmappedModules * UNMAPPED_ITEM_DAYS.module +
    unmappedAddons * UNMAPPED_ITEM_DAYS.addon +
    unmappedIntegrations * daysPerIntegration;
  baseEffort += unmappedEffort;

  const totalBaseEffort = Math.round(baseEffort);

  // --- Step 4: contingency -----------------------------------------------------------
  const contingencyDays = Math.round(totalBaseEffort * (contingencyPercentage / 100));
  const totalEffort = totalBaseEffort + contingencyDays;

  // --- Step 5: phases ----------------------------------------------------------------
  // Percentages are finalised first (an excluded phase zeroed, the slack redistributed
  // into realize), and only then are days apportioned — so the phases sum exactly.
  const phases = Object.entries(phaseDistribution).map(([id, phase]) => {
    const percentage = id === 'run' && !includeRun ? 0 : phase.percentage;
    return { id, name: phase.name, description: phase.description, percentage, days: 0 };
  });

  const declaredPercentage = phases.reduce((sum, p) => sum + p.percentage, 0);
  if (declaredPercentage < 100) {
    const realize = phases.find((p) => p.id === 'realize') || phases[0];
    realize.percentage += 100 - declaredPercentage;
  }

  const phaseDays = apportionDays(totalEffort, phases.map((p) => p.percentage));
  phases.forEach((phase, index) => {
    phase.days = phaseDays[index];
  });

  // --- Step 6: resources -------------------------------------------------------------
  /*
   * Training is a WORKSTREAM here, not a phase. Excluding it zeroes this one role's weight
   * and `apportionDays` spreads its days across the rest — the calendar does not change,
   * because enablement never was a block of it.
   *
   * `share` is DERIVED from the apportioned days rather than echoing the declared
   * percentage. The reference prints the declared figure, which stops being true the
   * moment a role is excluded or a caller overrides a weight: the table then shows shares
   * summing to 96 beside days summing to the total.
   */
  const resourceEntries = Object.entries(resourceAllocationConfig).map(([id, resource]) => [
    id,
    { ...resource, percentage: id === TRAINING_RESOURCE_ID && !includeTraining ? 0 : resource.percentage }
  ]);

  const resourceDays = apportionDays(totalEffort, resourceEntries.map(([, r]) => r.percentage));
  const resourceAllocation = resourceEntries
    .map(([id, resource], index) => {
      const days = resourceDays[index];
      const dailyRate = Math.round(resource.rate);
      return {
        id,
        name: resource.name,
        role: resource.role || null,
        days,
        share: totalEffort > 0 ? Math.round((days / totalEffort) * 100) : 0,
        dailyRate,
        // Integer arithmetic on integers: the line items add up to the budget exactly.
        totalCost: days * dailyRate
      };
    })
    .filter((resource) => resource.days > 0);

  const implementationBudget = resourceAllocation.reduce((sum, r) => sum + r.totalCost, 0);

  // --- Step 7: duration and rate -----------------------------------------------------
  const projectDurationWeeks = computeProjectDurationWeeks(phases.map((p) => p.days));
  const averageDailyRate = Math.round(implementationBudget / totalEffort);

  /*
   * ONE BUDGET, AND HYPERCARE IS INSIDE IT.
   *
   * The reference carries a `support` phase at 2% of the total AND adds a separately
   * computed hypercare budget — two people for the working days in the window — on top of
   * `implementationBudget`. Hypercare is therefore in the number twice: once as days
   * inside `totalManDays`, and again as a figure added to the total. Nothing reconciles
   * it, because the two live on different sides of the addition.
   *
   * Here `run` is a phase like any other. Its days are in the total, its cost is in the
   * budget, and `totalBudget` is the budget. What is exposed instead is `runPhase`, so a
   * reader can see what hypercare costs WITHIN the total rather than added to it.
   */
  const runPhase = phases.find((p) => p.id === 'run');
  const runPhaseDays = runPhase ? runPhase.days : 0;

  return {
    totalManDays: totalEffort,
    baseEffort: totalBaseEffort,
    contingencyDays,
    contingencyPercentage,

    implementationBudget,
    totalBudget: implementationBudget,
    averageDailyRate,
    currency,

    runPhase: {
      included: Boolean(includeRun) && runPhaseDays > 0,
      days: runPhaseDays,
      // Indicative, and inside totalBudget rather than added to it.
      cost: runPhaseDays * averageDailyRate
    },

    projectDurationWeeks,
    projectDurationMonths: Math.max(1, Math.round(projectDurationWeeks / 4.33)),

    lineBreakdown,
    moduleBreakdown,
    addonBreakdown,
    crossModuleBreakdown: crossModule.boundaries,
    crossModuleDays: crossModule.days,
    phaseBreakdown: phases,
    resourceAllocation,
    timeline: generateTimeline(phases),

    unmapped: {
      modules: unmappedModules,
      addons: unmappedAddons,
      integrations: unmappedIntegrations,
      days: unmappedEffort
    },

    multipliers: {
      transition: {
        value: transitionEntry.multiplier,
        name: transitionEntry.name,
        description: transitionEntry.description
      },
      complexity: { value: complexityEntry.multiplier, description: complexityEntry.description },
      users: { value: Number(userMultiplier.toFixed(2)), count: users },
      companyCodes: { value: Number(companyCodeMultiplier.toFixed(2)), count: companyCodes },
      countries: { value: Number(countryMultiplier.toFixed(2)), count: countries },
      cleanCore: { value: cleanCoreEntry.multiplier, name: cleanCoreEntry.name, description: cleanCoreEntry.description },
      industry: {
        value: industryEntry.multiplier,
        name: clientIndustry || 'Not specified',
        description: industryEntry.description
      },
      companySize: {
        value: companySizeEntry.multiplier,
        name: companySize || 'Not specified',
        description: companySizeEntry.description
      },
      integrations: { count: integrations, daysEach: daysPerIntegration, complexity: integrationComplexity }
    },

    options: { includeTraining, includeRun },
    calculatedAt: new Date().toISOString()
  };
}

/**
 * Sequential timeline over the active phases.
 *
 * Weeks come from the same per-phase calculation as the headline duration, so the Gantt
 * and the summary agree. Deriving them from a percentage of the total instead is how the
 * two end up contradicting each other.
 */
function generateTimeline(phases) {
  const timeline = [];
  let cursor = 0;

  for (const phase of phases) {
    if (phase.days <= 0) continue;
    const weeks = Math.max(1, Math.ceil(phase.days / AVERAGE_TEAM_SIZE / WORKING_DAYS_PER_WEEK));
    timeline.push({
      phase: phase.name,
      phaseId: phase.id,
      startWeek: cursor + 1,
      endWeek: cursor + weeks,
      durationWeeks: weeks,
      days: phase.days,
      milestone: PHASE_MILESTONES[phase.id] || 'Phase complete'
    });
    cursor += weeks;
  }

  return timeline;
}

/**
 * Cross-check a finished estimate against its own invariants.
 *
 * Called by the route before an estimate is ever shown or stored. If this returns
 * anything, the estimate contradicts itself and must not be presented as a quote.
 */
function reconciliationProblems(estimate) {
  const problems = [];

  const phaseSum = estimate.phaseBreakdown.reduce((sum, p) => sum + p.days, 0);
  if (phaseSum !== estimate.totalManDays) {
    problems.push(`phase days sum to ${phaseSum}, but the total is ${estimate.totalManDays}`);
  }

  const resourceSum = estimate.resourceAllocation.reduce((sum, r) => sum + r.days, 0);
  if (resourceSum !== estimate.totalManDays) {
    problems.push(`resource days sum to ${resourceSum}, but the total is ${estimate.totalManDays}`);
  }

  const costSum = estimate.resourceAllocation.reduce((sum, r) => sum + r.days * r.dailyRate, 0);
  if (costSum !== estimate.implementationBudget) {
    problems.push(`resource costs sum to ${costSum}, but the implementation budget is ${estimate.implementationBudget}`);
  }

  if (estimate.baseEffort + estimate.contingencyDays !== estimate.totalManDays) {
    problems.push('base effort plus contingency does not equal the total');
  }

  // The reference's hypercare bug, as an assertion: nothing may be added to the budget
  // that the resource lines have not already accounted for.
  if (estimate.totalBudget !== estimate.implementationBudget) {
    problems.push(
      `total budget ${estimate.totalBudget} differs from the implementation budget `
        + `${estimate.implementationBudget} — something is being counted outside the resource lines`
    );
  }

  const timelineWeeks = estimate.timeline.reduce((sum, t) => sum + t.durationWeeks, 0);
  if (timelineWeeks !== estimate.projectDurationWeeks) {
    problems.push(`timeline spans ${timelineWeeks} weeks, but the headline duration is ${estimate.projectDurationWeeks}`);
  }

  return problems;
}

module.exports = {
  apportionDays,
  overrideConfigMap,
  computeProjectDurationWeeks,
  countFreeTextItems,
  crossModuleEffort,
  calculateEstimation,
  generateTimeline,
  reconciliationProblems,
  AVERAGE_TEAM_SIZE,
  WORKING_DAYS_PER_WEEK,
  ALL_MODULES
};
