#!/usr/bin/env node
'use strict';

/**
 * Seed the `skills` table from the module catalogue.
 *
 * The skills table is otherwise built entirely from what people type: `Skill.findOrCreateMany`
 * creates a row for anything a job post or a profile mentions. That is the right behaviour —
 * this ecosystem's vocabulary is larger than any list — but it means the very first job post
 * and the very first profile invent their own spellings of the same module, and the skill
 * filter then has "EWM", "ewm" and "Extended Warehouse Management" as three different things
 * that never match each other.
 *
 * So the catalogue's module names are seeded first, and the slugs come from the same
 * `slugify` every other path uses. A later free-text "EWM" resolves to the seeded row rather
 * than making a new one.
 *
 * A DEPLOY STEP, not data entry: the list is derived from `config/sapProducts.js`, so it
 * changes when the code changes. Idempotent, and it never deletes — a module dropped from the
 * catalogue leaves its skill row behind, because profiles and job posts point at it and the
 * person who claimed it did not stop knowing it.
 */
const { promisePool, pool } = require('../config/database');
const { ALL_MODULES, PRODUCT_LINES } = require('../config/sapProducts');
const { slugify } = require('../utils/slug');

async function sync() {
  const wanted = ALL_MODULES.map((m) => [slugify(m.label), m.label, m.lineLabel]);

  const [result] = await promisePool.query(
    `INSERT INTO skills (slug, name, category)
     VALUES ?
     ON DUPLICATE KEY UPDATE name = VALUES(name), category = VALUES(category)`,
    [wanted]
  );

  const [[{ total }]] = await promisePool.query('SELECT COUNT(*) AS total FROM skills');
  console.log(
    `Catalogue synced: ${PRODUCT_LINES.length} product lines, ${wanted.length} modules ` +
      `(${result.affectedRows} row(s) written). ${total} skill(s) in total.`
  );
}

if (require.main === module) {
  sync()
    .then(() => pool.end(() => process.exit(0)))
    .catch((err) => {
      console.error(`Catalogue sync failed: ${err.message}`);
      pool.end(() => process.exit(1));
    });
}

module.exports = { sync };
