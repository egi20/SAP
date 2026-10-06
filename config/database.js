'use strict';

const mysql = require('mysql2');
const config = require('./config');

/**
 * One pool for the whole process. There is no ORM: every model is a class of
 * static methods issuing parameterised SQL through `promisePool`.
 */
const pool = mysql.createPool({
  host: config.database.host,
  port: config.database.port,
  user: config.database.user,
  password: config.database.password,
  database: config.database.database,
  waitForConnections: true,
  connectionLimit: config.database.connectionLimit,
  queueLimit: 0,
  enableKeepAlive: true,
  charset: 'utf8mb4_unicode_ci',
  timezone: 'Z',
  dateStrings: false
});

/*
 * Every connection speaks UTC.
 *
 * `timezone: 'Z'` above tells the DRIVER to read a DATETIME back as UTC. Nothing told the
 * SERVER to write one, so `NOW()` and every `DEFAULT CURRENT_TIMESTAMP` ran in whatever
 * zone the database host happened to be in, and the two halves disagreed by exactly that
 * offset. Reported from a machine in CEST: a message sent at 16:35 displayed as 18:35,
 * because MySQL stored 16:35, the driver read it as 16:35 UTC and the template rendered it
 * back into local time.
 *
 * The clock skew is the visible half. The silent half is every window computed in SQL —
 * `DATE_SUB(NOW(), INTERVAL ? DAY)` on the stalled-application count, the error purge, the
 * tax retention purge, `earns_until` on a referral, the rate submission's own period — all
 * off by the host's offset, and none of them with anything on screen to compare against.
 * It never showed in development because the containers run UTC.
 *
 * Set per connection rather than asked of the deployment: a rule that depends on how
 * somebody configured their database server is a rule this application cannot check.
 */
pool.on('connection', (connection) => {
  connection.query("SET time_zone = '+00:00'");
});

const promisePool = pool.promise();

/**
 * Run `fn` inside a transaction, rolling back on any throw.
 * Money and role mutations must always go through this.
 */
async function withTransaction(fn) {
  const connection = await promisePool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await fn(connection);
    await connection.commit();
    return result;
  } catch (err) {
    try {
      await connection.rollback();
    } catch (rollbackErr) {
      // Rolling back a already-dead connection is not the interesting failure.
      console.error('Rollback failed:', rollbackErr.message);
    }
    throw err;
  } finally {
    connection.release();
  }
}

module.exports = { pool, promisePool, withTransaction };
