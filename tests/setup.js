'use strict';

// Requiring any model pulls in config/database, which creates a mysql2 pool. The pool
// does not connect until a query is issued, but it does register a handle that would
// keep Jest alive, so it is closed once the suite finishes.
afterAll(async () => {
  /*
   * The session store sweeps expired rows on a timer, and a live timer keeps Node alive —
   * every run used to end in "Jest did not exit one second after the test run completed".
   *
   * Looked up through `require.cache`, never by `require()`: calling require here would
   * LOAD the whole application inside a unit suite that never wanted it, opening a pool
   * and a store purely so that this hook could close them. Only a suite that actually
   * loaded the app has anything to close.
   */
  try {
    const path = require.resolve('../server');
    const loaded = require.cache[path];
    const store = loaded && loaded.exports && loaded.exports.sessionStore;
    if (store) await store.close();
  } catch {
    // Nothing to close.
  }

  try {
    const { pool } = require('../config/database');
    await new Promise((resolve) => pool.end(resolve));
  } catch {
    // No pool was ever created by this suite.
  }
});
