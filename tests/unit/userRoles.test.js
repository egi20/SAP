'use strict';

/**
 * `User.rolesHeld` reads what an account already holds, so `create-admin` can ADD the admin
 * role to an existing account instead of replacing every role with it (2026-11-12).
 */

const fs = require('fs');
const path = require('path');
const User = require('../../models/User');

describe('User.rolesHeld', () => {
  it('reads the marketplace flags and the admin primary type', () => {
    expect(User.rolesHeld({ user_type: 'consultant', is_consultant: 1, is_company: 1, is_recruiter: 0, is_partner: 0 }))
      .toEqual(['consultant', 'company']);
    expect(User.rolesHeld({ user_type: 'admin', is_consultant: 0, is_company: 1 })).toEqual(['company', 'admin']);
    expect(User.rolesHeld(null)).toEqual([]);
  });

  it('create-admin keeps the roles an existing account holds', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../scripts/create-admin.js'), 'utf8');
    expect(src).toContain('User.rolesHeld(existing)');
    expect(src).not.toContain("adminSetRoles(existing.id, ['admin']");
  });
});
