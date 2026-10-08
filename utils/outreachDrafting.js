'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const config = require('../config/config');
const drafting = require('../config/drafting');
const ApiUsage = require('../models/ApiUsage');
const { assertWithinBudget, chargeToCache } = require('./aiBudget');
const { LIMITS } = require('../config/crm');
const { PRODUCT_LINES, ALL_MODULES, lineLabel } = require('../config/sapProducts');

/**
 * Drafting a first outreach message.
 *
 * THIS WRITES A DRAFT AND NOTHING ELSE. There is no send path in this module or in the
 * route above it: a person reads what came back, edits it, sends it from their own mail
 * client, and records that they did. A generate endpoint feeding a queue is one scheduler
 * away from an application that mails a thousand strangers on its own, and that is on this
 * project's standing refusal list.
 *
 * THE MODEL IS GIVEN NO PERSONAL DETAIL. `factsFor` hands over the company, the country,
 * the job title and the product lines somebody recorded — and nothing else. Not the name,
 * not the address, not the phone number, not the LinkedIn profile. None of it improves a
 * first paragraph about what the Hub does, and all of it would be somebody's contact
 * details leaving for a third party. A test asserts it.
 *
 * Spend goes to the SAME `ai_usage` ledger and the same month-to-date cap as the
 * assistant, so outreach cannot quietly become the largest line on the invoice.
 */

const FEATURE = 'crm_outreach';

let client = null;

function isConfigured() {
  return drafting.isConfigured();
}

function getClient() {
  if (!client) client = new Anthropic({ apiKey: config.assistant.apiKey });
  return client;
}

function setClientForTests(fake) {
  client = fake;
}

/**
 * The vocabulary the model is allowed to use for SAP itself, GENERATED from
 * `config/sapProducts.js` rather than typed here.
 *
 * Same rule as the assistant's prompt: a hand-typed list of SAP products in a prompt is a
 * second catalogue, and the drift is a draft confidently naming a product the rest of the
 * site has never heard of. Here it is worse than a wrong link — it is a sentence somebody
 * sends to a stranger under their own name.
 */
const PRODUCT_VOCABULARY = PRODUCT_LINES.map((line) => `- ${line.label}`).join('\n');

/**
 * The instruction, composed ONCE at module load so it is byte-identical on every call and
 * the cached prefix actually hits. Interpolating anything per-draft into this block would
 * multiply the input cost of the whole feature — the same reason the assistant splits its
 * system prompt in two.
 */
const ROLE = `You write the first paragraph of a cold outreach message on behalf of SAP Hub, a marketplace where SAP consultants find contract work and companies hire them, and where companies can get an SAP Activate-shaped scope estimate.

A person will read what you write, edit it, and send it from their own mail client under their own name. You are writing their first draft.

Rules, and the first one is not negotiable:

- Invent nothing about the recipient. You are given a company name, a country, a job title and possibly a note of which SAP product areas somebody recorded against them. You do not know their projects, their headcount, their landscape, their release, their revenue, or anything they have said publicly. Write as somebody who has looked up a company and nothing more.
- Never claim to have read, seen, noticed or admired anything of theirs. "I saw your recent post about…" is a lie in a first line, and it is the one that gets an address blocked.
- Name an SAP product area ONLY if it was given to you. If none was given, do not guess at one — do not mention any SAP module, component or two-letter code at all. Guessing which SAP products a company runs is the most plausible-sounding invention available to you and the easiest for the reader to catch.
- When a product area was given, use the name exactly as it appears in this list and no other SAP product name:
${PRODUCT_VOCABULARY}
- No statistics, no percentages, no figures of any kind, and no numerals. You have not been given any, so any you write are invented.
- No guarantee, warranty, indemnity, penalty, fixed price, or promise of a result or a saving.
- Say plainly why they are being contacted and what is on offer. One short paragraph, then one sentence asking whether it is worth a conversation.
- Plain text. No subject line, no greeting, no sign-off — the sender adds those.
- Write in English. The sender will translate it if they want to.`;

/**
 * What the model is told about this lead.
 *
 * Deliberately thin. The person's name is put back by the sender afterwards, locally, from
 * the row — it never leaves this process.
 */
function factsFor(lead) {
  const lines = [`Company: ${lead.company}`];
  if (lead.job_title) lines.push(`The recipient's job title: ${lead.job_title}`);
  if (lead.country) lines.push(`Country: ${lead.country}`);

  const recorded = Array.isArray(lead.product_lines) ? lead.product_lines : [];
  if (recorded.length) {
    lines.push(`SAP product areas recorded against them: ${recorded.map((v) => lineLabel(v)).join(', ')}`);
  } else {
    lines.push('No SAP product area has been recorded against them. Do not name one.');
  }
  return lines.join('\n');
}

/**
 * Terms that turn a draft into a commitment.
 *
 * A first paragraph is not the place to warrant anything, and a draft that does is one an
 * editor has to notice rather than one a person can send.
 */
const COMMITMENT_TERMS = Object.freeze([
  'guarantee', 'guaranteed', 'warrant', 'warranty', 'indemnif', 'penalty',
  'fixed price', 'fixed-price', 'no risk', 'risk-free', 'we promise', 'save you', 'savings of'
]);

/**
 * Phrases that claim a familiarity the model cannot have.
 *
 * It was given a company name and a job title. Every one of these implies it read
 * something, and a first line that opens on a fabricated observation is the single most
 * reliable way to get an address blocked.
 */
const FABRICATED_FAMILIARITY = Object.freeze([
  'i saw', 'i noticed', 'i read', 'i came across', 'i have been following', "i've been following",
  'your recent', 'your latest', 'impressed by', 'i admire', 'congratulations on',
  'i enjoyed', 'as a fellow'
]);

/**
 * Every SAP name the catalogue knows, as things to look for in a draft.
 *
 * The long labels are matched case-insensitively; the two-letter codes are matched as
 * WHOLE WORDS AND ONLY IN UPPER CASE, which is the one spelling that is unambiguously an
 * SAP module. `utils/jobMatcher.js` learned this the other way round: `includes('mm')`
 * matches "committed" and `includes('fi')` matches "specific", and every SAP advert
 * contains both.
 */
function sapTermsFromCatalogue() {
  const longNames = new Set();
  const codes = new Set();

  PRODUCT_LINES.forEach((line) => longNames.add(line.label.toLowerCase()));
  ALL_MODULES.forEach((module) => {
    // "General Ledger (FI-GL)" → the words, and the code inside the brackets.
    const bracket = module.label.match(/\(([^)]+)\)/);
    const plain = module.label.replace(/\s*\([^)]*\)\s*/, '').trim();
    if (plain.length > 4) longNames.add(plain.toLowerCase());
    if (bracket) {
      bracket[1].split(/[-/\s]+/).forEach((part) => {
        if (/^[A-Z]{2,4}$/.test(part)) codes.add(part);
      });
    }
  });

  return { longNames: [...longNames], codes: [...codes] };
}

const SAP_TERMS = sapTermsFromCatalogue();

function wordBoundaryHit(text, term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`).test(text);
}

/**
 * Check a draft before anybody sees it.
 *
 * Narrower than a quote narrative's checks because the risk is different: a quote must not
 * contradict an estimate, while an outreach message must not invent a relationship, a
 * figure, or a fact about somebody's SAP landscape.
 *
 * `lead` is needed for the last of those: what counts as invented depends on what was
 * recorded. A draft naming S/4HANA Finance is correct for a lead tagged with it and a
 * guess for a lead tagged with nothing.
 */
function problemsWith(body, lead = {}) {
  const problems = [];
  const text = String(body ?? '').trim();

  const words = text.split(/\s+/).filter(Boolean).length;
  if (words < drafting.MIN_WORDS) problems.push(`Too short: ${words} words, at least ${drafting.MIN_WORDS} expected.`);
  if (words > drafting.MAX_WORDS) problems.push(`Too long: ${words} words, at most ${drafting.MAX_WORDS} allowed.`);

  const lower = text.toLowerCase();

  FABRICATED_FAMILIARITY.forEach((phrase) => {
    if (lower.includes(phrase)) problems.push(`Claims a familiarity it cannot have: "${phrase}".`);
  });

  COMMITMENT_TERMS.forEach((term) => {
    if (lower.includes(term)) problems.push(`Makes a commitment a draft must not make: "${term}".`);
  });

  if (/\[|\]|\{\{|TBD|insert /i.test(text)) problems.push('Contains a placeholder.');

  /*
   * WHAT THE MODEL WAS ACTUALLY GIVEN is cut out before anything else is checked, and
   * there are two things in it.
   *
   * The company's own name, so an SAP partner called "FI Consulting GmbH" does not make
   * every draft about them fail a check about module codes.
   *
   * And the product area labels this lead WAS recorded against — because the catalogue's
   * own names contain digits. "SAP S/4HANA Finance" is a name the prompt tells the model
   * to use, and the numeral rule below would then reject every draft that obeyed. The two
   * rules contradict each other unless the given names come out first, and a test
   * caught it.
   */
  const allowed = (Array.isArray(lead.product_lines) ? lead.product_lines : []).map((v) => lineLabel(v));
  const given = [String(lead.company || ''), ...allowed].filter(Boolean);
  const scrubbed = given.reduce((acc, term) => acc.split(term).join(' '), text);
  const scrubbedLower = given.reduce((acc, term) => acc.split(term.toLowerCase()).join(' '), lower);

  // No digits at all in what is left. The model was handed no figures, so any it wrote are
  // invented — applied bluntly, because there is no estimate here to check one against.
  const numerals = scrubbed.match(/\d+/g);
  if (numerals) problems.push(`Contains figures it was never given: ${[...new Set(numerals)].join(', ')}.`);

  /*
   * The SAP rule. Anything the catalogue knows, that this lead was not recorded against,
   * is the model guessing at somebody's landscape.
   */
  SAP_TERMS.longNames.forEach((name) => {
    if (scrubbedLower.includes(name)) problems.push(`Names an SAP product area it was not given: "${name}".`);
  });

  SAP_TERMS.codes.forEach((code) => {
    if (wordBoundaryHit(scrubbed, code)) {
      problems.push(`Names an SAP module code it was not given: "${code}".`);
    }
  });

  return problems;
}

function textOf(response) {
  return (response.content || [])
    .filter((chunk) => chunk.type === 'text')
    .map((chunk) => chunk.text)
    .join('\n')
    .trim();
}

/**
 * Draft one message.
 *
 * Returns `{ ok: false, reason }` rather than throwing for every outcome a person can act
 * on — not switched on, out of budget, the model declined, the draft failed its checks.
 * The caller is a form post on an internal screen, and an exception there is a 500 page
 * where a sentence was wanted.
 */
async function draftFor(lead, { userId = null } = {}) {
  if (!isConfigured()) return { ok: false, reason: 'Drafting is not switched on here.' };

  try {
    // Before the call, because what a call costs is only known after it.
    await assertWithinBudget(userId);
  } catch (err) {
    if (err.code === 'BUDGET_EXCEEDED') return { ok: false, reason: err.message };
    throw err;
  }

  let response;
  try {
    response = await getClient().beta.messages.create({
      model: drafting.MODEL,
      max_tokens: drafting.MAX_OUTPUT_TOKENS,
      output_config: { effort: drafting.EFFORT },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [{ type: 'text', text: ROLE, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `${factsFor(lead)}\n\n---\n\nWrite the draft.` }]
    });
  } catch (err) {
    /*
     * Recorded at zero cost so the error rate is visible on /admin/ai. A feature failing
     * every call is invisible in a ledger that only lists what was paid for.
     */
    ApiUsage.record({ feature: FEATURE, model: drafting.MODEL, userId, outcome: 'error' });
    if (err.status === 400) {
      console.error(
        'Outreach drafting: the API REJECTED THE REQUEST SHAPE (400). This will not recover on its own — '
          + `check the model, the effort level and the beta flags in config/drafting.js. ${err.message}`
      );
    }
    console.error(`Outreach drafting failed for lead #${lead.id}: ${err.message}`);
    return { ok: false, reason: 'The drafting service did not answer. Try again in a moment.' };
  }

  const usage = response.usage || {};
  const inputTokens =
    (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  const outputTokens = usage.output_tokens || 0;
  const cost = drafting.costUsd(inputTokens, outputTokens);

  ApiUsage.record({
    feature: FEATURE,
    model: response.model || drafting.MODEL,
    userId,
    inputTokens,
    outputTokens,
    costUsd: cost,
    outcome: 'ok'
  });
  // Added to the cached total as well, or a burst inside one cache window all reads the
  // same stale figure and sails past the cap together.
  chargeToCache(userId, cost);

  // Checked before the content is read: a refusal comes back as an HTTP 200.
  if (response.stop_reason === 'refusal') {
    return { ok: false, reason: 'The model declined to draft this one. Write it yourself.' };
  }

  const body = textOf(response).slice(0, LIMITS.draft);

  if (response.stop_reason === 'max_tokens') {
    // Never served as though it were finished. With thinking on, the ceiling covers
    // reasoning too, so this is the realistic way to arrive here half-written.
    return { ok: false, reason: 'That draft ran past its ceiling and stopped mid-sentence. Try again.', body };
  }

  const problems = problemsWith(body, lead);
  if (problems.length) {
    /*
     * Returned with its reasons and NEVER STORED, and never silently retried. Somebody
     * should see that the model invented a relationship or a module, because that is the
     * failure this feature has to be watched for — and a retry loop would hide it while
     * paying for each attempt.
     */
    return { ok: false, reason: 'The draft failed its checks and was discarded.', problems, body };
  }

  return { ok: true, body, model: response.model || drafting.MODEL, inputTokens, outputTokens };
}

module.exports = {
  FEATURE,
  ROLE,
  COMMITMENT_TERMS,
  FABRICATED_FAMILIARITY,
  SAP_TERMS,
  isConfigured,
  factsFor,
  problemsWith,
  draftFor,
  setClientForTests
};
