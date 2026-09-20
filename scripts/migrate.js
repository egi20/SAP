#!/usr/bin/env node
'use strict';

/**
 * Minimal forward-only migration runner.
 *
 * Ported from Salesforce Hub, which added it because DynamicsHub had no runner: its
 * models self-created their own tables at boot with `CREATE TABLE IF NOT EXISTS`
 * plus guarded `ALTER TABLE` calls, while the files under `migrations/` were never
 * executed by anything. The documented consequence was that a column which existed
 * only in a migration file was simply missing in production, and concurrent boot-time
 * ALTERs on `users` deadlocked and dropped columns.
 *
 * Here the schema is data: numbered .sql files, applied in order, recorded in
 * `schema_migrations`, guarded by a MySQL advisory lock so two instances booting at
 * once cannot both apply the same file.
 *
 *   node scripts/migrate.js up      apply everything pending
 *   node scripts/migrate.js status  list applied / pending
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const config = require('../config/config');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const LOCK_NAME = 'sap_hub_migrations';
const LOCK_TIMEOUT_SECONDS = 60;

function migrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/**
 * Split a .sql file into individual statements.
 *
 * Handles `--` and `#` line comments, `/* *\/` block comments and quoted strings so a
 * semicolon inside a string literal or comment does not split a statement.
 */
function splitStatements(sql) {
  const statements = [];
  let current = '';
  let quote = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (!quote) {
      if (ch === '-' && next === '-') {
        inLineComment = true;
        i += 1;
        continue;
      }
      if (ch === '#') {
        inLineComment = true;
        continue;
      }
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        i += 1;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
        current += ch;
        continue;
      }
      if (ch === ';') {
        if (current.trim()) statements.push(current.trim());
        current = '';
        continue;
      }
    } else {
      if (ch === '\\') {
        current += ch + (next ?? '');
        i += 1;
        continue;
      }
      if (ch === quote) {
        // A doubled quote character is an escaped quote, not a terminator.
        if (next === quote) {
          current += ch + next;
          i += 1;
          continue;
        }
        quote = null;
      }
    }
    current += ch;
  }

  if (current.trim()) statements.push(current.trim());
  return statements;
}

function checksum(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

async function connect() {
  return mysql.createConnection({
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    database: config.database.database,
    multipleStatements: false,
    charset: 'utf8mb4_unicode_ci'
  });
}

async function ensureMigrationsTable(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   VARCHAR(255) NOT NULL PRIMARY KEY,
      checksum   CHAR(64)     NOT NULL,
      applied_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

/**
 * Refuse to run our migrations into somebody else's schema.
 *
 * If nothing has been applied yet but the database already contains tables, DB_NAME is
 * almost certainly pointing at a different application's database. Without this check the
 * first migration fails with a bare "Table 'users' already exists", which reads like a bug
 * in the migration rather than a misconfigured connection — and a schema that DID happen to
 * have no name collisions would get our tables mixed into it.
 */
async function assertDatabaseIsOursOrEmpty(conn, database) {
  const [[{ applied }]] = await conn.query('SELECT COUNT(*) AS applied FROM schema_migrations');
  if (applied > 0) return;

  const [[{ tables }]] = await conn.query(
    `SELECT COUNT(*) AS tables FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME <> 'schema_migrations'`,
    [database]
  );
  if (tables === 0) return;

  throw new Error(
    `Database "${database}" already contains ${tables} table(s) but has no migration history.\n` +
      '  This looks like another application\'s database. SAP Hub uses its own schema and\n' +
      '  cannot share one.\n' +
      `  Point DB_NAME at an empty database (npm run db:create creates one), or drop "${database}"\n` +
      '  first if it really is a stale attempt at this app.'
  );
}

async function appliedMigrations(conn) {
  const [rows] = await conn.query('SELECT filename, checksum FROM schema_migrations');
  return new Map(rows.map((r) => [r.filename, r.checksum]));
}

async function up() {
  const conn = await connect();
  try {
    const [[lock]] = await conn.query('SELECT GET_LOCK(?, ?) AS acquired', [LOCK_NAME, LOCK_TIMEOUT_SECONDS]);
    if (!lock.acquired) {
      throw new Error(`Could not acquire migration lock within ${LOCK_TIMEOUT_SECONDS}s`);
    }

    try {
      await ensureMigrationsTable(conn);
      await assertDatabaseIsOursOrEmpty(conn, config.database.database);
      const applied = await appliedMigrations(conn);
      const files = migrationFiles();
      let count = 0;

      for (const file of files) {
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
        const sum = checksum(sql);

        if (applied.has(file)) {
          if (applied.get(file) !== sum) {
            throw new Error(
              `Migration ${file} has already been applied but its contents changed. ` +
                'Migrations are immutable — add a new file instead of editing this one.'
            );
          }
          continue;
        }

        process.stdout.write(`applying ${file} ... `);
        const statements = splitStatements(sql);
        for (const statement of statements) {
          // Sequential by definition: DDL statements depend on the ones before them.
          // eslint-disable-next-line no-await-in-loop
          await conn.query(statement);
        }
        // eslint-disable-next-line no-await-in-loop
        await conn.query('INSERT INTO schema_migrations (filename, checksum) VALUES (?, ?)', [file, sum]);
        process.stdout.write(`ok (${statements.length} statements)\n`);
        count += 1;
      }

      console.log(count === 0 ? 'Database is up to date.' : `Applied ${count} migration(s).`);
    } finally {
      await conn.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
    }
  } finally {
    await conn.end();
  }
}

async function status() {
  const conn = await connect();
  try {
    await ensureMigrationsTable(conn);
    const applied = await appliedMigrations(conn);
    for (const file of migrationFiles()) {
      console.log(`${applied.has(file) ? '[applied]' : '[pending]'} ${file}`);
    }
  } finally {
    await conn.end();
  }
}

async function main() {
  const command = process.argv[2] || 'up';
  if (command === 'up') return up();
  if (command === 'status') return status();
  throw new Error(`Unknown command: ${command}. Use "up" or "status".`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Migration failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { splitStatements, checksum, migrationFiles };
