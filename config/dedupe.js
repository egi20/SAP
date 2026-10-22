'use strict';

/**
 * DH Dedupe: the master-data product /dedupe points to (owner's decision, 2026-10-22).
 *
 * SAP Hub does not build its own master-data deduplication. Cleaning business partners,
 * customers, vendors and materials before an S/4HANA migration is what DynamicsHub's Dedupe
 * platform does, so /dedupe says so and links there; the small free check for a list of
 * people stays beside it.
 *
 * The ADDRESS is `DH_DEDUPE_URL` and is never guessed: a link typed from memory is a 404 the
 * first time somebody clicks it, and nothing on this side would notice. Unset, the card
 * describes the product without a button. Set, it must be https on a dynamicshub.net host —
 * asserted at boot, like every other outbound address the site renders.
 *
 * The description is the owner's account of the product, in one place to be changed in one
 * place. No price: what another platform charges is that platform's to state, and a figure
 * copied here goes stale the day it changes there.
 */

const DH_DEDUPE = Object.freeze({
  name: 'DH Dedupe',
  url: (process.env.DH_DEDUPE_URL || '').trim() || null,
  what: 'Duplicate detection for ERP master data — business partners, customers, vendors, products and addresses — before they reach S/4HANA.',
  features: Object.freeze([
    'Upload CSV, Excel or JSON and map the columns',
    'Fuzzy matching with confidence scores, not only exact matches',
    'Side-by-side review, a golden record, and export'
  ])
});

function dedupeProblems(entry = DH_DEDUPE) {
  const problems = [];
  if (entry.url) {
    let parsed = null;
    try { parsed = new URL(entry.url); } catch (e) { parsed = null; }
    if (!parsed) problems.push('DH_DEDUPE_URL is not a URL');
    else {
      if (parsed.protocol !== 'https:') problems.push('DH_DEDUPE_URL must be https');
      if (!/(^|\.)dynamicshub\.net$/i.test(parsed.hostname)) problems.push('DH_DEDUPE_URL must be on dynamicshub.net');
      if (parsed.username || parsed.password) problems.push('DH_DEDUPE_URL must not carry credentials');
    }
  }
  if (!entry.features.length) problems.push('DH Dedupe needs at least one feature line');
  return problems;
}

function assertDedupeIntegrity() {
  const problems = dedupeProblems();
  if (problems.length) throw new Error(`config/dedupe.js: ${problems.join('; ')}`);
}

module.exports = { DH_DEDUPE, dedupeProblems, assertDedupeIntegrity };
