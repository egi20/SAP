'use strict';

const { promisePool, withTransaction } = require('../config/database');
const {
  KEYS,
  isValidKey,
  coerce,
  serialise,
  deserialise,
  defaults
} = require('../config/settings');

/**
 * The runtime settings, cached in process.
 *
 * Read on nearly every request (the site notice is in the layout), so a database round
 * trip per page would be a real cost for values that change perhaps twice a year. The
 * cache has a short TTL rather than being invalidated across instances: a second app
 * server picking up a change within a minute is fine for an operational switch, and a
 * cross-instance invalidation channel is a lot of machinery for that.
 *
 * `get()` NEVER throws and never awaits anything a page render depends on being fast: an
 * unreadable settings table falls back to the declared defaults, because the alternative
 * is that a hiccup in a table holding three rows takes down every page on the site.
 */

const CACHE_TTL_MS = 60 * 1000;

let cache = { values: null, at: 0 };

function clearSettingsCache() {
  cache = { values: null, at: 0 };
}

class AppSetting {
  static async all() {
    const now = Date.now();
    if (cache.values && now - cache.at < CACHE_TTL_MS) return cache.values;

    const values = defaults();
    try {
      const [rows] = await promisePool.query(
        'SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN (?)',
        [KEYS]
      );
      for (const row of rows) {
        if (isValidKey(row.setting_key)) {
          values[row.setting_key] = deserialise(row.setting_key, row.setting_value);
        }
      }
    } catch (err) {
      // Defaults, loudly. See the note above: this must not be able to break a page.
      console.error(`AppSetting.all failed, using declared defaults — ${err.message}`);
      cache = { values, at: now };
      return values;
    }

    cache = { values, at: now };
    return values;
  }

  static async get(key) {
    if (!isValidKey(key)) return null;
    const values = await AppSetting.all();
    return values[key];
  }

  /**
   * Write the submitted form.
   *
   * Iterates the DECLARED keys, not the submitted body: an unchecked checkbox posts
   * nothing at all, so a body-driven loop would leave every "off" switch untouched
   * forever. It is also what makes an unknown submitted field a no-op rather than a new
   * row — `config/settings.js` is provably the whole surface.
   */
  static async setMany(submitted = {}) {
    const written = {};

    await withTransaction(async (conn) => {
      for (const key of KEYS) {
        const value = coerce(key, submitted[key]);
        written[key] = value;
        // eslint-disable-next-line no-await-in-loop
        await conn.query(
          `INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)
           ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
          [key, serialise(key, value)]
        );
      }
    });

    clearSettingsCache();
    return written;
  }
}

module.exports = AppSetting;
module.exports.clearSettingsCache = clearSettingsCache;
