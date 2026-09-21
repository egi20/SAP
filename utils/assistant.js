'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const config = require('../config/config');
const assistantConfig = require('../config/assistant');
const ApiUsage = require('../models/ApiUsage');
const { buildSystemPrompt } = require('./assistantPrompt');
const { assertWithinBudget, chargeToCache } = require('./aiBudget');

/**
 * The only module that talks to the model.
 *
 * It degrades the way `utils/email.js` and `utils/stripe.js` do: with no
 * `ANTHROPIC_API_KEY` the module loads, `isConfigured()` is false, the widget is never
 * rendered and the endpoint answers 503. That is what keeps local development, CI and
 * `npm run validate-boot` working without credentials.
 */

const FEATURE = 'assistant';

/*
 * Server-side refusal fallback.
 *
 * On a policy decline the API re-runs the same request on a fallback model inside the
 * same call, rather than handing this site's visitor a dead end it cannot explain. The
 * scalar "default" form routes by refusal category, so there is no model list here to go
 * stale — which matters for a file whose whole job is to have one model name in it.
 */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

let client = null;

function getClient() {
  if (!assistantConfig.isConfigured()) {
    throw new Error('The assistant is not configured (ANTHROPIC_API_KEY is unset)');
  }
  if (!client) client = new Anthropic({ apiKey: config.assistant.apiKey });
  return client;
}

/** Tests drive a fake client through this rather than reaching the network. */
function setClientForTests(fake) {
  client = fake;
}

/**
 * Turn the caller's claimed history into something safe to send.
 *
 * The history lives in the visitor's own sessionStorage and is posted back with every
 * message, so ALL of it is untrusted input. Three things matter here and each is a cost
 * or a safety bound rather than tidiness:
 *
 *  1. the array is cut BEFORE it is walked — a hostile request can carry tens of
 *     thousands of entries inside the JSON body limit, and only the tail could survive
 *     the final slice anyway;
 *  2. every entry is truncated, so a long history cannot inflate one request's input
 *     tokens without bound;
 *  3. anything malformed is dropped silently rather than repaired. A `role` that is
 *     neither `user` nor `assistant` is not a typo to fix, it is somebody probing.
 */
function sanitiseHistory(history) {
  const { MAX_HISTORY_ENTRIES, MAX_HISTORY_ENTRY_CHARS } = assistantConfig;
  if (!Array.isArray(history)) return [];

  const clean = [];
  for (const entry of history.slice(-MAX_HISTORY_ENTRIES * 2)) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.role !== 'user' && entry.role !== 'assistant') continue;
    if (typeof entry.content !== 'string') continue;
    const content = entry.content.trim();
    if (!content) continue;
    clean.push({ role: entry.role, content: content.slice(0, MAX_HISTORY_ENTRY_CHARS) });
  }

  const capped = clean.slice(-MAX_HISTORY_ENTRIES);

  // The API rejects a conversation that does not open with a user turn, and a history
  // whose head was cut mid-exchange can easily start with an assistant one.
  while (capped.length && capped[0].role !== 'user') capped.shift();
  return capped;
}

/** Every text block, joined. Thinking blocks are not text and never reach the visitor. */
function textOf(response) {
  return (response.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/**
 * Bill what actually happened.
 *
 * Cache reads and writes are billed differently from ordinary input, and counting them in
 * keeps the ledger honest rather than flattering. `response.model` rather than the
 * configured one, because a refusal fallback means the answer may have come from a
 * different model than the one this file asked for — and it is billed at that model's
 * rates, so recording the requested name would file the spend under the wrong thing.
 */
async function recordUsage(response, userId, outcome) {
  const usage = response.usage || {};
  const inputTokens =
    (usage.input_tokens || 0)
    + (usage.cache_creation_input_tokens || 0)
    + (usage.cache_read_input_tokens || 0);
  const outputTokens = usage.output_tokens || 0;
  const costUsd = assistantConfig.costUsd(inputTokens, outputTokens);

  chargeToCache(userId, costUsd);
  await ApiUsage.record({
    feature: FEATURE,
    model: response.model || assistantConfig.MODEL,
    userId,
    inputTokens,
    outputTokens,
    costUsd,
    outcome
  });

  return { inputTokens, outputTokens, costUsd };
}

/**
 * Ask the assistant one question.
 *
 * Not streamed, deliberately: the answer is capped at a couple of hundred words and the
 * widget posts one request and renders one reply, so streaming would add a second
 * transport for no gain the visitor can see.
 *
 * @param {{message:string, history:Array, user:object|null}} input
 * @returns {Promise<{reply:string, truncated:boolean}>}
 * @throws {Error & {code:'BUDGET_EXCEEDED'}} when a spend cap has been reached.
 */
async function ask({ message, history = [], user = null }) {
  const userId = user && user.id ? user.id : null;

  // Before the call, because what a call costs is only known after it. See utils/aiBudget.js.
  await assertWithinBudget(userId);

  const { stable, viewer } = buildSystemPrompt(user);
  const messages = [...sanitiseHistory(history), { role: 'user', content: message }];

  let response;
  try {
    response = await getClient().beta.messages.create({
      model: assistantConfig.MODEL,
      max_tokens: assistantConfig.MAX_OUTPUT_TOKENS,
      output_config: { effort: assistantConfig.EFFORT },
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      system: [
        /*
         * Two blocks, and the split is the whole point. The first is byte-identical on
         * every request and marked cacheable; the second carries the per-viewer context
         * and is not. Merging them would make the entire system prompt volatile and cost
         * full price on every exchange.
         *
         * If the stable block is ever below the model's minimum cacheable length the
         * marker is simply ignored — no error, no behaviour change — so this stays correct
         * as the knowledge base and the generated vocabulary grow past it.
         */
        { type: 'text', text: stable, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: viewer }
      ],
      messages
    });
  } catch (err) {
    /*
     * A transport or validation failure. Nothing is charged for it, and it is recorded at
     * zero cost so the admin screen shows the error rate — an assistant that is failing
     * every call is invisible in a ledger that only lists what was paid for.
     */
    await ApiUsage.record({ feature: FEATURE, model: assistantConfig.MODEL, userId, outcome: 'error' });
    throw err;
  }

  /*
   * A refusal is a billed answer, not an error, and it is recorded as one. `fallbacks`
   * above means the chain has already been re-run on another model, so reaching here
   * means every model declined. The visitor gets a plain sentence rather than a failure
   * they cannot act on.
   */
  if (response.stop_reason === 'refusal') {
    await recordUsage(response, userId, 'ok');
    return {
      reply: 'I can’t help with that one. Ask me about how this site works and I will do better.',
      truncated: false
    };
  }

  await recordUsage(response, userId, 'ok');

  const reply = textOf(response);
  /*
   * Hitting the ceiling is reported, never served as though it were a finished answer.
   * With thinking on, the ceiling covers reasoning too, so a long think on a short
   * question is the realistic way to arrive here with an empty or half-written reply.
   */
  const truncated = response.stop_reason === 'max_tokens';

  return { reply, truncated };
}

module.exports = {
  FEATURE,
  ask,
  sanitiseHistory,
  textOf,
  setClientForTests,
  isConfigured: assistantConfig.isConfigured
};
