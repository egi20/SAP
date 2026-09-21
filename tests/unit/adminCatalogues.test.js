'use strict';

/**
 * The lists the admin screens read, checked against the schema they claim to mirror.
 *
 * Both of these are pure file reads, so they run without a database — which matters,
 * because a drift between a dropdown and the ENUM behind it is exactly the kind of thing
 * that only shows up when somebody picks the one option nobody tested.
 */

const fs = require('fs');
const path = require('path');

const Job = require('../../models/Job');
const Moderation = require('../../models/Moderation');

const MIGRATIONS = path.join(__dirname, '..', '..', 'scripts', 'migrations');

function enumValues(file, column) {
  const sql = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
  const match = sql.match(new RegExp(`${column}\\s+ENUM\\(([^)]+)\\)`, 'i'));
  if (!match) throw new Error(`No ENUM found for ${column} in ${file}`);
  return match[1].split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
}

describe('the admin lists mirror the schema', () => {
  /*
   * `Job.STATUSES` was written out by hand in three places before this — the employer's
   * status form, the route that validates what that form posts, and the admin filter —
   * against an ENUM that is the actual authority. Three copies of a five-item list is how
   * a status gets added to a dropdown and silently rejected by the validator behind it.
   */
  test('the job statuses are exactly the ENUM in migration 003, in order', () => {
    expect(Job.STATUSES).toEqual(enumValues('003_jobs.sql', 'status'));
  });

  test('the moderation subject types are exactly the ENUM in migration 011', () => {
    expect(Moderation.SUBJECT_TYPES).toEqual(enumValues('011_moderation.sql', 'subject_type'));
  });

  test('neither list can be mutated by a caller', () => {
    expect(Object.isFrozen(Job.STATUSES)).toBe(true);
    expect(Object.isFrozen(Moderation.SUBJECT_TYPES)).toBe(true);
  });
});
