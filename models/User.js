'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { isSignupSource } = require('../config/signupSources');
const { promisePool, withTransaction } = require('../config/database');
const config = require('../config/config');
const { containsPattern } = require('../utils/likePattern');

/**
 * Roles the public registration form is allowed to create.
 *
 * This is a security boundary, not a UI convenience. In DynamicsHub, before this filter
 * existed, a hand-crafted `user_types[]=partner` POST created a working partner account
 * with a commission rate and no approval step. Every other role is admin-onboarded.
 */
/*
 * `recruiter` IS self-service; `partner` is NOT, and the line between them is money.
 *
 * A recruiter account can do what a company account can already do — advertise roles and
 * read the consultant directory — so gating it behind support would make the role dead on
 * arrival without protecting anything. A partner account carries a commission rate, which
 * is why DynamicsHub's `user_types[]=partner` POST was a real escalation: it created a
 * working account that could be owed money, with no approval step.
 *
 * Anyone adding a role here: ask whether it grants access somebody else pays for.
 */
const PUBLIC_ROLES = Object.freeze(['consultant', 'company', 'recruiter']);
const ALL_ROLES = Object.freeze(['consultant', 'company', 'recruiter', 'partner', 'admin']);

const ROLE_FLAG_COLUMN = Object.freeze({
  consultant: 'is_consultant',
  company: 'is_company',
  recruiter: 'is_recruiter',
  partner: 'is_partner'
});

/**
 * Canonical email form used by EVERY route that looks a user up.
 *
 * Deliberately conservative: trim and lowercase, nothing else. In particular Gmail dots
 * are PRESERVED. Any normalisation that differs between the registration route and the
 * login route forks accounts — a user registers as `a.b@gmail.com` and can then never
 * sign in because login looked up `ab@gmail.com`.
 */
function normaliseEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * Union the submitted roles with the roles the user already holds.
 *
 * The self-service roles form is ADD-ONLY by design: a form post can never remove a
 * role, and can never demote an admin. Removing a role is an admin-only operation
 * (`User.adminSetRoles`). Pure function so the rule is unit-testable.
 */
function unionRoles(currentRoles, submittedRoles, { allowed = PUBLIC_ROLES } = {}) {
  const current = new Set((currentRoles || []).filter((r) => ALL_ROLES.includes(r)));
  for (const role of submittedRoles || []) {
    if (allowed.includes(role)) current.add(role);
  }
  return ALL_ROLES.filter((r) => current.has(r));
}

/**
 * Pick the primary `user_type` for a role set.
 * An existing primary role is always kept: promotion is explicit, never a side effect
 * of ticking a checkbox.
 */
function resolvePrimaryRole(roles, existingPrimary = null) {
  if (existingPrimary && roles.includes(existingPrimary)) return existingPrimary;
  if (existingPrimary === 'admin') return 'admin';
  return roles[0] || 'consultant';
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

class User {
  static get PUBLIC_ROLES() {
    return PUBLIC_ROLES;
  }

  static get ALL_ROLES() {
    return ALL_ROLES;
  }

  static normaliseEmail = normaliseEmail;

  static unionRoles = unionRoles;

  static resolvePrimaryRole = resolvePrimaryRole;

  static hashToken = hashToken;

  /**
   * Create a user.
   *
   * `consent` is intentionally optional and intentionally NOT defaulted. Only the
   * public registration route passes it, carrying the exact policy versions the person
   * actually accepted. Admin creation, seeds and tests pass nothing, because consent
   * must never be fabricated on someone's behalf.
   */
  static async create({ email, password, name, roles, consent = null, gender = null, dateOfBirth = null, signupIp = null, signupCountry = null, heardAbout = null }) {
    const normalisedEmail = normaliseEmail(email);
    const requestedRoles = unionRoles([], roles, { allowed: ALL_ROLES });
    const finalRoles = requestedRoles.length ? requestedRoles : ['consultant'];
    const primary = resolvePrimaryRole(finalRoles);
    const passwordHash = await bcrypt.hash(password, config.security.bcryptRounds);

    const flags = {
      is_consultant: finalRoles.includes('consultant') ? 1 : 0,
      is_company: finalRoles.includes('company') ? 1 : 0,
      is_recruiter: finalRoles.includes('recruiter') ? 1 : 0,
      is_partner: finalRoles.includes('partner') ? 1 : 0
    };

    const [result] = await promisePool.query(
      `INSERT INTO users
         (email, password_hash, name, user_type,
          is_consultant, is_company, is_recruiter, is_partner,
          terms_accepted_at, terms_version, privacy_policy_version,
          gender, date_of_birth, signup_ip, signup_country, heard_about)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        normalisedEmail,
        passwordHash,
        String(name).trim(),
        primary,
        flags.is_consultant,
        flags.is_company,
        flags.is_recruiter,
        flags.is_partner,
        consent ? new Date() : null,
        consent ? consent.termsVersion : null,
        consent ? consent.privacyVersion : null,
        gender,
        dateOfBirth,
        signupIp,
        signupCountry,
        // Closed vocabulary or nothing: an unrecognised answer is dropped rather than
        // stored, because the point of the column is that it can be counted.
        isSignupSource(heardAbout) ? heardAbout : null
      ]
    );

    return User.findById(result.insertId);
  }

  static async findById(id) {
    const [rows] = await promisePool.query('SELECT * FROM users WHERE id = ? LIMIT 1', [id]);
    return rows[0] || null;
  }

  static async findByEmail(email) {
    const [rows] = await promisePool.query('SELECT * FROM users WHERE email = ? LIMIT 1', [normaliseEmail(email)]);
    return rows[0] || null;
  }

  static async emailExists(email) {
    const [rows] = await promisePool.query('SELECT 1 FROM users WHERE email = ? LIMIT 1', [normaliseEmail(email)]);
    return rows.length > 0;
  }

  static async verifyPassword(user, password) {
    if (!user || !user.password_hash) return false;
    return bcrypt.compare(String(password), user.password_hash);
  }

  static async updatePassword(userId, password) {
    const hash = await bcrypt.hash(password, config.security.bcryptRounds);
    await promisePool.query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, userId]);
  }

  static async recordLogin(userId) {
    await promisePool.query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [userId]);
  }

  static async markOnboarded(userId) {
    await promisePool.query('UPDATE users SET onboarded_at = NOW() WHERE id = ? AND onboarded_at IS NULL', [userId]);
  }

  static async setEmailVerified(userId) {
    await promisePool.query('UPDATE users SET email_verified = 1 WHERE id = ?', [userId]);
  }

  /** Roles derived from the boolean flags plus the primary type. */
  static rolesOf(userRow) {
    if (!userRow) return [];
    const roles = new Set();
    if (userRow.is_consultant) roles.add('consultant');
    if (userRow.is_company) roles.add('company');
    if (userRow.is_recruiter) roles.add('recruiter');
    if (userRow.is_partner) roles.add('partner');
    if (userRow.user_type === 'admin') roles.add('admin');
    roles.add(userRow.user_type);
    return ALL_ROLES.filter((r) => roles.has(r));
  }

  /**
   * Self-service role update. Add-only, restricted to the public roles.
   * Returns the resulting role list.
   */
  static async addSelfServiceRoles(userId, submittedRoles) {
    return withTransaction(async (conn) => {
      const [rows] = await conn.query('SELECT * FROM users WHERE id = ? FOR UPDATE', [userId]);
      const user = rows[0];
      if (!user) throw new Error(`No such user: ${userId}`);

      const roles = unionRoles(User.rolesOf(user), submittedRoles, { allowed: PUBLIC_ROLES });
      const primary = resolvePrimaryRole(roles, user.user_type);

      await conn.query(
        `UPDATE users
            SET user_type = ?, is_consultant = ?, is_company = ?, is_recruiter = ?, is_partner = ?
          WHERE id = ?`,
        [
          primary,
          roles.includes('consultant') ? 1 : 0,
          roles.includes('company') ? 1 : 0,
          // Privileged flags are preserved exactly as they were; a self-service form
          // can neither grant nor revoke them.
          user.is_recruiter,
          user.is_partner,
          userId
        ]
      );
      return roles;
    });
  }

  /** Admin-only: set the exact role set, including removal and privileged roles. */
  static async adminSetRoles(userId, roles, { primary = null } = {}) {
    const finalRoles = ALL_ROLES.filter((r) => (roles || []).includes(r));
    const primaryRole = primary && finalRoles.includes(primary) ? primary : resolvePrimaryRole(finalRoles);

    await promisePool.query(
      `UPDATE users
          SET user_type = ?, is_consultant = ?, is_company = ?, is_recruiter = ?, is_partner = ?
        WHERE id = ?`,
      [
        primaryRole,
        finalRoles.includes('consultant') ? 1 : 0,
        finalRoles.includes('company') ? 1 : 0,
        finalRoles.includes('recruiter') ? 1 : 0,
        finalRoles.includes('partner') ? 1 : 0,
        userId
      ]
    );
    return finalRoles;
  }

  static async setActive(userId, isActive) {
    await promisePool.query('UPDATE users SET is_active = ? WHERE id = ?', [isActive ? 1 : 0, userId]);
  }

  static async setSuperadmin(userId, isSuperadmin) {
    await promisePool.query('UPDATE users SET is_superadmin = ? WHERE id = ?', [isSuperadmin ? 1 : 0, userId]);
  }

  /**
   * The session user contract.
   *
   * Rebuilt from the database on EVERY request by `validateActiveAccount`, so a role
   * revoked by an admin takes effect on the very next request rather than whenever the
   * person next signs in.
   */
  static buildSessionUser(userRow, { displayName = null, profilePicture = null } = {}) {
    const roles = User.rolesOf(userRow);
    return {
      id: userRow.id,
      email: userRow.email,
      userType: userRow.user_type,
      roles,
      isConsultant: Boolean(userRow.is_consultant) || userRow.user_type === 'consultant',
      isCompany: Boolean(userRow.is_company) || userRow.user_type === 'company',
      isRecruiter: Boolean(userRow.is_recruiter) || userRow.user_type === 'recruiter',
      isPartner: Boolean(userRow.is_partner) || userRow.user_type === 'partner',
      isAdmin: userRow.user_type === 'admin' || Boolean(userRow.is_superadmin),
      isSuperadmin: Boolean(userRow.is_superadmin),
      emailVerified: Boolean(userRow.email_verified),
      needsOnboarding: !userRow.onboarded_at,
      name: displayName || userRow.name || String(userRow.email).split('@')[0],
      profilePicture: profilePicture || null
    };
  }

  static async list({ search = '', role = '', limit = 20, offset = 0 } = {}) {
    const where = ['1 = 1'];
    const params = [];

    /*
     * Through `containsPattern`, not an interpolated `%...%`.
     *
     * Salesforce Hub added `utils/likePattern.js` when one search box started asking four
     * filter builders at once, and fixed all four — but not this one. `User.list` is the
     * admin user search, it was written before that util existed, and it still pasted the
     * raw string between two per-cent signs. The value was always bound so nothing was
     * injectable, but an admin searching for a literal `%` still asked for every row in
     * `users`, and one searching `a_b` matched `axb`. It is the same bug in the same
     * shape; it survived because nobody re-read a builder that was already working.
     */
    if (search) {
      where.push('(email LIKE ? OR name LIKE ?)');
      const pattern = containsPattern(search);
      params.push(pattern, pattern);
    }
    if (role && ALL_ROLES.includes(role)) {
      const column = ROLE_FLAG_COLUMN[role];
      where.push(column ? `(user_type = ? OR ${column} = 1)` : 'user_type = ?');
      params.push(role);
    }

    const clause = where.join(' AND ');
    const [rows] = await promisePool.query(
      `SELECT id, email, name, user_type, is_consultant, is_company, is_recruiter, is_partner,
              is_superadmin, is_active, email_verified, created_at, last_login_at
         FROM users
        WHERE ${clause}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const [[{ total }]] = await promisePool.query(`SELECT COUNT(*) AS total FROM users WHERE ${clause}`, params);
    return { rows, total };
  }
}

module.exports = User;
