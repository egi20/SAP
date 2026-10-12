#!/usr/bin/env node
'use strict';

/**
 * Correct the email address on one account.
 *
 * WHY THIS EXISTS. There is no address change anywhere on the site — not in settings, not
 * on /admin/users — so an account created with a typo (`dynamichub.net` for
 * `dynamicshub.net`) kept it, and every password reset and notification for that person
 * went to a domain they do not read. A self-service change is a bigger feature: the NEW
 * address has to be confirmed before it replaces the old one, or anybody signed in for a
 * moment could move an account to an inbox they control. Until that exists, the operator
 * corrects an address from the deploy's shell, which is where a privilege like this
 * belongs.
 *
 * It changes the address and nothing else: not the password, not the roles, not the
 * verified flag. An address that already belongs to another account is refused by name.
 *
 * Usage:
 *   npm run change-email -- old@example.com new@example.com
 */

const User = require('../models/User');
const { promisePool } = require('../config/database');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

(async () => {
  const [from, to] = process.argv.slice(2).map((e) => String(e || '').trim());

  if (!EMAIL_RE.test(from || '') || !EMAIL_RE.test(to || '')) {
    console.error('Usage: npm run change-email -- old@example.com new@example.com');
    process.exitCode = 1;
    return;
  }

  try {
    const user = await User.findByEmail(from);
    if (!user) {
      console.log(`  not found  ${from}  (check the spelling against /admin/users)`);
      process.exitCode = 1;
      return;
    }
    const changed = await User.changeEmail(user.id, to);
    if (!changed) {
      console.log(`  REFUSED    ${to} already belongs to an account`);
      process.exitCode = 1;
      return;
    }
    console.log(`  changed    ${from}  ->  ${to.toLowerCase()}  (password and roles unchanged)`);
  } catch (err) {
    console.error(`Could not change the address: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await promisePool.end().catch(() => {});
  }
})();
