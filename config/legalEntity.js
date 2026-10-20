'use strict';

/**
 * Who operates SAP Hub, under which law, and for whom — the facts the Terms of Service
 * state, in one place, so the page and anything else that quotes them cannot disagree.
 *
 * These are the owner's decisions (2026-10-20): operated by DynamicsHub, Albanian law, the
 * courts of Tirana, open to anybody aged 16 or over. The registration number and the
 * registered address come from the environment because they belong to the deployment's
 * paperwork; each line is printed only when it is set, and never invented.
 */
const LEGAL_ENTITY = Object.freeze({
  name: 'DynamicsHub',
  registrationNumber: (process.env.LEGAL_REGISTRATION_NUMBER || '').trim() || null,
  address: (process.env.LEGAL_ADDRESS || '').trim() || null,
  governingLaw: 'the laws of the Republic of Albania',
  courts: 'the competent courts of Tirana, Albania',
  minimumAge: 16,
  // How far ahead a material change to the terms is announced.
  noticeDays: 30
});

function assertLegalEntityIntegrity() {
  const problems = [];
  const e = LEGAL_ENTITY;
  if (!e.name) problems.push('name is empty');
  if (!e.governingLaw || !e.courts) problems.push('governing law and courts must both be named');
  // 16 is the highest age of digital consent the GDPR allows a member state to set.
  if (!(Number.isInteger(e.minimumAge) && e.minimumAge >= 16)) problems.push('minimumAge must be an integer of at least 16');
  if (!(Number.isInteger(e.noticeDays) && e.noticeDays >= 14)) problems.push('noticeDays must be at least 14');
  if (problems.length) throw new Error(`config/legalEntity.js: ${problems.join('; ')}`);
}

module.exports = { LEGAL_ENTITY, assertLegalEntityIntegrity };
