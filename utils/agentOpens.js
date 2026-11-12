'use strict';

const SalesAgent = require('../models/SalesAgent');
const { looksLikeAPerson } = require('../middleware/visitGeo');

/*
 * The FETCHERS that draw a link's preview card, by their own names — never the app a person
 * is using. This used to say `linkedin` and `twitter`, which also matched the LinkedIn and X
 * IN-APP BROWSERS ("[LinkedInApp]", "Twitter for iPhone"): a real person tapping an agent's
 * link inside LinkedIn was credited at sign-up and never counted as an open. LinkedIn's
 * fetcher is LinkedInBot, X's is Twitterbot.
 */
const LINK_PREVIEW = /whatsapp\/|facebookexternalhit|facebookcatalog|slackbot|slack-imgproxy|telegrambot|discordbot|linkedinbot|twitterbot|skypeuripreview|viber|embedly|vkshare|redditbot|pinterestbot/i;

/**
 * Count one open of an agent's link for this session, if it looks like a person and this
 * session has not been counted for that agent yet.
 *
 * WHY THIS IS CALLED FROM TWO PLACES (2026-11-09). An open used to be counted only on
 * `/s/<code>`, while a sign-up is credited from the code on `/auth/register?a=<code>` too.
 * The second address is what sits in the address bar after the first redirects, so when an
 * agent copied THAT and shared it, every sign-up through it was credited and none of the
 * visits was counted: a row read 27 sign-ups from 7 opens. An open is now "a session that
 * arrived carrying the agent's code", by either address — the same set of visits that can
 * produce a credited sign-up, so sign-ups can no longer outrun opens by construction. The
 * per-session list stops the redirect from `/s/` to `/auth/register?a=` counting twice.
 *
 * Best-effort: a counting failure is logged and never stops the page.
 */
async function countAgentOpen(req, agent) {
  try {
    if (!agent || !req.session) return false;
    const ua = req.get('user-agent') || '';
    const counted = Array.isArray(req.session.salesAgentOpens) ? req.session.salesAgentOpens : [];
    if (!looksLikeAPerson(ua) || LINK_PREVIEW.test(ua) || counted.includes(agent.code)) return false;
    req.session.salesAgentOpens = [...counted, agent.code].slice(-10);
    await SalesAgent.countOpen(agent.user_id);
    return true;
  } catch (err) {
    console.error(`Sales agent open not counted: ${err.message}`);
    return false;
  }
}

/**
 * A sign-up has just been credited to `agent`. If this session never had its open counted
 * (2026-11-11), count it now. A credited sign-up IS a person who arrived carrying the code —
 * the definition of an open — so the user-agent filters do not apply here: they exist to
 * keep fetchers and bots out, and a fetcher does not fill in a registration form. Without
 * this, a session the filters misjudged, or one that lost its cookie between the link and
 * the form (the hidden `a` field still carries the code), produced a sign-up with no open,
 * and the row read more sign-ups than opens.
 */
async function countOpenForSignup(req, agent) {
  try {
    if (!agent || !req.session) return false;
    const counted = Array.isArray(req.session.salesAgentOpens) ? req.session.salesAgentOpens : [];
    if (counted.includes(agent.code)) return false;
    req.session.salesAgentOpens = [...counted, agent.code].slice(-10);
    await SalesAgent.countOpen(agent.user_id);
    return true;
  } catch (err) {
    console.error(`Sales agent open not counted: ${err.message}`);
    return false;
  }
}

/**
 * Count one open of an agent's TAX link (`/t/<code>`, 2026-11-12) — the same person and
 * preview filters as the sign-up link, once per session per agent, but in its OWN session
 * list: opening the sign-up link must not use up the tax link's open, nor the other way
 * round. Best-effort, like the sign-up counter.
 */
async function countAgentTaxOpen(req, agent) {
  try {
    if (!agent || !req.session) return false;
    // The agent checking their own link is not somebody looking at the programme.
    if (req.session.user && req.session.user.id === agent.user_id) return false;
    const ua = req.get('user-agent') || '';
    const counted = Array.isArray(req.session.salesAgentTaxOpens) ? req.session.salesAgentTaxOpens : [];
    if (!looksLikeAPerson(ua) || LINK_PREVIEW.test(ua) || counted.includes(agent.code)) return false;
    req.session.salesAgentTaxOpens = [...counted, agent.code].slice(-10);
    await SalesAgent.countTaxOpen(agent.user_id);
    return true;
  } catch (err) {
    console.error(`Sales agent tax-link open not counted: ${err.message}`);
    return false;
  }
}

module.exports = { LINK_PREVIEW, countAgentOpen, countOpenForSignup, countAgentTaxOpen };
