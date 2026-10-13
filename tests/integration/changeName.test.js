'use strict';

/**
 * `npm run change-name` — an account created as "Administrator" gets its person's name,
 * and nothing else on the row moves.
 */

const { promisePool } = require('../../config/database');
const User = require('../../models/User');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const EMAIL = 'change-name@example.test';

maybe()('User.changeName', () => {
  let id;

  beforeAll(async () => {
    await promisePool.query('DELETE FROM users WHERE email = ?', [EMAIL]);
    const user = await User.create({ email: EMAIL, password: 'Sup3rSecret', name: 'Administrator', roles: ['admin'] });
    id = user.id;
  });

  it('writes the trimmed name and leaves email and roles alone', async () => {
    expect(await User.changeName(id, '  Paola   Ymet ')).toBe('Paola Ymet');
    const [[row]] = await promisePool.query('SELECT name, email, user_type FROM users WHERE id = ?', [id]);
    expect(row).toEqual({ name: 'Paola Ymet', email: EMAIL, user_type: 'admin' });
  });

  it('refuses an empty name rather than blanking the row', async () => {
    await expect(User.changeName(id, '   ')).rejects.toThrow(/1 to 200/);
    const [[row]] = await promisePool.query('SELECT name FROM users WHERE id = ?', [id]);
    expect(row.name).toBe('Paola Ymet');
  });
});
