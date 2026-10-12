'use strict';

/**
 * The parts of /admin/users that are pure: how a row is printed, and who may delete whom.
 * The last-superadmin rule is tested here because it cannot be reached honestly through
 * the route — the actor is always an active superadmin — and a test that deactivated
 * every other superadmin in a shared database would be asserting on global state.
 */

const User = require('../../models/User');
const AccountClosure = require('../../models/AccountClosure');
const { nameColumns, flagEmoji } = require('../../utils/adminUserDisplay');

describe('nameColumns', () => {
  it('splits a person at the first space', () => {
    expect(nameColumns({ user_type: 'consultant', name: 'Maria de la Cruz' })).toEqual({ first: 'Maria', last: 'de la Cruz' });
  });
  it('puts a company name in First and a dash in Last', () => {
    expect(nameColumns({ user_type: 'company', name: 'Hr Person', company_name: 'Acme GmbH' })).toEqual({ first: 'Acme GmbH', last: '—' });
  });
  it('copes with one word and with nothing', () => {
    expect(nameColumns({ user_type: 'consultant', name: 'Cher' })).toEqual({ first: 'Cher', last: '—' });
    expect(nameColumns({ user_type: 'consultant', name: '' })).toEqual({ first: '—', last: '—' });
  });
});

describe('flagEmoji', () => {
  it('builds a flag from an ISO code', () => {
    expect(flagEmoji('de')).toBe('🇩🇪');
  });
  it('gives nothing for anything else', () => {
    expect(flagEmoji('DEU')).toBe('');
    expect(flagEmoji('')).toBe('');
  });
});

describe('AccountClosure.adminRefusal', () => {
  const superActor = { id: 1, isAdmin: true, isSuperadmin: true };
  const plainActor = { id: 2, isAdmin: true, isSuperadmin: false };

  afterEach(() => jest.restoreAllMocks());

  it('refuses your own account', async () => {
    expect(await AccountClosure.adminRefusal(superActor, { id: 1, email: 'me@x.test' })).toMatch(/your own/);
  });

  it('refuses an ordinary admin deleting an administrator', async () => {
    expect(await AccountClosure.adminRefusal(plainActor, { id: 9, email: 'a@x.test', user_type: 'admin' })).toMatch(/only a superadmin/);
  });

  it('refuses the last active superadmin', async () => {
    jest.spyOn(User, 'countActiveSuperadmins').mockResolvedValue(0);
    expect(await AccountClosure.adminRefusal(superActor, { id: 9, email: 's@x.test', user_type: 'admin', is_superadmin: 1 })).toMatch(/last active superadmin/);
  });

  it('allows a superadmin to delete another superadmin while one remains', async () => {
    jest.spyOn(User, 'countActiveSuperadmins').mockResolvedValue(1);
    expect(await AccountClosure.adminRefusal(superActor, { id: 9, email: 's@x.test', user_type: 'admin', is_superadmin: 1 })).toBeNull();
  });

  it('allows an ordinary member', async () => {
    expect(await AccountClosure.adminRefusal(plainActor, { id: 9, email: 'c@x.test', user_type: 'consultant' })).toBeNull();
  });
});
