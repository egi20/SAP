'use strict';

/**
 * The tax advisory introduction: what it collects, and — more importantly — what it does
 * not.
 *
 * THE REFUSAL THAT DEFINES THIS FEATURE. DynamicsHub ships a calculator. It takes the
 * gross and net a visitor types, applies `newNet = gross - (gross * percentRate / 100 +
 * fixedFee)` with `percentRate` defaulting to 5 and editable by an administrator, and
 * returns a monthly saving, an annual saving and a percentage increase. That arithmetic
 * asserts that somebody's ENTIRE burden becomes five per cent of gross — no jurisdiction,
 * no entity type, no VAT position, no social security floor, no accountant's fee — and the
 * "saving" it shows is a marketing dial with a number on it.
 *
 * None of it is here, and a test scans this module, the model, the route and the view for
 * anything rate-, saving- or tax-shaped. It is the same test the success stories carry,
 * because this is the third time the same calculator has tried to arrive wearing a
 * different hat: once as `savings_monthly` on a story, once as a Budget Planner on the
 * company comparison, and now as its own page.
 *
 * WHAT IS REAL is the introduction. A consultant wants to talk to somebody who knows their
 * jurisdiction, and this site knows which consultants and which specialists exist. So this
 * is an ENQUIRY, and every field below earns its place by being needed to route it.
 *
 * WHAT IS NOT COLLECTED, AND WHY. The reference's form takes forty fields from an
 * anonymous visitor: current employer, contract end date, notice period, gross and net
 * monthly pay, current tax rate, VAT registration, desired day rate. That is a complete
 * financial and employment profile handed over before anybody has agreed to anything. A
 * first conversation needs six things. Everything else is asked by the specialist, in that
 * conversation, under their own engagement terms — which is also the only place a
 * professional duty of confidentiality attaches. It does not attach here.
 */

/**
 * What somebody can usefully be introduced about.
 *
 * A topic is routing information, not a diagnosis: it decides who reads the enquiry and
 * nothing else.
 */
const TOPICS = Object.freeze([
  Object.freeze({ value: 'structure', label: 'How I should be set up (employed, freelance, own company)' }),
  Object.freeze({ value: 'cross_border', label: 'Working for clients in another country' }),
  Object.freeze({ value: 'relocation', label: 'Moving country, or already moved' }),
  Object.freeze({ value: 'first_contract', label: 'Going contracting for the first time' }),
  Object.freeze({ value: 'other', label: 'Something else' })
]);

/**
 * How somebody works TODAY. Coarse on purpose: it is the one fact that decides whether an
 * introduction can help at all, and a finer answer belongs in the conversation.
 */
const ARRANGEMENTS = Object.freeze([
  Object.freeze({ value: 'employed', label: 'Employed by one company' }),
  Object.freeze({ value: 'freelance', label: 'Freelancing as an individual' }),
  Object.freeze({ value: 'own_company', label: 'Through my own company' }),
  Object.freeze({ value: 'umbrella', label: 'Through an umbrella or agency payroll' }),
  Object.freeze({ value: 'other', label: 'Something else' })
]);

const LIMITS = Object.freeze({
  name: 120,
  email: 190,
  // Deliberately longer than the two characters a country code is. It bounds the input
  // before the pattern runs; the pattern decides validity. A bound of exactly 2 would
  // TRUNCATE `ALB` into a valid-looking `AL` and `AUT` into Australia.
  country: 16,
  question: 2000,
  questionMin: 20
});

/**
 * How long an enquiry is kept.
 *
 * Declared because this is personal data collected for one named purpose. Once the
 * introduction is made, or the enquiry is closed, the Hub has no reason to hold it — the
 * specialist has their own record under their own terms. The admin screen shows how many
 * are due to go, so "we keep it for 180 days" is a fact somebody can check rather than a
 * sentence in a policy.
 */
const RETENTION_DAYS = 180;

/**
 * What the page promises, in ONE place, so the copy on the page and the behaviour of the
 * code cannot drift. The second list is the more important one.
 */
const PROMISE = Object.freeze({
  does: Object.freeze([
    'Passes what you write to a specialist who works in your country.',
    'Tells you who they are before anything else happens.',
    `Keeps your enquiry for ${RETENTION_DAYS} days after it is closed, and then deletes it.`
  ]),
  doesNot: Object.freeze([
    'Calculate your tax, your take-home pay, or a saving.',
    'Ask for your salary, your employer, or your notice period.',
    'Give you advice. The Hub is not an accountant and is not regulated to be one.'
  ])
});

function isTopic(value) {
  return TOPICS.some((t) => t.value === value);
}

function isArrangement(value) {
  return ARRANGEMENTS.some((a) => a.value === value);
}

/**
 * Asserted at boot beside the other catalogues, because every failure here is wrong
 * OUTPUT rather than an error: an option the form offers and the validator rejects is a
 * submission that silently fails, and a promise list that has lost its second half is a
 * page making a claim nothing holds it to.
 */
function assertTaxAdvisoryIntegrity() {
  const problems = [];
  const seen = new Set();

  [['topic', TOPICS], ['arrangement', ARRANGEMENTS]].forEach(([name, list]) => {
    if (!list.length) problems.push(`${name} has no options`);
    list.forEach((item) => {
      if (!item.value || !item.label) problems.push(`a ${name} option is missing its value or label`);
      const key = `${name}:${item.value}`;
      if (seen.has(key)) problems.push(`duplicate ${name} "${item.value}"`);
      seen.add(key);
    });
  });

  if (!(RETENTION_DAYS > 0)) problems.push('retention must be a positive number of days');
  if (LIMITS.questionMin >= LIMITS.question) problems.push('the question bounds are inverted');

  // The refusal, asserted rather than only commented. A promise list that lost its second
  // half is a page claiming to introduce while quietly having stopped saying what it will
  // not do.
  if (PROMISE.doesNot.length < 3) problems.push('the "does not" list is what this feature is');
  if (!PROMISE.doesNot.some((line) => /saving/i.test(line))) {
    problems.push('the page must say, in words, that it does not calculate a saving');
  }

  if (problems.length) {
    throw new Error(`config/taxAdvisory.js is inconsistent:\n  - ${problems.join('\n  - ')}`);
  }
  return true;
}

module.exports = {
  TOPICS,
  ARRANGEMENTS,
  LIMITS,
  RETENTION_DAYS,
  PROMISE,
  isTopic,
  isArrangement,
  assertTaxAdvisoryIntegrity
};
