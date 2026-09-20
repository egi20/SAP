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
