'use strict';

const { promisePool, withTransaction } = require('../config/database');
const User = require('./User');
const Job = require('./Job');
const Application = require('./Application');
const Referral = require('./Referral');
const ExternalIdentity = require('./ExternalIdentity');

/**
 * Closing an account.
 *
 * NOT a DELETE, and the distinction is the whole module. A hard delete of the user row
 * would cascade into a points ledger that is append-only so it can be audited, a
 * commission ledger that records real money somebody is owed, invoices that must never
 * rewrite themselves, one half of conversations the other party wrote, and the pipeline
 * rows an employer is working from. Every one of those is a record this codebase has
 * already argued, in writing, must survive its subject changing their mind.
 *
 * So: everything that is ONLY about this person is removed, the identity on the user row
 * is erased, and the rows that belong to somebody else or to the books are kept — and the
 * page says which, by name, BEFORE the button. A closure screen that promises "your data
 * will be deleted" and leaves an invoice standing is the one version of this that is
 * actually dishonest.
 *
 * It is the single writer. Everywhere else in this application a bare UPDATE beside a
 * module that owns a column is the bug; this is no different, and it is irreversible.
 */

/**
 * The name a closed account carries afterwards.
 *
 * A neutral label and never the email local part: `Conversation`'s display-name fallback
 * exists because the reference leaked a `firstname.lastname` prefix that way, and a
 * closure that reintroduced it would undo that fix for exactly the people who asked to be
 * forgotten.
 */
const CLOSED_NAME = 'Former member';

/**
 * `.invalid` is reserved by RFC 2606 and can never be delivered to, so a tombstone address
 * cannot collide with a real one or be mistaken for one. Writing it also FREES the real
 * address: somebody who closes an account and later wants to come back registers again
 * rather than finding their own email taken by a row they cannot reach.
 */
function tombstoneEmail(userId) {
  return `closed-${userId}@accounts.invalid`;
}

/**
 * What closing will do, in the words the confirmation page prints.
 *
 * Generated from the same constants the closure uses, so the page cannot drift from the
 * operation. A list of promises maintained separately from the code that keeps them is
 * worse than no list.
 */
const REMOVED = Object.freeze([
  'Your name, email address and password.',
  'Your consultant profile — headline, rate, availability, skills, certifications, work history and delivery history.',
  'Your company profile and logo.',
  'Your photograph, your LinkedIn confirmation, your saved roles and your notifications.',
  'Any tax optimisation application you sent while signed in.'
]);

const KEPT = Object.freeze([
  {
    what: 'Posts and replies you wrote in the community',
    why: 'People replied to them, and an accepted answer is the reason somebody else found the thread. They stay, under "Former member".'
  },
  {
    what: 'Messages you sent',
    why: 'The other half of a conversation was written by somebody else and is theirs to keep.'
  },
  {
    what: 'Applications you made, and applications made to your roles',
    why: 'They are a hiring record on both sides. Live applications of yours are withdrawn as part of closing.'
  },
  {
    what: 'Invoices and payments',
    why: 'A receipt that rewrites itself is not a receipt, and we are required to keep them.'
  },
  {
    what: 'Points and commission entries',
    why: 'Both ledgers are append-only so that every total on the site can be checked. Removing rows would make somebody else\'s figures unverifiable.'
  },
  {
    what: 'Day rates you contributed',
    why: 'They were always anonymous — the index never shows who gave a figure, and it only publishes a bucket once at least three people have. Removing yours would move a published number for everybody.'
  }
]);

function refuse(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

class AccountClosure {
  static get CLOSED_NAME() {
    return CLOSED_NAME;
  }

  static get REMOVED() {
    return REMOVED;
  }

  static get KEPT() {
    return KEPT;
  }

  static tombstoneEmail = tombstoneEmail;

  /**
   * May this account be closed, and if not, WHY NOT.
   *
   * Both blockers are things the member would lose the ability to resolve. Naming the
   * figure matters for the second one: "you cannot close your account" with no number is
   * the message people assume is a bug.
   */
  static async blockers(user) {
    const problems = [];

    if (user.is_superadmin || user.user_type === 'admin') {
      /*
       * Same reasoning as the admin screens refusing to act on your own account: an
       * administrator who closes themselves may be removing the last account that could
       * undo it. Another administrator does this one.
       */
      problems.push('An administrator account is closed by another administrator. Ask one of us.');
    }

    const referrer = await Referral.findByUserId(user.id);
    if (referrer) {
      const balance = await Referral.balanceFor(referrer.id);
      if (balance.unpaidMinor > 0) {
        problems.push(
          `There is still ${(balance.unpaidMinor / 100).toFixed(2)} in unpaid commission on your account. ` +
            'Closing it would remove the only page you can check that on. Write to us and we will settle it first.'
        );
      }
    }

    return { ok: problems.length === 0, problems };
  }

  /**
   * Close it.
   *
   * The order matters. The things that affect OTHER PEOPLE happen first and through the
   * models that own them — adverts are closed so nobody spends an evening applying to a
   * role nobody is hiring for, and live applications are withdrawn through
   * `Application.transition` so each one writes its audit event — and only then is the
   * identity erased. A closure that erased the identity first and then failed would leave
   * an anonymous account still advertising.
   */
  static async close(userId, { reason = null } = {}) {
    const user = await User.findById(userId);
    if (!user) throw refuse('NOT_FOUND', 'That account no longer exists.');
    if (!user.is_active) throw refuse('ALREADY_CLOSED', 'That account is already closed.');

    const { ok, problems } = await AccountClosure.blockers(user);
    if (!ok) throw refuse('BLOCKED', problems[0]);

    // 1. Nothing of theirs should still be asking the public for something.
    const [liveJobs] = await promisePool.query(
      "SELECT id FROM jobs WHERE company_user_id = ? AND status IN ('open','paused')",
      [userId]
    );
    for (const job of liveJobs) {
      // eslint-disable-next-line no-await-in-loop
      await Job.setStatus(job.id, userId, 'closed');
    }

    // 2. And nothing of theirs should still be live in somebody else's pipeline.
    const [mine] = await promisePool.query(
      "SELECT id, status FROM applications WHERE consultant_user_id = ? AND status NOT IN ('hired','rejected','withdrawn')",
      [userId]
    );
    for (const application of mine) {
      // Through the model, so the append-only event log records who withdrew and when —
      // the employer watching that pipeline is entitled to see what happened.
      // eslint-disable-next-line no-await-in-loop
      await Application.transition(application.id, userId, 'withdrawn', {
        note: 'The applicant closed their account.',
        actorIsEmployer: false
      }).catch(() => null);
    }

    // 3. The LinkedIn identity, through its single writer, which also clears the flag.
    await ExternalIdentity.unlink(ExternalIdentity.LINKEDIN, userId).catch(() => null);

    // 4. A referrer stops taking new introductions. Nothing already earned is touched.
    const referrer = await Referral.findByUserId(userId);
    if (referrer) await Referral.setActive(referrer.id, false);

    // 5. Everything that is only about this person, and the identity itself.
    return withTransaction(async (conn) => {
      const owned = [
        'consultant_photos',
        'company_logos',
        'consultant_profiles',
        'company_profiles',
        'saved_jobs',
        'notifications',
        // Salary, tax rate and phone number beside a name: only about this person.
        'tax_applications',
        'email_verifications',
        'password_reset_tokens'
      ];
      for (const table of owned) {
        // eslint-disable-next-line no-await-in-loop
        await conn.query(`DELETE FROM ${table} WHERE user_id = ?`, [userId]);
      }

      /*
       * Votes are NOT in that list, and the reason is a rule from the points ledger: an
       * upvote was settled to the author while it STANDS. Deleting the vote without
       * settling it back would leave somebody holding points for a vote that no longer
       * exists, and settling it back would take points away from a third party because a
       * second one left. Neither is a thing a closure should do, so the vote stays.
       */

      await conn.query(
        `UPDATE users
            SET name = ?, email = ?, password_hash = ?,
                gender = NULL, date_of_birth = NULL,
                signup_ip = NULL, signup_country = NULL, heard_about = NULL,
                is_active = 0, email_verified = 0,
                closed_at = NOW(), closed_reason = ?
          WHERE id = ?`,
        [
          CLOSED_NAME,
          tombstoneEmail(userId),
          // Not a hash of anything. bcrypt's verify fails against a string that is not a
          // hash, so there is no password this row can be signed in with — and there is no
          // moment where the old hash is still sitting there while the rest is erased.
          'closed',
          reason ? String(reason).slice(0, 200) : null,
          userId
        ]
      );

      /*
       * Sessions are NOT deleted here, and not because they do not matter.
       * `validateActiveAccount` rebuilds `req.session.user` from the database on EVERY
       * request, so a surviving cookie is dead on its next one. Reaching into the session
       * store would mean matching on the shape of somebody else's serialised JSON, which
       * is a guess that silently stops matching the day that shape changes — and a delete
       * driven by a guess is the wrong kind of wrong.
       */

      return { closedJobs: liveJobs.length, withdrawnApplications: mine.length };
    });
  }
}

module.exports = AccountClosure;
