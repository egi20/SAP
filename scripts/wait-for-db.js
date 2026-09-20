#!/usr/bin/env node
'use strict';

/**
 * Block until the database accepts connections, or give up.
 * Used before `migrate` in environments where the database container starts alongside
 * the app and may not be ready on the first attempt.
 */
const mysql = require('mysql2/promise');
const config = require('../config/config');

const MAX_ATTEMPTS = Number(process.env.DB_WAIT_ATTEMPTS || 30);
const DELAY_MS = Number(process.env.DB_WAIT_DELAY_MS || 2000);

async function tryConnect() {
  const conn = await mysql.createConnection({
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    database: config.database.database
  });
  await conn.query('SELECT 1');
  await conn.end();
}

async function main() {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await tryConnect();
      console.log(`Database is ready (attempt ${attempt}).`);
      return;
    } catch (err) {
      console.log(`Waiting for database (${attempt}/${MAX_ATTEMPTS}): ${err.code || err.message}`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    }
  }
  throw new Error(`Database was not reachable after ${MAX_ATTEMPTS} attempts.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
