#!/usr/bin/env node
'use strict';

/**
 * Pre-flight checks that do not need a database.
 *
 * Runs the config loader (which throws on a missing production SESSION_SECRET), every
 * catalogue integrity assertion, and a require() of every route, model and middleware
 * module, so a syntax error or a bad import is caught before the process tries to serve
 * traffic. Then it compiles every template, because an EJS error is otherwise a 500 on
 * one page that nobody opened before the deploy.
 */
const fs = require('fs');
const path = require('path');

const problems = [];

function check(label, fn) {
  try {
    fn();
    console.log(`  ok    ${label}`);
  } catch (err) {
    problems.push(`${label}: ${err.message}`);
    console.log(`  FAIL  ${label} — ${err.message}`);
  }
}

console.log('Boot validation');

check('config loads', () => require('../config/config'));
check('role taxonomy is consistent', () => require('../config/roleTaxonomy').assertTaxonomyIntegrity());
check('product catalogue is consistent', () => require('../config/sapProducts').assertCatalogueIntegrity());
check('certification catalogue is consistent', () => require('../config/certifications').assertCertificationIntegrity());
check('settings definitions are consistent', () => require('../config/settings').assertSettingsIntegrity());
check('country list is non-empty', () => {
  const countries = require('../config/all-countries.json');
  if (!Array.isArray(countries) || countries.length < 100) throw new Error(`only ${countries.length} countries`);
});
check('country dropdown list is consistent', () => require('../config/countries').assertCountriesIntegrity());

/*
 * The palette is checked, not trusted.
 *
 * DESIGN.md states a contrast ratio for every interactive colour, and a stated ratio is
 * only a comment until something measures it. This is the check that keeps SAP's own
 * #0070F2 out of the button fill: it clears AA by seven hundredths, and the moment
 * somebody "corrects" the CTA to the brand blue this fails rather than shipping.
 */
check('the palette meets its own contrast floor', () => {
  const { contrastRatio } = require('../utils/contrast');
  const required = [
    ['--primary-blue #0064D9 on white', '#0064D9', '#FFFFFF', 4.5],
    ['--primary-blue-dark #004AA8 on white', '#004AA8', '#FFFFFF', 4.5],
    ['--primary-navy #00265B on white', '#00265B', '#FFFFFF', 4.5],
    ['white on --primary-blue', '#FFFFFF', '#0064D9', 4.5],
    ['white on --primary-navy', '#FFFFFF', '#00265B', 4.5],
    ['--text-light #5A6673 on white', '#5A6673', '#FFFFFF', 4.5],
    ['--primary-blue-bright #7AC5FF on navy', '#7AC5FF', '#00265B', 4.5]
  ];
  const failures = [];
  for (const [label, fg, bg, floor] of required) {
    const ratio = contrastRatio(fg, bg);
    if (ratio === null || ratio < floor) {
      failures.push(`${label}: ${ratio === null ? 'unparseable' : ratio.toFixed(2)}:1, needs ${floor}:1`);
    }
  }
  if (failures.length) throw new Error(`\n      ${failures.join('\n      ')}`);
});

for (const dir of ['models', 'middleware', 'utils', 'routes']) {
  const full = path.join(__dirname, '..', dir);
  for (const file of fs.readdirSync(full).filter((f) => f.endsWith('.js'))) {
    check(`${dir}/${file} loads`, () => require(path.join(full, file)));
  }
}

check('every view template compiles', () => {
  const ejs = require('ejs');
  const viewsDir = path.join(__dirname, '..', 'views');
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const p = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(p) : p.endsWith('.ejs') ? [p] : [];
    });

  const failures = [];
  for (const file of walk(viewsDir)) {
    try {
      ejs.compile(fs.readFileSync(file, 'utf8'), { filename: file });
    } catch (err) {
      failures.push(`${path.relative(viewsDir, file)}: ${err.message.split('\n')[0]}`);
    }
  }
  if (failures.length) throw new Error(`\n      ${failures.join('\n      ')}`);
});

if (problems.length) {
  console.error(`\n${problems.length} problem(s) found.`);
  process.exit(1);
}
console.log('\nAll boot checks passed.');
