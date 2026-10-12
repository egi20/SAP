#!/usr/bin/env node
'use strict';

/**
 * Take superadmin away from one or more accounts, leaving them ordinary admins.
 *
 * WHY THIS EXISTS. `create-admin` is the only thing that grants superadmin, and nothing
 * took it back: the roles form on /admin/users edits the marketplace roles and `admin`,
 * never the superadmin flag. So an owner who created colleagues with `create-admin` — the
 * obvious script to reach for — had four superadmins and no way to make three of them
 * ordinary administrators short of a hand-typed one-liner in a web shell, which is the
 * kind of thing that gets pasted wrong. It is a script for the same reason granting is:
 * a privilege boundary is changed from a shell where somebody has the deploy's access,
 * never from a form.
 *
 * It REFUSES to remove the last superadmin. Only a superadmin can change roles, and an
 * account cannot act on its own roles, so a site with none can never get one back from
 * the site itself.
 *
 * It touches the flag and nothing else: not the password, not the admin role, not the
 * marketplace roles. The change takes effect on that account's next request.
 *
 * Usage:
 *   npm run revoke-superadmin -- someone@example.com [another@example.com ...]
 */

const User = require('../models/User');
const { promisePool } = require('../config/database');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

(async () => {
  const emails = process.argv.slice(2).map((e) => e.trim()).filter(Boolean);

  if (!emails.length || emails.some((e) => !EMAIL_RE.test(e))) {
    console.error('Usage: npm run revoke-superadmin -- someone@example.com [another@example.com ...]');
    process.exitCode = 1;
    return;
  }

  try {
    for (const email of emails) {
      // eslint-disable-next-line no-await-in-loop
      const user = await User.findByEmail(email);
      if (!user) {
        console.log(`  not found       ${email}  (check the spelling against /admin/users)`);
        continue;
      }
      if (!user.is_superadmin) {
        console.log(`  not superadmin  ${email}  (nothing to change)`);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const remaining = await User.countActiveSuperadmins({ excludeId: user.id });
      if (Number(remaining) === 0) {
        console.log(`  REFUSED         ${email}  (the last active superadmin; nobody could grant it back)`);
        process.exitCode = 1;
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      await User.setSuperadmin(user.id, false);
      console.log(`  revoked         ${email}  (still an admin)`);
    }
  } catch (err) {
    console.error(`Could not revoke superadmin: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await promisePool.end().catch(() => {});
  }
})();
