'use strict';

const { TRANSITION_APPROACHES } = require('./estimation');

/**
 * Which SAP an advert is for, and how the programme gets there.
 *
 * Both mirror ENUMs in `scripts/migrations/028_job_deployment.sql`, and a unit test
 * compares them — the `Job.STATUSES` rule: a value offered in a form and rejected by the
 * column behind it is the failure a second copy produces.
 *
 * The transition vocabulary is not written out here at all: it is the estimator's own
 * TRANSITION_APPROACHES, so an advert and a quote say "selective" and mean the same thing.
 */
const DEPLOYMENTS = Object.freeze([
  { value: 'public-cloud', label: 'S/4HANA Cloud Public Edition (GROW)', short: 'Public Cloud' },
  { value: 'private-cloud', label: 'S/4HANA Cloud Private Edition (RISE)', short: 'Private Cloud' },
  { value: 'on-premise', label: 'S/4HANA on-premise', short: 'On-premise' },
  { value: 'ecc', label: 'SAP ECC 6.0', short: 'ECC' }
]);

const TRANSITIONS = Object.freeze(
  Object.entries(TRANSITION_APPROACHES).map(([value, approach]) => ({ value, label: approach.name }))
);

const DEPLOYMENT_VALUES = Object.freeze(DEPLOYMENTS.map((d) => d.value));
const TRANSITION_VALUES = Object.freeze(TRANSITIONS.map((t) => t.value));

function isDeployment(value) {
  return DEPLOYMENT_VALUES.includes(value);
}

function isTransition(value) {
  return TRANSITION_VALUES.includes(value);
}

function deploymentLabel(value) {
  const found = DEPLOYMENTS.find((d) => d.value === value);
  return found ? found.label : null;
}

/** The short form a card has room for: "Private Cloud", "ECC". */
function deploymentShort(value) {
  const found = DEPLOYMENTS.find((d) => d.value === value);
  return found ? found.short : null;
}

function transitionLabel(value) {
  const found = TRANSITIONS.find((t) => t.value === value);
  return found ? found.label : null;
}

module.exports = {
  DEPLOYMENTS,
  TRANSITIONS,
  DEPLOYMENT_VALUES,
  TRANSITION_VALUES,
  isDeployment,
  isTransition,
  deploymentLabel,
  deploymentShort,
  transitionLabel
};
