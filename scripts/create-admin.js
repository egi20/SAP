#!/usr/bin/env node
'use strict';

/**
 * Create ONE superadmin, and nothing else.
 *
 * WHY THIS EXISTS SEPARATELY FROM `npm run seed`. The seed is development data: it creates
 * 30 jobs, 24 consultant profiles, 6 companies, 9 community posts — and 24 rate
 * submissions. On a real site that last one is not cosmetic. The rate index publishes
 * percentiles derived from what it holds, with a floor that counts PEOPLE; twenty-four
 * invented figures would put a published, real-looking benchmark in front of visitors that
 * nobody contributed to. The seeded consultant profiles are the same problem with faces on
 * them: a public directory of people who do not exist.
 *
 * So a production install runs this instead, and ends up with an empty site and one
 * account that can administer it.
 *
 * Usage:
 *   npm run create-admin -- you@example.com "Your Name"
 *
 * The password is not taken from the command line — it is generated here and printed once.
 * A password in an argument is a password in the shell history, in `ps` output while the
 * process runs, and in whatever ships those logs somewhere else.
 */

const crypto = require('crypto');

const User = require('../models/User');
const { promisePool } = require('../config/database');

/**
 * Readable but not guessable: 24 characters from an alphabet with no look-alikes, so
 * somebody can retype it off a screen without wondering whether that is a 1 or an l.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

function generatePassword(length = 24) {
  const bytes = crypto.randomBytes(length * 2);
  let out = '';
  for (let i = 0; out.length < length; i += 1) {
    // Rejection sampling rather than a modulo: `% 55` over 0-255 biases the first
    // characters of the alphabet, which is exactly the kind of quiet weakening nobody
    // notices in a password generator.
    const byte = bytes[i % bytes.length];
    if (byte < Math.floor(256 / ALPHABET.length) * ALPHABET.length) {
      out += ALPHABET[byte % ALPHABET.length];
    }
  }
  return out;
}

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
