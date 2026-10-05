#!/usr/bin/env node
'use strict';

/**
 * Create ONE superadmin, and nothing else.
 *
 * WHY THERE IS NO SEED SCRIPT BESIDE IT. Both references ship one and it is the obvious
 * thing to want: thirty jobs, a couple of dozen consultant profiles, some companies and
 * posts, so that a fresh install has something to look at. The rate submissions are what
 * make it unshippable. The rate index publishes percentiles over what it holds, with a
 * floor that counts PEOPLE, so two dozen invented figures put a real-looking published
 * benchmark in front of visitors that nobody contributed to — and seeded consultant
 * profiles are the same problem with faces on them, a public directory of people who do
 * not exist. A seed that leaves both out is a seed of an empty marketplace, which is what
 * an install gets anyway.
 *
 * So this is the whole of first-run setup: an empty site and one account that can
 * administer it.
 *
 * Usage:
 *   npm run create-admin -- you@example.com "Your Name"
 *
 * For an ordinary consultant, company or agency account — the ones you want in order to
 * walk the site as a member — use `npm run create-user` instead. This script is the
 * privileged one and grants superadmin.
 */

const User = require('../models/User');
const { generatePassword } = require('../utils/initialPassword');
const { promisePool } = require('../config/database');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

(async () => {
  const [email, name] = process.argv.slice(2);

  if (!email || !EMAIL_RE.test(email)) {
    console.error('Usage: npm run create-admin -- you@example.com "Your Name"');
    console.error('The email must be one you can actually receive mail at.');
    process.exitCode = 1;
    return;
  }

  try {
    const existing = await User.findByEmail(email);
    if (existing) {
      /*
       * Promote rather than refuse, but NEVER touch the password.
       *
       * Re-running this must not be a way to reset somebody's password from a shell — and
       * on a machine where this script can run, that would be an account takeover with a
       * convenient wrapper.
       */
      await User.adminSetRoles(existing.id, ['admin'], { primary: 'admin' });
      await User.setSuperadmin(existing.id, true);
      await User.setEmailVerified(existing.id);
      console.log(`${email} already existed and is now a superadmin. Its password is unchanged.`);
      return;
    }

    const password = generatePassword();

    // No consent object, deliberately. Only `POST /auth/register` stamps consent, because
    // consent must never be fabricated on somebody's behalf — an account made from a shell
    // did not agree to anything.
    const admin = await User.create({
      email,
      password,
      name: name || 'Administrator',
      roles: ['admin']
    });

    await User.setEmailVerified(admin.id);
    await User.setSuperadmin(admin.id, true);

    console.log('');
    console.log('  Superadmin created.');
    console.log('');
    console.log(`    email     ${email}`);
    console.log(`    password  ${password}`);
    console.log('');
    console.log('  This is the only time that password is shown. Put it in a password');
    console.log('  manager now, then change it at /profile/settings.');
    console.log('');
  } catch (err) {
    console.error(`Could not create the administrator: ${err.message}`);
    process.exitCode = 1;
  } finally {
    // `promisePool.end()`, not `pool.end()`. The callback-style pool's `end` takes a
    // callback and returns undefined, so `await pool.end().catch(...)` throws a TypeError
    // AFTER the work is done — a script that succeeds and then reports failure, which on a
    // nightly cron is an alert every morning about nothing.
    await promisePool.end().catch(() => {});
  }
})();
