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
const { seedCategories } = require('../config/community');
const { slugify } = require('../utils/slug');

/**
 * Bring `post_categories` into line with `config/community.js`.
 *
 * The tree is DERIVED from the product lines, so it changes when the code changes, not when
 * somebody edits a row — which is what makes this a deploy step rather than data entry. A
 * category that disappears from the config is DEACTIVATED rather than deleted, because
 * posts point at it and a post whose category vanished is a post nobody can find.
 */
async function syncCategories() {
  const wanted = seedCategories();
  const values = wanted.map((c) => [c.slug, c.name, c.description || null, c.familySlug || null, c.icon, c.sortOrder]);

  await promisePool.query(
    `INSERT INTO post_categories (slug, name, description, family_slug, icon, sort_order)
     VALUES ?
     ON DUPLICATE KEY UPDATE
       name = VALUES(name),
       description = VALUES(description),
       family_slug = VALUES(family_slug),
       icon = VALUES(icon),
       sort_order = VALUES(sort_order),
       is_active = 1`,
    [values]
  );

  const [result] = await promisePool.query(
    'UPDATE post_categories SET is_active = 0 WHERE slug NOT IN (?)',
    [wanted.map((c) => c.slug)]
  );

  return { total: wanted.length, deactivated: result.changedRows };
}

async function sync() {
  const wanted = ALL_MODULES.map((m) => [slugify(m.label), m.label, m.lineLabel]);

  const [result] = await promisePool.query(
    `INSERT INTO skills (slug, name, category)
     VALUES ?
     ON DUPLICATE KEY UPDATE name = VALUES(name), category = VALUES(category)`,
    [wanted]
  );

  const [[{ total }]] = await promisePool.query('SELECT COUNT(*) AS total FROM skills');
  const categories = await syncCategories();

  console.log(
    `Catalogue synced: ${PRODUCT_LINES.length} product lines, ${wanted.length} modules ` +
      `(${result.affectedRows} row(s) written). ${total} skill(s) in total.`
  );
  console.log(
    `Community categories synced: ${categories.total} active`
      + (categories.deactivated ? `, ${categories.deactivated} deactivated` : '')
      + '.'
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

module.exports = { sync, syncCategories };
