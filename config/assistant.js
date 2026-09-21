'use strict';

const config = require('./config');

/**
 * The in-site assistant: what it costs, what it is allowed to spend, and how much of a
 * conversation ever reaches the model.
 *
 * Every number an attacker could turn into a bill lives HERE rather than in the route,
 * because a paid endpoint with its limits scattered across three files is a paid endpoint
 * whose limits nobody can state.
 */

/*
 * The model.
 *
 * `claude-opus-5` is the default, and the cost of that choice is stated rather than
 * hidden: an Opus answer costs roughly five times a Haiku one, so the same monthly cap
 * buys about a fifth as many exchanges. The reference chose the cheap model for this job
 * on the grounds that site navigation help is lookup, not reasoning — a defensible
 * argument, and the wrong one to make silently on somebody else's behalf. The model is
 * therefore the one knob a deployment is expected to turn, and `/admin/ai` prints which
 * one is answering next to what it has spent.
 *
 * Whatever is chosen, PRICES MUST MOVE WITH IT — see the note below.
 */
const MODEL = process.env.ASSISTANT_MODEL || 'claude-opus-5';

/*
 * Published list price per MILLION tokens, in USD, for the model above.
 *
 * These are here to be CHECKED, not trusted forever. A price that moved, or a model
 * changed by the environment variable above without changing these, makes the budget
 * circuit-breaker cut off early or late — and either way silently, because nothing else
 * in the system knows what a call costs. Both are overridable so a deployment can correct
 * them without waiting for a release.
 */
const PRICE_PER_MTOK_INPUT = Number(process.env.ASSISTANT_PRICE_INPUT_USD || 5);
const PRICE_PER_MTOK_OUTPUT = Number(process.env.ASSISTANT_PRICE_OUTPUT_USD || 25);

/**
 * How hard the model works on an answer.
 *
 * `low`, because this is site navigation help: the answer is in the knowledge base and
 * the job is to find it and say it in under 150 words. Thinking is left ON — turning it
 * off on this model is a documented footgun, and the cheaper way to spend less is to
 * lower the effort, not to remove the reasoning.
 */
const EFFORT = process.env.ASSISTANT_EFFORT || 'low';
const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

/*
 * The output cap, and it is NOT the length of the answer.
 *
 * Thinking is on, and thinking tokens are billed as output and counted against this same
 * ceiling. The reference's 700 was right for a model that does not think: here it would
 * spend most of the allowance reasoning and then truncate the visible answer mid-sentence,
 * which reads as a broken feature rather than a cap. Brevity comes from the prompt ("under
 * about 150 words") and from the low effort level; this is the ceiling that stops one
 * exchange running away, and `stop_reason: "max_tokens"` is checked so hitting it is
 * never served as if it were a finished answer.
 */
const MAX_OUTPUT_TOKENS = 2000;

/** What reaches the model from one request. All three are hard caps, not suggestions. */
const MAX_MESSAGE_CHARS = 2000;
const MAX_HISTORY_ENTRIES = 12;
const MAX_HISTORY_ENTRY_CHARS = 1500;

/**
 * Spend caps, month to date, in USD. 0 disables a cap.
 *
 * The GLOBAL cap is the one that matters: it is the only thing standing between a
 * distributed flood and an unbounded invoice, because rate limiting cannot bound
 * aggregate spend. The PER-USER cap stops one signed-in account eating the global budget
 * on its own; anonymous visitors are governed by the global cap and the rate limiters
 * alone, since there is nothing durable to key a per-person total on.
 */
const GLOBAL_MONTHLY_BUDGET_USD = Number(process.env.AI_MONTHLY_BUDGET_USD || 25);
const USER_MONTHLY_BUDGET_USD = Number(process.env.AI_USER_MONTHLY_BUDGET_USD || 2);

/**
 * Request rate. Per-IP, plus a process-wide backstop.
 *
 * The backstop is not redundant: 500 addresses each staying politely under 25 requests is
 * still 12,500 model calls, and only a global counter sees that.
 */
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX_PER_IP = 25;
const RATE_MAX_GLOBAL = 300;

/** Cost of one exchange, in USD, from the token counts the API reported. */
function costUsd(inputTokens, outputTokens) {
  const input = (Number(inputTokens) || 0) / 1e6;
  const output = (Number(outputTokens) || 0) / 1e6;
  return input * PRICE_PER_MTOK_INPUT + output * PRICE_PER_MTOK_OUTPUT;
}

/** No key, no feature. The widget is not rendered and the endpoint answers 503. */
function isConfigured() {
  return Boolean(config.assistant.apiKey);
}

/**
 * Asserted at boot, like every other catalogue here, because each of these produces WRONG
 * OUTPUT rather than an error:
 *
 *  - a price of zero makes every call free, so the circuit-breaker never trips and the
 *    first anybody hears of it is the invoice;
 *  - a negative or absurd cap is a cap nobody can reason about;
 *  - a history cap of zero sends a conversation with no context and the assistant repeats
 *    itself, which reads as a broken feature rather than a misconfiguration;
 *  - an effort level the API does not accept is a 400 on every single request, and this
 *    endpoint's own error path turns that into "please try again in a moment" forever.
 */
function assistantProblems() {
  const problems = [];

  if (!MODEL || typeof MODEL !== 'string') problems.push('no model is configured');
  if (!EFFORT_LEVELS.includes(EFFORT)) {
    problems.push(`effort "${EFFORT}" is not one of ${EFFORT_LEVELS.join(', ')}`);
  }

  for (const [name, price] of [
    ['input', PRICE_PER_MTOK_INPUT],
    ['output', PRICE_PER_MTOK_OUTPUT]
  ]) {
    if (!Number.isFinite(price) || price <= 0) {
      problems.push(`the ${name} price is ${price} — a zero price makes every call free and the budget cap meaningless`);
    }
  }

  for (const [name, cap] of [
    ['global', GLOBAL_MONTHLY_BUDGET_USD],
    ['per-user', USER_MONTHLY_BUDGET_USD]
  ]) {
    if (!Number.isFinite(cap) || cap < 0) problems.push(`the ${name} budget cap is not a positive number`);
  }
  if (GLOBAL_MONTHLY_BUDGET_USD > 0 && USER_MONTHLY_BUDGET_USD > GLOBAL_MONTHLY_BUDGET_USD) {
    problems.push('the per-user cap is above the global cap, so it can never bind');
  }

  if (!Number.isInteger(MAX_OUTPUT_TOKENS) || MAX_OUTPUT_TOKENS < 100) {
    problems.push('the output cap is below 100 tokens — answers would be cut mid-sentence');
  }
  if (!Number.isInteger(MAX_MESSAGE_CHARS) || MAX_MESSAGE_CHARS < 100) {
    problems.push('the message cap is below 100 characters');
  }
  if (!Number.isInteger(MAX_HISTORY_ENTRIES) || MAX_HISTORY_ENTRIES < 2) {
    problems.push('the history cap is below two entries, so the assistant cannot follow up');
  }
  if (!Number.isInteger(MAX_HISTORY_ENTRY_CHARS) || MAX_HISTORY_ENTRY_CHARS < 100) {
    problems.push('the per-entry history cap is below 100 characters');
  }

  if (RATE_MAX_PER_IP > RATE_MAX_GLOBAL) {
    problems.push('one address may send more than the process-wide backstop allows, so the backstop is dead');
  }

  return problems;
}

function assertAssistantIntegrity() {
  const problems = assistantProblems();
  if (problems.length) {
    throw new Error(`config/assistant.js is inconsistent:\n  - ${problems.join('\n  - ')}`);
  }
  return true;
}

module.exports = {
  MODEL,
  EFFORT,
  EFFORT_LEVELS,
  MAX_OUTPUT_TOKENS,
  MAX_MESSAGE_CHARS,
  MAX_HISTORY_ENTRIES,
  MAX_HISTORY_ENTRY_CHARS,
  GLOBAL_MONTHLY_BUDGET_USD,
  USER_MONTHLY_BUDGET_USD,
  PRICE_PER_MTOK_INPUT,
  PRICE_PER_MTOK_OUTPUT,
  RATE_WINDOW_MS,
  RATE_MAX_PER_IP,
  RATE_MAX_GLOBAL,
  costUsd,
  isConfigured,
  assistantProblems,
  assertAssistantIntegrity
};
