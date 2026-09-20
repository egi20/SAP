'use strict';

const {
  apportionDays,
  crossModuleEffort,
  calculateEstimation,
  reconciliationProblems,
  computeProjectDurationWeeks
} = require('../../utils/sapEstimation');
const { ACTIVATE_PHASES } = require('../../config/activatePhases');
const {
  PHASE_DISTRIBUTION,
  DEFAULT_RESOURCE_ALLOCATION,
  TRAINING_RESOURCE_ID,
  TRANSITION_APPROACHES,
  assertEstimationIntegrity,
  catalogueVersion
} = require('../../config/estimation');
const { CROSS_MODULE_INTEGRATION_SHARE, moduleByValue } = require('../../config/sapProducts');

const SCOPE = {
  selectedModules: ['fi-gl', 'co-cca', 'sd-sales', 'mm-purchasing'],
  numberOfUsers: 400,
  numberOfCompanyCodes: 3,
  numberOfCountries: 2,
  numberOfIntegrations: 4,
  clientIndustry: 'Manufacturing',
  companySize: 'Large (501-5000)',
  includeTraining: true,
  includeRun: true
};

describe('apportionDays', () => {
  test('parts always sum exactly to the total', () => {
    for (const total of [1, 7, 100, 101, 999, 1000, 12345]) {
      for (const weights of [[10, 15, 35, 15, 15, 10], [1, 1, 1], [33, 33, 34], [5, 0, 95], [1]]) {
        const parts = apportionDays(total, weights);
        expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
      }
    }
  });

  test('independent rounding would NOT sum exactly — which is why this exists', () => {
    const total = 101;
    const weights = [33, 33, 34];
    const naive = weights.map((w) => Math.round((total * w) / 100));
    expect(naive.reduce((a, b) => a + b, 0)).not.toBe(total);
    expect(apportionDays(total, weights).reduce((a, b) => a + b, 0)).toBe(total);
  });

  test('a zero weight receives nothing', () => {
    expect(apportionDays(100, [50, 0, 50])[1]).toBe(0);
  });

  test('no weight, or no total, distributes nothing', () => {
    expect(apportionDays(100, [0, 0])).toEqual([0, 0]);
    expect(apportionDays(0, [1, 1])).toEqual([0, 0]);
  });
});

describe('cross-module boundaries', () => {
  test('a dependency IN scope costs nothing', () => {
    // co-cca depends on fi-gl. Both selected, so the integration is inside their baselines.
    expect(crossModuleEffort(['fi-gl', 'co-cca']).days).toBe(0);
  });

  test('a dependency OUT of scope is charged a share of its own baseline', () => {
    const { days, boundaries } = crossModuleEffort(['co-cca']);
    const expected = Math.round(moduleByValue('fi-gl').baseEffortDays * CROSS_MODULE_INTEGRATION_SHARE);
    expect(boundaries).toEqual([{ from: 'co-cca', to: 'fi-gl', days: expected }]);
    expect(days).toBe(expected);
  });

  test('a boundary is counted once, not once from each side', () => {
    /*
     * mm-purchasing declares fi-ap, and fi-ap declares mm-purchasing. With both of those
     * out of scope but each reachable from a different selected module, a naive loop would
     * charge the same boundary twice.
     */
    const both = crossModuleEffort(['mm-purchasing', 'sd-billing']);
    const keys = both.boundaries.map((b) => [b.from, b.to].sort().join('|'));
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('an unknown module contributes no boundary and does not throw', () => {
    expect(crossModuleEffort(['not-a-module']).days).toBe(0);
  });

  test('the estimate includes the boundary days in its base effort', () => {
    const withoutMm = calculateEstimation({ ...SCOPE, selectedModules: ['sd-sales'] });
    expect(withoutMm.crossModuleDays).toBeGreaterThan(0);
    expect(withoutMm.crossModuleBreakdown.length).toBeGreaterThan(0);
  });
});

describe('an estimate reconciles with itself', () => {
  test('the reference scope', () => {
    expect(reconciliationProblems(calculateEstimation(SCOPE))).toEqual([]);
  });

  test('across a spread of shapes', () => {
    const shapes = [
      {},
      { selectedModules: ['fi-gl'] },
      { selectedLines: ['btp'] },
      { ...SCOPE, includeTraining: false },
      { ...SCOPE, includeRun: false },
      { ...SCOPE, includeTraining: false, includeRun: false },
      { ...SCOPE, transitionApproach: 'brownfield' },
      { ...SCOPE, transitionApproach: 'selective', cleanCoreLevel: 'heavy' },
      { ...SCOPE, numberOfUsers: 1, numberOfCompanyCodes: 1, numberOfCountries: 1 },
      { ...SCOPE, numberOfUsers: 90000, numberOfCompanyCodes: 60, numberOfCountries: 30 },
      { ...SCOPE, otherModules: 'a, b, c', otherAddons: 'x;y', otherIntegrations: 'z' },
      { selectedAddons: ['addon-vertex', 'addon-other', 'not-a-real-addon'] }
    ];
    for (const shape of shapes) {
      const estimate = calculateEstimation(shape);
      expect({ shape, problems: reconciliationProblems(estimate) }).toEqual({ shape, problems: [] });
    }
  });

  test('contingency of 0 and of 50 both reconcile', () => {
    for (const contingencyPercentage of [0, 50]) {
      expect(reconciliationProblems(calculateEstimation(SCOPE, { contingencyPercentage }))).toEqual([]);
    }
  });
});

describe('nothing is counted twice', () => {
  /*
   * The reference carries a `support` phase at 2% of the total AND adds a separately
   * computed hypercare budget on top of the implementation budget — so hypercare is in the
   * number twice, once as days inside the total and once as a figure added to it. Here
   * `run` is a phase like any other and the budget is the budget.
   */
  test('the total budget is the implementation budget', () => {
    const estimate = calculateEstimation(SCOPE);
    expect(estimate.totalBudget).toBe(estimate.implementationBudget);
  });

  test('hypercare is reported as a share of the total, not an addition to it', () => {
    const estimate = calculateEstimation(SCOPE);
    expect(estimate.runPhase.included).toBe(true);
    expect(estimate.runPhase.days).toBeGreaterThan(0);
    expect(estimate.runPhase.days).toBeLessThan(estimate.totalManDays);

    const runInPhases = estimate.phaseBreakdown.find((p) => p.id === 'run').days;
    expect(estimate.runPhase.days).toBe(runInPhases);
  });

  test('excluding hypercare removes the phase and keeps the total whole', () => {
    const estimate = calculateEstimation({ ...SCOPE, includeRun: false });
    expect(estimate.phaseBreakdown.find((p) => p.id === 'run').days).toBe(0);
    expect(estimate.timeline.some((t) => t.phaseId === 'run')).toBe(false);
    expect(reconciliationProblems(estimate)).toEqual([]);
  });
});

describe('training is a workstream, not a phase', () => {
  const included = calculateEstimation(SCOPE);
  const excluded = calculateEstimation({ ...SCOPE, includeTraining: false });

  test('excluding it removes the role', () => {
    expect(included.resourceAllocation.some((r) => r.id === TRAINING_RESOURCE_ID)).toBe(true);
    expect(excluded.resourceAllocation.some((r) => r.id === TRAINING_RESOURCE_ID)).toBe(false);
  });

  test('its days go to the rest of the team, not out of the project', () => {
    expect(excluded.totalManDays).toBe(included.totalManDays);
    expect(excluded.resourceAllocation.reduce((s, r) => s + r.days, 0)).toBe(excluded.totalManDays);
  });

  test('and the calendar does not move, because enablement was never a block of it', () => {
    expect(excluded.projectDurationWeeks).toBe(included.projectDurationWeeks);
    expect(excluded.phaseBreakdown.map((p) => p.days)).toEqual(included.phaseBreakdown.map((p) => p.days));
  });

  test('every resource share is derived from its days, so the table cannot contradict itself', () => {
    for (const resource of excluded.resourceAllocation) {
      expect(resource.share).toBe(Math.round((resource.days / excluded.totalManDays) * 100));
    }
  });
});

describe('the phases are SAP Activate\'s', () => {
  test('the catalogue matches the shared list, in order', () => {
    expect(Object.keys(PHASE_DISTRIBUTION)).toEqual([...ACTIVATE_PHASES]);
  });

  test('an estimate reports them in that order', () => {
    expect(calculateEstimation(SCOPE).phaseBreakdown.map((p) => p.id)).toEqual([...ACTIVATE_PHASES]);
  });

  test('the timeline is sequential and contiguous', () => {
    const { timeline, projectDurationWeeks } = calculateEstimation(SCOPE);
    let cursor = 0;
    for (const entry of timeline) {
      expect(entry.startWeek).toBe(cursor + 1);
      cursor = entry.endWeek;
    }
    expect(cursor).toBe(projectDurationWeeks);
  });

  test('duration is the sum of phases, not the total worked in one parallel bucket', () => {
    // The naive model collapses a long programme; this is the difference, stated as a test.
    const phaseDays = [36, 73, 181, 254, 109, 72];
    const total = phaseDays.reduce((a, b) => a + b, 0);
    const naive = Math.ceil(total / 6 / 5);
    expect(computeProjectDurationWeeks(phaseDays)).toBeGreaterThan(naive);
  });
});

describe('the SAP-specific levers move the number', () => {
  test('brownfield and selective both cost more than greenfield', () => {
    const green = calculateEstimation({ ...SCOPE, transitionApproach: 'greenfield' }).totalManDays;
    const brown = calculateEstimation({ ...SCOPE, transitionApproach: 'brownfield' }).totalManDays;
    const selective = calculateEstimation({ ...SCOPE, transitionApproach: 'selective' }).totalManDays;

    expect(brown).toBeGreaterThan(green);
    expect(selective).toBeGreaterThan(brown);
  });

  test('greenfield is the baseline, exactly', () => {
    expect(TRANSITION_APPROACHES.greenfield.multiplier).toBe(1.0);
  });

  test('in-core development costs more than a clean core', () => {
    const clean = calculateEstimation({ ...SCOPE, cleanCoreLevel: 'clean' }).totalManDays;
    const heavy = calculateEstimation({ ...SCOPE, cleanCoreLevel: 'heavy' }).totalManDays;
    expect(heavy).toBeGreaterThan(clean);
  });

  test('a second country costs more than a second company code', () => {
    const base = { ...SCOPE, numberOfCompanyCodes: 1, numberOfCountries: 1 };
    const extraCode = calculateEstimation({ ...base, numberOfCompanyCodes: 2 }).totalManDays;
    const extraCountry = calculateEstimation({ ...base, numberOfCountries: 2 }).totalManDays;
    expect(extraCountry).toBeGreaterThan(extraCode);
  });

  test('an SAP programme is not priced like a CRM one', () => {
    // Four S/4HANA modules across three company codes is a multi-hundred-day programme.
    // If this ever drops to CRM scale, a baseline has been carried across from a reference.
    expect(calculateEstimation(SCOPE).totalManDays).toBeGreaterThan(300);
  });
});

describe('the catalogue fingerprint', () => {
  test('is stable across calls', () => {
    expect(catalogueVersion()).toBe(catalogueVersion());
  });

  test('is twelve hex characters', () => {
    expect(catalogueVersion()).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('the configuration asserts itself', () => {
  test('integrity', () => expect(assertEstimationIntegrity()).toBe(true));

  test('every resource names a role in the taxonomy', () => {
    const { isRole } = require('../../config/roleTaxonomy');
    for (const [id, resource] of Object.entries(DEFAULT_RESOURCE_ALLOCATION)) {
      expect({ id, known: isRole(resource.role) }).toEqual({ id, known: true });
    }
  });
});
