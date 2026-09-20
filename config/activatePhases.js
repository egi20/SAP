'use strict';

/**
 * SAP Activate's phases, in order. One source of truth.
 *
 * Three different parts of this application store or display a phase: a job advert says
 * which phase a role is scoped to, a consultant's delivery history says which phase they
 * worked, and the estimator distributes effort across all six. They were declared in
 * `models/Job.js` while only the first of those existed; the moment the estimator needed
 * them too, a second copy would have been a list that drifts — and drift here means a
 * quote and a CV using the same word for different things.
 *
 * The order is load-bearing, not cosmetic: the estimator's timeline runs these
 * sequentially, and `config/estimation.js` asserts at boot that its phase table matches
 * this list exactly, in this order.
 *
 * These names are also stored in ENUM columns (migrations 002 and 003). Changing one is a
 * migration, not an edit.
 */
const ACTIVATE_PHASES = Object.freeze(['discover', 'prepare', 'explore', 'realize', 'deploy', 'run']);

/** Title case for display. The stored value is always the lower-case slug. */
function phaseLabel(phase) {
  if (!ACTIVATE_PHASES.includes(phase)) return null;
  return phase.charAt(0).toUpperCase() + phase.slice(1);
}

function isPhase(value) {
  return ACTIVATE_PHASES.includes(value);
}

module.exports = { ACTIVATE_PHASES, phaseLabel, isPhase };
