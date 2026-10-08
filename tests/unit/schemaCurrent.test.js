'use strict';

/**
 * Pending migrations, and the country names a page is allowed to print.
 *
 * Two small things from the same QA pass, both of which cost somebody real time: a
 * database the code had outgrown answered 500 on most of the site with a stack trace that
 * blamed the query, and a profile said "Tirana, AL".
 */

const fs = require('fs');
const path = require('path');
const { pendingMigrations, migrationFiles } = require('../../scripts/migrate');
const { countryName, locationLabel } = require('../../utils/geo');

describe('pendingMigrations', () => {
  const fake = (rows) => ({ query: async () => [rows] });

  it('reports the files the database has not applied', async () => {
    const files = migrationFiles();
    const applied = files.slice(0, -1).map((filename) => ({ filename }));
    await expect(pendingMigrations(fake(applied))).resolves.toEqual([files[files.length - 1]]);
  });

  it('reports nothing when the database is current', async () => {
    const applied = migrationFiles().map((filename) => ({ filename }));
    await expect(pendingMigrations(fake(applied))).resolves.toEqual([]);
  });

  it('treats a missing bookkeeping table as "none of them have run"', async () => {
    const missing = {
      query: async () => {
        const err = new Error('no such table');
        err.code = 'ER_NO_SUCH_TABLE';
        throw err;
      }
    };
    await expect(pendingMigrations(missing)).resolves.toHaveLength(migrationFiles().length);
  });

  it('lets a real database error through rather than reporting "up to date"', async () => {
    // Swallowing this would answer "nothing pending" for a database that is unreachable,
    // which is the one wrong answer this check must never give.
    const broken = { query: async () => { throw new Error('connection lost'); } };
    await expect(pendingMigrations(broken)).rejects.toThrow('connection lost');
  });
});

describe('the server checks it before it serves', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');

  it('names the files and the command rather than failing per request', () => {
    expect(server).toContain('checkSchemaIsCurrent');
    expect(server).toContain('npm run migrate');
  });

  it('refuses outright in production', () => {
    // Serving a schema that does not match the code is how a write lands in a column that
    // means something else.
    const fn = server.slice(server.indexOf('async function checkSchemaIsCurrent'));
    expect(fn.slice(0, fn.indexOf('\n}'))).toContain('process.exit(1)');
  });
});

describe('countries are printed by name', () => {
  it('expands a code somebody is not expected to know', () => {
    expect(countryName('AL')).toBe('Albania');
    expect(countryName('DE')).toBe('Germany');
  });

  it('falls back to the code rather than to nothing', () => {
    // A row holding something unexpected should still render as the fact it holds.
    expect(countryName('ZZ')).toBe('ZZ');
    expect(countryName(null)).toBeNull();
  });

  it('builds the location a CV prints', () => {
    expect(locationLabel('Tirana', 'AL')).toBe('Tirana, Albania');
    expect(locationLabel(null, 'AL')).toBe('Albania');
    expect(locationLabel('Tirana', null)).toBe('Tirana');
    expect(locationLabel(null, null)).toBeNull();
  });
});
