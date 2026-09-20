'use strict';

/**
 * Decide ONCE, before any test file is loaded, whether a database is reachable.
 *
 * It has to happen here rather than in a `beforeAll`. Jest evaluates a test file — and
 * registers every `describe` in it — before it runs any hook, so a flag set in `beforeAll`
 * is still false at the moment the suite decides whether to skip. The first version of the
 * integration suite did exactly that and reported "7 skipped" against a database that was
 * running perfectly well, which is the worst possible outcome: a green run that tested
 * nothing.
 *
 * `globalSetup` runs in the parent process and its `process.env` is inherited by the
 * workers, so the answer is available at module-evaluation time where it is needed.
 */
module.exports = async () => {
  require('dotenv').config();
  const mysql = require('mysql2/promise');

  try {
    const conn = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT, 10) || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'sap_hub',
      connectTimeout: 3000
    });
    await conn.query('SELECT 1');
    await conn.end();
    process.env.TEST_DATABASE_AVAILABLE = '1';
    console.log('\n  database reachable — integration suites will run');
  } catch (err) {
    process.env.TEST_DATABASE_AVAILABLE = '';
    console.log(`\n  no database (${err.code || err.message}) — integration suites will be SKIPPED`);
  }
};
