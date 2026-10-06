'use strict';

const assistantConfig = require('./assistant');
const config = require('./config');

/**
 * Drafting a first outreach message in the CRM.
 *
 * Separate from `config/assistant.js` because it is a different job with a different
 * sensible model — site navigation help is lookup, a cold first paragraph is writing — but
 * it DEFAULTS to the assistant's model and the assistant's prices, so a deployment that
 * does not care has one knob rather than three.
 *
 * It spends from the SAME month-to-date ledger and the same cap. Two AI features with two
 * budgets is two invoices and no answer to "what did this cost"; outreach must not be able
 * to quietly become the largest line on one.
 */

const MODEL = process.env.CRM_DRAFT_MODEL || assistantConfig.MODEL;

/*
 * Published list price per MILLION tokens, in USD, for the model above.
 *
 * Defaulted from the assistant's so the common case needs nothing, and asserted below so
 * the uncommon case cannot go wrong quietly — a model changed without its prices makes the
 * budget breaker cut off early or late, and either way silently, because nothing else in
 * the system knows what a call costs.
 */
const PRICE_PER_MTOK_INPUT = Number(process.env.CRM_DRAFT_PRICE_INPUT_USD || assistantConfig.PRICE_PER_MTOK_INPUT);
const PRICE_PER_MTOK_OUTPUT = Number(process.env.CRM_DRAFT_PRICE_OUTPUT_USD || assistantConfig.PRICE_PER_MTOK_OUTPUT);

/**
 * The output ceiling, and it is not the length of the message.
 *
 * Thinking is on and thinking tokens are billed as output against this same ceiling, so
 * this is what stops one draft running away rather than what decides how long it is.
 * Length comes from the prompt and from the verifier, which refuses anything outside the
 * word bounds below.
 */
const MAX_OUTPUT_TOKENS = 1600;

const EFFORT = process.env.CRM_DRAFT_EFFORT || 'low';

/** Nobody reads a cold email of four hundred words, and forty is not a message. */
const MIN_WORDS = 40;
const MAX_WORDS = 160;

/** Cost of one draft, in USD, from the token counts the API reported. */
function costUsd(inputTokens, outputTokens) {
  const input = (Number(inputTokens) || 0) / 1e6;
  const output = (Number(outputTokens) || 0) / 1e6;
  return input * PRICE_PER_MTOK_INPUT + output * PRICE_PER_MTOK_OUTPUT;
}

function isConfigured() {
  return Boolean(config.assistant.apiKey);
}

/**
 * Asserted at boot, and the first check is the one this file exists for.
 *
 * CHANGING THE MODEL WITHOUT CHANGING THE PRICES is the failure here, and it is silent:
 * the breaker keeps charging the old rate against the new model and the first anybody
 * hears of it is the invoice. Defaulting the prices from the assistant's makes the common
 * case right; this makes the uncommon case loud.
 */
function draftingProblems() {
  const problems = [];

  if (!MODEL || typeof MODEL !== 'string') problems.push('no drafting model is configured');

  const modelOverridden = Boolean(process.env.CRM_DRAFT_MODEL) && MODEL !== assistantConfig.MODEL;
  const pricesOverridden =
    Boolean(process.env.CRM_DRAFT_PRICE_INPUT_USD) && Boolean(process.env.CRM_DRAFT_PRICE_OUTPUT_USD);
  if (modelOverridden && !pricesOverridden) {
    problems.push(
      `CRM_DRAFT_MODEL is set to "${MODEL}" but its prices are not. Set CRM_DRAFT_PRICE_INPUT_USD and `
        + 'CRM_DRAFT_PRICE_OUTPUT_USD too, or the budget is being charged at another model\'s rate.'
    );
  }

  [['input', PRICE_PER_MTOK_INPUT], ['output', PRICE_PER_MTOK_OUTPUT]].forEach(([name, price]) => {
    if (!Number.isFinite(price) || price <= 0) {
      problems.push(`the ${name} price is ${price} — a zero price makes every draft free and the cap meaningless`);
    }
  });

  if (!assistantConfig.EFFORT_LEVELS.includes(EFFORT)) {
    problems.push(`effort "${EFFORT}" is not one of ${assistantConfig.EFFORT_LEVELS.join(', ')}`);
  }
  if (!Number.isInteger(MAX_OUTPUT_TOKENS) || MAX_OUTPUT_TOKENS < 400) {
    problems.push('the output ceiling is below 400 tokens — with thinking on, the draft would be cut mid-sentence');
  }
  if (!(MIN_WORDS > 0) || !(MAX_WORDS > MIN_WORDS)) problems.push('the word bounds are not a range');

  return problems;
}

function assertDraftingIntegrity() {
  const problems = draftingProblems();
  if (problems.length) {
    throw new Error(`config/drafting.js is inconsistent:\n  - ${problems.join('\n  - ')}`);
  }
  return true;
}

module.exports = {
  MODEL,
  EFFORT,
  MAX_OUTPUT_TOKENS,
  MIN_WORDS,
  MAX_WORDS,
  PRICE_PER_MTOK_INPUT,
  PRICE_PER_MTOK_OUTPUT,
  costUsd,
  isConfigured,
  draftingProblems,
  assertDraftingIntegrity
};
