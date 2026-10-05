#!/usr/bin/env node
'use strict';

/**
 * Create ONE ordinary member account, with the marketplace roles you name.
 *
 * WHY THIS EXISTS. There is no seed script — see `create-admin.js` for the reasoning —
 * so the only ways onto a fresh install were the registration form and a superadmin.
 * Walking the site as a consultant or a company then meant either registering through
 * the browser and finding the verification link in a log that does not print it, or
 * giving a test account administrator rights, which is how somebody ends up demonstrating
 * the consultant view from an account that can also void rate submissions.
 *
 * It grants PUBLIC roles only — consultant, company, recruiter. A privileged role is
 * `create-admin.js`'s job and nowhere else, because a general-purpose account script that
 * can also grant admin is one typo away from being the account-takeover tool this project
 * is careful not to build.
 *
 * Usage:
 *   npm run create-user -- someone@example.com "Their Name" consultant
 *   npm run create-user -- someone@example.com "Their Name" company,recruiter
 */

const User = require('../models/User');
const { generatePassword } = require('../utils/initialPassword');
const { promisePool } = require('../config/database');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function usage(message) {
  if (message) console.error(message);
  console.error('');
  console.error('Usage: npm run create-user -- someone@example.com "Their Name" <roles>');
  console.error(`Roles, comma separated, from: ${User.PUBLIC_ROLES.join(', ')}`);
  console.error('For an administrator use: npm run create-admin -- you@example.com "Your Name"');
}

(async () => {
  const [email, name, roleArg] = process.argv.slice(2);

  if (!email || !EMAIL_RE.test(email)) {
    usage('An email address is required.');
    process.exitCode = 1;
    return;
  }
  if (!name || !name.trim()) {
    usage('A name is required — it is what the rest of the site shows for this account.');
    process.exitCode = 1;
    return;
  }

  const roles = (roleArg || 'consultant')
    .split(',')
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);

  const refused = roles.filter((r) => !User.PUBLIC_ROLES.includes(r));
  if (refused.length) {
    // Named rather than silently dropped. A script that quietly ignores `admin` hands back
    // an account that looks like the one that was asked for and is not.
    usage(`Cannot grant from here: ${refused.join(', ')}.`);
    process.exitCode = 1;
    return;
  }
  if (!roles.length) {
    usage('Name at least one role.');
    process.exitCode = 1;
    return;
  }

  try {
    const existing = await User.findByEmail(email);
    if (existing) {
      /*
       * Add the roles and leave the password alone, exactly as `create-admin` does. Being
       * able to re-run this must never be a way to reset somebody's password from a shell.
       */
      const finalRoles = await User.addSelfServiceRoles(existing.id, roles);
      console.log(`${email} already existed. Roles are now: ${finalRoles.join(', ')}.`);
      console.log('Its password is unchanged.');
      return;
    }

    const password = generatePassword();

    // No consent object, deliberately. Only `POST /auth/register` stamps consent, because
    // an account made from a shell did not agree to anything.
    const user = await User.create({ email, password, name: name.trim(), roles });

    // Verified, because the verification email cannot be followed here: with no Resend key
    // `utils/email.js` logs the recipient and the subject and not the link inside it.
    await User.setEmailVerified(user.id);

    console.log('');
    console.log(`  Account created — ${roles.join(', ')}.`);
    console.log('');
    console.log(`    email     ${email}`);
    console.log(`    password  ${password}`);
    console.log('');
    console.log('  This is the only time that password is shown.');
    console.log('');
  } catch (err) {
    console.error(`Could not create the account: ${err.message}`);
    process.exitCode = 1;
  } finally {
    // `promisePool.end()`, not `pool.end()` — see the note in create-admin.js.
    await promisePool.end().catch(() => {});
  }
})();
