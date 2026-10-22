'use strict';

/**
 * The example CV on /cv-generator: a FICTIONAL consultant, rendered by the real builder.
 *
 * A visitor deciding whether to fill in a profile cannot tell what they would get from a
 * description, so the page shows one — produced by `utils/cvData.js` and
 * `utils/documents/cvDocx.js` exactly as a member's is, so the example can never promise a
 * layout the builder does not make. The person is invented and says so on every surface:
 * the name is "Example Consultant", the employers are "Example" companies, and the page and
 * the file are labelled as an example. Nothing here describes a real person or client.
 *
 * Module, role and certification values are catalogue keys and the assertion checks them, so
 * the example cannot show a module the directory filter does not have.
 */

const { isModule } = require('./sapProducts');
const { ROLE_SLUGS } = require('./roleTaxonomy');
const { certByCode } = require('./certifications');

const EXAMPLE_PROFILE = Object.freeze({
  name: 'Example Consultant',
  headline: 'Senior SAP EWM consultant — warehouse design to go-live',
  primary_role: 's4-ewm',
  seniority: 'senior',
  city: 'Hamburg',
  country: 'DE',
  work_mode: 'hybrid',
  willing_to_travel: 1,
  years_experience: 11,
  full_lifecycles: 3,
  bio: 'This is an example CV for a fictional consultant. Everything on it is a field a member fills in on their own profile: '
    + 'this paragraph is the About section, the engagements below are the delivery history, and the modules come from the SAP catalogue.'
});

const EXAMPLE_SKILLS = ['Wave and task management', 'RF framework', 'Yard management', 'Cutover planning'];

const EXAMPLE_CERTIFICATIONS = [{ code: 'C_S4EWM', earned_on: '2023-05-01' }];

const EXAMPLE_PROJECTS = [
  {
    name: 'S/4HANA EWM rollout, three distribution centres',
    client: 'Example Retail GmbH',
    role: 'EWM lead',
    activate_phase: 'realize',
    is_full_lifecycle: 1,
    modules: ['ewm', 'mm-inventory'],
    started_on: '2023-02-01',
    ended_on: null,
    description: 'Example engagement text, written by the member on their profile.'
  },
  {
    name: 'Warehouse design for a new automated site',
    client: 'Example Logistics AG',
    role: 'EWM consultant',
    activate_phase: 'explore',
    is_full_lifecycle: 0,
    modules: ['ewm', 'tm'],
    started_on: '2021-03-01',
    ended_on: '2022-12-31',
    description: ''
  },
  {
    name: 'ECC to S/4HANA conversion, logistics stream',
    client: 'Example Manufacturing SE',
    role: 'MM consultant',
    activate_phase: 'deploy',
    is_full_lifecycle: 1,
    modules: ['mm-purchasing', 'mm-inventory'],
    started_on: '2018-06-01',
    ended_on: '2020-12-31',
    description: ''
  }
];

const EXAMPLE_EXPERIENCES = [
  { title: 'Freelance SAP consultant', company: 'Independent', started_on: '2021-01-01', ended_on: null, is_current: 1, description: '' },
  { title: 'SAP logistics consultant', company: 'Example Consulting Ltd', started_on: '2014-09-01', ended_on: '2020-12-31', is_current: 0, description: '' }
];

/** The rows `buildCv` reads, shaped as the models return them. */
function exampleCvInput() {
  return {
    profile: { ...EXAMPLE_PROFILE },
    skills: EXAMPLE_SKILLS.map((name) => ({ name })),
    certifications: EXAMPLE_CERTIFICATIONS.map((c) => ({ label: certByCode(c.code).label, earned_on: c.earned_on })),
    experiences: EXAMPLE_EXPERIENCES.map((e) => ({ ...e })),
    projects: EXAMPLE_PROJECTS.map((p) => ({ ...p, modules: [...p.modules] })),
    job: null
  };
}

function exampleProblems() {
  const problems = [];
  if (!/example/i.test(EXAMPLE_PROFILE.name)) problems.push('the example CV must be named as an example');
  if (!ROLE_SLUGS.includes(EXAMPLE_PROFILE.primary_role)) problems.push(`unknown role ${EXAMPLE_PROFILE.primary_role}`);
  for (const p of EXAMPLE_PROJECTS) {
    if (!/example/i.test(p.client)) problems.push(`example client "${p.client}" must be named as an example`);
    for (const m of p.modules) if (!isModule(m)) problems.push(`unknown module ${m} in the example CV`);
  }
  for (const c of EXAMPLE_CERTIFICATIONS) if (!certByCode(c.code)) problems.push(`unknown certification ${c.code}`);
  return problems;
}

function assertCvExampleIntegrity() {
  const problems = exampleProblems();
  if (problems.length) throw new Error(`config/cvExample.js: ${problems.join('; ')}`);
}

module.exports = { exampleCvInput, exampleProblems, assertCvExampleIntegrity };
