'use strict';

const ApiUsage = require('../models/ApiUsage');
const { GLOBAL_MONTHLY_BUDGET_USD, USER_MONTHLY_BUDGET_USD } = require('../config/assistant');

/**
 * The spend circuit-breaker.
 *
 * A public endpoint that costs money per request needs a bound that is not a rate limiter.
 * Rate limiting bounds requests PER ADDRESS; five hundred addresses each staying politely
 * under the limit still produce an unbounded bill. This is the thing that says stop.
 *
 * Two decisions worth arguing with rather than discovering:
 *
 *  1. IT FAILS OPEN. If the ledger cannot be read, the call is allowed. The failure mode
 *     of failing closed is a site-wide feature outage caused by a monitoring query, which
 *     is worse than a few minutes of uncapped spend on a capped-output endpoint. The
 *     exception is logged so it cannot rot.
 *  2. THE CHECK IS BEFORE, THE LEDGER IS AFTER. What a call costs is only known once it
 *     returns, so the cap is always crossed by at most one exchange — and, with the cache
 *     below, by at most one cache window's worth of concurrent ones. That is the honest
 *     bound, and it is why the caps sit well below a figure that would actually hurt.
 */

const CACHE_TTL_MS = 45 * 1000;

let cache = { global: { value: null, at: 0 }, perUser: new Map() };

class BudgetExceededError extends Error {
  constructor(message, scope) {
    super(message);
    this.name = 'BudgetExceededError';
    this.code = 'BUDGET_EXCEEDED';
    // 'global' or 'user'. The visitor is told a different thing by each.
    this.scope = scope;
  }
}

function clearBudgetCache() {
  cache = { global: { value: null, at: 0 }, perUser: new Map() };
}

async function globalMonthToDate() {
  const now = Date.now();
  if (cache.global.value !== null && now - cache.global.at < CACHE_TTL_MS) return cache.global.value;
  const value = await ApiUsage.monthToDateCost();
  cache.global = { value, at: now };
  return value;
}

async function userMonthToDate(userId) {
  const now = Date.now();
  const hit = cache.perUser.get(userId);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await ApiUsage.monthToDateCostForUser(userId);
  cache.perUser.set(userId, { value, at: now });
  return value;
}

/**
 * @param {number|null} userId null for an anonymous visitor, who faces only the global
 *   cap — there is nothing durable to key a per-person total on, which is exactly why the
 *   per-IP and process-wide rate limiters exist alongside this.
 * @throws {BudgetExceededError} when a cap that is actually set has been reached.
 */
async function assertWithinBudget(userId = null) {
  try {
    if (GLOBAL_MONTHLY_BUDGET_USD > 0) {
      const spent = await globalMonthToDate();
      if (spent >= GLOBAL_MONTHLY_BUDGET_USD) {
        throw new BudgetExceededError(
          'The assistant has reached its budget for this month. It will be back at the start of next month.',
          'global'
        );
      }
    }

    if (userId && USER_MONTHLY_BUDGET_USD > 0) {
      const spent = await userMonthToDate(userId);
      if (spent >= USER_MONTHLY_BUDGET_USD) {
        throw new BudgetExceededError(
          'You have used your assistant allowance for this month. It resets at the start of next month.',
          'user'
        );
      }
    }
  } catch (err) {
    if (err.code === 'BUDGET_EXCEEDED') throw err;
    // Fail OPEN, loudly. See the note above: an unreadable ledger must not be an outage,
    // and it must never be silent either.
    console.error(`aiBudget: could not read the spend ledger, allowing the call — ${err.message}`);
  }
  return true;
}

/**
 * Charge a call that has already happened.
 *
 * The cache is advanced in memory rather than invalidated, so the very next request sees
 * this spend even inside the current window. Dropping the cache instead would be correct
 * too and would put a `SUM` on the hot path of a public endpoint; adding to it keeps the
 * breaker tight without that.
 */
function chargeToCache(userId, costUsd) {
  const amount = Number(costUsd) || 0;
  if (amount <= 0) return;
  if (cache.global.value !== null) cache.global.value += amount;
  if (userId) {
    const hit = cache.perUser.get(userId);
    if (hit) hit.value += amount;
  }
}

/** For the admin panel: what has been spent, and against what. */
async function budgetStatus() {
  const spent = await ApiUsage.monthToDateCost();
  return {
    spentUsd: spent,
    globalCapUsd: GLOBAL_MONTHLY_BUDGET_USD,
    userCapUsd: USER_MONTHLY_BUDGET_USD,
    capped: GLOBAL_MONTHLY_BUDGET_USD > 0,
    remainingUsd: GLOBAL_MONTHLY_BUDGET_USD > 0 ? Math.max(0, GLOBAL_MONTHLY_BUDGET_USD - spent) : null,
    percentUsed:
      GLOBAL_MONTHLY_BUDGET_USD > 0
        ? Math.min(100, Math.round((spent / GLOBAL_MONTHLY_BUDGET_USD) * 100))
        : 0
  };
}

module.exports = {
  assertWithinBudget,
  chargeToCache,
  budgetStatus,
  clearBudgetCache,
  BudgetExceededError
};
