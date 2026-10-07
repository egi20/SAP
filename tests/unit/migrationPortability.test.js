'use strict';

/**
 * The migrations have to apply on MySQL 8 as well as on MariaDB.
 *
 * Everything here was developed against MariaDB 10.11 in a container, and the first MySQL 8
 * this schema ever met refused migration 022 with "Cannot add foreign key constraint" —
 * errno 1215, which names neither the column nor the rule. The table had been applying
 * cleanly for weeks.
 *
 * These are static scans, because the failure they catch only ever shows up on an engine
 * this suite does not run against, and the suite itself skips without any database at all.
 */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'scripts', 'migrations');

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

/** A migration with its comments stripped: a rule's explanation must not match the rule. */
function statements(file) {
  return fs.readFileSync(path.join(DIR, file), 'utf8').replace(/^\s*--.*$/gm, '');
}

/** `{ name, kind, baseColumns }` for every generated column declared in `sql`. */
function generatedColumns(sql) {
  return [...sql.matchAll(/^\s*(\w+)\s+[A-Z0-9()\s]+?\s+AS\s+\(([\s\S]*?)\)\s*(STORED|VIRTUAL)/gim)]
    .map(([, name, expression, kind]) => ({
      name,
      kind: kind.toUpperCase(),
      baseColumns: [...new Set((expression.match(/\b[a-z_][a-z0-9_]*\b/gi) || []).map((w) => w.toLowerCase()))]
    }));
}

/** `{ column, action }` for every foreign key carrying a referential action. */
function foreignKeyActions(sql) {
  return [...sql.matchAll(
    /FOREIGN KEY \(([^)]+)\) REFERENCES [^\n,]*?(ON (?:DELETE|UPDATE) (?:CASCADE|SET NULL|SET DEFAULT))/gi
  )].map(([, column, action]) => ({ column: column.trim().toLowerCase(), action: action.toUpperCase() }));
}

describe('no foreign key sits on the base column of a stored generated column', () => {
  it.each(files)('%s', (file) => {
    /*
     * MySQL 8 refuses CASCADE, SET NULL and SET DEFAULT on a foreign key whose column is a
     * base column of a STORED generated column — the whole CREATE TABLE fails. MariaDB
     * does not enforce it, which is why 022 shipped: `pending_job_id AS (IF(status =
     * 'pending', job_id, NULL)) STORED` sat over a `job_id` carrying ON DELETE CASCADE.
     *
     * The fix is not to drop the cascade. Keep the column out of the EXPRESSION and put it
     * in the KEY: a marker derived from `status` alone, under UNIQUE (job_id, marker), is
     * the same guarantee on both engines.
     */
    const sql = statements(file);
    const fks = foreignKeyActions(sql);

    for (const column of generatedColumns(sql)) {
      if (column.kind !== 'STORED') continue;
      for (const fk of fks) {
        expect({
          file,
          generated: column.name,
          baseColumn: fk.column,
          action: fk.action,
          conflict: column.baseColumns.includes(fk.column)
        }).toMatchObject({ conflict: false });
      }
    }
  });
});

describe('no MySQL-only syntax', () => {
  it.each(files)('%s', (file) => {
    // MariaDB's JSON is an alias for LONGTEXT with a json_valid() CHECK, and there is no
    // JSON cast target: `CAST(? AS JSON)` is a parse error there. Bind the string instead.
    expect(statements(file)).not.toMatch(/CAST\s*\([^)]*AS\s+JSON\s*\)/i);
  });
});
