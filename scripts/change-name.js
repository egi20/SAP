#!/usr/bin/env node
'use strict';

/**
 * Correct the name on one account.
 *
 * WHY THIS EXISTS. `npm run create-admin` names an account "Administrator" when it is not
 * given a name, and nothing on the site changes `users.name` afterwards — so the three
 * administrators created that way were listed, greeted and credited in the community under
 * a role rather than as people. Same shape as `change-email.js`: an operator correction
 * from the deploy's shell, changing the name and nothing else.
 *
 * Usage (quote a name with a space in it):
 *   npm run change-name -- someone@example.com "First Last"
 */

const User = require('../models/User');
const { promisePool } = require('../config/database');

(async () => {
  const [email, ...rest] = process.argv.slice(2).map((a) => String(a || '').trim());
  const name = rest.join(' ').trim();

  if (!email || !email.includes('@') || !name) {
    console.error('Usage: npm run change-name -- someone@example.com "First Last"');
    process.exitCode = 1;
    return;
  }

  try {
    const user = await User.findByEmail(email);
    if (!user) {
      console.log(`  not found  ${email}  (check the spelling against /admin/users)`);
      process.exitCode = 1;
      return;
    }
    const saved = await User.changeName(user.id, name);
    console.log(`  renamed    ${email}  "${user.name}"  ->  "${saved}"`);
  } catch (err) {
    console.error(`Could not change the name: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await promisePool.end().catch(() => {});
  }
})();
