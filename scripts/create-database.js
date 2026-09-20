#!/usr/bin/env node
'use strict';

/**
 * Create the application database if it does not exist.
 *
 * `npm run migrate` connects WITH a database selected, so it cannot create one — a fresh
 * checkout fails on "Unknown database" before a single migration runs. This script
 * connects without selecting one and issues a single guarded CREATE.
 *
 * It is deliberately NOT part of `npm start`. Creating a database is a one-off setup step,
 * and a production start command that silently creates a schema when the configured one is
 * missing hides a misconfigured DB_NAME instead of failing on it.
 */

const mysql = require('mysql2/promise');
const config = require('../config/config');

async function main() {
  const { host, port, user, password, database } = config.database;

  // Identifiers cannot be parameterised, so the name is validated rather than escaped.
  // Anything outside this character set is a configuration mistake, not a value to quote.
  if (!/^[A-Za-z0-9_]{1,64}$/.test(database)) {
    throw new Error(`DB_NAME "${database}" is not a valid database name (letters, digits and underscore only).`);
  }

  const connection = await mysql.createConnection({ host, port, user, password });
  try {
    const [rows] = await connection.query('SHOW DATABASES LIKE ?', [database]);
    if (rows.length) {
      console.log(`Database "${database}" already exists — nothing to do.`);
      return;
    }

    await connection.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    console.log(`Created database "${database}" (utf8mb4 / utf8mb4_unicode_ci).`);
    console.log('Next: npm run migrate');
  } finally {
    await connection.end();
  }
}

main().catch((err) => {
  console.error(`Could not create the database: ${err.message}`);
  if (err.code === 'ER_ACCESS_DENIED_ERROR') {
    console.error('Check DB_USER and DB_PASSWORD in .env.');
  }
  if (err.code === 'ECONNREFUSED') {
    console.error(`Nothing is listening on ${config.database.host}:${config.database.port} — is MySQL running?`);
  }
  process.exit(1);
});
