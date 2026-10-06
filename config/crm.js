'use strict';

const { PRODUCT_LINES, lineByValue } = require('./sapProducts');

/**
 * The internal sales CRM: leads, and the rules that make holding them defensible.
 *
 * WHAT THIS FEATURE ACTUALLY IS, because every decision below follows from it. Every other
 * table in this application holds something somebody gave us — an account they created, a
 * profile they published, a rate they contributed, an enquiry they sent. This one holds
 * the names, addresses, phone numbers and job titles of people who have NOT asked to be
 * contacted, so that somebody can contact them. That is a different kind of object and it
 * carries obligations the rest of the schema does not: a lawful basis, a record of where
 * the contact came from, a way to object, and a suppression that outlives the row.
 *
 * Four rules, each held in the schema or in a pure function rather than left to a handler:
 *
 * 1. A LEAD CANNOT EXIST WITHOUT A SOURCE. `source` is NOT NULL and must be one of the
 *    values below, and most of them require a detail. "Where did you get this person's
 *    address" is the first question anybody will ask, and the answer has to be recorded at
 *    the moment of the import rather than reconstructed from memory a year later.
 *
 * 2. THE SOURCE IS FIRST-TOUCH AND PERMANENT. A re-import does not overwrite it. It is the
 *    lawful-basis record, and a record a later file can rewrite is not one — the same
 *    argument as `referral_attributions` being unique and never overwritten.
 *
 * 3. SUPPRESSION OUTLIVES THE ROW. `crm_suppressions` is keyed on a hash of the address and
 *    has no foreign key to `crm_leads`. Deleting a lead is exactly how an application loses
 *    the fact that its subject asked never to be contacted again, and the next quarterly
 *    import then writes them straight back in.
 *
 * 4. NOTHING IS SENT FROM HERE. A draft is written, a person reads it, a person sends it
 *    from their own mail client, and a person records that they did. An application that
 *    can mail a thousand strangers on a schedule is a different product with a different
 *    risk profile, and it is on this project's standing refusal list.
 */

/**
 * Where a contact came from.
 *
 * Deliberately short and concrete: a free-text source field fills up with "web" and tells
 * nobody anything a year later. `needsDetail` marks the ones where the category alone is
 * not an answer — "a public directory" means something only with the directory named.
 */
const LEAD_SOURCES = Object.freeze([
  Object.freeze({
    value: 'inbound',
    label: 'They contacted us',
    needsDetail: true,
    help: 'A form, an email or a call from them. Name which — an enquiry number is ideal.'
  }),
  Object.freeze({
    value: 'event',
    label: 'Met at an event',
    needsDetail: true,
    help: 'Name the event and roughly when. "SAP Sapphire, June" is an answer; "a conference" is not.'
  }),
  Object.freeze({
    value: 'referral',
    label: 'Introduced by someone',
    needsDetail: true,
    help: 'Who made the introduction.'
  }),
  Object.freeze({
    value: 'public_directory',
    label: 'A public business directory',
    needsDetail: true,
    help: 'Name the directory. A business address published for business contact is not the same as a personal one.'
  }),
  Object.freeze({
    value: 'company_website',
    label: 'Published on the company website',
    needsDetail: true,
    help: 'The page it was published on.'
  }),
  Object.freeze({
    value: 'sap_partner_directory',
    label: 'The SAP partner directory',
    needsDetail: true,
    help: 'Which listing. This ecosystem publishes its partners, which is the most defensible source on this list.'
  }),
  Object.freeze({
    value: 'existing_customer',
    label: 'Already a customer',
    needsDetail: false,
    help: 'They have an account here or have paid for something.'
  })
]);

const SOURCE_VALUES = Object.freeze(LEAD_SOURCES.map((s) => s.value));

/**
 * The pipeline, as declared transitions — the same shape as `models/Application.js`. An
 * undeclared move is refused rather than written, so the board cannot reach a state no
 * screen has a column for.
 *
 * `unsubscribed` is terminal, is reachable from everywhere in ONE step, and is the only
 * status that writes a suppression. Somebody asking to be left alone must never depend on
 * the pipeline happening to be in the right place first.
 */
const TRANSITIONS = Object.freeze({
  new: Object.freeze(['contacted', 'parked', 'unsubscribed', 'disqualified']),
  contacted: Object.freeze(['replied', 'parked', 'unsubscribed', 'disqualified']),
  replied: Object.freeze(['qualified', 'parked', 'unsubscribed', 'disqualified']),
  qualified: Object.freeze(['won', 'lost', 'unsubscribed']),
  parked: Object.freeze(['contacted', 'unsubscribed', 'disqualified']),
  won: Object.freeze([]),
  lost: Object.freeze([]),
  disqualified: Object.freeze([]),
  unsubscribed: Object.freeze([])
});

const STATUSES = Object.freeze(Object.keys(TRANSITIONS));
const TERMINAL = Object.freeze(STATUSES.filter((s) => TRANSITIONS[s].length === 0));

/** How a message would go out. Recorded, never used to send anything. */
const CHANNELS = Object.freeze([
  Object.freeze({ value: 'email', label: 'Email' }),
  Object.freeze({ value: 'linkedin', label: 'LinkedIn message' }),
  Object.freeze({ value: 'phone', label: 'Phone' }),
  Object.freeze({ value: 'other', label: 'Something else' })
]);

const CHANNEL_VALUES = Object.freeze(CHANNELS.map((c) => c.value));

/**
 * What an activity records. Append-only; there is no edit and no delete.
 *
 * `CONTACT_OUTCOMES` is the subset that means somebody was actually written to or spoken
 * to. It decides what may be bulk-deleted: the log of a contact that happened is the
 * record that answers a complaint about it, and a record somebody can tidy away is not one.
 */
const OUTCOMES = Object.freeze([
  Object.freeze({ value: 'sent', label: 'Sent a message', isContact: true }),
  Object.freeze({ value: 'replied', label: 'They replied', isContact: true }),
  Object.freeze({ value: 'no_reply', label: 'No reply', isContact: false }),
  Object.freeze({ value: 'meeting', label: 'Had a meeting', isContact: true }),
  Object.freeze({ value: 'refused', label: 'They said no', isContact: true }),
  Object.freeze({ value: 'note', label: 'Just a note', isContact: false })
]);

const OUTCOME_VALUES = Object.freeze(OUTCOMES.map((o) => o.value));
const CONTACT_OUTCOMES = Object.freeze(OUTCOMES.filter((o) => o.isContact).map((o) => o.value));

const LIMITS = Object.freeze({
  company: 200,
  contactName: 200,
  email: 190,
  phone: 40,
  jobTitle: 200,
  url: 500,
  sourceDetail: 300,
  note: 2000,
  draft: 4000,
  // An import is read into memory and previewed before anything is written, so it is
  // bounded at a number of rows a person can actually review.
  importRows: 500
});

/**
 * How long a lead nobody has touched is kept.
 *
 * This is personal data held for one named purpose, and a purpose that has visibly stopped
 * applying is not a purpose. Eighteen months with no activity means the person has moved
 * on; holding their old work address helps nobody.
 */
const STALE_AFTER_DAYS = 540;

/** The bulk operations a screen may run. */
const BULK_ACTIONS = Object.freeze(['delete', 'park']);

function isSource(value) {
  return SOURCE_VALUES.includes(value);
}

function sourceNeedsDetail(value) {
  const source = LEAD_SOURCES.find((s) => s.value === value);
  return Boolean(source && source.needsDetail);
}

function isStatus(value) {
  return STATUSES.includes(value);
}

function isChannel(value) {
  return CHANNEL_VALUES.includes(value);
}

function isOutcome(value) {
  return OUTCOME_VALUES.includes(value);
}

function isContactOutcome(value) {
  return CONTACT_OUTCOMES.includes(value);
}

function canTransition(from, to) {
  return Boolean(TRANSITIONS[from] && TRANSITIONS[from].includes(to));
}

function isTerminal(status) {
  return TERMINAL.includes(status);
}

/** The product lines a lead can be tagged with — the site's own vocabulary, not a new one. */
function isLeadProductLine(value) {
  return Boolean(value && lineByValue(value));
}

/**
 * Asserted at boot beside the other catalogues.
 *
 * Every failure here produces WRONG BEHAVIOUR rather than an error, and two of them are
 * about somebody's right to be left alone — which is the one thing on this screen that
 * cannot be fixed afterwards.
 */
function assertCrmIntegrity() {
  const problems = [];

  if (!LEAD_SOURCES.length) problems.push('A lead needs at least one possible source.');
  const seen = new Set();
  LEAD_SOURCES.forEach((source) => {
    if (!source.value || !source.label || !source.help) {
      problems.push(`Source "${source.value}" is missing a value, a label or its help text.`);
    }
    if (seen.has(source.value)) problems.push(`Source "${source.value}" is declared twice.`);
    seen.add(source.value);
  });

  Object.entries(TRANSITIONS).forEach(([from, targets]) => {
    targets.forEach((to) => {
      if (!TRANSITIONS[to]) problems.push(`Transition ${from} → ${to} names a status that is not declared.`);
    });
  });

  // One step to "leave me alone", from everywhere it is still possible.
  STATUSES.forEach((status) => {
    if (isTerminal(status)) return;
    if (!TRANSITIONS[status].includes('unsubscribed')) {
      problems.push(`A lead in "${status}" cannot be unsubscribed in one step.`);
    }
  });

  if (!TERMINAL.includes('unsubscribed')) problems.push('`unsubscribed` must be terminal.');
  if (!CONTACT_OUTCOMES.length) problems.push('No outcome counts as having contacted somebody.');
  if (!CONTACT_OUTCOMES.includes('sent')) problems.push('Sending a message must count as a contact.');
  if (!(STALE_AFTER_DAYS > 0)) problems.push('The stale threshold must be positive.');
  if (!PRODUCT_LINES.length) problems.push('The product lines a lead is tagged with come from config/sapProducts.js.');

  if (problems.length) {
    throw new Error(`config/crm.js is inconsistent:\n  - ${problems.join('\n  - ')}`);
  }
  return true;
}

module.exports = {
  LEAD_SOURCES,
  SOURCE_VALUES,
  TRANSITIONS,
  STATUSES,
  TERMINAL,
  CHANNELS,
  CHANNEL_VALUES,
  OUTCOMES,
  OUTCOME_VALUES,
  CONTACT_OUTCOMES,
  LIMITS,
  STALE_AFTER_DAYS,
  BULK_ACTIONS,
  isSource,
  sourceNeedsDetail,
  isStatus,
  isChannel,
  isOutcome,
  isContactOutcome,
  isLeadProductLine,
  canTransition,
  isTerminal,
  assertCrmIntegrity
};
