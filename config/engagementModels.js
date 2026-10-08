'use strict';

/**
 * The three ways a company buys SAP delivery here, and the one place that describes them.
 *
 * THE HUB IS A MARKETPLACE, AND EVERY SENTENCE HERE HAS TO SAY SO. The Terms of Service
 * state that the Hub is not a party to any engagement and does not employ, vet or
 * guarantee anybody. These pages once said "we own the plan, the team and the delivery",
 * which is a promise the Terms disclaim in the same breath — and the one a client with a
 * failed project would quote back. So each model names three parties: what the client
 * owns, what the consultant or partner they contract owns, and what the Hub provides,
 * which is tooling and nothing that could be read as delivery. The assertion below
 * refuses the first-person ownership phrasing outright.
 *
 * They are a vocabulary before they are three pages: the same three words appear on the
 * landing page, in the navigation, on each page's own heading and in the "compare" row at
 * the foot of each one. Written out four times they would drift, and drift in a page that
 * explains what a client is buying is the kind that ends in an argument about scope.
 *
 * NONE OF THEM CARRIES A PRICE. `config/payments.js` is the only module that decides what
 * anything costs, and these are descriptions of a shape of engagement, not products with
 * a rate card. A number here would be a second source of truth for money.
 */
const ENGAGEMENT_MODELS = Object.freeze([
  {
    slug: 'staff-augmentation',
    label: 'Staff augmentation',
    icon: 'bi-person-plus',
    summary: 'One or more consultants join your team and work to your plan.',
    bestFor: 'A gap in a team you already have, and a backlog you already own.',
    youOwn: 'Scope, priorities, delivery method and the outcome.',
    supplierOwns: 'Their own work, to your direction, under the contract you agree with them.',
    hubProvides: 'A directory filtered by delivery history, and a thread anchored to the role so you can talk to people.',
    steps: [
      ['Describe the gap', 'Post a role with the module, the Activate phase you are in, the seniority and when you need somebody.'],
      ['See candidates', 'Profiles filtered by what they have delivered, not what they have ticked.'],
      ['Talk to them', 'Through the Hub, anchored to the role, so the thread has a subject.'],
      ['Contract and start', 'You agree terms with them directly; they join your plan, your stand-up, and report to you.']
    ],
    benefits: [
      'You keep control of the plan — nothing about how you deliver has to change.',
      'Scale down as easily as up: the commitment is per person, per month.',
      'Filter on delivery history, so "has done EWM" means a project and not a course.',
      'The Hub charges no placement fee: what you agree with the consultant is between the two of you.'
    ],
    watchOut: 'If nobody on your side owns the design, this is the model that quietly fails — an augmented team needs somebody to augment.'
  },
  {
    slug: 'project-based',
    label: 'Project-based',
    icon: 'bi-diagram-3',
    summary: 'A defined scope, a defined price, delivered against a statement of work.',
    bestFor: 'A piece of work whose edges you can describe: a rollout, a migration, a module going live.',
    youOwn: 'The business decisions, sign-off at each phase, and your own people\'s time.',
    supplierOwns: 'The plan, the team and the delivery against the statement of work you sign with them.',
    hubProvides: 'The estimator, and an itemised estimate you can export for your own approvals and for comparing partners\' bids.',
    steps: [
      ['Size it', 'The estimator turns a scope into consultant-days, phases and a budget in minutes.'],
      ['Find a delivery partner', 'Consultants and agencies whose delivery history covers the modules in scope.'],
      ['Agree the statement of work with them', 'What is in, what is out, and what each phase produces — the contract is between you and them.'],
      ['They deliver', 'Through Explore, Realize, Deploy and Run, against the plan you both signed.']
    ],
    benefits: [
      'The cost is known before you commit, and the breakdown reconciles line by line.',
      'Scope changes are visible, because the original estimate does not get rewritten.',
      'A quote keeps the catalogue it was priced under, so nobody re-prices history.',
      'Export the whole thing as a document, a workbook or a deck for your own approvals.'
    ],
    watchOut: 'A scope nobody can describe yet is not a project — size it as a short discovery first, or you are buying an argument.'
  },
  {
    slug: 'managed-services',
    label: 'Managed services',
    icon: 'bi-shield-check',
    summary: 'Ongoing support and small change for a system that is already live.',
    bestFor: 'Life after go-live: incidents, support packs, small enhancements, the quiet half of SAP.',
    youOwn: 'Priorities, business sign-off, and what counts as urgent.',
    supplierOwns: 'The rota, the response times you agree, and keeping the knowledge when individuals move on.',
    hubProvides: 'A place to find a team whose delivery history covers your estate, and to talk to them.',
    steps: [
      ['Describe the estate', 'Modules, versions, interfaces and how much of it is standard.'],
      ['Find a provider', 'Consultants or agencies whose delivery history covers what you run.'],
      ['Agree the shape with them', 'Hours, response expectations and who may raise what — in your contract with them.'],
      ['Transition and run', 'A documented handover from whoever built it, then support plus a small-change allowance.']
    ],
    benefits: [
      'Cover that does not depend on one person\'s holiday plans.',
      'Ask for small change in the same contract, so "we will raise it next year" stops being the answer.',
      'Knowledge stays with the engagement rather than leaving with a contractor.',
      'Providers are filtered by what they have run before, not by what they claim.'
    ],
    watchOut: 'If what you actually have is a half-finished implementation, support will spend its time on it — finish the project first.'
  }
]);

const BY_SLUG = Object.freeze(Object.fromEntries(ENGAGEMENT_MODELS.map((m) => [m.slug, m])));

function engagementModel(slug) {
  return Object.prototype.hasOwnProperty.call(BY_SLUG, slug) ? BY_SLUG[slug] : null;
}

/**
 * Asserted at boot like every other catalogue, because each failure here produces a page
 * that is WRONG rather than a page that errors: a model whose slug does not match its
 * route renders under the wrong heading, and a missing field renders as a blank bullet
 * nobody notices until a client reads it.
 */
function assertEngagementIntegrity() {
  const problems = [];
  const seen = new Set();

  ENGAGEMENT_MODELS.forEach((model) => {
    if (!/^[a-z][a-z0-9-]*$/.test(model.slug)) problems.push(`"${model.slug}" is not a usable slug`);
    if (seen.has(model.slug)) problems.push(`${model.slug} is declared twice`);
    seen.add(model.slug);

    ['label', 'icon', 'summary', 'bestFor', 'youOwn', 'supplierOwns', 'hubProvides', 'watchOut'].forEach((field) => {
      if (!model[field] || !String(model[field]).trim()) problems.push(`${model.slug} has no ${field}`);
    });

    if (!Array.isArray(model.steps) || model.steps.length < 3) {
      problems.push(`${model.slug} needs at least three steps`);
    } else {
      model.steps.forEach((step, i) => {
        if (!Array.isArray(step) || step.length !== 2 || !step[0] || !step[1]) {
          problems.push(`${model.slug} step ${i + 1} is not a [title, detail] pair`);
        }
      });
    }

    if (!Array.isArray(model.benefits) || model.benefits.length < 3) {
      problems.push(`${model.slug} needs at least three benefits`);
    }

    /*
     * No prices. config/payments.js is the only module that decides what anything costs,
     * and a figure that drifted onto one of these pages would be a second answer to the
     * same question in front of a client.
     */
    const prose = JSON.stringify(model);
    if (/[€$£]\s?\d/.test(prose)) problems.push(`${model.slug} names a price, which belongs in config/payments.js`);

    /*
     * No delivery promises in the Hub's own voice. The Terms say the Hub is not a party to
     * any engagement; "we own the delivery" on a sales page says the opposite, and it is
     * the sentence a client with a failed project would quote.
     */
    if (/\bwe (own|deliver|guarantee|vet|staff|run|provide the team)\b/i.test(prose) || /\bweOwn\b/.test(prose)) {
      problems.push(`${model.slug} promises delivery in the Hub's own voice, which the Terms disclaim`);
    }
  });

  if (problems.length) {
    throw new Error(`Engagement models are inconsistent:\n  - ${problems.join('\n  - ')}`);
  }
}

module.exports = { ENGAGEMENT_MODELS, engagementModel, assertEngagementIntegrity };
