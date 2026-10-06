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

/**
 * The EFFECTIVE values of an ENUM, across every migration in order.
 *
 * Pinning a test to the migration that first created a column is pinning it to a schema
 * that no longer exists: the moment a later file alters the column the test is comparing
 * the code against history. `subject_type` was created in 011 and widened twice since, and
 * this test failed on the second of those — correctly, but for the wrong reason, because
 * the code was right and the file it was being checked against was stale.
 *
 * The last definition wins, exactly as it does when the runner applies them in order.
 */
function effectiveEnumValues(column) {
  const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  let values = null;
  files.forEach((file) => {
    const sql = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
    const pattern = new RegExp(`${column}\\s+ENUM\\(([^)]+)\\)`, 'gi');
    let match = pattern.exec(sql);
    while (match) {
      values = match[1].split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
      match = pattern.exec(sql);
    }
  });
  if (!values) throw new Error(`No ENUM found for ${column} in any migration`);
  return values;
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

  test('the moderation subject types are exactly the ENUM as the migrations leave it', () => {
    // 011 created it; 025 and 026 widened it. The last definition is the live one.
    expect(Moderation.SUBJECT_TYPES).toEqual(effectiveEnumValues('subject_type'));
  });

  test('neither list can be mutated by a caller', () => {
    expect(Object.isFrozen(Job.STATUSES)).toBe(true);
    expect(Object.isFrozen(Moderation.SUBJECT_TYPES)).toBe(true);
  });
});
